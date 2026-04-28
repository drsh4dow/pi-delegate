import { describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const { PI_DELEGATE_LIVE } = process.env;
const liveEnabled = PI_DELEGATE_LIVE === "1";
const defaultEvalModel = "openai/gpt-5.5:low";
const defaultJudgeModel = defaultEvalModel;

function evalModel() {
	const { PI_DELEGATE_EVAL_MODEL } = process.env;
	return PI_DELEGATE_EVAL_MODEL?.trim() || defaultEvalModel;
}

function evalJudgeModel() {
	const { PI_DELEGATE_EVAL_JUDGE_MODEL } = process.env;
	return PI_DELEGATE_EVAL_JUDGE_MODEL?.trim() || defaultJudgeModel;
}

type DelegateExpectation = "required" | "allowed" | "forbidden";
type DelegateEffort = "fast" | "balanced" | "smart";

type UsageSummary = {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
};

type FixtureTask = {
	id: string;
	expectDelegate: DelegateExpectation;
	expectedDelegateEffort?: DelegateEffort;
	readOnly: boolean;
	prompt: string;
	expectedOutcome: string;
	files: Record<string, string>;
	postCheck?: string[];
};

type RunSummary = {
	mode: "enabled" | "disabled" | "judge";
	exitCode: number;
	durationMs: number;
	delegateCalls: number;
	delegateSucceeded: number;
	delegateFailed: number;
	delegateEfforts: DelegateEffort[];
	parentUsage: UsageSummary;
	childUsage: UsageSummary;
	finalText: string;
	stderr: string;
	jsonParseErrors: number;
	postCheck?: { exitCode: number; stdout: string; stderr: string };
	readOnlyChangedFiles: string[];
	artifact: string;
};

type JudgeScores = {
	correctness: number;
	evidence: number;
	coverage: number;
	usefulness: number;
};

type JudgeResult = {
	enabled: { scores: JudgeScores; rationale: Record<string, string> };
	disabled: { scores: JudgeScores; rationale: Record<string, string> };
};

type CaseAttempt = {
	attempt: number;
	enabled: RunSummary;
	disabled: RunSummary;
	judge?: RunSummary;
	judgement?: JudgeResult;
	hardFailures: string[];
	decisionScore: number;
	effortScore: number;
	enabledQuality: number | null;
	disabledQuality: number | null;
};

type EvalTimeouts = {
	agentMs: number;
	judgeMs: number;
	postCheckMs: number;
};

const emptyUsage = (): UsageSummary => ({
	turns: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: 0,
});

const addUsage = (target: UsageSummary, usage: unknown) => {
	if (!usage || typeof usage !== "object") return;
	const u = usage as {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
	target.turns++;
	target.input += u.input ?? 0;
	target.output += u.output ?? 0;
	target.cacheRead += u.cacheRead ?? 0;
	target.cacheWrite += u.cacheWrite ?? 0;
	target.totalTokens +=
		u.totalTokens ??
		(u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
	target.cost += u.cost?.total ?? 0;
};

const addUsageSummary = (target: UsageSummary, usage: UsageSummary) => {
	target.turns += usage.turns;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.cost += usage.cost;
};

const textFromMessage = (message: unknown): string => {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			const p = part as { type?: unknown; text?: unknown };
			if (p.type !== "text" || typeof p.text !== "string") return [];
			const text = p.text.trim();
			return text ? [text] : [];
		})
		.join("\n");
};

const extractJsonObject = (text: string): unknown => {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start === -1 || end <= start)
			throw new Error("judge did not return JSON");
		return JSON.parse(trimmed.slice(start, end + 1));
	}
};

const scoreAverage = (scores: JudgeScores | undefined): number | null => {
	if (!scores) return null;
	return (
		(scores.correctness +
			scores.evidence +
			scores.coverage +
			scores.usefulness) /
		4
	);
};

const clampScore = (value: unknown): number => {
	return Math.max(0, Math.min(5, typeof value === "number" ? value : 0));
};

const normalizeJudgement = (value: unknown): JudgeResult => {
	const root = value as {
		enabled?: {
			scores?: Partial<JudgeScores>;
			rationale?: Record<string, string>;
		};
		disabled?: {
			scores?: Partial<JudgeScores>;
			rationale?: Record<string, string>;
		};
	};
	const normalizeSide = (
		side: {
			scores?: Partial<JudgeScores>;
			rationale?: Record<string, string>;
		} = {},
	) => ({
		scores: {
			correctness: clampScore(side.scores?.correctness),
			evidence: clampScore(side.scores?.evidence),
			coverage: clampScore(side.scores?.coverage),
			usefulness: clampScore(side.scores?.usefulness),
		},
		rationale: side.rationale ?? {},
	});
	return {
		enabled: normalizeSide(root.enabled),
		disabled: normalizeSide(root.disabled),
	};
};

const scoreDecision = (
	expectation: DelegateExpectation,
	delegateCalls: number,
): number => {
	if (expectation === "required") return delegateCalls > 0 ? 1 : 0;
	if (expectation === "forbidden") return delegateCalls === 0 ? 1 : 0;
	return 1;
};

const scoreEffort = (
	expected: DelegateEffort | undefined,
	actual: DelegateEffort[],
): number => {
	if (!expected) return 1;
	return actual.includes(expected) ? 1 : 0;
};

const liveTasks: FixtureTask[] = [
	{
		id: "broad-repo-scan",
		expectDelegate: "required",
		expectedDelegateEffort: "fast",
		readOnly: true,
		prompt:
			"Map this small repository for a maintainer. Identify the public API, data flow, two risks, and the files you inspected. Do not modify files.",
		expectedOutcome:
			"A concise repo map that covers src/api.ts, src/store.ts, src/worker.ts, and notes the duplicated validation and synchronous write risk.",
		files: {
			"AGENTS.md": "Fixture repo. Follow the user scope exactly.\n",
			"src/api.ts":
				"import { saveJob } from './store';\nimport { runJob } from './worker';\n\nexport async function createJob(input: { id: string; payload: string }) {\n\tif (!input.id) throw new Error('id required');\n\tawait saveJob(input);\n\treturn runJob(input.id);\n}\n",
			"src/store.ts":
				"const jobs = new Map<string, { id: string; payload: string }>();\n\nexport async function saveJob(job: { id: string; payload: string }) {\n\tif (!job.id) throw new Error('id required');\n\tjobs.set(job.id, job);\n}\n\nexport function getJob(id: string) {\n\treturn jobs.get(id);\n}\n",
			"src/worker.ts":
				"import { writeFileSync } from 'node:fs';\nimport { getJob } from './store';\n\nexport function runJob(id: string) {\n\tconst job = getJob(id);\n\tif (!job) throw new Error('missing job');\n\twriteFileSync('/tmp/fixture-worker.log', job.payload);\n\treturn { id, status: 'done' as const };\n}\n",
		},
	},
	{
		id: "noisy-investigation",
		expectDelegate: "required",
		expectedDelegateEffort: "smart",
		readOnly: true,
		prompt:
			"Investigate why totals sometimes differ between checkout and invoices. This is read-only. Report the root cause, exact files, and the smallest safe fix.",
		expectedOutcome:
			"Finds that checkout rounds per item while invoice rounds once at the end; cites pricing/checkout.ts and pricing/invoice.ts.",
		files: {
			"pricing/checkout.ts":
				"export function checkoutTotal(items: { cents: number; qty: number; discount: number }[]) {\n\treturn items.reduce((sum, item) => {\n\t\tconst discounted = Math.round(item.cents * (1 - item.discount));\n\t\treturn sum + discounted * item.qty;\n\t}, 0);\n}\n",
			"pricing/invoice.ts":
				"export function invoiceTotal(items: { cents: number; qty: number; discount: number }[]) {\n\tconst raw = items.reduce((sum, item) => sum + item.cents * item.qty * (1 - item.discount), 0);\n\treturn Math.round(raw);\n}\n",
			"pricing/README.md":
				"Invoices are source of truth. Checkout preview should match invoices exactly.\n",
			"notes/noise.md":
				"Old tax experiments live here and are unrelated to the total mismatch.\n".repeat(
					20,
				),
		},
	},
	{
		id: "library-api-research",
		expectDelegate: "required",
		expectedDelegateEffort: "fast",
		readOnly: true,
		prompt:
			"Research how this project should consume the local fake library. Do not edit files. Compare the current usage with the library docs and report the API mismatch.",
		expectedOutcome:
			"Reports that widget-lib v2 uses createWidget({name, retries}) instead of new Widget(name), with docs and app usage cited.",
		files: {
			"node_modules/widget-lib/README.md":
				"# widget-lib v2\n\nUse `createWidget({ name, retries })`. The old `new Widget(name)` constructor was removed.\n",
			"node_modules/widget-lib/index.d.ts":
				"export function createWidget(options: { name: string; retries?: number }): { start(): Promise<void> };\n",
			"src/widget.ts":
				"import { Widget } from 'widget-lib';\n\nexport const widget = new Widget('sync');\n",
			"package.json":
				'{\n\t"dependencies": {\n\t\t"widget-lib": "2.0.0"\n\t}\n}\n',
		},
	},
	{
		id: "independent-review",
		expectDelegate: "required",
		expectedDelegateEffort: "smart",
		readOnly: true,
		prompt:
			"Do an independent code review of the proposed change. Do not modify files. Focus on correctness, missing tests, and migration risk.",
		expectedOutcome:
			"Review flags that the migration drops disabled users and lacks a test for preserving disabled status.",
		files: {
			"review/base.ts":
				"export type User = { id: string; email: string; disabled?: boolean };\nexport const users: User[] = [];\n",
			"review/proposed.ts":
				"import type { User } from './base';\n\nexport function migrate(users: User[]) {\n\treturn users.filter((user) => !user.disabled).map((user) => ({\n\t\tid: user.id,\n\t\temail: user.email.toLowerCase(),\n\t}));\n}\n",
			"review/proposed.test.ts":
				"import { expect, test } from 'bun:test';\nimport { migrate } from './proposed';\n\ntest('lowercases email', () => {\n\texpect(migrate([{ id: '1', email: 'A@EXAMPLE.COM' }])).toEqual([{ id: '1', email: 'a@example.com' }]);\n});\n",
		},
	},
	{
		id: "plan-critique",
		expectDelegate: "required",
		expectedDelegateEffort: "smart",
		readOnly: true,
		prompt:
			"Critique the migration plan as a skeptical reviewer. Do not edit files. Identify missing sequencing, rollback, and validation work.",
		expectedOutcome:
			"Notes missing dual-write/rollback/validation, and cites plan.md plus schema files.",
		files: {
			"docs/plan.md":
				"# Account ID migration\n\n1. Rename `account_id` to `customer_id`.\n2. Deploy API.\n3. Delete old column.\n",
			"db/current.sql":
				"create table orders (id text primary key, account_id text not null);\ncreate index orders_account_id_idx on orders(account_id);\n",
			"src/orders.ts":
				"export function byAccount(accountId: string) {\n\treturn ['select * from orders where account_id = ?', accountId];\n}\n",
		},
	},
	{
		id: "narrow-implementation",
		expectDelegate: "required",
		expectedDelegateEffort: "balanced",
		readOnly: false,
		prompt:
			"Fix the failing discount behavior in this tiny package. Keep the change focused and run the relevant test.",
		expectedOutcome:
			"The discount test passes and applyDiscount returns cents * (1 - rate), rounded once.",
		postCheck: ["bun test"],
		files: {
			"package.json":
				'{\n\t"type": "module",\n\t"scripts": { "test": "bun test" }\n}\n',
			"discount.ts":
				"export function applyDiscount(cents: number, rate: number) {\n\treturn Math.round(cents * rate);\n}\n",
			"discount.test.ts":
				"import { expect, test } from 'bun:test';\nimport { applyDiscount } from './discount';\n\ntest('applies discount rate', () => {\n\texpect(applyDiscount(1000, 0.25)).toBe(750);\n});\n",
		},
	},
	{
		id: "medium-summary",
		expectDelegate: "allowed",
		readOnly: true,
		prompt:
			"Summarize the error-handling policy and mention anything ambiguous. Do not modify files.",
		expectedOutcome:
			"Summarizes docs/policy.md and notices retry ownership is ambiguous.",
		files: {
			"docs/policy.md":
				"# Error handling\n\nValidation errors return 400. Auth errors return 401. Payment provider timeouts are retried twice by the caller. Retry ownership for queue workers is not defined.\n",
		},
	},
	{
		id: "small-review",
		expectDelegate: "allowed",
		expectedDelegateEffort: "smart",
		readOnly: true,
		prompt: "Review this small parser for edge cases. Do not edit files.",
		expectedOutcome:
			"Mentions empty segments and missing URL decoding as possible edge cases.",
		files: {
			"parser.ts":
				"export function parseQuery(query: string) {\n\treturn Object.fromEntries(query.replace(/^\\?/, '').split('&').map((part) => part.split('=')));\n}\n",
		},
	},
	{
		id: "trivial-answer",
		expectDelegate: "forbidden",
		readOnly: true,
		prompt:
			"What is the package name in package.json? Answer with only the name. Do not modify files.",
		expectedOutcome: "Answers `tiny-fixture` without delegation.",
		files: {
			"package.json": '{\n\t"name": "tiny-fixture"\n}\n',
		},
	},
	{
		id: "trivial-edit",
		expectDelegate: "forbidden",
		readOnly: false,
		prompt:
			"Fix the typo in README.md: change 'teh' to 'the'. This is a trivial local edit.",
		expectedOutcome: "README.md has the typo fixed without delegation.",
		files: {
			"README.md": "This is teh smallest fixture.\n",
		},
	},
];

async function writeFixture(task: FixtureTask, root: string) {
	for (const [path, content] of Object.entries(task.files)) {
		const fullPath = join(root, path);
		await mkdir(dirname(fullPath), { recursive: true });
		await writeFile(fullPath, content);
	}
}

async function snapshotFiles(root: string): Promise<Map<string, string>> {
	const snapshot = new Map<string, string>();
	async function walk(dir: string) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === ".pi") continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			snapshot.set(relative(root, fullPath), await readFile(fullPath, "utf8"));
		}
	}
	await walk(root);
	return snapshot;
}

function changedFiles(before: Map<string, string>, after: Map<string, string>) {
	const changed = new Set<string>();
	for (const [path, content] of before) {
		if (after.get(path) !== content) changed.add(path);
	}
	for (const path of after.keys()) {
		if (!before.has(path)) changed.add(path);
	}
	return [...changed].sort();
}

const timeoutExitCode = 124;
const streamDrainMs = 500;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessGroup(proc: Bun.Subprocess) {
	try {
		proc.unref();
	} catch {
		// The process may already be gone.
	}
	try {
		if (process.platform !== "win32") {
			process.kill(-proc.pid, "SIGKILL");
			return;
		}
	} catch {
		// Fall back to killing the direct child below.
	}
	try {
		proc.kill("SIGKILL");
	} catch {
		// The process may already be gone.
	}
}

function collectStream(stream: ReadableStream<Uint8Array>) {
	let text = "";
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	const done = (async () => {
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				text += decoder.decode(chunk.value, { stream: true });
			}
		} catch {
			// Cancellation is expected when a leaked descendant keeps a pipe open.
		} finally {
			text += decoder.decode();
		}
	})();
	return {
		done,
		text: () => text,
		cancel: async () => {
			try {
				await reader.cancel();
			} catch {
				// Already closed.
			}
		},
	};
}

async function drainStreams(
	proc: Bun.Subprocess,
	stdout: ReturnType<typeof collectStream>,
	stderr: ReturnType<typeof collectStream>,
) {
	const drained = await Promise.race([
		Promise.all([stdout.done, stderr.done]).then(() => true),
		sleep(streamDrainMs).then(() => false),
	]);
	if (drained) return;
	killProcessGroup(proc);
	await Promise.all([stdout.cancel(), stderr.cancel()]);
}

async function runCommand(
	command: string[],
	cwd: string,
	timeoutMs: number,
): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}> {
	const startedAt = Date.now();
	const proc = Bun.spawn(command, {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: process.platform !== "win32",
		env: process.env,
	});
	const stdout = collectStream(proc.stdout);
	const stderr = collectStream(proc.stderr);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const exit = await Promise.race([
			proc.exited,
			new Promise<"timeout">((resolve) => {
				timeout = setTimeout(() => {
					killProcessGroup(proc);
					resolve("timeout");
				}, timeoutMs);
			}),
		]);
		if (exit === "timeout") {
			await Promise.race([proc.exited, sleep(streamDrainMs)]);
			await Promise.all([stdout.cancel(), stderr.cancel()]);
			const message = `Command timed out after ${timeoutMs}ms`;
			return {
				exitCode: timeoutExitCode,
				stdout: stdout.text(),
				stderr: stderr.text() ? `${stderr.text()}\n${message}` : message,
				durationMs: Date.now() - startedAt,
			};
		}
		await drainStreams(proc, stdout, stderr);
		return {
			exitCode: exit,
			stdout: stdout.text(),
			stderr: stderr.text(),
			durationMs: Date.now() - startedAt,
		};
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function parseRun(
	mode: RunSummary["mode"],
	run: { exitCode: number; stdout: string; stderr: string; durationMs: number },
	artifact: string,
	readOnlyChangedFiles: string[],
	postCheck?: { exitCode: number; stdout: string; stderr: string },
): RunSummary {
	const parentUsage = emptyUsage();
	const childUsage = emptyUsage();
	let finalText = "";
	let delegateCalls = 0;
	let delegateSucceeded = 0;
	let delegateFailed = 0;
	const delegateEfforts: DelegateEffort[] = [];
	let jsonParseErrors = 0;

	for (const line of run.stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			jsonParseErrors++;
			continue;
		}
		if (!event || typeof event !== "object") continue;
		const e = event as {
			type?: string;
			toolName?: string;
			args?: { effort?: unknown };
			isError?: boolean;
			message?: { role?: string; usage?: unknown };
			result?: { details?: { childUsage?: UsageSummary } };
		};
		if (e.type === "tool_execution_start" && e.toolName === "delegate") {
			delegateCalls++;
			if (
				e.args?.effort === "fast" ||
				e.args?.effort === "balanced" ||
				e.args?.effort === "smart"
			) {
				delegateEfforts.push(e.args.effort);
			}
		}
		if (e.type === "tool_execution_end" && e.toolName === "delegate") {
			if (e.isError) delegateFailed++;
			else delegateSucceeded++;
			if (e.result?.details?.childUsage) {
				addUsageSummary(childUsage, e.result.details.childUsage);
			}
		}
		if (e.type === "message_end" && e.message?.role === "assistant") {
			addUsage(parentUsage, e.message.usage);
			const text = textFromMessage(e.message);
			if (text) finalText = text;
		}
	}

	return {
		mode,
		exitCode: run.exitCode,
		durationMs: run.durationMs,
		delegateCalls,
		delegateSucceeded,
		delegateFailed,
		delegateEfforts,
		parentUsage,
		childUsage,
		finalText,
		stderr: run.stderr,
		jsonParseErrors,
		postCheck,
		readOnlyChangedFiles,
		artifact,
	};
}

async function runPi(
	mode: "enabled" | "disabled",
	prompt: string,
	cwd: string,
	artifact: string,
	timeoutMs: number,
	model: string,
) {
	const args = [
		"--bun",
		"pi",
		"--mode",
		"json",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--model",
		model,
	];
	if (mode === "enabled") args.push("-e", repoRoot);
	args.push(prompt);
	const run = await runCommand(["bunx", ...args], cwd, timeoutMs);
	await writeFile(artifact, run.stdout);
	return run;
}

async function runJudge(
	task: FixtureTask,
	enabled: RunSummary,
	disabled: RunSummary,
	cwd: string,
	artifact: string,
	timeoutMs: number,
) {
	const judgeModel = evalJudgeModel();
	const prompt = `You are an evaluator for a coding-agent live integration test. Return only valid JSON.\n\nTask id: ${task.id}\nDelegate expectation: ${task.expectDelegate}\nUser prompt:\n${task.prompt}\n\nExpected outcome:\n${task.expectedOutcome}\n\nEnabled run final answer:\n${enabled.finalText}\n\nDisabled-control final answer:\n${disabled.finalText}\n\nEnabled deterministic post-check: ${JSON.stringify(enabled.postCheck ?? null)}\nDisabled deterministic post-check: ${JSON.stringify(disabled.postCheck ?? null)}\n\nScore each side from 0 to 5 on correctness, evidence, coverage, and usefulness. Use the expected outcome and deterministic checks. Respond exactly as:\n{"enabled":{"scores":{"correctness":0,"evidence":0,"coverage":0,"usefulness":0},"rationale":{"correctness":"...","evidence":"...","coverage":"...","usefulness":"..."}},"disabled":{"scores":{"correctness":0,"evidence":0,"coverage":0,"usefulness":0},"rationale":{"correctness":"...","evidence":"...","coverage":"...","usefulness":"..."}}}`;
	const run = await runCommand(
		[
			"bunx",
			"--bun",
			"pi",
			"--mode",
			"json",
			"--no-session",
			"--no-extensions",
			"--no-tools",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--model",
			judgeModel,
			prompt,
		],
		cwd,
		timeoutMs,
	);
	await writeFile(artifact, run.stdout);
	const summary = parseRun("judge", run, artifact, [], undefined);
	return {
		run: summary,
		judgement: normalizeJudgement(extractJsonObject(summary.finalText)),
	};
}

async function runPostCheck(task: FixtureTask, cwd: string, timeoutMs: number) {
	if (!task.postCheck) return undefined;
	const outputs: string[] = [];
	for (const command of task.postCheck) {
		const result = await runCommand(["bash", "-lc", command], cwd, timeoutMs);
		outputs.push(`$ ${command}\n${result.stdout}${result.stderr}`);
		if (result.exitCode !== 0) {
			return {
				exitCode: result.exitCode,
				stdout: outputs.join("\n"),
				stderr: result.stderr,
			};
		}
	}
	return { exitCode: 0, stdout: outputs.join("\n"), stderr: "" };
}

async function runAgentSide(
	mode: "enabled" | "disabled",
	task: FixtureTask,
	attemptDir: string,
	timeouts: EvalTimeouts,
	model: string,
): Promise<RunSummary> {
	const fixture = await mkdtemp(
		join(tmpdir(), `pi-delegate-${task.id}-${mode}-`),
	);
	try {
		await writeFixture(task, fixture);
		const before = await snapshotFiles(fixture);
		const artifact = join(attemptDir, `${mode}.jsonl`);
		const run = await runPi(
			mode,
			task.prompt,
			fixture,
			artifact,
			timeouts.agentMs,
			model,
		);
		const postCheck = await runPostCheck(task, fixture, timeouts.postCheckMs);
		const after = await snapshotFiles(fixture);
		const readOnlyChangedFiles = task.readOnly
			? changedFiles(before, after)
			: [];
		return parseRun(mode, run, artifact, readOnlyChangedFiles, postCheck);
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
}

function hardFailuresFor(
	task: FixtureTask,
	attempt: Omit<CaseAttempt, "hardFailures">,
) {
	const failures: string[] = [];
	for (const run of [attempt.enabled, attempt.disabled, attempt.judge].filter(
		Boolean,
	) as RunSummary[]) {
		if (run.exitCode !== 0)
			failures.push(`${task.id}/${run.mode}: pi exited ${run.exitCode}`);
		if (run.jsonParseErrors > 0) {
			failures.push(
				`${task.id}/${run.mode}: ${run.jsonParseErrors} JSONL parse errors`,
			);
		}
		if (run.readOnlyChangedFiles.length > 0) {
			failures.push(
				`${task.id}/${run.mode}: read-only files changed: ${run.readOnlyChangedFiles.join(", ")}`,
			);
		}
	}
	if (
		task.expectDelegate === "required" &&
		attempt.enabled.delegateCalls === 0
	) {
		failures.push(`${task.id}: delegate was not called on required task`);
	}
	if (
		task.expectDelegate === "forbidden" &&
		attempt.enabled.delegateCalls > 0
	) {
		failures.push(`${task.id}: delegate was called on forbidden task`);
	}
	if (
		task.expectedDelegateEffort &&
		attempt.enabled.delegateCalls > 0 &&
		attempt.effortScore !== 1
	) {
		failures.push(
			`${task.id}: expected delegate effort ${task.expectedDelegateEffort}, saw ${attempt.enabled.delegateEfforts.join(", ")}`,
		);
	}
	return failures;
}

async function runCaseAttempt(
	task: FixtureTask,
	attempt: number,
	artifactDir: string,
	timeouts: EvalTimeouts,
	model: string,
): Promise<CaseAttempt> {
	const attemptDir = join(artifactDir, task.id, `attempt-${attempt}`);
	await mkdir(attemptDir, { recursive: true });
	console.log(
		`[live-eval] ${task.id}/attempt-${attempt}: enabled + disabled runs`,
	);
	const [enabled, disabled] = await Promise.all([
		runAgentSide("enabled", task, attemptDir, timeouts, model),
		runAgentSide("disabled", task, attemptDir, timeouts, model),
	]);
	let judge: RunSummary | undefined;
	let judgement: JudgeResult | undefined;
	if (enabled.exitCode === 0 && disabled.exitCode === 0) {
		try {
			console.log(`[live-eval] ${task.id}/attempt-${attempt}: judge run`);
			const judged = await runJudge(
				task,
				enabled,
				disabled,
				attemptDir,
				join(attemptDir, "judge.jsonl"),
				timeouts.judgeMs,
			);
			judge = judged.run;
			judgement = judged.judgement;
		} catch (error) {
			judge = {
				mode: "judge",
				exitCode: 1,
				durationMs: 0,
				delegateCalls: 0,
				delegateSucceeded: 0,
				delegateFailed: 0,
				delegateEfforts: [],
				parentUsage: emptyUsage(),
				childUsage: emptyUsage(),
				finalText: "",
				stderr: error instanceof Error ? error.message : String(error),
				jsonParseErrors: 0,
				readOnlyChangedFiles: [],
				artifact: join(attemptDir, "judge.jsonl"),
			};
		}
	} else {
		console.log(
			`[live-eval] ${task.id}/attempt-${attempt}: skipping judge after agent failure`,
		);
	}
	const withoutFailures = {
		attempt,
		enabled,
		disabled,
		judge,
		judgement,
		decisionScore: scoreDecision(task.expectDelegate, enabled.delegateCalls),
		effortScore: scoreEffort(
			task.expectedDelegateEffort,
			enabled.delegateEfforts,
		),
		enabledQuality: scoreAverage(judgement?.enabled.scores),
		disabledQuality: scoreAverage(judgement?.disabled.scores),
	};
	return {
		...withoutFailures,
		hardFailures: hardFailuresFor(task, withoutFailures),
	};
}

function parsePositiveNumberEnv(name: string, raw: string): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive number`);
	}
	return value;
}

function requiredNumberEnv(name: string): number {
	const raw = process.env[name];
	if (!raw) throw new Error(`${name} is required for live evals`);
	return parsePositiveNumberEnv(name, raw);
}

function optionalNumberEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	return raw ? parsePositiveNumberEnv(name, raw) : fallback;
}

function selectedTasks(raw?: string): FixtureTask[] {
	if (raw === undefined) {
		const { PI_DELEGATE_EVAL_TASKS } = process.env;
		raw = PI_DELEGATE_EVAL_TASKS;
	}
	if (!raw) return liveTasks;
	const requested = new Set(
		raw
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
	);
	const selected = liveTasks.filter((task) => requested.has(task.id));
	if (selected.length !== requested.size) {
		const found = new Set(selected.map((task) => task.id));
		const missing = [...requested].filter((id) => !found.has(id));
		throw new Error(`Unknown live eval task id(s): ${missing.join(", ")}`);
	}
	return selected;
}

describe("live eval scoring", () => {
	test("scores delegate decisions from required/allowed/forbidden labels", () => {
		expect(scoreDecision("required", 1)).toBe(1);
		expect(scoreDecision("required", 0)).toBe(0);
		expect(scoreDecision("allowed", 0)).toBe(1);
		expect(scoreDecision("allowed", 2)).toBe(1);
		expect(scoreDecision("forbidden", 0)).toBe(1);
		expect(scoreDecision("forbidden", 1)).toBe(0);
	});

	test("scores delegate effort when a task has an expected effort", () => {
		expect(scoreEffort(undefined, [])).toBe(1);
		expect(scoreEffort("fast", ["fast"])).toBe(1);
		expect(scoreEffort("smart", ["fast", "smart"])).toBe(1);
		expect(scoreEffort("balanced", ["fast"])).toBe(0);
		expect(scoreEffort("smart", [])).toBe(0);
	});

	test("hard-fails required delegate and expected effort misses", () => {
		const run = (delegateEfforts: DelegateEffort[] = []): RunSummary => ({
			mode: "enabled",
			exitCode: 0,
			durationMs: 1,
			delegateCalls: delegateEfforts.length,
			delegateSucceeded: delegateEfforts.length,
			delegateFailed: 0,
			delegateEfforts,
			parentUsage: emptyUsage(),
			childUsage: emptyUsage(),
			finalText: "",
			stderr: "",
			jsonParseErrors: 0,
			readOnlyChangedFiles: [],
			artifact: "artifact.jsonl",
		});
		const task: FixtureTask = {
			id: "required-fast",
			expectDelegate: "required",
			expectedDelegateEffort: "fast",
			readOnly: true,
			prompt: "",
			expectedOutcome: "",
			files: {},
		};

		expect(
			hardFailuresFor(task, {
				attempt: 1,
				enabled: run(),
				disabled: run(),
				decisionScore: 0,
				effortScore: 0,
				enabledQuality: null,
				disabledQuality: null,
			}),
		).toEqual(["required-fast: delegate was not called on required task"]);
		expect(
			hardFailuresFor(task, {
				attempt: 1,
				enabled: run(["balanced"]),
				disabled: run(),
				decisionScore: 1,
				effortScore: 0,
				enabledQuality: null,
				disabledQuality: null,
			}),
		).toEqual(["required-fast: expected delegate effort fast, saw balanced"]);
	});

	test("selects a requested task subset", () => {
		expect(
			selectedTasks("broad-repo-scan,trivial-answer").map((task) => task.id),
		).toEqual(["broad-repo-scan", "trivial-answer"]);
	});

	test("does not wait forever when a descendant keeps stdout open", async () => {
		if (process.platform === "win32") return;
		const run = await runCommand(
			["bash", "-lc", "printf ready; (sleep 30) & exit 0"],
			repoRoot,
			5000,
		);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("ready");
		expect(run.durationMs).toBeLessThan(3000);
	});

	test("kills a command that exceeds its timeout", async () => {
		const run = await runCommand(["bash", "-lc", "sleep 30"], repoRoot, 200);
		expect(run.exitCode).toBe(timeoutExitCode);
		expect(run.stderr).toContain("Command timed out after 200ms");
		expect(run.durationMs).toBeLessThan(3000);
	});

	test("parses Pi JSONL usage and delegate child usage", async () => {
		const stdout = [
			JSON.stringify({
				type: "tool_execution_start",
				toolName: "delegate",
				args: { effort: "smart" },
			}),
			JSON.stringify({
				type: "tool_execution_end",
				toolName: "delegate",
				isError: false,
				result: {
					details: {
						childUsage: {
							turns: 1,
							input: 3,
							output: 4,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 7,
							cost: 0.01,
						},
					},
				},
			}),
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: {
						input: 10,
						output: 2,
						cacheRead: 1,
						cacheWrite: 0,
						totalTokens: 13,
						cost: { total: 0.02 },
					},
				},
			}),
		].join("\n");
		const artifact = join(tmpdir(), `pi-delegate-parse-${Date.now()}.jsonl`);
		await writeFile(artifact, stdout);
		const summary = parseRun(
			"enabled",
			{ exitCode: 0, stdout, stderr: "", durationMs: 5 },
			artifact,
			[],
		);
		expect(summary.delegateCalls).toBe(1);
		expect(summary.delegateSucceeded).toBe(1);
		expect(summary.delegateEfforts).toEqual(["smart"]);
		expect(summary.finalText).toBe("done");
		expect(summary.parentUsage.totalTokens).toBe(13);
		expect(summary.childUsage.totalTokens).toBe(7);
		await rm(artifact, { force: true });
	});
});

(liveEnabled ? describe : describe.skip)(
	"live Pi delegate integration eval",
	() => {
		test("runs the baseline KPI suite", async () => {
			const timeoutMs = requiredNumberEnv("PI_DELEGATE_EVAL_TIMEOUT_MS");
			const timeouts: EvalTimeouts = {
				agentMs: optionalNumberEnv(
					"PI_DELEGATE_EVAL_AGENT_TIMEOUT_MS",
					timeoutMs,
				),
				judgeMs: optionalNumberEnv(
					"PI_DELEGATE_EVAL_JUDGE_TIMEOUT_MS",
					Math.min(timeoutMs, 120000),
				),
				postCheckMs: optionalNumberEnv(
					"PI_DELEGATE_EVAL_POSTCHECK_TIMEOUT_MS",
					Math.min(timeoutMs, 60000),
				),
			};
			const maxTokens = requiredNumberEnv("PI_DELEGATE_EVAL_MAX_TOKENS");
			const maxCost = requiredNumberEnv("PI_DELEGATE_EVAL_MAX_COST_USD");
			const { PI_DELEGATE_EVAL_ARTIFACT_DIR } = process.env;
			const model = evalModel();
			const judgeModel = evalJudgeModel();
			const tasks = selectedTasks();
			const artifactDir =
				PI_DELEGATE_EVAL_ARTIFACT_DIR ??
				join(tmpdir(), `pi-delegate-live-${Date.now()}`);
			await mkdir(artifactDir, { recursive: true });

			const attempts: CaseAttempt[] = [];
			const hardFailures: string[] = [];
			const budgetUsage = emptyUsage();

			console.log(
				`[live-eval] running ${tasks.length} task(s); model=${model}; judge=${judgeModel}; artifacts: ${artifactDir}`,
			);
			for (const task of tasks) {
				let attempt = await runCaseAttempt(
					task,
					1,
					artifactDir,
					timeouts,
					model,
				);
				if (attempt.hardFailures.length > 0) {
					console.log(
						`[live-eval] ${task.id}: retrying after hard failure(s): ${attempt.hardFailures.join("; ")}`,
					);
					attempt = await runCaseAttempt(task, 2, artifactDir, timeouts, model);
				}
				console.log(
					`[live-eval] ${task.id}: decision=${attempt.decisionScore} effort=${attempt.effortScore} enabled=${attempt.enabled.durationMs}ms disabled=${attempt.disabled.durationMs}ms judge=${attempt.judge?.durationMs ?? 0}ms`,
				);
				attempts.push(attempt);
				for (const run of [
					attempt.enabled,
					attempt.disabled,
					attempt.judge,
				].filter(Boolean) as RunSummary[]) {
					addUsageSummary(budgetUsage, run.parentUsage);
					addUsageSummary(budgetUsage, run.childUsage);
				}
				if (budgetUsage.totalTokens > maxTokens) {
					hardFailures.push(
						`token budget exceeded: ${budgetUsage.totalTokens} > ${maxTokens}`,
					);
					break;
				}
				if (budgetUsage.cost > maxCost) {
					hardFailures.push(
						`cost budget exceeded: ${budgetUsage.cost} > ${maxCost}`,
					);
					break;
				}
			}

			for (const attempt of attempts)
				hardFailures.push(...attempt.hardFailures);
			const decisionScore =
				attempts.reduce((sum, attempt) => sum + attempt.decisionScore, 0) /
				attempts.length;
			const effortScore =
				attempts.reduce((sum, attempt) => sum + attempt.effortScore, 0) /
				attempts.length;
			const enabledQuality = attempts
				.map((attempt) => attempt.enabledQuality)
				.filter((value): value is number => value !== null);
			const disabledQuality = attempts
				.map((attempt) => attempt.disabledQuality)
				.filter((value): value is number => value !== null);
			const summary = {
				startedAt: new Date().toISOString(),
				phase: "baseline",
				config: {
					tasks: tasks.map((task) => task.id),
					timeoutMs,
					timeouts,
					maxTokens,
					maxCost,
					model,
					judgeModel,
				},
				kpis: {
					decisionScore,
					effortScore,
					enabledQuality:
						enabledQuality.reduce((sum, value) => sum + value, 0) /
						enabledQuality.length,
					disabledQuality:
						disabledQuality.reduce((sum, value) => sum + value, 0) /
						disabledQuality.length,
					budgetUsage,
				},
				hardFailures,
				attempts,
			};
			await writeFile(
				join(artifactDir, "summary.json"),
				`${JSON.stringify(summary, null, 2)}\n`,
			);

			expect(hardFailures).toEqual([]);
		});
	},
);
