# CLAUDE.md: Strutvane Tooling

## Ecosystem memory (shared by every Strutvane repo)

The file below is synced from strutvane-tooling and is identical in every repo. It covers how the whole ecosystem fits together: repo map, decisions, connection rules, standards, workflow and current status. Read it before changing anything.

@.claude/ECOSYSTEM.md

## What this repo is

Canonical configs and CI workflows for every Strutvane package repo, plus `scripts/sync.mjs`, which copies them into `../<repo>`. It is not published to npm (`private: true`). Repos stay standalone: they commit their copies.

Hub/blueprint: `../../docs/` (decisions D1–D24 in `00-executive-summary.md` win over anything here).

## Rules

- Change shared configs only in `canonical/`, then run `npm run sync`. Never hand-edit synced copies in package repos.
- Every config flag needs a comment explaining which bug it prevents, or why it exists.
- `sync.mjs` must stay dependency-free and cross-platform. Every behaviour change needs a test in `scripts/*.test.mjs` (`node --test`). Tests may use dev dependencies (e.g. `yaml`); the synced scripts may not.
- GitHub Actions are pinned to **full commit SHAs**, with the tag in a trailing comment. Dependabot bumps them.
- Package-repo scripts call tools directly (`biome`, `tsc`, `vitest`, `tsdown`), never `npm run x` inside another script, so each step is visible and runs the same everywhere.
- No Docker files, no `.env` files, no secrets, ever.

## Commands

- `npm ci`, then `npm run ci`: lint + tests (must pass before commit). npm only (npm >= 11.19); this repo has no pnpm.
- `npm run sync:dry` / `sync` / `sync:check` (or `node scripts/sync.mjs --check --repo <name>`)

## Map

- `canonical/`: files synced into every repo, filtered by repo profile (`library` / `site` / `meta` / `app-template`, see `manifest.json`), including the shared ecosystem memory `canonical/.claude/ECOSYSTEM.md`, the `strutvane-ecosystem-guardian` agent and the `strutvane-contribute` skill. Profile-specific variants (e.g. the app template's tsconfig and CI) live under `canonical/<profile>/` and are named by the manifest entry's `source`
- `scripts/sync.mjs` + `sync.test.mjs`: the sync engine and its tests; `manifest.test.mjs` (the real manifest and canonical tree), `workflows.test.mjs` (YAML, npm only, pinned actions, permissions), `check-deps.test.mjs`, `check-code-rules.test.mjs`, `check-package.test.mjs`, `publish-if-new.test.mjs`
- `.claude/skills/sync-configs/`: playbook for changing a shared config
- `.claude/agents/config-change-reviewer.md`: reviews config/CI changes
