import { type Static, StringEnum, Type } from "@mariozechner/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	type ToolInfo,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const TOOL_NAME = "delegate";
const TIMEOUT_MS = 15 * 60 * 1000;
const REQUESTED_MODEL = "openai-codex/gpt-5.5";
const DELEGATE_PROMPT = `You are a delegated worker running in a fresh context.

Complete only the assigned task. Use tools as needed. Return a concise final report with the useful result, relevant files changed or inspected, and any caveats. Do not continue the parent conversation.`;

export const DEFAULT_DELEGATE_MODEL = {
	provider: "openai-codex",
	id: "gpt-5.5",
} as const;
export const DELEGATION_TOOL_DENYLIST = [
	TOOL_NAME,
	"subagent",
	"subagent_status",
] as const;

const DelegateParams = Type.Object({
	task: Type.String({
		description: "The task for the delegated child agent to perform.",
	}),
	effort: Type.Optional(
		StringEnum(["fast", "balanced", "smart"], {
			description:
				"Speed vs smartness tradeoff. fast=minimal thinking, balanced=medium, smart=high.",
			default: "balanced",
		}),
	),
});

type DelegateParams = Static<typeof DelegateParams>;
export type DelegateEffort = "fast" | "balanced" | "smart";
export type DelegateThinking = "minimal" | "medium" | "high";

export interface DelegateDetails {
	success: boolean;
	effort: DelegateEffort;
	requestedModel: string;
	model?: string;
	thinking: DelegateThinking;
	fallbackReason?: string;
	durationMs: number;
	toolCalls: number;
	failedToolCalls: number;
	timedOut: boolean;
	aborted: boolean;
	error?: string;
}

export function thinkingForEffort(effort: DelegateEffort): DelegateThinking {
	if (effort === "fast") return "minimal";
	if (effort === "smart") return "high";
	return "medium";
}

export function selectChildToolNames(
	tools: Pick<ToolInfo, "name">[],
): string[] {
	const deny = new Set<string>(DELEGATION_TOOL_DENYLIST);
	const selected: string[] = [];
	const seen = new Set<string>();

	for (const tool of tools) {
		if (deny.has(tool.name) || seen.has(tool.name)) continue;
		seen.add(tool.name);
		selected.push(tool.name);
	}

	return selected;
}

export function extractAssistantText(message: {
	role?: unknown;
	content?: unknown;
}): string {
	if (message.role !== "assistant") return "";
	const content = message.content;

	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			const maybeText = part as { type?: unknown; text?: unknown };
			if (maybeText.type !== "text" || typeof maybeText.text !== "string") {
				return [];
			}
			const text = maybeText.text.trim();
			return text ? [text] : [];
		})
		.join("\n");
}

function normalizeEffort(effort: DelegateParams["effort"]): DelegateEffort {
	if (effort === "fast" || effort === "balanced" || effort === "smart") {
		return effort;
	}
	return "balanced";
}

function modelName(
	model: { provider?: unknown; id?: unknown } | undefined,
): string | undefined {
	if (
		!model ||
		typeof model.provider !== "string" ||
		typeof model.id !== "string"
	) {
		return undefined;
	}
	return `${model.provider}/${model.id}`;
}

export function resolveDelegateModel(ctx: ExtensionContext): {
	model: ExtensionContext["model"];
	fallbackReason?: string;
} {
	const preferred = ctx.modelRegistry.find(
		DEFAULT_DELEGATE_MODEL.provider,
		DEFAULT_DELEGATE_MODEL.id,
	);
	if (preferred && ctx.modelRegistry.hasConfiguredAuth(preferred)) {
		return { model: preferred };
	}

	if (ctx.model) {
		return {
			model: ctx.model,
			fallbackReason: preferred
				? `${modelName(preferred)} has no configured auth; used parent model.`
				: `${REQUESTED_MODEL} was not found; used parent model.`,
		};
	}

	return {
		model: undefined,
		fallbackReason: preferred
			? `${modelName(preferred)} has no configured auth and no parent model was available.`
			: `${REQUESTED_MODEL} was not found and no parent model was available.`,
	};
}

export function buildFailureResult(
	reason: string,
	details: DelegateDetails,
): { content: [{ type: "text"; text: string }]; details: DelegateDetails } {
	return {
		content: [{ type: "text", text: `Delegated task failed: ${reason}` }],
		details,
	};
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

export default function delegateExtension(pi: ExtensionAPI) {
	pi.registerTool<typeof DelegateParams, DelegateDetails>({
		name: TOOL_NAME,
		label: "Delegate",
		description:
			"Delegate a task to a fresh child Pi agent so the main context receives only the final result. The child has normal Pi tools and can modify files; delegate write-capable tasks only when edits are intended.",
		promptSnippet:
			"Delegate isolated work to a fresh child agent and return only its concise result.",
		promptGuidelines: [
			"Use delegate for isolated investigation or implementation tasks whose intermediate context should not pollute the main conversation.",
			"Use delegate for write-capable tasks only when the user intent allows edits, because delegate child agents have normal Pi tools and may modify files.",
		],
		parameters: DelegateParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const effort = normalizeEffort(params.effort);
			const thinking = thinkingForEffort(effort);
			const startedAt = Date.now();
			const modelChoice = resolveDelegateModel(ctx);
			let toolCalls = 0;
			let failedToolCalls = 0;
			let lastAssistantText = "";
			let timedOut = false;
			let aborted = false;
			let child:
				| Awaited<ReturnType<typeof createAgentSession>>["session"]
				| undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let unsubscribe: (() => void) | undefined;
			let removeAbortListener: (() => void) | undefined;

			onUpdate?.({
				content: [{ type: "text", text: `Delegating (${effort})...` }],
				details: {
					success: false,
					effort,
					requestedModel: REQUESTED_MODEL,
					model: modelName(modelChoice.model),
					thinking,
					fallbackReason: modelChoice.fallbackReason,
					durationMs: 0,
					toolCalls: 0,
					failedToolCalls: 0,
					timedOut: false,
					aborted: false,
				},
			});

			const abortChild = async () => {
				if (!child?.isStreaming) return;
				try {
					await child.abort();
				} catch {
					// The caller receives the timeout/abort result below.
				}
			};

			try {
				const resourceLoader = new DefaultResourceLoader({
					cwd: ctx.cwd,
					agentDir: getAgentDir(),
					appendSystemPrompt: [DELEGATE_PROMPT],
				});

				await resourceLoader.reload();
				const result = await createAgentSession({
					cwd: ctx.cwd,
					agentDir: getAgentDir(),
					resourceLoader,
					sessionManager: SessionManager.inMemory(ctx.cwd),
					model: modelChoice.model,
					thinkingLevel: thinking,
				});
				child = result.session;
				child.setActiveToolsByName(selectChildToolNames(child.getAllTools()));

				unsubscribe = child.subscribe((event: AgentSessionEvent) => {
					if (event.type === "tool_execution_start") toolCalls++;
					if (event.type === "tool_execution_end" && event.isError) {
						failedToolCalls++;
					}
					if (event.type !== "message_end") return;
					const text = extractAssistantText(event.message);
					if (text) lastAssistantText = text;
				});

				const timeoutPromise = new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						void (async () => {
							timedOut = true;
							await abortChild();
							reject(new Error("Timed out after 15 minutes"));
						})();
					}, TIMEOUT_MS);
				});

				const abortPromise = new Promise<never>((_, reject) => {
					if (!signal) return;
					const onAbort = () => {
						void (async () => {
							aborted = true;
							await abortChild();
							reject(new Error("Delegation aborted"));
						})();
					};
					removeAbortListener = () =>
						signal.removeEventListener("abort", onAbort);
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				});

				await Promise.race([
					child.prompt(params.task, {
						expandPromptTemplates: false,
						source: "extension",
					}),
					timeoutPromise,
					abortPromise,
				]);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return buildFailureResult(message, {
					success: false,
					effort,
					requestedModel: REQUESTED_MODEL,
					model: modelName(child?.model ?? modelChoice.model),
					thinking,
					fallbackReason: modelChoice.fallbackReason,
					durationMs: Date.now() - startedAt,
					toolCalls,
					failedToolCalls,
					timedOut,
					aborted,
					error: message,
				});
			} finally {
				removeAbortListener?.();
				unsubscribe?.();
				if (timer) clearTimeout(timer);
				child?.dispose();
			}

			const details: DelegateDetails = {
				success: true,
				effort,
				requestedModel: REQUESTED_MODEL,
				model: modelName(child?.model ?? modelChoice.model),
				thinking,
				fallbackReason: modelChoice.fallbackReason,
				durationMs: Date.now() - startedAt,
				toolCalls,
				failedToolCalls,
				timedOut,
				aborted,
			};

			return {
				content: [
					{
						type: "text",
						text:
							lastAssistantText ||
							"Delegated task completed without a final text response.",
					},
				],
				details,
			};
		},
		renderCall(args, theme) {
			const effort = args.effort ?? "balanced";
			const preview = args.task?.trim();
			return new Text(
				theme.fg("toolTitle", theme.bold(`${TOOL_NAME} `)) +
					theme.fg("muted", `${effort}${preview ? ` • ${preview}` : ""}`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}
			if (!details.success) {
				return new Text(
					theme.fg(
						"warning",
						`failed • ${details.model ?? "unknown model"} • ${formatDuration(details.durationMs)}`,
					),
					0,
					0,
				);
			}
			return new Text(
				theme.fg(
					"success",
					`done • ${details.model ?? "unknown model"} • ${formatDuration(details.durationMs)} • ${details.toolCalls} tools`,
				),
				0,
				0,
			);
		},
	});
}
