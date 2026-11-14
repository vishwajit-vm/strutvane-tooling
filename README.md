<div align="center">

# Strutvane Tooling

**One source of truth for how every Strutvane repo is linted, type-checked, tested, built and released.**

[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

## Why this repo exists

Strutvane is a **polyrepo**: every package (`framework`, `auth`, `ui`, `core`, `contracts`, …) lives in its own GitHub repository ([ADR-0002](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0002-one-repository-per-package.md)).

That raises a familiar problem: ten repos tend to end up with ten slightly different TypeScript, lint and CI setups, and bugs creep in through the differences. This repo solves it in a deliberately simple way:

1. **Canonical files live here**, in [`canonical/`](canonical/).
2. **A sync script copies them into each package repo** ([`scripts/sync.mjs`](scripts/sync.mjs)).
3. **Each repo commits its copy.** It then builds and tests completely on its own, with no dependency on this repo at install, build or CI time.
4. **Drift is detected.** `pnpm sync:check` fails if any repo's copy differs from the canonical file.

> **Why copy instead of publishing config packages?** Copying means a package repo can never break because a shared config package changed or wasn't published yet. Every change to a shared config shows up as a reviewable diff in every repo it affects. We can switch to published `@strutvane/*-config` packages later, without changing anything else.

## What's inside

Every target repo has a **profile**, so each repo only gets what makes sense for it:
- `library`: TypeScript package repos (contracts, core, framework, auth, ui, cli, devkit, create-strutvane)
- `site`: the docs site
- `meta`: the hub/blueprint repo and this tooling repo

| File (in `canonical/`) | What it does | Goes to |
|---|---|---|
| `.claude/ECOSYSTEM.md` | **Shared ecosystem memory.** Repo map, decisions, connection rules, standards, workflow and current status. Every repo's `CLAUDE.md` imports it (`@.claude/ECOSYSTEM.md`), so anyone who clones *any single repo* gets the whole picture. | every repo |
| `.claude/agents/strutvane-ecosystem-guardian.md` | Reviews a diff in any repo against the ecosystem rules: boundaries, connections, error model, security, tests. | every repo |
| `.claude/skills/strutvane-contribute/SKILL.md` | The standard contribution workflow: understand, change, verify, land on `main`. | every repo |
| `.editorconfig`, `.gitattributes` | Consistent whitespace. **LF line endings forced**, so Windows checkouts never fail the formatter. | every repo |
| `.gitignore` | Ignores env files, Docker files (local-only, [ADR-0006](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0006-docker-local-only.md)) and build output. | library |
| `tsconfig.base.json` | Strictest practical TypeScript settings. Each flag is commented with the bug it prevents. Repos `extends` it. | library, once it has a `package.json` |
| `biome.base.json` | Formatting and lint rules (Biome). Repos `extends` it from their own `biome.json`. | library, once it has a `package.json` |
| `vitest.shared.ts` | Test defaults: no silent passes, type-level tests on, coverage thresholds (90/90/85/90). Repos merge it in `vitest.config.ts`. | library, once it has a `package.json` |
| `.github/workflows/ci.yml` | Quality gate on Linux, Windows and macOS × Node 24 and 26, with actions pinned to commit SHAs. | library, once it has a `package.json` |
| `.github/workflows/release.yml` | On every push to `main`: quality gate, then **stages** every new version on npm through trusted publishing (OIDC, no tokens) with provenance. A maintainer approves each staged version on npmjs.com with 2FA ([ADR-0016](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0016-release-flow-version-on-main.md), [ADR-0018](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0018-staged-npm-publishing.md)). Gated behind the repo variable `RELEASE_ENABLED=true`. | library, once it has a `package.json` |
| `.github/scripts/publish-if-new.mjs` | Stages each package whose version is neither published nor staged. One package from the root, or, when the root is private, every non-private `pnpm-workspace.yaml` package from its own folder, in dependency order. | library, once it has a `package.json` |
| `.github/scripts/check-deps.mjs` | Fails on `link:`/`file:`/`workspace:`/path dependencies in the root and every workspace package, and on local overrides. | library, once it has a `package.json` |
| `.github/scripts/workspace-packages.mjs` | Shared, dependency-free reader for `pnpm-workspace.yaml` `packages:` (plain paths and `dir/*` only; anything else is rejected). | library, once it has a `package.json` |
| `.github/dependabot.yml` | Weekly grouped updates for actions and npm deps. | any repo with a `package.json` |

The list and the profiles live in [`manifest.json`](manifest.json). Changing the shared memory works like any other config: edit `canonical/.claude/ECOSYSTEM.md`, run `pnpm sync`, and commit in each repo.

## Every package repo follows the same contract

Each repo's `package.json` provides these scripts. CI only ever calls `ci`:

| Script | Runs |
|---|---|
| `lint` | `biome check .` |
| `typecheck` | `tsc --noEmit` |
| `test` | `vitest run` |
| `build` | `tsdown` |
| `ci` | all of the above, in that order. Scripts call the tools directly, never `pnpm run …`, so they work wherever pnpm is invoked from (corepack, CI, global install). |

## Using the sync script

The script runs from the local umbrella folder, where package repos sit side by side under `packages/<name>/`:

```bash
pnpm sync          # write canonical files into every repo that needs them
pnpm sync:dry      # preview: show what would change, write nothing
pnpm sync:check    # exit 1 if any repo has drifted (use before releases)
node scripts/sync.mjs --repo contracts --repo core   # only some repos
```

**What it guarantees:**
- **No dependencies:** it uses only Node built-ins, and it is cross-platform.
- **No false drift from line endings:** they are normalised to LF, so Windows `autocrlf` never shows a difference that isn't real.
- **Never deletes anything,** and never touches files that aren't in the manifest.
- **Validates the manifest first.** Path traversal and unknown repos are rejected, so a broken manifest can't cause a partial sync.

### Changing a shared config (the process)

1. Edit the file in `canonical/`. Explain the *why* in a comment.
2. Run `pnpm sync:dry` to see which repos change.
3. Run `pnpm sync`. Then, in each affected repo, run its `ci` script locally and commit with the message `chore: sync tooling configs`.
4. Open the tooling PR, linking the package-repo commits.

## Releasing packages (trusted publishing)

Versions are bumped in normal commits on `main` (`changeset version`, then `chore(release): <name>@<version>`). CI then **stages** every version that is new, using npm **trusted publishing**, and a maintainer approves each one on npmjs.com with 2FA. No npm token exists anywhere, and a CI run alone can never make a version live (ADR-0016, ADR-0018).

A repo with a private root and several packages in `pnpm-workspace.yaml` (such as strutvane-cli) gets each non-private workspace package staged from its own folder, dependencies first. Those packages must depend on each other by exact published version, never `workspace:`, because `npm stage publish` does not rewrite that protocol; `check-deps.mjs` enforces it.

**One-time setup per published package on npmjs.com** (each workspace package needs its own):
1. Open **Package → Settings → Trusted publishing → GitHub Actions**.
2. Set the owner to `vishwajit-vm`, the repository to the package's repo, the workflow to `release.yml`, no environment, and leave both **"Allow npm publish"** and **"Allow npm dist-tag"** unticked (staging only).
3. Set the repo variable `RELEASE_ENABLED=true`.

## Developing this repo

```bash
corepack pnpm@12.18.0 install   # or: pnpm install
corepack pnpm@12.18.0 run ci    # lint + the sync script's tests (node --test)
```

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
