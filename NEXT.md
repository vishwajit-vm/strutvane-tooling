# NEXT.md: strutvane-tooling, branch `feat/npx-and-app-template`

Facts here are checked against git and the gate output; anything the coordinator has not re-run
is *(agent-reported)*.

## Done
- New targets: `npx` (`library`) and `skeleton` (new `app-template` profile).
- `app-template` profile: `.editorconfig`, `.gitattributes`, `.claude/*` shared files, `.npmrc`,
  `biome.base.json`, `dependabot.yml`, `check-deps.mjs`, `check-code-rules.mjs`, `scorecard.yml`,
  plus three variants under `canonical/app-template/`: `tsconfig.base.json` (no
  `isolatedDeclarations` / `declaration` / `declarationMap`), `.github/workflows/ci.yml`
  (verify + repeat without build + security; no package-check, no `workflow_call`) and `.gitignore`
  (library rules + `/.work/`, `*.tgz`). No release workflow, publish/package scripts, Vitest
  configs or `RELEASE-READINESS.md`.
- `sync.mjs`: optional `source` per manifest file entry (variant file for the same target path);
  two entries for one path may not share a profile. Tests: `sync.test.mjs` (variants, validation,
  CLI end to end for skeleton and npx), `manifest.test.mjs` (app-template file set, tsconfig equals
  the library one minus the declaration flags, `.gitignore` superset), `workflows.test.mjs`
  (app-template CI jobs identical to the library jobs, minus the build step and package-check).
- Gate: `npm run ci` 3× green, 144 tests *(agent-reported)*.

## Next
1. Coordinator: re-run the gate, merge into `main`, push.
2. Merge the synced branches in the targets: npx `chore/tooling-sync`, skeleton `v2/skeleton`.
3. Other repos showed drift in `sync:check` against `packages/` before this branch (their checkouts
   are on work branches); not touched here.

## How to verify
```bash
npm ci
npm run ci
node scripts/sync.mjs --check --repo npx --repo skeleton   # in packages/tooling, once both are merged
```
