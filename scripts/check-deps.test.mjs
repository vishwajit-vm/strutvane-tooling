// Tests for canonical/.github/scripts/check-deps.mjs (node --test).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { findLocalDeps, findRepoLocalDeps } from '../canonical/.github/scripts/check-deps.mjs'

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

describe('findLocalDeps', () => {
  test('accepts registry versions and ranges', () => {
    const pkg = { dependencies: { '@strutvane/contracts': '0.1.0-next.0', zod: '^4.6.7' } }
    assert.deepEqual(findLocalDeps(pkg, ''), [])
  })
  test('flags link:, file:, workspace: and path specs in any dependency field', () => {
    const pkg = {
      dependencies: { a: 'link:../a', b: 'workspace:^' },
      devDependencies: { c: 'file:../c', d: '../d', e: 'C:\\x\\e' },
      peerDependencies: { f: '/abs/f' },
    }
    assert.equal(findLocalDeps(pkg, '').length, 6)
  })
  test('flags local overrides in pnpm-workspace.yaml, ignores normal settings', () => {
    const yaml =
      "overrides:\n  '@strutvane/contracts': link:../contracts\nonlyBuiltDependencies:\n  - esbuild\n"
    assert.deepEqual(findLocalDeps({}, yaml), [
      'pnpm-workspace.yaml: @strutvane/contracts = "link:../contracts"',
    ])
  })
  test('the packages list itself is not mistaken for an override', () => {
    assert.deepEqual(findLocalDeps({}, 'packages:\n  - packages/*\n  - ./tools/x\n'), [])
  })
})

describe('findRepoLocalDeps', () => {
  test('a single-package repo checks only its root, as before', () => {
    const repo = makeRepo({ 'package.json': { dependencies: { a: 'link:../a' } } })
    assert.deepEqual(findRepoLocalDeps(repo), ['dependencies.a = "link:../a"'])
  })
  test('checks every workspace package, prefixing problems with its path', () => {
    const repo = makeRepo({
      'package.json': { name: 'ws', private: true, devDependencies: { biome: '2.6.7' } },
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n  - tools/gen\n',
      'packages/cli/package.json': { name: '@s/cli', dependencies: { '@s/core': 'file:../core' } },
      'packages/launcher/package.json': {
        name: 'strutvane',
        dependencies: { '@s/cli': 'workspace:*' },
      },
      'packages/clean/package.json': { name: 'clean', dependencies: { zod: '4.6.7' } },
      'tools/gen/package.json': { name: 'gen', private: true, devDependencies: { x: 'link:../x' } },
    })
    assert.deepEqual(findRepoLocalDeps(repo), [
      'packages/cli/package.json: dependencies.@s/core = "file:../core"',
      'packages/launcher/package.json: dependencies.@s/cli = "workspace:*"',
      'tools/gen/package.json: devDependencies.x = "link:../x"',
    ])
  })
  test('a clean workspace passes', () => {
    const repo = makeRepo({
      'package.json': { name: 'ws', private: true },
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'packages/a/package.json': { name: 'a', dependencies: { b: '1.0.0' } },
      'packages/b/package.json': { name: 'b' },
    })
    assert.deepEqual(findRepoLocalDeps(repo), [])
  })
  test('an unreadable workspace list fails closed', () => {
    const repo = makeRepo({
      'package.json': { name: 'ws', private: true },
      'pnpm-workspace.yaml': 'packages:\n  - "!packages/x"\n',
    })
    assert.throws(() => findRepoLocalDeps(repo), /unsupported packages entry/)
  })
})

describe('check-deps.mjs (script)', () => {
  const runIn = (repo) => spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8' })

  test('exits 1 and lists the workspace package problem', () => {
    const repo = makeRepo({
      'package.json': { name: 'ws', private: true },
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'packages/a/package.json': { name: 'a', dependencies: { b: 'workspace:^' } },
    })
    const r = runIn(repo)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /packages\/a\/package\.json: dependencies\.b = "workspace:\^"/)
  })
  test('exits 0 on a clean repo, and 1 with a message on a broken workspace file', () => {
    assert.equal(runIn(makeRepo({ 'package.json': { name: 'x' } })).status, 0)
    const broken = runIn(
      makeRepo({ 'package.json': { name: 'x' }, 'pnpm-workspace.yaml': 'packages: [a]\n' }),
    )
    assert.equal(broken.status, 1)
    assert.match(broken.stderr, /check-deps failed: .*inline/)
  })
})
