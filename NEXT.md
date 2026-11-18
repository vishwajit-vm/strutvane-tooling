# NEXT.md: strutvane-tooling, branch `feat/more-targets`

Facts here are checked against git and the gate output; anything the coordinator has not re-run
is *(agent-reported)*.

## Done
- New `library` targets: `social-login`, `search`, `import-export`, `redis`, `health`, `charts`
  (`files` was already one). `manifest.test.mjs`: the add-ons are library targets; target names
  are unique.
- Gate: `npm run ci` 3× green, 146 tests *(agent-reported)*.

## Next
1. Coordinator: re-run the gate, push `main`.
2. Each new target's synced commit sits on its `v2/<name>` branch; push those with the branch.
3. Per repo settings (maintainer only): repo variable `RELEASE_ENABLED=true` and an npm trusted
   publisher (org `vishwajit-vm`, repo `strutvane-<name>`, workflow `release.yml`).

## How to verify
```bash
npm ci
npm run ci
node scripts/sync.mjs --check --repo social-login --repo search --repo import-export --repo redis --repo health --repo charts
```
