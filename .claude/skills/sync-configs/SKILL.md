---
name: sync-configs
description: Change a shared Strutvane config or CI workflow safely, sync it to every package repo, and verify each repo still passes its quality gate.
---

# sync-configs

1. **Edit the canonical file** in `canonical/`, never a synced copy.
   - Add a comment explaining why the change is made.
   - For GitHub Actions, pin to the full commit SHA:
     ```bash
     gh api repos/<owner>/<action>/git/ref/tags/<tag>
     ```
     If that returns an annotated tag, dereference it to the commit:
     ```bash
     gh api repos/<owner>/<action>/git/tags/<sha>
     ```
2. **Run `corepack pnpm@12.18.0 run ci`** here, for lint and the sync tests.
3. **Run `corepack pnpm@12.18.0 run sync:dry`** and list the repos and files that will change.
4. **Run `corepack pnpm@12.18.0 run sync`.**
5. **In each affected `../<repo>` that has a package.json,** run:
   ```bash
   corepack pnpm@12.18.0 install
   corepack pnpm@12.18.0 run ci
   ```
   Report the exact results. If one fails, fix the canonical file. Never patch the copy.
6. **Commit in each repo** with the message `chore: sync tooling configs`. Ask the user before pushing.
7. **Confirm** that `corepack pnpm@12.18.0 run sync:check` reports "All repos are in sync."
