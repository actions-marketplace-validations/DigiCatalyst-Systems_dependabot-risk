# Dependabot Risk Report

A GitHub Action that tells you **which Dependabot PRs actually matter**.

Semver tells you how much changed. It does not tell you what is urgent. A `patch`
bump can close a high-severity command injection; a `major` bump can be entirely
additive. This action reads the release notes and advisory data and ranks the
packages in a PR by real risk.

## What it looks like

Most of the time, reassurance:

> ### ✅ Nothing to worry about
>
> Checked `esbuild` 0.28.1 → 0.28.2. No security advisories affecting you, and no breaking changes in the release notes.

When a routine-looking patch is hiding something:

> ### 🔴 Merge this — it closes 2 security holes
>
> `lodash` 4.17.20 → 4.17.21 is a patch bump, but your current version is exposed to:
>
> - **Command Injection** — HIGH, fix soon
> - **Regular Expression Denial of Service (ReDoS)** — MODERATE, worth fixing
>
> Nothing else changes. Safe to merge as is.

**This is the case the action exists for.** Dependabot surfaces advisory
information on *security* updates. On a routine scheduled version bump it does
not — so a patch that happens to close a command injection looks like any other
patch.

When something will actually break:

> ### ⚠️ Read before merging — 2 things change
>
> `express` 4.18.2 → 5.0.0
>
> **What breaks**
> - `req.param()` has been removed — use `req.params`
> - Node.js 18 or higher is required
>
> Your tests may not catch these — they change behaviour, not syntax.
>
> [Migration guide →](https://expressjs.com/en/guide/migrating-5.html)

And for a grouped PR, which is where triage actually costs you time — one row
per package, routine ones included, so a quiet row reads as "I checked this"
rather than "I skipped this":

### 2 of 5 updates need a look

|  | Package | Scope | Change | What to know |
|---|---|---|---|---|
| 🚨 | `lodash` | runtime | 4.17.20 → 4.17.21 | closes Command Injection (HIGH, fix soon) · 1 more |
| 🚫 | `actions/checkout` | CI | 4 → 7 | 3 breaking changes · now requires runner v2.327.1 |
| ✅ | `esbuild` | dev | 0.28.1 → 0.28.2 | nothing found |
| ✅ | `tsx` | dev | 4.21.0 → 4.23.13 | nothing found |
| ✅ | `zod` | runtime | 4.3.6 → 4.5.2 | nothing found |

The full list of what breaks sits in a `<details>` block under the table, so
nothing is truncated anywhere.

### Dependency scope

The **Scope** column says where each package actually runs:

| scope | meaning |
|---|---|
| `runtime` | ships to production |
| `dev` | a development dependency — build tooling, tests, types |
| `CI` | a GitHub Actions workflow step |
| `indirect` | a transitive dependency, pulled in by something else |
| `—` | could not be determined |

**Scope never changes a package's risk level.** A build tool runs in CI holding
your repository token — that is exactly how the `tj-actions/changed-files`
attack worked — so a security advisory in one is still reported as a security
advisory. The tag tells you where the code runs; it does not tell you to worry
less.

The scope is read from Dependabot's commit trailer, or from Renovate's `Type`
column where the repository is configured to include one. Where neither is
available the package is simply left untagged.

## Usage

```yaml
name: Dependabot risk
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  risk:
    # Gate on the pull request's author, not `github.actor`. The actor is whoever
    # triggered the run, so anyone reopening or pushing to a bot's branch would
    # skip the check.
    if: >-
      github.event.pull_request.user.login == 'dependabot[bot]' ||
      github.event.pull_request.user.login == 'renovate[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: DigiCatalyst-Systems/dependabot-risk@v1
```

No configuration and no token setup: the action reads the version bumps out of the
pull request itself and uses the job's own `GITHUB_TOKEN`.

The `if:` is optional — without it the action runs on every pull request and simply
reports that it found no dependency bumps. It is there to save a runner minute.

### Versions and pinning

`@v1` tracks the newest `v1.x` release, so fixes and new features arrive without
a change on your side. Every version is listed in [CHANGELOG.md](CHANGELOG.md),
mirrored from
[Releases](https://github.com/DigiCatalyst-Systems/dependabot-risk/releases).

To decide for yourself when the action changes, pin the commit SHA instead —
which is what we would suggest if you already pin your other actions that way:

```yaml
      - uses: DigiCatalyst-Systems/dependabot-risk@e7ac917d4c5e220188941418db2c7dc8d76f8f73 # v1.1.0
```

Released versions are immutable: a `vX.Y.Z` tag in this repository cannot be
moved or deleted once pushed, by anyone, including us. Only `v1` moves.

### Verifying what you run

This action ships a bundled `dist/index.js` — about 1.1 MB of compiled
JavaScript. You should not have to take our word that it matches the source
beside it. Every release is attested with
[build provenance](https://docs.github.com/en/actions/security-guides/using-artifact-attestations),
so you can check:

```console
$ gh attestation verify dist/index.js --repo DigiCatalyst-Systems/dependabot-risk
```

The attestation is produced by a workflow that rebuilds the bundle from `src/`
at the release tag and refuses to sign it if the result differs from what was
committed — so it certifies a bundle proven to match the source, not merely one
we uploaded.

Releases from v1.2.0 onward carry attestations; earlier ones predate the
workflow.

### Fail the check on risky upgrades

```yaml
      - uses: DigiCatalyst-Systems/dependabot-risk@v1
        with:
          fail-on: caution
```

### GitHub Actions bumps

No configuration needed — they are detected from the name:

```yaml
      - uses: DigiCatalyst-Systems/dependabot-risk@v1
```

### Python projects

```yaml
      - uses: DigiCatalyst-Systems/dependabot-risk@v1
        with:
          ecosystem: pypi
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `github-token` | `${{ github.token }}` | Reads release notes and posts the comment. |
| `ecosystem` | `npm` | Default for names that do not settle it themselves: `npm` or `pypi`. GitHub Actions bumps are detected from the name. |
| `comment` | `true` | Post and update a comment on the PR. |
| `fail-on` | `none` | Fail at this level or worse: `security`, `caution`, `review`, `likely-safe`, `safe`, `none`. |
| `label` | *(none)* | Label to apply when the PR is safe to automerge, and remove when it stops being. Empty disables labelling. |

## Outputs

| Output | Description |
|---|---|
| `highest-level` | Riskiest level found across the PR. |
| `security-count` | Total advisories resolved by the PR. |
| `summary` | The rendered Markdown report. |
| `safe-to-automerge` | `true` when no advisories, no breaking changes, and patch/minor only. `false` when nothing could be analyzed. |

### Automerging the boring ones

Most dependency PRs are a patch bump with nothing in the release notes. This
action can say so in a form your own workflow can act on:

```yaml
      - uses: DigiCatalyst-Systems/dependabot-risk@v1
        id: risk
        with:
          label: safe-to-automerge

      - if: steps.risk.outputs.safe-to-automerge == 'true'
        run: gh pr merge --auto --squash "${{ github.event.pull_request.html_url }}"
        env:
          GH_TOKEN: ${{ github.token }}
```

`safe-to-automerge` is `true` only when every package in the PR resolved no
advisories, had no breaking changes in its release notes, and was a patch or
minor bump. A package the action could not check is never safe, and neither is
a PR it could not read at all.

The output works on its own — you do not need the label, and reading it needs no
write permission. Set `label` as well if you want the state visible in the PR
list, or if you drive automerge from a label rule.

**The label is reconciled on every run.** It is added when the PR qualifies and
**removed when it stops qualifying** — so if a force-push adds a major bump, the
label comes off before anything merges it. That also means a hand-applied label
is stripped on the next unsafe run: a stale "safe to merge" is worse than an
overridden human, because a bot acts on it without reading. To force a merge,
merge it directly.

**This action never merges anything itself.** Merging would need
`contents: write` — write access to your source, from a tool whose whole pitch
is supply-chain safety. `gh pr merge --auto` above is GitHub's own automerge,
and it respects your branch protection, required checks and merge queue. The
action's job is the verdict; the merge stays yours.

## What it reads

- **Security fixes** — advisories present at the old version and resolved at the new one, via [OSV.dev](https://osv.dev).
- **Breaking changes** — extracted from GitHub release notes between the two versions, with prerelease tags and CI/docs churn filtered out.
- **Migration links** — upgrade guide URLs found in those release notes.

### Supported bots and ecosystems

Both **Dependabot** and **Renovate** are read. Dependabot states each change in prose
(`Bumps [zod](...) from 4.3.6 to 4.5.2`); Renovate states it only in its body table
(`` | [zod](...) | `4.3.6` -> `4.5.2` | ``), including the range operators
(`^`, `==`, `>=`), which are stripped.

**Supported ecosystems: npm, PyPI and GitHub Actions.** Anything else is named
rather than guessed at — a Maven or Gradle coordinate like
`org.springframework:spring-core` is reported as "Maven is not supported yet"
instead of being sent to the npm registry, which would 404 and read as a broken
action. Gradle version-catalog aliases (the `Bumps \`media3\`` line that
summarises the coordinates beneath it) are not treated as packages at all.

npm, PyPI, and **GitHub Actions** are analyzed. An `actions/checkout` bump needs no
configuration: a slashed, unscoped name is a repository coordinate, so it is detected
and routed regardless of the `ecosystem` input. This matters more than it sounds —
`actions/*` bumps are among the most common PRs Dependabot opens, and they carry real
advisories: `tj-actions/changed-files` 45.0.7 → 46.0.1 closes a HIGH-severity secret
disclosure that the PR body says nothing about.

If a dependency bot opened the PR and no version change could be read from it, the
action logs a warning rather than passing silently. A quiet no-op is indistinguishable
from a broken install.

The report is always written to the job summary, so it survives even when a fork PR's
token cannot post comments.

## How it works

Dependabot and Renovate PR bodies already state every version change, so this action
does not need to parse lockfiles. It reads them directly, then hands each change to
[`dep-diff`](https://github.com/DigiCatalyst-Systems/dep-diff-mcp) — the same analysis
engine available as an MCP server for interactive use in Claude Code, Cursor, and
Claude Desktop.

## License

MIT
