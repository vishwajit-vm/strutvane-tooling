// Tests for canonical/.github/scripts/check-deps.mjs (node --test).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  findLocalDeps,
  findLockfileProblems,
  findRepoLocalDeps,
} from '../canonical/.github/scripts/check-deps.mjs'

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../canonical/.github/scripts/check-deps.mjs',
)

const tempDirs = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Create a temp repo holding `files` (relative path → content; objects become JSON). */
function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'sv-check-deps-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return root
}

const REG = 'https://registry.npmjs.org'
/** A v3 lockfile with the given `packages` entries next to the root entry. */
const lock = (packages) => ({
  name: 'x',
  lockfileVersion: 3,
  packages: { '': { name: 'x' }, ...packages },
})

describe('findLocalDeps', () => {
  test('accepts registry versions, ranges and aliases', () => {
    const pkg = { dependencies: { a: '1.0.0', b: '^2.0.0' }, devDependencies: { c: 'npm:d@1' } }
    assert.deepEqual(findLocalDeps(pkg, ''), [])
  })
  test('flags link:, file:, workspace: and path specs in any dependency field', () => {
    const pkg = {
      dependencies: { a: 'link:../a', b: 'file:../b' },
      devDependencies: { c: 'workspace:*', d: '../d' },
      peerDependencies: { e: 'C:\\e' },
      optionalDependencies: { f: '/abs/f' },
    }
    assert.equal(findLocalDeps(pkg, '').length, 6)
  })
  test('flags local npm overrides, including nested ones', () => {
    const pkg = {
      overrides: {
        a: '1.0.0',
        '@strutvane/framework': 'file:../framework',
        b: { c: 'link:../c', '.': '2.0.0' },
      },
    }
    assert.deepEqual(findLocalDeps(pkg, ''), [
      'overrides.@strutvane/framework = "file:../framework"',
      'overrides.b.c = "link:../c"',
    ])
  })
  test('flags local overrides in a leftover pnpm-workspace.yaml, ignores normal settings', () => {
    const ws =
      "minimumReleaseAgeExclude:\n  - '@strutvane/*'\noverrides:\n  '@strutvane/core': link:../core\n"
    assert.deepEqual(findLocalDeps({}, ws), [
      'pnpm-workspace.yaml: @strutvane/core = "link:../core"',
    ])
  })
})

describe('findLockfileProblems (security review F-21: lockfile injection)', () => {
  test('registry-resolved entries and bundled entries pass', () => {
    const l = lock({
      'node_modules/a': { version: '1.0.0', resolved: `${REG}/a/-/a-1.0.0.tgz` },
      'node_modules/a/node_modules/b': { version: '1.0.0', inBundle: true },
    })
    assert.deepEqual(findLockfileProblems(l), [])
  })
  test('another host, a git URL, a missing resolved or a link fails', () => {
    const l = lock({
      'node_modules/a': { resolved: 'https://evil.example/a-1.0.0.tgz' },
      'node_modules/b': { resolved: 'git+ssh://git@github.com/x/b.git#abc' },
      'node_modules/c': { version: '1.0.0' },
      'node_modules/@strutvane/framework': { resolved: '../framework', link: true },
      // A look-alike host must not pass the prefix check.
      'node_modules/d': { resolved: 'https://registry.npmjs.org.evil.example/d.tgz' },
    })
    const problems = findLockfileProblems(l)
    assert.equal(problems.length, 5, problems.join('\n'))
    assert.match(problems.join('\n'), /@strutvane\/framework is a local link/)
  })
  test('a lockfile that is not v3, or not an object, fails closed', () => {
    const old = findLockfileProblems({ lockfileVersion: 1, dependencies: {} })
    assert.match(old[0] ?? '', /lockfileVersion 3/)
    assert.equal(findLockfileProblems(null).length, 1)
    assert.equal(findLockfileProblems([]).length, 1)
  })
})

describe('findRepoLocalDeps', () => {
  test('checks package.json and package-lock.json together', () => {
    const repo = makeRepo({
      'package.json': { name: 'x', dependencies: { a: 'file:../a' } },
      'package-lock.json': lock({ 'node_modules/a': { link: true } }),
    })
    assert.equal(findRepoLocalDeps(repo).length, 2)
  })
  test('a clean repo passes, with or without a lockfile', () => {
    assert.deepEqual(findRepoLocalDeps(makeRepo({ 'package.json': { name: 'x' } })), [])
    const repo = makeRepo({
      'package.json': { name: 'x', dependencies: { a: '1.0.0' } },
      'package-lock.json': lock({ 'node_modules/a': { resolved: `${REG}/a/-/a-1.0.0.tgz` } }),
    })
    assert.deepEqual(findRepoLocalDeps(repo), [])
  })
  test('an unreadable package.json or lockfile fails closed', () => {
    assert.throws(() => findRepoLocalDeps(makeRepo({ 'package.json': '{' })), /package\.json/)
    assert.throws(() => findRepoLocalDeps(makeRepo({ 'package.json': '[]' })), /JSON object/)
    const badLock = makeRepo({ 'package.json': { name: 'x' }, 'package-lock.json': 'nope' })
    assert.throws(() => findRepoLocalDeps(badLock), /package-lock\.json/)
  })
})

describe('check-deps.mjs (script)', () => {
  const runIn = (repo) => spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8' })

  test('exits 1 and lists each problem', () => {
    const r = runIn(
      makeRepo({
        'package.json': { name: 'x' },
        'package-lock.json': lock({ 'node_modules/a': { resolved: 'https://evil.example/a.tgz' } }),
      }),
    )
    assert.equal(r.status, 1)
    assert.match(r.stderr, /node_modules\/a is resolved from "https:\/\/evil\.example\/a\.tgz"/)
  })
  test('exits 0 on a clean repo, and 1 with a message on a broken file', () => {
    const clean = runIn(makeRepo({ 'package.json': { name: 'x' } }))
    assert.equal(clean.status, 0)
    assert.match(clean.stdout, /no package-lock\.json to check/)
    const locked = runIn(makeRepo({ 'package.json': { name: 'x' }, 'package-lock.json': lock({}) }))
    assert.equal(locked.status, 0)
    assert.match(locked.stdout, /package-lock\.json resolves only from the npm registry/)
    const broken = runIn(makeRepo({ 'package.json': '{' }))
    assert.equal(broken.status, 1)
    assert.match(broken.stderr, /check-deps failed: /)
  })
})
