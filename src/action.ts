import * as core from "@actions/core";
import * as github from "@actions/github";
import { analyzePackageChange } from "@digicatalyst/dep-diff-mcp/dist/analyzer.js";
import {
	isDependencyBot,
	parseDependabotPr,
	unsupportedEcosystem,
	type Ecosystem,
} from "./dependabot.ts";
import { parseRenovatePr } from "./renovate.ts";
import { parseDependabotScopes, parseRenovateScopes, type Scope } from "./scope.ts";
import {
	COMMENT_MARKER,
	capForComment,
	highestLevel,
	isSafeToAutomerge,
	renderComment,
	LOG_BANNER,
	SUMMARY_HEADING,
	type Analyzed,
} from "./render.ts";

const ORDER = ["security", "caution", "review", "likely-safe", "safe"];
const CONCURRENCY = 8;

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * The two things that reach the network. Injecting them lets the end-to-end
 * test drive the real `run()` -- parsing, ranking, rendering, commenting and
 * labelling -- without a live GitHub or a live registry.
 */
export type Deps = {
	analyze: (
		ecosystem: Ecosystem,
		name: string,
		fromVersion: string,
		toVersion: string,
		token: string
	) => Promise<Analyzed>;
	getOctokit: (token: string) => Octokit;
};

const DEFAULTS: Deps = {
	analyze: (ecosystem, name, from, to, token) =>
		analyzePackageChange(ecosystem, name, from, to, token) as Promise<Analyzed>,
	getOctokit: (token) => github.getOctokit(token),
};

/** Small bounded-concurrency map, so a 30-package group does not open 30 sockets. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]!);
		}
	});
	await Promise.all(workers);
	return out;
}

export async function run(overrides: Partial<Deps> = {}): Promise<void> {
	const deps: Deps = { ...DEFAULTS, ...overrides };
	const token = core.getInput("github-token", { required: true });
	const ecosystem = (core.getInput("ecosystem") || "npm") as Ecosystem;
	const failOn = (core.getInput("fail-on") || "none").trim();
	const shouldComment = core.getBooleanInput("comment");
	// Empty disables labelling. Opt-in, because a label that appears unasked may
	// trigger an automerge workflow the repository already has.
	const labelName = core.getInput("label").trim();

	const pr = github.context.payload.pull_request;
	if (!pr) {
		core.info("Not a pull_request event — nothing to analyze.");
		return;
	}

	const body = (pr.body as string | null) ?? undefined;
	// Dependabot states the change in prose; Renovate only in a table. Neither
	// format matches the other, so a miss on one is not a miss on the other.
	const changes = [
		...parseDependabotPr(pr.title ?? "", body),
		...parseRenovatePr(body),
	].filter((c, i, all) => all.findIndex((o) => o.name === c.name) === i);
	if (changes.length === 0) {
		// Reading a pull request body is reading a presentation format, not an API.
		// When the author was a dependency bot there were changes to find, so failing
		// quietly here would read as "the action is broken" — say so instead.
		if (isDependencyBot(pr.user?.login)) {
			core.warning(
				`Could not read any version changes from this ${pr.user?.login} pull request. ` +
					"The body format may have changed — please open an issue at " +
					"https://github.com/DigiCatalyst-Systems/dependabot-risk/issues with a link to this PR."
			);
		} else {
			core.info("No dependency bumps found in this pull request.");
		}
		core.setOutput("highest-level", "safe");
		core.setOutput("security-count", "0");
		// Nothing was analyzed, so nothing is safe to merge unread. "highest-level"
		// says "safe" here only because there is no risk on record -- which is not
		// the same claim.
		core.setOutput("safe-to-automerge", "false");
		return;
	}

	const actionCount = changes.filter((c) => c.ecosystem === "github-actions").length;
	const unsupported = changes.filter((c) => unsupportedEcosystem(c.name));
	core.info(
		`Analyzing ${changes.length} package change(s): ` +
			`${changes.length - actionCount - unsupported.length} in ${ecosystem}, ` +
			`${actionCount} github-actions, ${unsupported.length} unsupported.`
	);
	// One notice for the whole pull request. A warning per package would bury the
	// report on a repository this action does not cover yet.
	if (unsupported.length > 0) {
		core.notice(
			`${unsupported.length} of ${changes.length} package(s) are ` +
				`${unsupportedEcosystem(unsupported[0]!.name)}, which this action does not support yet. ` +
				"It covers npm, PyPI and GitHub Actions."
		);
	}

	const octokit = deps.getOctokit(token);
	const [analyses, commitMessages] = await Promise.all([
		mapLimit(changes, CONCURRENCY, async (c): Promise<Analyzed> => {
			// Say which ecosystem is missing rather than letting the name reach a
			// registry that cannot possibly hold it. "npm returned 404 for
			// org.springframework:spring-core" reads as a broken action; on a Java
			// repository every row would say it.
			const missing = unsupportedEcosystem(c.name);
			if (missing) {
				return {
					package: c.name,
					fromVersion: c.fromVersion,
					toVersion: c.toVersion,
					error: `${missing} is not supported yet — this action covers npm, PyPI and GitHub Actions.`,
					recommendationLevel: "review",
				};
			}
			try {
				return await deps.analyze(
					// A slashed, unscoped name is a repository coordinate, so the name
					// itself settles the ecosystem regardless of the configured default.
					c.ecosystem ?? ecosystem,
					c.name,
					c.fromVersion,
					c.toVersion,
					token
				);
			} catch (err) {
				// Report the failure in place. Dropping it would silently understate risk.
				core.warning(`Could not analyze ${c.name}: ${(err as Error).message}`);
				return {
					package: c.name,
					error: (err as Error).message,
					recommendationLevel: "review",
				};
			}
		}),
		// Scope does not feed the analysis, so fetching it alongside costs nothing.
		fetchCommitMessages(octokit, pr.number),
	]);

	// mapLimit preserves order, so analyses and changes stay index-aligned.
	const scopes = parseDependabotScopes(commitMessages);
	for (const [name, scope] of parseRenovateScopes(body)) {
		if (!scopes.has(name)) scopes.set(name, scope);
	}
	for (const [i, a] of analyses.entries()) {
		// Dependabot calls actions/checkout `direct:production`, which is true but
		// useless -- the reader needs "this runs in CI", not "this is production".
		const scope: Scope | undefined =
			changes[i]!.ecosystem === "github-actions" ? "ci" : scopes.get(changes[i]!.name);
		if (scope) a.scope = scope;
	}
	const unscoped = analyses.filter((a) => !a.scope).length;
	if (unscoped > 0) {
		core.debug(`No dependency scope found for ${unscoped} of ${analyses.length} package(s).`);
	}

	const report = renderComment(analyses);
	const level = highestLevel(analyses);
	const securityCount = analyses.reduce((n, a) => n + (a.securityFixes?.length ?? 0), 0);

	const safe = isSafeToAutomerge(analyses);

	core.setOutput("highest-level", level);
	core.setOutput("security-count", String(securityCount));
	core.setOutput("summary", report);
	core.setOutput("safe-to-automerge", String(safe));
	await core.summary.addRaw(`${SUMMARY_HEADING}\n\n${report}`).write();

	// The log is the one surface that cannot be blocked by a fork's read-only
	// token or trimmed by GitHub's comment size limit, so the whole report goes
	// here unconditionally. Grouped, so it collapses by default.
	// Printed outside the group so it is visible without expanding anything --
	// a log full of other jobs should still say which one wrote this.
	core.info(`\n${LOG_BANNER}\n`);
	core.startGroup("Risk report");
	core.info(report);
	core.endGroup();

	if (shouldComment) await upsertComment(octokit, pr.number, capForComment(report));

	if (labelName) {
		const current = ((pr.labels ?? []) as { name?: string }[]).map((l) => l.name);
		await reconcileLabel(octokit, pr.number, labelName, safe, current.includes(labelName));
	}

	if (failOn !== "none") {
		const threshold = ORDER.indexOf(failOn);
		if (threshold === -1) {
			core.warning(`Unknown fail-on value "${failOn}"; expected one of ${ORDER.join(", ")}, or none.`);
		} else if (ORDER.indexOf(level) <= threshold) {
			core.setFailed(`Highest risk level is "${level}", at or above the fail-on threshold "${failOn}".`);
		}
	}
}

/**
 * Dependabot publishes the dependency scope in its commit trailer. Reading it
 * needs only `pull-requests: read`, which the documented workflow already
 * grants -- no manifest parsing and no `contents:` permission.
 *
 * Failure is debug, not warning: an absent annotation understates nothing, and
 * a routine warning here would corrode the green all-clear.
 */
async function fetchCommitMessages(octokit: Octokit, issueNumber: number): Promise<string[]> {
	const { owner, repo } = github.context.repo;
	try {
		const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
			owner,
			repo,
			pull_number: issueNumber,
			per_page: 100,
		});
		return commits.map((c) => c.commit.message);
	} catch (err) {
		core.debug(`Could not read pull request commits for dependency scope: ${(err as Error).message}`);
		return [];
	}
}

/**
 * Keep the label in step with the current analysis, so it holds one invariant:
 * present if and only if the latest run said safe.
 *
 * A stale "safe to merge" label is worse than a stale report, because an
 * automerge workflow acts on it without reading it -- so a hand-applied label
 * is stripped too. Anyone wanting to force a merge can merge directly.
 *
 * `pull-requests: write` grants both calls; no extra permission is needed.
 */
async function reconcileLabel(
	octokit: Octokit,
	issueNumber: number,
	name: string,
	safe: boolean,
	present: boolean
): Promise<void> {
	if (safe === present) return;
	const { owner, repo } = github.context.repo;
	try {
		if (safe) {
			await octokit.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [name] });
			core.info(`Labelled "${name}" — no advisories, no breaking changes, patch or minor only.`);
			return;
		}
		await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name });
		core.info(`Removed "${name}" — this pull request no longer meets the bar.`);
	} catch (err) {
		// 404 on removal means the label is already gone, which is the end state
		// we wanted; anything else the user asked for and did not get.
		if (!safe && (err as { status?: number }).status === 404) return;
		// The user opted in by naming a label, so a silent no-op here is a broken
		// feature rather than a missing annotation.
		core.warning(
			`Could not ${safe ? "add" : "remove"} the "${name}" label (${(err as Error).message}). ` +
				"Grant pull-requests: write, or clear the `label` input to disable labelling."
		);
	}
}

/** Update this action's own comment rather than adding one per push. */
async function upsertComment(octokit: Octokit, issueNumber: number, body: string): Promise<void> {
	const { owner, repo } = github.context.repo;
	try {
		const existing = await octokit.paginate(octokit.rest.issues.listComments, {
			owner,
			repo,
			issue_number: issueNumber,
			per_page: 100,
		});
		const mine = existing.find((c) => c.body?.includes(COMMENT_MARKER));
		if (mine) {
			await octokit.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body });
			core.info(`Updated existing comment ${mine.id}.`);
			return;
		}
		await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
		core.info("Posted risk report comment.");
	} catch (err) {
		// A fork PR gets a read-only token; the job summary still carries the report.
		core.warning(
			`Could not post the comment (${(err as Error).message}). ` +
				"If this is a pull request from a fork, grant pull-requests: write or read the job summary instead."
		);
	}
}
