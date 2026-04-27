import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Static, StringEnum, Type } from "@mariozechner/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	formatSize,
	getAgentDir,
	SessionManager,
	type ToolInfo,
	type TruncationResult,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const TOOL_NAME = "delegate";
const TIMEOUT_MS = 15 * 60 * 1000;
const REQUESTED_MODEL = "openai-codex/gpt-5.5";
const DELEGATE_PROMPT = `You are a delegated child Pi agent running in a fresh context for a parent agent.

Your contract:
- Complete only the assigned task. Do not continue the parent conversation.
- Treat the task as self-contained. Use repository/project instructions and tools as needed.
- Respect scope exactly. If the task says read-only, do not modify files. If edits are allowed, make focused changes only; do not commit, revert unrelated work, or touch unrelated files.
- Prefer evidence over assertion. Inspect before changing. Verify important claims with tests, typechecks, commands, or source references when practical.
- If blocked or uncertain, make the smallest reasonable investigation, then report the blocker clearly instead of guessing.
- Keep intermediate exploration out of the final answer.

Final response format:
- Result: concise answer or summary of completed work.
- Files inspected/changed: relevant paths only.
- Verification: commands run and outcomes, or "not run" with reason.
- Caveats/next steps: only if important.

Return only the final report.`;

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
		description:
			"Self-contained task for the delegated child agent. Include objective, relevant context/files, constraints, whether edits are allowed or read-only, expected output, and verification requirements.",
	}),
	effort: Type.Optional(
		StringEnum(["fast", "balanced", "smart"], {
			description:
				"Speed vs depth for the child agent. fast=quick reconnaissance/simple tasks, balanced=normal investigation or edits, smart=ambiguous/high-risk design, debugging, or review.",
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
	outputTruncated?: boolean;
	fullOutputFile?: string;
}

export interface DelegateOutput {
	text: string;
	truncation?: TruncationResult;
	fullOutputFile?: string;
}

export async function formatDelegateOutput(
	text: string,
): Promise<DelegateOutput> {
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return { text };

	let fullOutputFile: string | undefined;
	let fullOutputNotice = "Full output could not be saved.";
	try {
		fullOutputFile = join(
			tmpdir(),
			`pi-delegate-${process.pid}-${Date.now()}-${randomUUID()}.txt`,
		);
		await writeFile(fullOutputFile, text, "utf8");
		fullOutputNotice = `Full output saved to: ${fullOutputFile}`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fullOutputFile = undefined;
		fullOutputNotice = `Full output could not be saved: ${message}`;
	}

	const notice = `[Delegated output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${fullOutputNotice}]`;
	return {
		text: truncation.content ? `${truncation.content}\n\n${notice}` : notice,
		truncation,
		fullOutputFile,
	};
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
			"Run a fresh child Pi agent for subagent/delegated work. Use when you want an isolated worker for investigation, research, review, broad repo scanning, or a narrow implementation while keeping the parent context clean. The parent receives only the child’s final report. The child has normal Pi tools and may modify files; delegate write-capable tasks only when user intent permits edits.",
		promptSnippet:
			"Run an isolated child Pi agent for subagent/delegation work; returns only the child’s concise final result.",
		promptGuidelines: [
			"Use delegate whenever you want to invoke a subagent, spin off a delegated worker, or isolate exploration from the main conversation.",
			"Use delegate for broad repo scans, noisy investigation, library/API research, independent code review, plan critique, or narrow implementation tasks whose intermediate context should not pollute the parent context.",
			"Do not manually simulate a subagent in chat; if a separate worker would help, call delegate with a self-contained task.",
			"When calling delegate, include the objective, relevant context/files, constraints, whether edits are allowed, expected output, and verification requirements.",
			"Use delegate for write-capable tasks only when user intent allows edits; mark the task read-only for investigation, research, or review.",
			"Do not use delegate for trivial local edits or questions the parent can answer cheaply; delegation should buy isolation, parallel reasoning, or reduced context noise.",
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

			const output = await formatDelegateOutput(
				lastAssistantText ||
					"Delegated task completed without a final text response.",
			);
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
				outputTruncated: output.truncation?.truncated,
				fullOutputFile: output.fullOutputFile,
			};

			return {
				content: [
					{
						type: "text",
						text: output.text,
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
