import { describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { delimiter } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	initTheme,
} from "@mariozechner/pi-coding-agent";
import delegateExtension, {
	CHILD_EXTENSION_PATHS_ENV,
	childExtensionPaths,
	DEFAULT_DELEGATE_MODEL,
	DELEGATION_TOOL_DENYLIST,
	type DelegateDetails,
	extractAssistantText,
	formatDelegateOutput,
	resolveDelegateModel,
	selectChildToolNames,
	thinkingForEffort,
} from "./extensions/delegate.ts";

type DelegateTool = Parameters<ExtensionAPI["registerTool"]>[0];

function getTool(): DelegateTool {
	let tool: unknown;

	delegateExtension({
		on: () => {},
		registerTool(definition: DelegateTool) {
			tool = definition;
		},
	} as unknown as ExtensionAPI);

	if (!tool) {
		throw new Error("delegate tool was not registered");
	}

	return tool as DelegateTool;
}

function getRegisteredEvents(): string[] {
	const events: string[] = [];
	delegateExtension({
		on(event: string) {
			events.push(event);
		},
		registerTool: () => {},
	} as unknown as ExtensionAPI);
	return events;
}

function fakeContext(input: {
	preferred?: ExtensionContext["model"];
	preferredHasAuth?: boolean;
	parent?: ExtensionContext["model"];
}): ExtensionContext {
	return {
		model: input.parent,
		modelRegistry: {
			find: () => input.preferred,
			hasConfiguredAuth: () => input.preferredHasAuth === true,
		},
	} as unknown as ExtensionContext;
}

function fakeTheme(): Parameters<NonNullable<DelegateTool["renderCall"]>>[1] {
	initTheme(undefined, false);
	return {
		fg: (_name: string, text: string) => text,
		bold: (text: string) => text,
	} as Parameters<NonNullable<DelegateTool["renderCall"]>>[1];
}

function renderText(component: { render(width: number): string[] }): string {
	return component.render(120).join("\n");
}

describe("delegate extension", () => {
	test("registers a small sequential delegate tool", () => {
		const tool = getTool();
		const parameters = tool.parameters as unknown as {
			properties: {
				task?: { description?: string };
				effort?: { default?: string; description?: string };
			};
			required?: string[];
		};
		const promptGuidelines = tool.promptGuidelines ?? [];

		expect(tool.name).toBe("delegate");
		expect(tool.label).toBe("Delegate");
		expect(tool.executionMode).toBe("sequential");
		expect(tool.description).toContain("isolated");
		expect(tool.description).toContain("required policy");
		expect(tool.description).toContain("final report");
		expect(tool.description).toContain("may modify files");
		expect(tool.promptSnippet).toContain("Required once early");
		expect(tool.promptSnippet).toContain("isolated child Pi final report");
		expect(promptGuidelines).toHaveLength(4);
		const joinedGuidelines = promptGuidelines.join("\n");
		for (const guideline of promptGuidelines) {
			expect(guideline).toContain("delegate");
		}
		expect(joinedGuidelines).toContain("broad repo scanning");
		expect(joinedGuidelines).toContain("current library/API research");
		expect(joinedGuidelines).toContain("non-trivial implementation");
		expect(joinedGuidelines).toContain("noisy/root-cause investigation");
		expect(joinedGuidelines).toContain("call delegate once early");
		expect(joinedGuidelines).toContain("trivial fact lookups");
		expect(joinedGuidelines).toContain("obvious typo/format/text-only edits");
		expect(joinedGuidelines).toContain("self-contained delegate task");
		expect(joinedGuidelines).toContain("constraints");
		expect(joinedGuidelines).toContain("verification");
		expect(joinedGuidelines).toContain("choose effort explicitly");
		expect(joinedGuidelines).toContain("fast only for read-only scouting");
		expect(joinedGuidelines).toContain("docs/API lookup");
		expect(joinedGuidelines).toContain("smart for any review or critique");
		expect(joinedGuidelines).toContain("ambiguous or high-risk design");
		expect(joinedGuidelines).toContain("fixing failing tests/behavior");
		expect(parameters.properties.task?.description).toContain(
			"Self-contained task",
		);
		expect(parameters.properties.task?.description).toContain("read-only");
		expect(parameters.properties.task?.description).toContain("verification");
		expect(parameters.properties.task?.description).toContain("handoff-ready");
		expect(parameters.properties.effort?.description).toContain(
			"read-only scouting",
		);
		expect(parameters.properties.effort?.description).toContain(
			"docs/API lookup",
		);
		expect(parameters.properties.effort?.description).toContain("review");
		expect(parameters.properties.effort?.description).toContain(
			"noisy/root-cause investigation",
		);
		expect(parameters.properties.effort?.description).toContain("debugging");
		expect(parameters.properties.effort?.description).toContain(
			"fixing failing tests/behavior",
		);
		expect(parameters.properties.effort?.default).toBe("balanced");
		expect(parameters.required).toEqual(["task"]);
		expect(Object.keys(parameters.properties).sort()).toEqual([
			"effort",
			"task",
		]);
	});

	test("keeps parent delegation guidance tool-owned", () => {
		expect(getRegisteredEvents()).not.toContain("before_agent_start");
	});

	test("child prompt defines the delegated worker contract", async () => {
		const source = await Bun.file("extensions/delegate.ts").text();

		expect(source).toContain("Parent called you as a bounded tool");
		expect(source).toContain("If the task is read-only, do not write files");
		expect(source).toContain("Evidence before claims");
		expect(source).toContain("Verify important claims when practical");
		expect(source).toContain("Final report:");
		expect(source).toContain("Task: one-line assigned task");
		expect(source).toContain("Evidence: bullets");
		expect(source).toContain("Scout/research/review");
		expect(source).toContain("Return only the final report");
	});

	test("package metadata follows Pi package distribution conventions", async () => {
		const pkg = (await Bun.file("package.json").json()) as {
			private?: boolean;
			exports?: string;
			files?: string[];
			pi?: { extensions?: string[] };
			peerDependencies?: Record<string, string>;
		};

		expect(pkg.private).toBeUndefined();
		expect(pkg.exports).toBe("./index.ts");
		expect(pkg.pi?.extensions).toEqual(["./extensions/delegate.ts"]);
		expect(pkg.files).toEqual(["extensions", "index.ts", "README.md"]);
		expect(pkg.peerDependencies).toEqual({
			"@mariozechner/pi-ai": "*",
			"@mariozechner/pi-coding-agent": "*",
			"@mariozechner/pi-tui": "*",
		});
	});

	test("maps effort to gpt-5.5 thinking levels", () => {
		expect(DEFAULT_DELEGATE_MODEL).toEqual({
			provider: "openai-codex",
			id: "gpt-5.5",
		});
		expect(thinkingForEffort("fast")).toBe("minimal");
		expect(thinkingForEffort("balanced")).toBe("medium");
		expect(thinkingForEffort("smart")).toBe("high");
	});

	test("uses preferred gpt-5.5 model when it has auth", () => {
		const preferred = {
			provider: "openai-codex",
			id: "gpt-5.5",
		} as ExtensionContext["model"];
		const parent = {
			provider: "anthropic",
			id: "claude-sonnet-4-5",
		} as ExtensionContext["model"];

		expect(
			resolveDelegateModel(
				fakeContext({ preferred, preferredHasAuth: true, parent }),
			),
		).toEqual({ model: preferred });
	});

	test("falls back to parent model when preferred model lacks auth", () => {
		const preferred = {
			provider: "openai-codex",
			id: "gpt-5.5",
		} as ExtensionContext["model"];
		const parent = {
			provider: "anthropic",
			id: "claude-sonnet-4-5",
		} as ExtensionContext["model"];

		const choice = resolveDelegateModel(
			fakeContext({ preferred, preferredHasAuth: false, parent }),
		);

		expect(choice.model).toBe(parent);
		expect(choice.fallbackReason).toContain("no configured auth");
	});

	test("reads inherited child extension paths from the environment", () => {
		expect(
			childExtensionPaths({
				[CHILD_EXTENSION_PATHS_ENV]: `/tmp/a${delimiter}/tmp/b${delimiter}/tmp/a${delimiter}  `,
			}),
		).toEqual(["/tmp/a", "/tmp/b"]);
	});

	test("filters recursive delegation tools from child tools", () => {
		expect(DELEGATION_TOOL_DENYLIST).toContain("delegate");
		expect(
			selectChildToolNames([
				{ name: "read" },
				{ name: "delegate" },
				{ name: "web_search" },
				{ name: "subagent" },
				{ name: "subagent_status" },
				{ name: "read" },
			]),
		).toEqual(["read", "web_search"]);
	});

	test("extracts text from final assistant messages without tool calls", () => {
		expect(
			extractAssistantText({
				role: "assistant",
				content: [
					{ type: "text", text: "First" },
					{ type: "toolCall", toolName: "read" },
					{ type: "text", text: "Second" },
				],
			}),
		).toBe("First\nSecond");
	});

	test("ignores non-assistant messages while extracting assistant text", () => {
		expect(
			extractAssistantText({
				role: "user",
				content: [{ type: "text", text: "Nope" }],
			}),
		).toBe("");
	});

	test("renders running delegate calls without a false failed state", () => {
		const tool = getTool();
		const details: DelegateDetails = {
			success: false,
			assignedTask: "Inspect this repo.\nDo not modify files.",
			effort: "balanced",
			requestedModel: "openai-codex/gpt-5.5",
			model: "openai-codex/gpt-5.5",
			thinking: "medium",
			durationMs: 123,
			toolCalls: 2,
			failedToolCalls: 1,
			childUsage: {
				turns: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: 0,
			},
			timedOut: false,
			aborted: false,
		};

		const text = renderText(
			tool.renderResult?.(
				{ content: [], details },
				{ expanded: false, isPartial: true },
				fakeTheme(),
				{ isError: false } as Parameters<
					NonNullable<DelegateTool["renderResult"]>
				>[3],
			) ?? { render: () => [] },
		);

		expect(text).toContain("running • gpt-5.5 • 123ms • 2 tools");
		expect(text).toContain("1 failed");
		expect(text).toContain("assigned task");
		expect(text).toContain("Inspect this repo.");
		expect(text).toContain("Do not modify files.");
		expect(text).not.toContain("failed •");
	});

	test("renders assigned tasks as a bounded collapsed card and full expanded card", () => {
		const tool = getTool();
		const details: DelegateDetails = {
			success: false,
			assignedTask: [
				"Line one objective",
				"Line two context",
				"Line three constraints",
				"Line four verification",
				"Line five hidden",
				"Line six hidden",
			].join("\n"),
			effort: "smart",
			requestedModel: "openai-codex/gpt-5.5",
			model: "openai-codex/gpt-5.5",
			thinking: "high",
			durationMs: 5000,
			toolCalls: 0,
			failedToolCalls: 0,
			childUsage: {
				turns: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: 0,
			},
			timedOut: false,
			aborted: false,
		};

		const collapsed = renderText(
			tool.renderResult?.(
				{ content: [], details },
				{ expanded: false, isPartial: true },
				fakeTheme(),
				{ isError: false } as Parameters<
					NonNullable<DelegateTool["renderResult"]>
				>[3],
			) ?? { render: () => [] },
		);
		const expanded = renderText(
			tool.renderResult?.(
				{ content: [], details },
				{ expanded: true, isPartial: true },
				fakeTheme(),
				{ isError: false } as Parameters<
					NonNullable<DelegateTool["renderResult"]>
				>[3],
			) ?? { render: () => [] },
		);

		expect(collapsed).toContain("assigned task");
		expect(collapsed).toContain("Line one objective");
		expect(collapsed).toContain("Line four verification");
		expect(collapsed).toContain("… 2 more lines hidden");
		expect(collapsed).toContain("expand assigned task");
		expect(collapsed).not.toContain("Line five hidden");
		expect(expanded).toContain("assigned task");
		expect(expanded).toContain("Line six hidden");
		expect(expanded).toContain("collapse assigned task");
	});

	test("renders completed delegate results with a small collapsed report preview", () => {
		const tool = getTool();
		const details: DelegateDetails = {
			success: true,
			assignedTask: "Inspect this repo.\nDo not modify files.",
			effort: "balanced",
			requestedModel: "openai-codex/gpt-5.5",
			model: "openai-codex/gpt-5.5",
			thinking: "medium",
			durationMs: 1234,
			toolCalls: 3,
			failedToolCalls: 0,
			childUsage: {
				turns: 2,
				input: 1500,
				output: 750,
				cacheRead: 120,
				cacheWrite: 50,
				totalTokens: 2420,
				cost: 0.033,
			},
			timedOut: false,
			aborted: false,
		};

		const text = renderText(
			tool.renderResult?.(
				{
					content: [
						{ type: "text", text: "# Child report\n\nThis is now visible." },
					],
					details,
				},
				{ expanded: false, isPartial: false },
				fakeTheme(),
				{ isError: false } as Parameters<
					NonNullable<DelegateTool["renderResult"]>
				>[3],
			) ?? { render: () => [] },
		);

		expect(text).toContain("assigned task");
		expect(text).toContain("Inspect this repo.");
		expect(text).toContain("Do not modify files.");
		expect(text).toContain("done • gpt-5.5 • 1.2s • 3 tools");
		expect(text).toContain("↑1.5k ↓750 $0.0330");
		expect(text).toContain("child report preview");
		expect(text).toContain("# Child report");
		expect(text).toContain("This is now visible");
		expect(text).toContain("compact preview •");
		expect(text).toContain("expand child report");
	});

	test("bounds long collapsed delegate report previews", () => {
		const tool = getTool();
		const details: DelegateDetails = {
			success: true,
			assignedTask: "Inspect this repo.\nDo not modify files.",
			effort: "fast",
			requestedModel: "openai-codex/gpt-5.5",
			model: "openai-codex/gpt-5.5",
			thinking: "minimal",
			durationMs: 1234,
			toolCalls: 1,
			failedToolCalls: 0,
			childUsage: {
				turns: 1,
				input: 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: 0,
			},
			timedOut: false,
			aborted: false,
		};

		const text = renderText(
			tool.renderResult?.(
				{
					content: [
						{
							type: "text",
							text: [
								"line one",
								"line two",
								"line three",
								"line four",
								"line five should not render",
							].join("\n"),
						},
					],
					details,
				},
				{ expanded: false, isPartial: false },
				fakeTheme(),
				{ isError: false } as Parameters<
					NonNullable<DelegateTool["renderResult"]>
				>[3],
			) ?? { render: () => [] },
		);

		expect(text).toContain("line one");
		expect(text).toContain("line four");
		expect(text).toContain("… 1 more line");
		expect(text).toContain("preview truncated");
		expect(text).toContain("expand child report");
		expect(text).not.toContain("line five should not render");
		expect(text.split("\n").length).toBeLessThanOrEqual(12);
	});

	test("renders empty completed delegate results without a fake preview", () => {
		const tool = getTool();
		const details: DelegateDetails = {
			success: true,
			assignedTask: "Inspect this repo.\nDo not modify files.",
			effort: "balanced",
			requestedModel: "openai-codex/gpt-5.5",
			model: "openai-codex/gpt-5.5",
			thinking: "medium",
			durationMs: 1234,
			toolCalls: 0,
			failedToolCalls: 0,
			childUsage: {
				turns: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: 0,
			},
			timedOut: false,
			aborted: false,
		};

		const text = renderText(
			tool.renderResult?.(
				{ content: [{ type: "text", text: "   \n\n" }], details },
				{ expanded: false, isPartial: false },
				fakeTheme(),
				{ isError: false } as Parameters<
					NonNullable<DelegateTool["renderResult"]>
				>[3],
			) ?? { render: () => [] },
		);

		expect(text).toContain("done • gpt-5.5 • 1.2s • 0 tools");
		expect(text).not.toContain("child report preview");
	});

	test("renders expanded delegate results with full report and detailed usage", () => {
		initTheme(undefined, false);
		const tool = getTool();
		const details: DelegateDetails = {
			success: true,
			assignedTask: "Inspect this repo.\nDo not modify files.",
			effort: "smart",
			requestedModel: "openai-codex/gpt-5.5",
			model: "openai-codex/gpt-5.5",
			thinking: "high",
			durationMs: 65000,
			toolCalls: 4,
			failedToolCalls: 1,
			childUsage: {
				turns: 2,
				input: 1500,
				output: 750,
				cacheRead: 120,
				cacheWrite: 50,
				totalTokens: 2420,
				cost: 0.033,
			},
			timedOut: false,
			aborted: false,
			outputTruncated: true,
			fullOutputFile: "/tmp/full-output.txt",
		};

		const text = renderText(
			tool.renderResult?.(
				{
					content: [
						{
							type: "text",
							text: "# Child report\n\nFull expanded report.",
						},
					],
					details,
				},
				{ expanded: true, isPartial: false },
				fakeTheme(),
				{ isError: false } as Parameters<
					NonNullable<DelegateTool["renderResult"]>
				>[3],
			) ?? { render: () => [] },
		);

		expect(text).toContain("done • gpt-5.5 • 1m5s • 4 tools");
		expect(text).toContain("1 failed");
		expect(text).toContain("2 turns ↑1.5k ↓750 R120 W50 total 2.4k $0.0330");
		expect(text).toContain("output truncated");
		expect(text).toContain("/tmp/full-output.txt");
		expect(text).toContain("collapse child report");
		expect(text).toContain("assigned task");
		expect(text).toContain("Inspect this repo.");
		expect(text).toContain("Do not modify files.");
		expect(text).toContain("Child report");
		expect(text).toContain("Full expanded report.");
	});

	test("renders delegate call headers without inline task truncation", () => {
		const tool = getTool();
		const text = renderText(
			tool.renderCall?.(
				{
					effort: "smart",
					task: `${"Inspect this very noisy delegated task ".repeat(6)}\nDo not show this second line`,
				},
				fakeTheme(),
				{} as Parameters<NonNullable<DelegateTool["renderCall"]>>[2],
			) ?? { render: () => [] },
		);

		expect(text.trimEnd()).toBe("delegate • smart");
		expect(text).not.toContain("task:");
		expect(text).not.toContain("Inspect this very noisy");
		expect(text).not.toContain("…");
	});

	test("truncates delegated final output and stores the full text", async () => {
		const output = await formatDelegateOutput("line\n".repeat(3000));

		expect(output.truncation?.truncated).toBe(true);
		expect(output.fullOutputFile).toBeString();
		expect(output.text).toContain("Delegated output truncated");
		expect(output.text).toContain(output.fullOutputFile ?? "missing-file");
		const fullOutputFile = output.fullOutputFile;
		if (!fullOutputFile) throw new Error("expected full output file");
		expect(await Bun.file(fullOutputFile).text()).toBe("line\n".repeat(3000));
		await unlink(fullOutputFile);
	});

	test("executes a child session, filters recursive tools, returns final text, and throws native failures", async () => {
		let activeTools: string[] = [];
		let disposeCount = 0;
		let reloaded = false;
		let promptText = "";
		let resourceLoaderOptions:
			| { additionalExtensionPaths?: string[] }
			| undefined;
		const updates: DelegateDetails[] = [];
		type FakeAgentEvent = {
			type: string;
			toolName?: string;
			isError?: boolean;
			message?: {
				role: string;
				content: Array<{ type: string; text: string }>;
				usage?: unknown;
			};
		};
		let listener: ((event: FakeAgentEvent) => void) | undefined;

		mock.module("@mariozechner/pi-coding-agent", () => ({
			DefaultResourceLoader: class {
				constructor(options: { additionalExtensionPaths?: string[] }) {
					resourceLoaderOptions = options;
				}

				async reload() {
					reloaded = true;
				}
			},
			SessionManager: {
				inMemory: () => ({ kind: "memory-session" }),
			},
			createAgentSession: async () => ({
				session: {
					model: { provider: "openai-codex", id: "gpt-5.5" },
					isStreaming: false,
					abort: async () => {},
					dispose: () => {
						disposeCount++;
					},
					getAllTools: () => [
						{ name: "read" },
						{ name: "delegate" },
						{ name: "write" },
						{ name: "subagent" },
					],
					prompt: async (text: string) => {
						promptText = text;
						listener?.({ type: "tool_execution_start", toolName: "read" });
						if (text === "fail task") {
							listener?.({
								type: "tool_execution_end",
								toolName: "read",
								isError: true,
							});
							throw new Error("child exploded");
						}
						listener?.({
							type: "tool_execution_end",
							toolName: "read",
							isError: false,
						});
						listener?.({
							type: "message_end",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "child final report" }],
								...(text === "no usage task"
									? {}
									: {
											usage: {
												input: 10,
												output: 5,
												cacheRead: 2,
												cacheWrite: 1,
												totalTokens: 18,
												cost: {
													input: 0.01,
													output: 0.02,
													cacheRead: 0.001,
													cacheWrite: 0.002,
													total: 0.033,
												},
											},
										}),
							},
						});
					},
					setActiveToolsByName: (names: string[]) => {
						activeTools = names;
					},
					subscribe: (fn: typeof listener) => {
						listener = fn;
						return () => {
							listener = undefined;
						};
					},
				},
			}),
			getAgentDir: () => "/tmp/pi-agent",
		}));

		const previousChildExtensionPaths = process.env[CHILD_EXTENSION_PATHS_ENV];
		process.env[CHILD_EXTENSION_PATHS_ENV] =
			`/tmp/telemetry-a${delimiter}/tmp/telemetry-b`;
		const tool = getTool();
		const context = {
			cwd: "/workspace",
			model: { provider: "openai-codex", id: "gpt-5.5" },
			modelRegistry: {
				find: () => ({ provider: "openai-codex", id: "gpt-5.5" }),
				hasConfiguredAuth: () => true,
			},
		} as unknown as ExtensionContext;

		const result = await tool.execute(
			"tool-call",
			{ task: "inspect package", effort: "fast" },
			undefined,
			(update) => updates.push(update.details as DelegateDetails),
			context,
		);

		process.env[CHILD_EXTENSION_PATHS_ENV] = previousChildExtensionPaths;

		expect(reloaded).toBe(true);
		expect(resourceLoaderOptions?.additionalExtensionPaths).toEqual([
			"/tmp/telemetry-a",
			"/tmp/telemetry-b",
		]);
		expect(disposeCount).toBe(1);
		expect(promptText).toBe("inspect package");
		expect(activeTools).toEqual(["read", "write"]);
		expect(updates.at(0)).toMatchObject({
			success: false,
			assignedTask: "inspect package",
			effort: "fast",
			toolCalls: 0,
		});
		expect(updates.at(-1)).toMatchObject({
			success: false,
			assignedTask: "inspect package",
			effort: "fast",
			toolCalls: 1,
			failedToolCalls: 0,
		});
		expect(result.content).toEqual([
			{ type: "text", text: "child final report" },
		]);
		expect(result.details).toMatchObject({
			success: true,
			assignedTask: "inspect package",
			effort: "fast",
			toolCalls: 1,
			failedToolCalls: 0,
			timedOut: false,
			aborted: false,
			childUsage: {
				turns: 1,
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 1,
				totalTokens: 18,
				cost: 0.033,
			},
		});

		const noUsageResult = await tool.execute(
			"tool-call",
			{ task: "no usage task", effort: "fast" },
			undefined,
			undefined,
			context,
		);
		expect(noUsageResult.details).toMatchObject({
			assignedTask: "no usage task",
			childUsage: {
				turns: 1,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: 0,
			},
		});

		await expect(
			tool.execute(
				"tool-call",
				{ task: "fail task", effort: "balanced" },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow("Delegated task failed: child exploded (gpt-5.5 •");
		expect(disposeCount).toBe(3);
	});
});
