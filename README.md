<div align="center">

# Strutvane Tooling

**One source of truth for how every Strutvane repo is linted, type-checked, tested, built and released.**

[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

## Why this repo exists

Strutvane is organised like Laravel's GitHub org: `strutvane-framework` (which absorbs the old contracts, core, cli and devkit repos), `create-strutvane`, `strutvane-auth`, `strutvane-ui`, the design packages, `strutvane-log-viewer` and one repo per add-on ([hub `docs/18-v2-blueprint.md` §3.2](https://github.com/vishwajit-vm/strutvane/blob/main/docs/18-v2-blueprint.md)). The project expects more than 100 packages over time.

Many repos tend to end up with many slightly different TypeScript, lint and CI setups, and bugs creep in through the differences. This repo solves it in a deliberately simple way:

1. **Canonical files live here**, in [`canonical/`](canonical/).
2. **A sync script copies them into each package repo** ([`scripts/sync.mjs`](scripts/sync.mjs)).
3. **Each repo commits its copy.** It then builds and tests completely on its own, with no dependency on this repo at install, build or CI time.
4. **Drift is detected.** `npm run sync:check` fails if any repo's copy differs from the canonical file, or still holds a file that was retired.

> **Why copy instead of publishing config packages?** Copying means a package repo can never break because a shared config package changed or wasn't published yet. Every change to a shared config shows up as a reviewable diff in every repo it affects. We can switch to published `@strutvane/*-config` packages later, without changing anything else.

## What's inside

Every target repo has a **profile**, so each repo only gets what makes sense for it:
- `library`: TypeScript package repos (framework, auth, ui, create-strutvane, logs/log-viewer, files, design-crisp, design-vivid, npx, …)
- `site`: the docs site
- `meta`: the hub and this tooling repo
- `app-template`: an application template that is never published (`strutvane-skeleton`, the app `npm create strutvane` installs). It gets the npm guards, Biome, the code rules and a CI of its own, but no release workflow, package check (publint, attw), Vitest coverage config or `RELEASE-READINESS.md`.

A profile can get its **own variant** of a file under the usual path: the manifest entry names it with `source` (kept under `canonical/<profile>/`), and two entries for one path never share a profile. Tests keep each variant tied to the library file it comes from, so a change to the library file that the variant misses fails tooling's CI.

| File (in `canonical/`) | What it does | Goes to |
|---|---|---|
| `.claude/ECOSYSTEM.md` | **Shared ecosystem memory.** Repo map, decisions, connection rules, standards, workflow and current status. Every repo's `CLAUDE.md` imports it (`@.claude/ECOSYSTEM.md`), so anyone who clones *any single repo* gets the whole picture. | every repo |
| `.claude/agents/strutvane-ecosystem-guardian.md` | Reviews a diff in any repo against the ecosystem rules: boundaries, connections, error model, security, npm, tests. | every repo |
| `.claude/skills/strutvane-contribute/SKILL.md` | The standard contribution workflow: understand, change, verify, land on `main`. | every repo |
| `.editorconfig`, `.gitattributes` | Consistent whitespace. **LF line endings forced**, so Windows checkouts never fail the formatter. | every repo |
| `.gitignore` | Ignores env files, Docker files (Strutvane repos never commit them, [ADR-0006](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0006-docker-local-only.md)) and build output. `logs/` is anchored as `/logs/` so it can't hide a nested folder. | library (app-template: its own variant, below) |
| `.npmrc` | **npm supply-chain guards** (npm ≥ 11.19): install scripts only from the package.json `allowScripts` allowlist (`strict-allow-scripts`), third-party versions at least a day old (`min-release-age`, `@strutvane/*` exempt), no git dependencies, Node engine enforced. | library and app-template, once they have a `package.json` |
| `tsconfig.base.json` | Strictest practical TypeScript settings. Each flag is commented with the bug it prevents. Repos `extends` it. | library (app-template: its own variant, below), once it has a `package.json` |
| `biome.base.json` | Formatting and lint rules (Biome). Repos `extends` it from their own `biome.json`. | library and app-template, once they have a `package.json` |
| `vitest.shared.ts`, `vitest.perf.config.ts` | Test defaults: no silent passes, type-level tests on, coverage thresholds (90/90/85/90); performance budgets kept out of the deterministic gate. | library, once it has a `package.json` |
| `.github/workflows/ci.yml` | The machine-checked **production-readiness gates** ([hub docs/19](https://github.com/vishwajit-vm/strutvane/blob/main/docs/19-production-readiness.md)): `verify` (R1/R2: Linux, Windows and macOS × Node 24 and 26, npm 11.19.0, `check-deps`, `check-code-rules`, `npm ci`, `npm audit signatures`, `npm run ci`), `repeat` (R2: tests 3× in a row), `security` (R3: `npm audit --omit=dev --audit-level=high`, TruffleHog secrets scan) and `package-check` (R5: tarball contents, publint, attw). Every job runs with `NODE_OPTIONS=--unhandled-rejections=strict`. Also callable (`workflow_call`). | library (app-template: its own variant, below), once it has a `package.json` |
| `.github/workflows/release.yml` | On every push to `main`: calls `ci.yml` and `needs` it, so **nothing is staged unless every gate is green**; then gates the build again and **stages** the new version on npm through trusted publishing (OIDC, no tokens) with provenance. A maintainer approves each staged version on npmjs.com with 2FA ([ADR-0016](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0016-release-flow-version-on-main.md), [ADR-0018](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0018-staged-npm-publishing.md)). Gated behind the repo variable `RELEASE_ENABLED=true`. | library, once it has a `package.json` |
| `.github/workflows/scorecard.yml` | Weekly OpenSSF Scorecard supply-chain check. | library, app-template and meta, once they have a `package.json` |
| `.github/scripts/publish-if-new.mjs` | Stages the repo's one package (from the root) if its version is neither published nor staged. A 409 "already exists" is a skip only when the published tarball's integrity matches this build; for a staged version it prints the integrity the approver must see. Fails closed if the repo declares workspaces. | library, once it has a `package.json` |
| `.github/scripts/check-code-rules.mjs` | R1: fails on `console.` in `src/` (exact-path exceptions in package.json `strutvane.allowConsole`, which must exist and still use the console) and on TODO/FIXME in `src/` or `test/` without `(#n)` or an issues URL. | library and app-template, once they have a `package.json` |
| `.github/scripts/check-package.mjs` | R5: reads `npm pack --dry-run --json` and fails on tests, fixtures, coverage, env files, keys or `.npmrc` in the tarball, source maps with local absolute paths, a missing README/LICENSE (tarball) or CHANGELOG.md (repo), and `engines.node` below `>=24.3`. | library, once it has a `package.json` |
| `RELEASE-READINESS.md` | **Create-once** (`once: true`): one row per gate R1–R9 with status, evidence link and date. Sync writes it only when missing; after that the repo owns it and it is never compared or overwritten. | library, once it has a `package.json` |
| `.github/scripts/check-deps.mjs` | Fails on `link:`/`file:`/`workspace:`/path dependencies and npm `overrides`, and on any `package-lock.json` entry that is a link or not resolved from `https://registry.npmjs.org/`. | library and app-template, once they have a `package.json` |
| `app-template/tsconfig.base.json` → `tsconfig.base.json` | The library tsconfig without `isolatedDeclarations`, `declaration` and `declarationMap`: an app emits no `.d.ts` files, so explicit return types on every route handler and seeder buy nothing. Every safety flag is identical (tested). | app-template, once it has a `package.json` |
| `app-template/.github/workflows/ci.yml` → `.github/workflows/ci.yml` | The library CI minus what only a published package needs: `verify` and `security` are identical, `repeat` runs the tests 3× without a build, and there is no `package-check` job and no `workflow_call` (tested against the library file). | app-template, once it has a `package.json` |
| `app-template/.gitignore` → `.gitignore` | The library `.gitignore` (env files, Docker files, secrets) plus `/.work/` and `*.tgz`, the scratch output of the integration test that installs the template like a user would. | app-template |
| `.github/dependabot.yml` | Weekly grouped updates for actions and npm deps. | any repo with a `package.json` |

The list, the profiles, the create-once files and the **retired** files live in [`manifest.json`](manifest.json). Changing the shared memory works like any other config: edit `canonical/.claude/ECOSYSTEM.md`, run `npm run sync`, and commit in each repo.

**Retired files.** A file that is no longer canonical (today: `.github/scripts/workspace-packages.mjs`, the pnpm-workspace reader that left with the CLI repo) is listed under `retired`. Sync never deletes it, but `--check` reports every repo that still has a copy (`!` lines) until someone deletes it there.

## Every package repo follows the same contract

npm only (npm ≥ 11.19, pinned in each repo's package.json with `devEngines.packageManager`, `onFail: error`, because an older npm ignores the `.npmrc` guards silently). Each repo commits `package-lock.json` and provides these scripts. CI only ever calls `ci`:

| Script | Runs |
|---|---|
| `lint` | `biome check .` |
| `typecheck` | `tsc --noEmit` |
| `test` | `vitest run` |
| `build` | `tsdown` |
| `ci` | all of the above, in that order. Scripts call the tools directly, never `npm run …` inside another script, so every step shows in the log and runs the same everywhere. |

An `app-template` repo builds nothing, so it has no `build` script: its `ci` is lint, typecheck and test.

A dependency that needs an install script is approved explicitly with `npm approve-scripts <pkg>`, which writes a pinned `pkg@version` entry to package.json `allowScripts`; any other install script fails the install.

## Using the sync script

The script runs from the local umbrella folder, where package repos sit side by side under `packages/<name>/`:

```bash
npm run sync          # write canonical files into every repo that needs them
npm run sync:dry      # preview: show what would change, write nothing
npm run sync:check    # exit 1 if any repo has drifted (use before releases)
node scripts/sync.mjs --repo framework --repo auth   # only some repos
node scripts/sync.mjs --check --root /path/to/clones  # check clones somewhere else
```

**What it guarantees:**
- **No dependencies:** it uses only Node built-ins, and it is cross-platform.
- **No false drift from line endings:** they are normalised to LF, so Windows `autocrlf` never shows a difference that isn't real.
- **Never deletes anything,** and never touches files that aren't in the manifest. Retired files are reported, not removed.
- **Missing repos are skipped, not failed.** A target folder that doesn't exist (not cloned, or not created yet) is listed once with `?` and never fails `--check`.
- **Validates the manifest first.** Path traversal, unknown profiles and unknown repos are rejected, so a broken manifest can't cause a partial sync. Repos the framework absorbed (contracts, core, cli, devkit) are no longer targets, so `--repo core` is refused.

### Changing a shared config (the process)

1. Edit the file in `canonical/`. Explain the *why* in a comment.
2. Run `npm run sync:dry` to see which repos change.
3. Run `npm run sync`. Then, in each affected repo, run `npm ci && npm run ci` locally and commit with the message `chore: sync tooling configs`.
4. Open the tooling PR, linking the package-repo commits.

**Repos still on pnpm:** the npm CI workflow needs `package-lock.json`. Sync it into a repo only together with that repo's move to npm (lockfile, `.npmrc`, `devEngines`, no `packageManager: pnpm`), one repo at a time with `--repo`.

## Releasing packages (trusted publishing)

Versions are bumped in normal commits on `main` (`npx changeset version`, then `chore(release): <name>@<version>`). CI then **stages** the version if it is new, using npm **trusted publishing**, and a maintainer approves it on npmjs.com with 2FA. No npm token exists anywhere, and a CI run alone can never make a version live (ADR-0016, ADR-0018).

Every repo publishes exactly one package, from its root. The multi-package (pnpm workspace) mode was retired with the CLI repo, which the framework absorbed.

**One-time setup per published package on npmjs.com:**
1. Open **Package → Settings → Trusted publishing → GitHub Actions**.
2. Set the owner to `vishwajit-vm`, the repository to the package's repo, the workflow to `release.yml`, no environment, and leave both **"Allow npm publish"** and **"Allow npm dist-tag"** unticked (staging only).
3. Set the repo variable `RELEASE_ENABLED=true`.

## Developing this repo

```bash
npm ci        # npm >= 11.19 (devEngines)
npm run ci    # Biome + the node --test suites: sync, manifest, workflows, check-deps, check-code-rules, check-package, publish-if-new
```

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
