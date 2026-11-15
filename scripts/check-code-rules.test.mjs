// Tests for canonical/.github/scripts/check-code-rules.mjs (node --test).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkRepo,
  findConsoleUses,
  findUntrackedTodos,
  parseAllowConsole,
} from '../canonical/.github/scripts/check-code-rules.mjs'

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../canonical/.github/scripts/check-code-rules.mjs',
)

const tempDirs = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Create a temp repo holding `files` (relative path → content; objects become JSON). */
function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'sv-code-rules-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return root
}

describe('findConsoleUses', () => {
  test('finds console calls in every form', () => {
    const text = [
      'console.log(1)',
      'globalThis.console.error(x)',
      'console?.warn(x)',
      "console['info'](x)",
      'console . debug(x)',
      'foo(); console.log(x) // trailing comment does not hide it',
    ].join('\n')
    assert.deepEqual(findConsoleUses(text), [1, 2, 3, 4, 5, 6])
  })
  test('ignores comment lines (TSDoc examples), and names that only contain "console"', () => {
    const text = [
      '/**',
      ' * @example console.log(format(x))',
      ' */',
      '// console.log(debug)',
      '/* console.log(x) */',
      'const myconsole = 1',
      'export const consoleLike = { log() {} }',
      "import { Console } from 'node:console'",
    ].join('\r\n')
    assert.deepEqual(findConsoleUses(text), [])
  })
})

describe('findUntrackedTodos', () => {
  test('a TODO or FIXME needs (#n) or an issues URL on the same line', () => {
    const text = [
      '// TODO: tidy this',
      '// FIXME handle EPIPE',
      '// TODO(#42): tidy this',
      '// FIXME see https://github.com/vishwajit-vm/strutvane-framework/issues/7',
      '// TODO see #42', // a bare #42 is not enough: it must be "(#42)"
      'const todoList = []', // lower case and identifiers are not markers
      'const TODO_LIMIT = 3',
    ].join('\n')
    assert.deepEqual(findUntrackedTodos(text), [1, 2, 5])
  })
})

describe('parseAllowConsole', () => {
  test('reads exact src/ paths; absent means none', () => {
    assert.deepEqual(parseAllowConsole({}), [])
    assert.deepEqual(parseAllowConsole({ strutvane: { commands: './x' } }), [])
    assert.deepEqual(parseAllowConsole({ strutvane: { allowConsole: ['src/console/bin.ts'] } }), [
      'src/console/bin.ts',
    ])
  })
  test('rejects globs, traversal, Windows separators, paths outside src/ and bad shapes', () => {
    for (const bad of [
      'src/**',
      'src/*.ts',
      'src/../x.ts',
      'src\\bin.ts',
      'lib/bin.ts',
      'src//bin.ts',
      './src/bin.ts',
      3,
    ]) {
      assert.throws(() => parseAllowConsole({ strutvane: { allowConsole: [bad] } }), /exact path/)
    }
    assert.throws(() => parseAllowConsole({ strutvane: { allowConsole: 'src/a.ts' } }), /array/)
    assert.throws(() => parseAllowConsole({ strutvane: [] }), /object/)
  })
})

describe('checkRepo', () => {
  test('a clean repo passes; tests may use the console', () => {
    const repo = makeRepo({
      'package.json': { name: 'x' },
      'src/index.ts': 'export const a = 1\n',
      'test/a.test.ts': 'console.log("debugging a test is fine")\n',
    })
    assert.deepEqual(checkRepo(repo), [])
  })
  test('console in src/ fails with file and line; the allowlist exempts exact files only', () => {
    const files = {
      'src/console/bin.ts': 'console.log("usage")\n',
      'src/core/log.ts': 'export {}\nconsole.error("x")\n',
    }
    const strict = makeRepo({ 'package.json': { name: 'x' }, ...files })
    assert.deepEqual(checkRepo(strict), [
      'src/console/bin.ts:1: console call in package code; use the framework Logger',
      'src/core/log.ts:2: console call in package code; use the framework Logger',
    ])
    const allowed = makeRepo({
      'package.json': { name: 'x', strutvane: { allowConsole: ['src/console/bin.ts'] } },
      ...files,
    })
    assert.deepEqual(checkRepo(allowed), [
      'src/core/log.ts:2: console call in package code; use the framework Logger',
    ])
  })
  test('stale allowlist entries fail: missing files and files that no longer use the console', () => {
    const repo = makeRepo({
      'package.json': { name: 'x', strutvane: { allowConsole: ['src/a.ts', 'src/gone.ts'] } },
      'src/a.ts': 'export const a = 1\n',
    })
    assert.deepEqual(checkRepo(repo), [
      'src/a.ts: listed in strutvane.allowConsole but no longer uses the console',
      'strutvane.allowConsole lists src/gone.ts, which does not exist',
    ])
  })
  test('untracked TODOs fail in src/ and test/; node_modules and hidden folders are skipped', () => {
    const repo = makeRepo({
      'package.json': { name: 'x' },
      'src/a.ts': '// TODO tidy\n',
      'test/b.test.ts': '// FIXME(#3) ok\n// FIXME flaky\n',
      'src/node_modules/dep/index.js': 'console.log("vendored")\n// TODO x\n',
      'src/.cache/x.js': 'console.log(1)\n',
      'src/notes.md': 'TODO: not source\n',
    })
    assert.deepEqual(checkRepo(repo), [
      'src/a.ts:1: TODO/FIXME without an issue reference "(#123)" or issue URL',
      'test/b.test.ts:2: TODO/FIXME without an issue reference "(#123)" or issue URL',
    ])
  })
})

describe('check-code-rules.mjs (script)', () => {
  const runIn = (repo) => spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8' })

  test('exits 0 when clean and 1 with every problem listed', () => {
    const clean = runIn(makeRepo({ 'package.json': { name: 'x' }, 'src/a.ts': 'export {}\n' }))
    assert.equal(clean.status, 0, clean.stderr)
    const dirty = runIn(makeRepo({ 'package.json': { name: 'x' }, 'src/a.ts': 'console.log(1)\n' }))
    assert.equal(dirty.status, 1)
    assert.match(dirty.stderr, /R1.*\n {2}- src\/a\.ts:1: console call/)
  })
  test('a broken allowlist or package.json fails closed', () => {
    const bad = runIn(
      makeRepo({ 'package.json': { name: 'x', strutvane: { allowConsole: ['src/*'] } } }),
    )
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /check-code-rules failed: .*exact path/)
    assert.equal(runIn(makeRepo({ 'package.json': '{' })).status, 1)
  })
})
