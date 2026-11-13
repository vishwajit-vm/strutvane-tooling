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
/**
 * Repo profile. Each repo kind gets only the files that make sense for it:
 * - `library`: a TypeScript package repo (gets tsconfig/biome/vitest/CI/release),
 * - `site`: the docs site (Astro; has its own build config),
 * - `meta`: the hub/blueprint repo and the tooling repo itself.
 * @typedef {'library' | 'site' | 'meta'} Profile
 */
/** @typedef {{ path: string, when: When, profiles: Profile[] }} ManifestFile */
/** @typedef {{ name: string, dir: string, profile: Profile }} Target */
/** @typedef {{ targets: Target[], files: ManifestFile[] }} Manifest */
/** @typedef {'create' | 'update' | 'unchanged' | 'skipped-no-package-json' | 'skipped-missing-repo' | 'skipped-profile'} Status */
/** @typedef {{ repo: string, path: string, status: Status, target: string, content?: string }} Action */

/** @type {readonly Profile[]} */
const PROFILES = ['library', 'site', 'meta']
const NAME_PATTERN = /^[a-z0-9-]+$/

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
  if (!Array.isArray(m.targets) || m.targets.length === 0) {
    throw new Error('manifest: "targets" must be a non-empty array')
  }
  const targets = m.targets.map((t, i) => parseTarget(t, i))
  const names = targets.map((t) => t.name)
  const duplicate = names.find((n, i) => names.indexOf(n) !== i)
  if (duplicate) throw new Error(`manifest: duplicate target "${duplicate}"`)

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
    const profiles = file.profiles === undefined ? [...PROFILES] : file.profiles
    if (
      !Array.isArray(profiles) ||
      profiles.length === 0 ||
      profiles.some((p) => !PROFILES.includes(p))
    ) {
      throw new Error(
        `manifest: files[${i}].profiles must list one or more of ${PROFILES.join(', ')}`,
      )
    }
    return {
      path: file.path,
      when: /** @type {When} */ (file.when),
      profiles: /** @type {Profile[]} */ (profiles),
    }
  })
  return { targets, files }
}

/**
 * A target is either a folder name (shorthand for a `library` repo in that folder) or an object
 * `{ name, dir?, profile }`. `dir` defaults to `name`; the only path allowed besides a plain
 * folder name is `..` (the hub repo, which contains the package folders).
 * @param {unknown} value
 * @param {number} index
 * @returns {Target}
 */
function parseTarget(value, index) {
  if (typeof value === 'string') {
    if (!NAME_PATTERN.test(value))
      throw new Error(`manifest: targets[${index}] is not a valid repo folder name`)
    return { name: value, dir: value, profile: 'library' }
  }
  const t = /** @type {Record<string, unknown>} */ (value ?? {})
  if (typeof t.name !== 'string' || !NAME_PATTERN.test(t.name)) {
    throw new Error(`manifest: targets[${index}].name must be a lowercase name`)
  }
  const dir = t.dir === undefined ? t.name : t.dir
  if (typeof dir !== 'string' || !(dir === '..' || NAME_PATTERN.test(dir))) {
    throw new Error(`manifest: targets[${index}].dir must be a folder name or ".."`)
  }
  if (typeof t.profile !== 'string' || !PROFILES.includes(/** @type {Profile} */ (t.profile))) {
    throw new Error(`manifest: targets[${index}].profile must be one of ${PROFILES.join(', ')}`)
  }
  return { name: t.name, dir, profile: /** @type {Profile} */ (t.profile) }
}

/**
 * Compute what a sync would do. Pure with respect to the target repos (reads only).
 * @param {{ canonicalDir: string, rootDir: string, manifest: Manifest, repos?: string[] }} options
 * @returns {Action[]}
 */
export function planSync({ canonicalDir, rootDir, manifest, repos }) {
  const known = manifest.targets.map((t) => t.name)
  const unknown = (repos ?? []).filter((r) => !known.includes(r))
  if (unknown.length > 0)
    throw new Error(`unknown repo(s): ${unknown.join(', ')} (not in manifest targets)`)
  const selected =
    repos && repos.length > 0
      ? manifest.targets.filter((t) => repos.includes(t.name))
      : manifest.targets

  /** @type {Action[]} */
  const actions = []
  for (const { name: repo, dir, profile } of selected) {
    const repoDir = join(rootDir, dir)
    const hasRepo = existsSync(repoDir)
    const hasPackageJson = hasRepo && existsSync(join(repoDir, 'package.json'))
    for (const file of manifest.files) {
      const target = join(repoDir, file.path)
      if (!file.profiles.includes(profile)) {
        actions.push({ repo, path: file.path, status: 'skipped-profile', target })
        continue
      }
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

  /** @type {Record<Status, string>} */
  const symbol = {
    create: '+',
    update: '~',
    unchanged: '=',
    'skipped-no-package-json': '-',
    'skipped-missing-repo': '?',
    'skipped-profile': '-',
  }
  /** Statuses that are expected and need no attention, so they are not printed. */
  const quiet = new Set(['unchanged', 'skipped-no-package-json', 'skipped-profile'])
  for (const a of actions) {
    if (quiet.has(a.status)) continue
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
