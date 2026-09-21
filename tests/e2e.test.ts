import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as github from "@actions/github";
import { run } from "../src/action.ts";
import type { Analyzed } from "../src/render.ts";

/**
 * Drives the real `run()` end to end: parsing a genuine Dependabot payload,
 * ranking, rendering, the outputs, the comment upsert and the label reconcile.
 *
 * Only the two calls that reach the network are injected. Everything else is
 * the action as shipped, including `@actions/core` reading INPUT_* out of the
 * environment and writing to GITHUB_OUTPUT, exactly as a runner drives it.
 */

/** A grouped Dependabot pull request: two dev dependencies, nothing alarming. */
const GROUPED_BODY = [
	"Bumps the dev-dependencies group with 2 updates: esbuild and tsx.",
	"",
	"Updates `esbuild` from 0.28.1 to 0.28.2",
	"Updates `tsx` from 4.21.0 to 4.23.13",
].join("\n");

const GROUPED_TRAILER = [
	"chore(deps-dev): bump the dev-dependencies group",
	"",
	"---",
	"updated-dependencies:",
	"- dependency-name: esbuild",
	"  dependency-type: direct:development",
	"- dependency-name: tsx",
	"  dependency-type: direct:development",
	"...",
].join("\n");

type Call = { op: string; args: Record<string, unknown> };

function fakeOctokit(calls: Call[], opts: { comments?: { id: number; body: string }[] } = {}) {
	const rec = (op: string) => async (args: Record<string, unknown>) => {
		calls.push({ op, args });
		return { data: {} };
	};
	const listComments = rec("listComments");
	const listCommits = rec("listCommits");
	return {
		paginate: async (route: unknown) => {
			if (route === listCommits) {
				calls.push({ op: "listCommits", args: {} });
				return [{ commit: { message: GROUPED_TRAILER } }];
			}
			calls.push({ op: "listComments", args: {} });
			return opts.comments ?? [];
		},
		rest: {
			issues: {
				listComments,
				createComment: rec("createComment"),
				updateComment: rec("updateComment"),
				addLabels: rec("addLabels"),
				removeLabel: rec("removeLabel"),
			},
			pulls: { listCommits },
		},
	};
}

const analyzed = (name: string, from: string, to: string, level: string): Analyzed => ({
	package: name, fromVersion: from, toVersion: to, semverClass: "patch",
	breakingChanges: [], securityFixes: [], migrationLinks: [], recommendationLevel: level,
});

let dir: string;
let summaryPath: string;
let runs = 0;

// Only the variables this test sets are saved and restored. Snapshotting the
// whole of process.env and diffing it would also clobber the test runner's own
// variables, which breaks it when a single file is run in the main process.
const TOUCHED = ["GITHUB_REPOSITORY", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"] as const;
const saved: Record<string, string | undefined> = {};

/** Sets up the environment a GitHub runner would provide, then runs the action. */
async function runAction(
	payload: { number: number; [key: string]: unknown },
	inputs: Record<string, string>,
	analyses: Record<string, Analyzed>,
	calls: Call[],
	comments?: { id: number; body: string }[]
) {
	const outPath = join(dir, `out-${runs++}`);
	writeFileSync(outPath, "");

	process.env.GITHUB_REPOSITORY = "DigiCatalyst-Systems/agency-os";
	process.env.GITHUB_OUTPUT = outPath;
	for (const k of Object.keys(process.env)) if (k.startsWith("INPUT_")) delete process.env[k];
	for (const [k, v] of Object.entries({ "github-token": "t", comment: "true", ...inputs })) {
		process.env[`INPUT_${k.toUpperCase()}`] = v;
	}

	// @actions/github reads GITHUB_EVENT_PATH once, when it is first imported,
	// so the payload is set on the live context rather than through the file.
	github.context.payload = { pull_request: payload };

	// The action logs the whole report to stdout via @actions/core. When the test
	// runner runs a file in a child process it uses that same stdout to send
	// V8-serialised results back to the parent, and raw text interleaved into
	// that stream corrupts it ("Unable to deserialize cloned data").
	//
	// The two writers are distinguishable: the runner writes Buffers, core writes
	// strings. So drop strings for the duration of the run and let everything
	// else through, rather than blocking the stream wholesale -- which silently
	// swallows test results.
	const write = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
		typeof chunk === "string"
			? true
			: (write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
	try {
		await run({
			analyze: async (_eco: string, name: string) =>
				analyses[name] ?? analyzed(name, "0", "1", "safe"),
			getOctokit: () => fakeOctokit(calls, { comments }) as never,
		});
	} finally {
		process.stdout.write = write;
	}

	const raw = readFileSync(outPath, "utf8");
	const outputs: Record<string, string> = {};
	for (const m of raw.matchAll(/^(\S+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]!] = m[3]!;
	return { outputs, summary: readFileSync(summaryPath, "utf8") };
}

before(() => {
	for (const k of TOUCHED) saved[k] = process.env[k];
	dir = mkdtempSync(join(tmpdir(), "dr-e2e-"));
	// core.summary resolves its path once and caches it, so it is fixed up front.
	summaryPath = join(dir, "summary.md");
	writeFileSync(summaryPath, "");
	process.env.GITHUB_STEP_SUMMARY = summaryPath;
});
after(() => {
	for (const k of TOUCHED) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	for (const k of Object.keys(process.env)) if (k.startsWith("INPUT_")) delete process.env[k];
	rmSync(dir, { recursive: true, force: true });
});

describe("end to end", () => {
	it("analyzes a grouped PR, scopes it, and posts one comment", async () => {
		const calls: Call[] = [];
		const { outputs, summary } = await runAction(
			{ number: 7, title: "chore(deps-dev): bump the dev-dependencies group", body: GROUPED_BODY, user: { login: "dependabot[bot]" }, labels: [] },
			{},
			{
				// One package needs a look, so the grouped table renders rather than
				// the all-clear prose -- which is where the Scope column lives.
				esbuild: analyzed("esbuild", "0.28.1", "0.28.2", "review"),
				tsx: analyzed("tsx", "4.21.0", "4.23.13", "safe"),
			},
			calls
		);

		assert.equal(outputs["highest-level"], "review");
		assert.equal(outputs["security-count"], "0");
		// Both packages carry direct:development in the commit trailer, and the
		// scope reaches the rendered table without anyone passing it by hand.
		assert.match(outputs.summary!, /\|  \| Package \| Scope \| Change \| What to know \|/);
		assert.match(outputs.summary!, /\| `esbuild` \| dev \|/);
		assert.match(outputs.summary!, /\| `tsx` \| dev \|/);
		assert.match(summary, /Dependabot Risk Report/);
		assert.equal(calls.filter((c) => c.op === "createComment").length, 1);
		assert.equal(calls.filter((c) => c.op === "updateComment").length, 0);
	});

	it("updates its own comment instead of posting a second one", async () => {
		const calls: Call[] = [];
		await runAction(
			{ number: 7, title: "chore(deps-dev): bump the dev-dependencies group", body: GROUPED_BODY, user: { login: "dependabot[bot]" }, labels: [] },
			{},
			{},
			calls,
			[{ id: 99, body: "<!-- dependabot-risk -->\nold report" }]
		);
		assert.equal(calls.filter((c) => c.op === "createComment").length, 0);
		const updates = calls.filter((c) => c.op === "updateComment");
		assert.equal(updates.length, 1);
		assert.equal(updates[0]!.args.comment_id, 99);
	});

	// The path that shipped in v1.1.0 having never executed.
	it("adds the label when the PR qualifies", async () => {
		const calls: Call[] = [];
		const { outputs } = await runAction(
			{ number: 7, title: "chore(deps-dev): bump the dev-dependencies group", body: GROUPED_BODY, user: { login: "dependabot[bot]" }, labels: [] },
			{ label: "safe-to-automerge", comment: "false" },
			{},
			calls
		);
		assert.equal(outputs["safe-to-automerge"], "true");
		const added = calls.filter((c) => c.op === "addLabels");
		assert.equal(added.length, 1);
		assert.deepEqual(added[0]!.args.labels, ["safe-to-automerge"]);
	});

	it("removes the label when the PR stops qualifying", async () => {
		const calls: Call[] = [];
		const { outputs } = await runAction(
			{ number: 7, title: "chore(deps-dev): bump the dev-dependencies group", body: GROUPED_BODY, user: { login: "dependabot[bot]" }, labels: [{ name: "safe-to-automerge" }] },
			{ label: "safe-to-automerge", comment: "false" },
			{ esbuild: { ...analyzed("esbuild", "0.28.1", "0.28.2", "security"), securityFixes: [{ id: "GHSA-x", summary: "Path Traversal", severity: "HIGH" }] } },
			calls
		);
		assert.equal(outputs["safe-to-automerge"], "false");
		const removed = calls.filter((c) => c.op === "removeLabel");
		assert.equal(removed.length, 1);
		assert.equal(removed[0]!.args.name, "safe-to-automerge");
	});

	it("leaves the label alone when it already matches the verdict", async () => {
		const calls: Call[] = [];
		await runAction(
			{ number: 7, title: "chore(deps-dev): bump the dev-dependencies group", body: GROUPED_BODY, user: { login: "dependabot[bot]" }, labels: [{ name: "safe-to-automerge" }] },
			{ label: "safe-to-automerge", comment: "false" },
			{},
			calls
		);
		assert.equal(calls.filter((c) => c.op === "addLabels" || c.op === "removeLabel").length, 0);
	});

	it("names Maven rather than sending the coordinate to npm", async () => {
		const calls: Call[] = [];
		const { outputs } = await runAction(
			{
				number: 7, title: "Bump media3 from 1.10.1 to 1.11.0",
				body: [
					"Bumps `media3` from 1.10.1 to 1.11.0.",
					"Updates `androidx.media3:media3-exoplayer` from 1.10.1 to 1.11.0",
				].join("\n"),
				user: { login: "dependabot[bot]" }, labels: [],
			},
			{ label: "safe-to-automerge" },
			{},
			calls
		);
		// The catalog alias is not a package, so it never reaches the report.
		assert.doesNotMatch(outputs.summary!, /media3` \|/);
		assert.match(outputs.summary!, /androidx\.media3:media3-exoplayer/);
		assert.match(outputs.summary!, /Maven is not supported yet/);
		assert.doesNotMatch(outputs.summary!, /404/);
		// Nothing was actually analyzed, so nothing is safe to merge unread.
		assert.equal(outputs["safe-to-automerge"], "false");
		assert.equal(calls.filter((c) => c.op === "addLabels").length, 0);
	});

	it("never labels a pull request it could not read", async () => {
		const calls: Call[] = [];
		const { outputs } = await runAction(
			{ number: 7, title: "Update the docs", body: "no bumps here", user: { login: "dependabot[bot]" }, labels: [] },
			{ label: "safe-to-automerge", comment: "false" },
			{},
			calls
		);
		// "highest-level" reports safe because no risk is on record -- which is
		// not the same claim as "safe to merge unread".
		assert.equal(outputs["highest-level"], "safe");
		assert.equal(outputs["safe-to-automerge"], "false");
		assert.equal(calls.filter((c) => c.op === "addLabels").length, 0);
	});
});
