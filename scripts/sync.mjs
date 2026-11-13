#!/usr/bin/env node
// @ts-check
/**
 * strutvane-tooling: config sync
 *
 * Copies the canonical config files in `canonical/` into each Strutvane package repo, so every
 * repo builds, lints, tests and releases the same way, while each repo stays fully standalone
 * (no runtime or build-time dependency on this repo).
 *
 * Usage (from the tooling repo, inside the local umbrella folder):
 *   node scripts/sync.mjs                 # write changes
 *   node scripts/sync.mjs --check         # report drift, exit 1 if any (use in CI / pre-release)
 *   node scripts/sync.mjs --dry-run       # show what would change, write nothing
 *   node scripts/sync.mjs --repo contracts --repo core
 *   node scripts/sync.mjs --root ../      # folder that contains the package repos (default: ..)
 *
 * Guarantees:
 *   - Zero dependencies (Node built-ins only), works on Windows, macOS and Linux.
 *   - Line endings are normalised to LF before comparing and writing, so Git's autocrlf on
 *     Windows never shows false drift.
 *   - Never deletes files. Never touches files that are not listed in manifest.json.
 *   - A missing target repo folder is reported and skipped, never created.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @typedef {'always' | 'hasPackageJson'} When */
/** @typedef {{ path: string, when: When }} ManifestFile */
/** @typedef {{ targets: string[], files: ManifestFile[] }} Manifest */
/** @typedef {'create' | 'update' | 'unchanged' | 'skipped-no-package-json' | 'skipped-missing-repo'} Status */
/** @typedef {{ repo: string, path: string, status: Status, target: string, content?: string }} Action */

const TOOLING_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Normalise text for comparison and writing: LF line endings, exactly one trailing newline. */
export function normalize(/** @type {string} */ text) {
  return `${text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`
}

/**
 * Validate and return a manifest object. Throws a descriptive Error on any problem, so a broken
 * manifest can never cause a partial or surprising sync.
 * @param {unknown} value
 * @returns {Manifest}
 */
export function parseManifest(value) {
  if (typeof value !== 'object' || value === null) throw new Error('manifest: must be an object')
  const m = /** @type {Record<string, unknown>} */ (value)
  if (
    !Array.isArray(m.targets) ||
    m.targets.some((t) => typeof t !== 'string' || !/^[a-z0-9-]+$/.test(t))
  ) {
    throw new Error('manifest: "targets" must be an array of lowercase repo folder names')
  }
  if (!Array.isArray(m.files) || m.files.length === 0)
    throw new Error('manifest: "files" must be a non-empty array')
  const files = m.files.map((f, i) => {
    const file = /** @type {Record<string, unknown>} */ (f ?? {})
    if (
      typeof file.path !== 'string' ||
      file.path.length === 0 ||
      file.path.includes('..') ||
      file.path.startsWith('/')
    ) {
      throw new Error(`manifest: files[${i}].path must be a relative path inside the repo`)
    }
    if (file.when !== 'always' && file.when !== 'hasPackageJson') {
      throw new Error(`manifest: files[${i}].when must be "always" or "hasPackageJson"`)
    }
    return { path: file.path, when: /** @type {When} */ (file.when) }
  })
  return { targets: /** @type {string[]} */ (m.targets), files }
}

/**
 * Compute what a sync would do. Pure with respect to the target repos (reads only).
 * @param {{ canonicalDir: string, rootDir: string, manifest: Manifest, repos?: string[] }} options
 * @returns {Action[]}
 */
export function planSync({ canonicalDir, rootDir, manifest, repos }) {
  const unknown = (repos ?? []).filter((r) => !manifest.targets.includes(r))
  if (unknown.length > 0)
    throw new Error(`unknown repo(s): ${unknown.join(', ')} (not in manifest targets)`)
  const selected = repos && repos.length > 0 ? repos : manifest.targets

  /** @type {Action[]} */
  const actions = []
  for (const repo of selected) {
    const repoDir = join(rootDir, repo)
    const hasRepo = existsSync(repoDir)
    const hasPackageJson = hasRepo && existsSync(join(repoDir, 'package.json'))
    for (const file of manifest.files) {
      const target = join(repoDir, file.path)
      if (!hasRepo) {
        actions.push({ repo, path: file.path, status: 'skipped-missing-repo', target })
        continue
      }
      if (file.when === 'hasPackageJson' && !hasPackageJson) {
        actions.push({ repo, path: file.path, status: 'skipped-no-package-json', target })
        continue
      }
      const source = join(canonicalDir, file.path)
      if (!existsSync(source)) throw new Error(`canonical file missing: ${file.path}`)
      const content = normalize(readFileSync(source, 'utf8'))
      if (!existsSync(target)) {
        actions.push({ repo, path: file.path, status: 'create', target, content })
      } else {
        const current = normalize(readFileSync(target, 'utf8'))
        actions.push({
          repo,
          path: file.path,
          status: current === content ? 'unchanged' : 'update',
          target,
          content,
        })
      }
    }
  }
  return actions
}

/**
 * Write every create/update action to disk.
 * @param {Action[]} actions
 * @returns {number} number of files written
 */
export function applySync(actions) {
  let written = 0
  for (const a of actions) {
    if ((a.status === 'create' || a.status === 'update') && a.content !== undefined) {
      mkdirSync(dirname(a.target), { recursive: true })
      writeFileSync(a.target, a.content, 'utf8')
      written++
    }
  }
  return written
}

/** Parse CLI arguments. Exported for tests. */
export function parseArgs(/** @type {string[]} */ argv) {
  /** @type {{ check: boolean, dryRun: boolean, repos: string[], root: string | undefined }} */
  const opts = { check: false, dryRun: false, repos: [], root: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') opts.check = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--repo' || arg === '--root') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      if (arg === '--repo') opts.repos.push(value)
      else opts.root = value
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const manifest = parseManifest(
    JSON.parse(readFileSync(join(TOOLING_DIR, 'manifest.json'), 'utf8')),
  )
  const rootDir = resolve(TOOLING_DIR, opts.root ?? '..')
  const actions = planSync({
    canonicalDir: join(TOOLING_DIR, 'canonical'),
    rootDir,
    manifest,
    repos: opts.repos,
  })

  const symbol = {
    create: '+',
    update: '~',
    unchanged: '=',
    'skipped-no-package-json': '-',
    'skipped-missing-repo': '?',
  }
  for (const a of actions) {
    if (a.status === 'unchanged' || a.status === 'skipped-no-package-json') continue
    process.stdout.write(`${symbol[a.status]} ${a.repo}/${a.path} (${a.status})\n`)
  }
  const drift = actions.filter((a) => a.status === 'create' || a.status === 'update')
  const summary = `${drift.length} file(s) out of sync across ${new Set(drift.map((a) => a.repo)).size} repo(s)`

  if (opts.check) {
    process.stdout.write(
      drift.length === 0 ? 'All repos are in sync.\n' : `${summary}. Run: pnpm sync\n`,
    )
    process.exitCode = drift.length === 0 ? 0 : 1
    return
  }
  if (opts.dryRun) {
    process.stdout.write(`Dry run: ${summary}. Nothing written.\n`)
    return
  }
  const written = applySync(actions)
  process.stdout.write(`Wrote ${written} file(s). Review and commit the changes in each repo.\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`sync failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
