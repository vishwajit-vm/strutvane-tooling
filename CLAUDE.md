# CLAUDE.md: Strutvane Tooling

## What this repo is

Canonical configs and CI workflows for every Strutvane package repo, plus `scripts/sync.mjs`, which copies them into `../<repo>`. It is not published to npm (`private: true`). Repos stay standalone: they commit their copies.

Hub/blueprint: `../../docs/` (decisions D1–D20 in `00-executive-summary.md` win over anything here).

## Rules

- Change shared configs only in `canonical/`, then run `pnpm sync`. Never hand-edit synced copies in package repos.
- Every config flag needs a comment explaining which bug it prevents, or why it exists.
- `sync.mjs` must stay dependency-free and cross-platform. Every behaviour change needs a test in `scripts/sync.test.mjs` (`node --test`).
- GitHub Actions are pinned to **full commit SHAs**, with the tag in a trailing comment. Dependabot bumps them.
- Package-repo scripts call tools directly (`biome`, `tsc`, `vitest`, `tsdown`), never `pnpm run x`, so they work when pnpm is not on PATH.
- No Docker files, no `.env` files, no secrets, ever.

## Commands

- `corepack pnpm@12.18.0 run ci`: lint + tests (must pass before commit)
- `corepack pnpm@12.18.0 run sync:dry` / `sync` / `sync:check`

## Map

- `canonical/`: files synced into package repos (see `manifest.json`)
- `scripts/sync.mjs` + `sync.test.mjs`: the sync engine and its tests
- `.claude/skills/sync-configs/`: playbook for changing a shared config
- `.claude/agents/config-change-reviewer.md`: reviews config/CI changes
