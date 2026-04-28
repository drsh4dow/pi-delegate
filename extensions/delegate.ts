import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
	getMarkdownTheme,
	keyHint,
	SessionManager,
	type ToolInfo,
	type TruncationResult,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

const TOOL_NAME = "delegate";
const TIMEOUT_MS = 15 * 60 * 1000;
const COLLAPSED_PREVIEW_LINES = 4;
const COLLAPSED_PREVIEW_CHARS = 360;
const REQUESTED_MODEL = "openai-codex/gpt-5.5";
export const CHILD_EXTENSION_PATHS_ENV = "PI_CHILD_EXTENSION_PATHS";
const DELEGATE_DECISION_PROMPT = `Delegation decision policy:
- If delegate is available and the user asks for broad repo scanning, noisy investigation, current library/API research, independent code review, plan critique, or non-trivial code changes with verification, call delegate once early before doing direct exploration or edits.
- Choose effort explicitly: fast for scouting/recon/repo mapping/docs/API lookup, smart for review/critique/debugging/ambiguous or high-risk design, balanced for ordinary focused implementation or moderate investigation.
- Ask for handoff-ready output: concise result, evidence, inspected/changed files, verification, and caveats/next steps only when useful.
- Do not delegate trivial fact lookups, obvious typo/format/text-only edits, or work the parent can finish with one or two cheap local tool calls.
- For read-only work, pass read-only constraints to delegate. For write-capable work, delegate only when the user's request allows edits.`;

const DELEGATE_PROMPT = `You are a delegated child Pi agent running in a fresh context for a parent agent.

Your contract:
- Complete only the assigned task. Do not continue the parent conversation.
- Treat the task as self-contained. Use repository/project instructions and tools as needed.
- Respect scope exactly. If the task says read-only, do not modify files. If edits are allowed, make focused changes only; do not commit, revert unrelated work, or touch unrelated files.
- Prefer evidence over assertion. Inspect before changing. Verify important claims with tests, typechecks, commands, or source references when practical.
- If blocked or uncertain, make the smallest reasonable investigation, then report the blocker clearly instead of guessing.
- Keep intermediate exploration out of the final answer.

Final response format:
- Task: one-line restatement of the assigned task.
- Result: concise answer or summary of completed work.
- Evidence: concise bullets with files, symbols, commands, outcomes, or source URLs when they support the result.
- Files inspected/changed: relevant paths only.
- Verification: commands run and outcomes, or "not run" with reason.
- Parent handoff: only if the parent must decide, continue, or handle risk.
- Caveats/next steps: only if important.

Task-specific guidance:
- Scout/recon tasks: report map, inspected files, important risks, and where to look next.
- Research/docs tasks: include current facts and concise citations/URLs for online or documentation sources.
- Review tasks: prioritize findings with severity, evidence, and concrete remediation direction.
- Implementation tasks: emphasize changed behavior, changed files, and validation instead of implementation narration.

Use the shortest useful report. Prefer 10-25 lines; up to about 50 lines is fine when the task genuinely needs richer research/review detail. Return only the final report.`;

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
			"Self-contained task for the delegated child agent. Include objective, relevant context/files, constraints, whether edits are allowed or read-only, expected output, verification requirements, and a request for handoff-ready output.",
	}),
	effort: Type.Optional(
		StringEnum(["fast", "balanced", "smart"], {
			description:
				"Speed vs depth for the child agent. Choose explicitly: fast=scouting/recon/repo mapping/docs/API lookup, smart=review/critique/debugging/ambiguous or high-risk design, balanced=ordinary focused implementation or moderate investigation. Omitted effort falls back to balanced.",
			default: "balanced",
		}),
	),
});

type DelegateParams = Static<typeof DelegateParams>;
export type DelegateEffort = "fast" | "balanced" | "smart";
export type DelegateThinking = "minimal" | "medium" | "high";

export interface DelegateUsageStats {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface DelegateDetails {
	success: boolean;
	assignedTask: string;
	effort: DelegateEffort;
	requestedModel: string;
	model?: string;
	thinking: DelegateThinking;
	fallbackReason?: string;
	durationMs: number;
	toolCalls: number;
	failedToolCalls: number;
	childUsage: DelegateUsageStats;
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

export function childExtensionPaths(
	env: Record<string, string | undefined> = process.env,
): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const raw of (env[CHILD_EXTENSION_PATHS_ENV] ?? "").split(delimiter)) {
		const path = raw.trim();
		if (!path || seen.has(path)) continue;
		seen.add(path);
		paths.push(path);
	}
	return paths;
}

function emptyUsageStats(): DelegateUsageStats {
	return {
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
}

function copyUsageStats(stats: DelegateUsageStats): DelegateUsageStats {
	return { ...stats };
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatCompactUsage(stats: DelegateUsageStats): string {
	const parts: string[] = [];
	if (stats.input > 0) parts.push(`↑${formatTokens(stats.input)}`);
	if (stats.output > 0) parts.push(`↓${formatTokens(stats.output)}`);
	if (stats.cost > 0) parts.push(`$${stats.cost.toFixed(4)}`);
	return parts.join(" ");
}

function formatDetailedUsage(stats: DelegateUsageStats): string {
	const parts: string[] = [];
	if (stats.turns > 0) {
		parts.push(`${stats.turns} ${stats.turns === 1 ? "turn" : "turns"}`);
	}
	if (stats.input > 0) parts.push(`↑${formatTokens(stats.input)}`);
	if (stats.output > 0) parts.push(`↓${formatTokens(stats.output)}`);
	if (stats.cacheRead > 0) parts.push(`R${formatTokens(stats.cacheRead)}`);
	if (stats.cacheWrite > 0) parts.push(`W${formatTokens(stats.cacheWrite)}`);
	if (stats.totalTokens > 0)
		parts.push(`total ${formatTokens(stats.totalTokens)}`);
	if (stats.cost > 0) parts.push(`$${stats.cost.toFixed(4)}`);
	return parts.join(" ");
}

function shortModelName(name: string | undefined): string {
	if (!name) return "unknown model";
	const slash = name.lastIndexOf("/");
	return slash === -1 ? name : name.slice(slash + 1);
}

function toolCountText(count: number): string {
	return `${count} ${count === 1 ? "tool" : "tools"}`;
}

function formatStatusParts(details: DelegateDetails): string {
	let text = `${shortModelName(details.model)}${details.fallbackReason ? " (fallback)" : ""} • ${formatDuration(details.durationMs)} • ${toolCountText(details.toolCalls)}`;
	if (details.failedToolCalls > 0) {
		text += ` • ${details.failedToolCalls} failed`;
	}
	return text;
}

function formatCollapsedPreview(text: string): {
	text: string;
	truncated: boolean;
	hiddenLines: number;
} {
	const lines = text
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	if (lines.length === 0) {
		return { text: "", truncated: false, hiddenLines: 0 };
	}

	const hiddenLines = Math.max(0, lines.length - COLLAPSED_PREVIEW_LINES);
	let truncated = hiddenLines > 0;
	let preview = lines.slice(0, COLLAPSED_PREVIEW_LINES).join("\n");
	if (preview.length > COLLAPSED_PREVIEW_CHARS) {
		preview = preview.slice(0, COLLAPSED_PREVIEW_CHARS - 1).trimEnd();
		truncated = true;
	}
	return { text: preview, truncated, hiddenLines };
}

export default function delegateExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		if (!event.systemPromptOptions.selectedTools?.includes(TOOL_NAME)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${DELEGATE_DECISION_PROMPT}`,
		};
	});

	pi.registerTool<typeof DelegateParams, DelegateDetails>({
		name: TOOL_NAME,
		label: "Delegate",
		description:
			"Run a fresh child Pi agent for subagent/delegated work. Use delegate as required policy for non-trivial investigation, research, review, broad repo scanning, plan critique, or focused implementation when isolation would keep the parent context clean. The parent receives only the child’s final report. The child has normal Pi tools and may modify files; delegate write-capable tasks only when user intent permits edits.",
		promptSnippet:
			"MUST use for broad/noisy/research/review/plan work and non-trivial code fixes with tests; delegates to an isolated child Pi agent and returns only the child’s final result.",
		promptGuidelines: [
			"Delegate policy: for broad repo scanning, noisy investigation, current library/API research, independent code review, plan critique, non-trivial code modification, or focused implementation with verification, call delegate exactly once early unless the user forbids delegation; this policy applies even when the repo or task looks small.",
			"For prompts asking to research, investigate, review, critique, map, or fix failing behavior with tests, call delegate before doing your own read/find/bash/web research; do not implement these tasks directly unless they are explicitly a trivial typo/single-line edit.",
			"Use delegate as the required way to invoke a subagent or delegated worker; do not manually simulate a subagent in chat.",
			"When calling delegate, include the objective, relevant context/files, constraints, whether edits are allowed, expected output, verification requirements, a request for handoff-ready output, and an explicit effort.",
			"When calling delegate, choose effort explicitly: fast for scouting/recon/repo mapping/docs/API lookup; smart for review/critique/debugging/ambiguous or high-risk design; balanced for ordinary focused implementation or moderate investigation.",
			"Use delegate for write-capable tasks only when user intent allows edits; mark investigation, research, review, and critique tasks read-only.",
			"Do not use delegate for trivial fact lookups, obvious typo/format/text-only edits, or questions the parent can answer with one or two cheap local tool calls; failing tests and behavior bugs are not trivial edits.",
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
			const childUsage = emptyUsageStats();
			let lastAssistantText = "";
			let timedOut = false;
			let aborted = false;
			let child:
				| Awaited<ReturnType<typeof createAgentSession>>["session"]
				| undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let unsubscribe: (() => void) | undefined;
			let removeAbortListener: (() => void) | undefined;

			const currentDetails = (): DelegateDetails => ({
				success: false,
				assignedTask: params.task,
				effort,
				requestedModel: REQUESTED_MODEL,
				model: modelName(child?.model ?? modelChoice.model),
				thinking,
				fallbackReason: modelChoice.fallbackReason,
				durationMs: Date.now() - startedAt,
				toolCalls,
				failedToolCalls,
				childUsage: copyUsageStats(childUsage),
				timedOut,
				aborted,
			});

			const updateProgress = () => {
				onUpdate?.({
					content: [{ type: "text", text: `Delegating (${effort})...` }],
					details: currentDetails(),
				});
			};

			updateProgress();

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
					additionalExtensionPaths: childExtensionPaths(),
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
					if (event.type === "tool_execution_start") {
						toolCalls++;
						updateProgress();
					}
					if (event.type === "tool_execution_end") {
						if (event.isError) failedToolCalls++;
						updateProgress();
					}
					if (event.type !== "message_end") return;
					const text = extractAssistantText(event.message);
					if (text) lastAssistantText = text;
					if (event.message.role !== "assistant") return;
					const usage = event.message.usage as
						| {
								input?: number;
								output?: number;
								cacheRead?: number;
								cacheWrite?: number;
								totalTokens?: number;
								cost?: { total?: number };
						  }
						| undefined;
					childUsage.turns++;
					childUsage.input += usage?.input ?? 0;
					childUsage.output += usage?.output ?? 0;
					childUsage.cacheRead += usage?.cacheRead ?? 0;
					childUsage.cacheWrite += usage?.cacheWrite ?? 0;
					childUsage.totalTokens += usage?.totalTokens ?? 0;
					childUsage.cost += usage?.cost?.total ?? 0;
				});

				const timeoutPromise = new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						timedOut = true;
						void abortChild();
						reject(new Error("Timed out after 15 minutes"));
					}, TIMEOUT_MS);
				});

				const abortPromise = new Promise<never>((_, reject) => {
					if (!signal) return;
					const onAbort = () => {
						aborted = true;
						void abortChild();
						reject(new Error("Delegation aborted"));
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
				const details = { ...currentDetails(), error: message };
				let failure = `Delegated task failed: ${message} (${formatStatusParts(details)}`;
				if (timedOut) failure += " • timed out";
				if (aborted) failure += " • aborted";
				failure += ")";
				throw new Error(failure);
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
				assignedTask: params.task,
				effort,
				requestedModel: REQUESTED_MODEL,
				model: modelName(child?.model ?? modelChoice.model),
				thinking,
				fallbackReason: modelChoice.fallbackReason,
				durationMs: Date.now() - startedAt,
				toolCalls,
				failedToolCalls,
				childUsage: copyUsageStats(childUsage),
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
		renderCall(args, theme, _context) {
			const effort = args.effort ?? "balanced";
			return new Text(
				theme.fg("toolTitle", theme.bold(TOOL_NAME)) +
					theme.fg("muted", " • ") +
					theme.fg("accent", effort),
				0,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			const details = result.details;
			const renderStatus = (
				label: "running" | "done",
				color: "muted" | "success",
				delegateDetails: DelegateDetails,
				includeUsage: boolean,
			) => {
				let text =
					theme.fg(color, label) +
					theme.fg("muted", " • ") +
					theme.fg("accent", formatStatusParts(delegateDetails));
				const usage = includeUsage
					? formatCompactUsage(delegateDetails.childUsage)
					: "";
				if (usage) text += theme.fg("dim", ` • ${usage}`);
				if (delegateDetails.outputTruncated) {
					text += theme.fg("warning", " • truncated");
				}
				return text;
			};
			const renderAssignedTask = (task: string, expanded: boolean) => {
				const cleanTask = task.trimEnd();
				const lines = cleanTask
					.split(/\r?\n/)
					.map((line) => line.trimEnd())
					.filter((line) => line.trim().length > 0);
				if (!cleanTask || lines.length === 0) return undefined;

				const hiddenLines = Math.max(0, lines.length - COLLAPSED_PREVIEW_LINES);
				const body = expanded
					? cleanTask
					: lines.slice(0, COLLAPSED_PREVIEW_LINES).join("\n");
				const box = new Box(1, 0);
				box.addChild(
					new Text(theme.fg("muted", "─── assigned task ───"), 0, 0),
				);
				box.addChild(new Text(theme.fg("toolOutput", body), 0, 0));

				const expandHint = keyHint("app.tools.expand", "expand assigned task");
				const hint = expanded
					? keyHint("app.tools.expand", "collapse assigned task")
					: hiddenLines > 0
						? `${theme.fg(
								"warning",
								`… ${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"} hidden`,
							)} • ${expandHint}`
						: `${theme.fg("dim", "compact task")} • ${expandHint}`;
				box.addChild(new Text(hint, 0, 0));
				return box;
			};

			if (details?.success === false && options.isPartial) {
				const container = new Container();
				container.addChild(
					new Text(renderStatus("running", "muted", details, true), 0, 0),
				);
				const task = renderAssignedTask(
					details.assignedTask ?? "",
					options.expanded,
				);
				if (task) container.addChild(task);
				return container;
			}
			if (details?.success === true) {
				const line = renderStatus("done", "success", details, true);
				const content = result.content[0];
				const output = content?.type === "text" ? content.text : "";
				if (!options.expanded) {
					const preview = formatCollapsedPreview(output);
					const container = new Container();
					container.addChild(new Text(line, 0, 0));
					const task = renderAssignedTask(details.assignedTask ?? "", false);
					if (task) container.addChild(task);
					if (!preview.text) return container;
					container.addChild(
						new Text(theme.fg("muted", "─── child report preview ───"), 0, 0),
					);
					container.addChild(
						new Text(theme.fg("toolOutput", preview.text), 0, 0),
					);
					const previewHint = preview.truncated
						? preview.hiddenLines > 0
							? `… ${preview.hiddenLines} more ${preview.hiddenLines === 1 ? "line" : "lines"} hidden • preview truncated`
							: "preview truncated"
						: "compact preview";
					container.addChild(
						new Text(
							theme.fg(preview.truncated ? "warning" : "dim", previewHint) +
								` • ${keyHint("app.tools.expand", "expand child report")}`,
							0,
							0,
						),
					);
					return container;
				}

				const detailedUsage = formatDetailedUsage(details.childUsage);
				const container = new Container();
				container.addChild(new Text(line, 0, 0));
				container.addChild(
					new Text(keyHint("app.tools.expand", "collapse child report"), 0, 0),
				);
				const task = renderAssignedTask(details.assignedTask ?? "", true);
				if (task) container.addChild(task);
				if (detailedUsage) {
					container.addChild(
						new Text(theme.fg("dim", `usage • ${detailedUsage}`), 0, 0),
					);
				}
				if (details.fallbackReason) {
					container.addChild(
						new Text(
							theme.fg("warning", `fallback • ${details.fallbackReason}`),
							0,
							0,
						),
					);
				}
				if (details.outputTruncated) {
					const saved = details.fullOutputFile
						? ` • full output: ${details.fullOutputFile}`
						: "";
					container.addChild(
						new Text(theme.fg("warning", `output truncated${saved}`), 0, 0),
					);
				}
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(theme.fg("muted", "─── child report ───"), 0, 0),
				);
				if (output.trim()) {
					container.addChild(
						new Markdown(output.trim(), 0, 0, getMarkdownTheme()),
					);
				} else {
					container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
				}
				return container;
			}

			const content = result.content[0];
			const text = content?.type === "text" ? content.text : "";
			if (context.isError) {
				return new Text(theme.fg("error", `failed • ${text}`), 0, 0);
			}
			return new Text(text, 0, 0);
		},
	});
}
