import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import delegateExtension, {
	buildFailureResult,
	DEFAULT_DELEGATE_MODEL,
	DELEGATION_TOOL_DENYLIST,
	type DelegateDetails,
	extractAssistantText,
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
		expect(tool.description).toContain("fresh child Pi agent");
		expect(tool.description).toContain("can modify files");
		expect(tool.promptSnippet).toContain("fresh child agent");
		expect(promptGuidelines).toHaveLength(2);
		expect(
			promptGuidelines.every((guideline) => guideline.includes("delegate")),
		).toBe(true);
		expect(parameters.properties.task?.description).toContain("task");
		expect(parameters.properties.effort?.default).toBe("balanced");
		expect(parameters.required).toEqual(["task"]);
		expect(Object.keys(parameters.properties).sort()).toEqual([
			"effort",
			"task",
		]);
	});

	test("package metadata follows Pi package distribution conventions", async () => {
		const pkg = (await Bun.file("package.json").json()) as {
			private?: boolean;
			files?: string[];
			pi?: { extensions?: string[] };
			peerDependencies?: Record<string, string>;
		};

		expect(pkg.private).toBeUndefined();
		expect(pkg.pi?.extensions).toEqual(["./extensions/delegate.ts"]);
		expect(pkg.files).toEqual(["extensions", "README.md"]);
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

	test("returns structured failure results without throwing", () => {
		const details: DelegateDetails = {
			success: false,
			effort: "balanced",
			requestedModel: "openai-codex/gpt-5.5",
			model: "openai-codex/gpt-5.5",
			thinking: "medium",
			durationMs: 123,
			toolCalls: 2,
			failedToolCalls: 1,
			timedOut: true,
			aborted: false,
			error: "Timed out after 15 minutes",
		};

		expect(buildFailureResult("Timed out after 15 minutes", details)).toEqual({
			content: [
				{
					type: "text",
					text: "Delegated task failed: Timed out after 15 minutes",
				},
			],
			details,
		});
	});
});
