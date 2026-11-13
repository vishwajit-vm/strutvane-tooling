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

| File (in `canonical/`) | What it does | Synced when |
|---|---|---|
| `tsconfig.base.json` | Strictest practical TypeScript settings. Each flag is commented with the bug it prevents. Repos `extends` it. | repo has `package.json` |
| `biome.base.json` | Formatting and lint rules (Biome). Repos `extends` it from their own `biome.json`. | repo has `package.json` |
| `vitest.shared.ts` | Test defaults: no silent passes, type-level tests on, coverage thresholds (90/90/85/90). Repos merge it in `vitest.config.ts`. | repo has `package.json` |
| `.github/workflows/ci.yml` | Quality gate on Linux, Windows and macOS × Node 24 and 26, with actions pinned to commit SHAs. | repo has `package.json` |
| `.github/workflows/release.yml` | Changesets release PR, then npm **trusted publishing** (OIDC, no tokens) with provenance. | repo has `package.json` |
| `.github/dependabot.yml` | Weekly grouped updates for actions and npm deps. | repo has `package.json` |
| `.editorconfig`, `.gitignore` | Consistent whitespace. Ignores env files, Docker files (local-only, [ADR-0006](https://github.com/vishwajit-vm/strutvane/blob/main/docs/adr/0006-docker-local-only.md)) and build output. | always |

The list lives in [`manifest.json`](manifest.json).

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

Releases use [Changesets](https://github.com/changesets/changesets) with npm **trusted publishing**. No npm token exists anywhere.

**One-time setup per package on npmjs.com:**
1. Open **Package → Settings → Trusted publishing → GitHub Actions**.
2. Set the owner to `vishwajit-vm`, the repository to the package's repo, and the workflow to `release.yml`.
3. After the first successful trusted publish, set **"Require 2FA and disallow tokens"**.

**Each repo needs these scripts:** `version-packages` (`changeset version`) and `release` (`changeset publish`).

> First-release checklist: confirm the publish step uses npm ≥ 11.5 OIDC, and that the provenance badge appears on npmjs.com. Record the result in the repo's `CHANGELOG`.

## Developing this repo

```bash
corepack pnpm@12.18.0 install   # or: pnpm install
corepack pnpm@12.18.0 run ci    # lint + the sync script's tests (node --test)
```

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
