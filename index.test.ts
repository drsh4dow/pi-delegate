import { describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import delegateExtension, {
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
		registerTool(definition) {
			tool = definition;
		},
	} as ExtensionAPI);

	if (!tool) {
		throw new Error("delegate tool was not registered");
	}

	return tool as DelegateTool;
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
		expect(tool.description).toContain("subagent/delegated work");
		expect(tool.description).toContain("final report");
		expect(tool.description).toContain("may modify files");
		expect(tool.promptSnippet).toContain("subagent/delegation");
		expect(promptGuidelines).toHaveLength(6);
		const joinedGuidelines = promptGuidelines.join("\n");
		expect(joinedGuidelines).toContain("invoke a subagent");
		expect(joinedGuidelines).toContain("broad repo scans");
		expect(joinedGuidelines).toContain("Do not manually simulate a subagent");
		expect(joinedGuidelines).toContain("self-contained task");
		expect(joinedGuidelines).toContain("read-only");
		expect(joinedGuidelines).toContain("trivial local edits");
		expect(parameters.properties.task?.description).toContain(
			"Self-contained task",
		);
		expect(parameters.properties.task?.description).toContain("read-only");
		expect(parameters.properties.task?.description).toContain("verification");
		expect(parameters.properties.effort?.description).toContain(
			"quick reconnaissance",
		);
		expect(parameters.properties.effort?.description).toContain("high-risk");
		expect(parameters.properties.effort?.default).toBe("balanced");
		expect(parameters.required).toEqual(["task"]);
		expect(Object.keys(parameters.properties).sort()).toEqual([
			"effort",
			"task",
		]);
	});

	test("child prompt defines the delegated worker contract", async () => {
		const source = await Bun.file("extensions/delegate.ts").text();

		expect(source).toContain("Your contract:");
		expect(source).toContain("If the task says read-only, do not modify files");
		expect(source).toContain("Prefer evidence over assertion");
		expect(source).toContain("Final response format:");
		expect(source).toContain("Verification: commands run and outcomes");
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
			effort: "balanced",
			requestedModel: "openai-codex/gpt-5.5",
			model: "openai-codex/gpt-5.5",
			thinking: "medium",
			durationMs: 123,
			toolCalls: 2,
			failedToolCalls: 1,
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
		expect(text).not.toContain("failed •");
	});

	test("renders concise delegate call previews", () => {
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

		expect(text).toStartWith("delegate smart • Inspect this very noisy");
		expect(text).toContain("…");
		expect(text).not.toContain("Do not show this second line");
		expect(text.length).toBeLessThan(130);
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
		const updates: DelegateDetails[] = [];
		type FakeAgentEvent = {
			type: string;
			toolName?: string;
			isError?: boolean;
			message?: {
				role: string;
				content: Array<{ type: string; text: string }>;
			};
		};
		let listener: ((event: FakeAgentEvent) => void) | undefined;

		mock.module("@mariozechner/pi-coding-agent", () => ({
			DefaultResourceLoader: class {
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

		expect(reloaded).toBe(true);
		expect(disposeCount).toBe(1);
		expect(promptText).toBe("inspect package");
		expect(activeTools).toEqual(["read", "write"]);
		expect(updates.at(0)).toMatchObject({
			success: false,
			effort: "fast",
			toolCalls: 0,
		});
		expect(updates.at(-1)).toMatchObject({
			success: false,
			effort: "fast",
			toolCalls: 1,
			failedToolCalls: 0,
		});
		expect(result.content).toEqual([
			{ type: "text", text: "child final report" },
		]);
		expect(result.details).toMatchObject({
			success: true,
			effort: "fast",
			toolCalls: 1,
			failedToolCalls: 0,
			timedOut: false,
			aborted: false,
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
		expect(disposeCount).toBe(2);
	});
});
