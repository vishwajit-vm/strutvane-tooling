// Tests for canonical/.github/scripts/check-package.mjs (node --test). The pure checks are tested
// directly; the script runs the real `npm pack --dry-run` against temp packages.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  checkEngines,
  checkPackFiles,
  checkSourceMap,
} from '../canonical/.github/scripts/check-package.mjs'

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../canonical/.github/scripts/check-package.mjs',
)

const tempDirs = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Create a temp package holding `files` (relative path → content; objects become JSON). */
function makePackage(files) {
  const root = mkdtempSync(join(tmpdir(), 'sv-check-package-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return root
}

const BASE = ['package.json', 'README.md', 'LICENSE', 'dist/index.mjs', 'dist/index.d.mts']

describe('checkPackFiles', () => {
  test('a normal tarball passes', () => {
    assert.deepEqual(checkPackFiles([...BASE, 'dist/testing/index.mjs', '.env.example']), [])
  })
  test('tests, fixtures, coverage, env files, keys and .npmrc fail', () => {
    const bad = [
      'test/a.test.ts',
      'dist/__tests__/x.js',
      'fixtures/app/package.json',
      'coverage/lcov.info',
      'dist/a.spec.mjs',
      'dist/types.test-d.ts',
      '.env',
      'config/.env.production',
      '.npmrc',
      'certs/server.key',
    ]
    const problems = checkPackFiles([...BASE, ...bad])
    assert.equal(problems.length, bad.length, problems.join('\n'))
  })
  test('README and LICENSE must be in the tarball (any case, any extension)', () => {
    assert.deepEqual(checkPackFiles(['package.json', 'readme.md', 'LICENCE.txt']), [])
    assert.deepEqual(checkPackFiles(['package.json']), [
      'README is missing from the package',
      'LICENSE is missing from the package',
    ])
  })
})

describe('checkSourceMap', () => {
  const map = (o) => JSON.stringify({ version: 3, mappings: '', ...o })
  test('relative sources pass', () => {
    assert.deepEqual(checkSourceMap('a.map', map({ sources: ['../src/a.ts'] })), [])
  })
  test('absolute local paths in sources or sourceRoot fail', () => {
    for (const leak of [
      { sources: ['C:\\Users\\dev\\src\\a.ts'] },
      { sources: ['/home/runner/work/x/src/a.ts'] },
      { sources: ['file:///Users/dev/a.ts'] },
      { sourceRoot: '/Users/dev/project', sources: ['a.ts'] },
      { sources: ['\\\\server\\share\\a.ts'] },
    ]) {
      assert.equal(checkSourceMap('a.map', map(leak)).length, 1, JSON.stringify(leak))
    }
  })
  test('an unparsable map fails', () => {
    assert.match(checkSourceMap('a.map', '{')[0] ?? '', /not valid JSON/)
  })
})

describe('checkEngines', () => {
  test('>=24.3 or higher passes', () => {
    for (const node of ['>=24.3', '>=24.3.0', '>= 24.10', '>=26', '>=26.0.0']) {
      assert.deepEqual(checkEngines({ engines: { node } }), [], node)
    }
  })
  test('lower, missing or non-">=" ranges fail', () => {
    for (const engines of [
      { node: '>=24' },
      { node: '>=24.2.9' },
      { node: '>=22' },
      { node: '^24.3.0' },
      { node: '*' },
      {},
      undefined,
    ]) {
      assert.equal(checkEngines({ engines }).length, 1, JSON.stringify(engines))
    }
  })
})

describe('check-package.mjs (script, real npm pack --dry-run)', () => {
  const runIn = (dir) => spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' })
  const manifest = {
    name: 'sv-check-package-fixture',
    version: '1.0.0',
    license: 'MIT',
    engines: { node: '>=24.3' },
    files: ['dist'],
  }

  test('a clean package passes', () => {
    const dir = makePackage({
      'package.json': manifest,
      'README.md': '# x\n',
      LICENSE: 'MIT\n',
      'CHANGELOG.md': '# Changelog\n',
      'dist/index.mjs': 'export const a = 1\n',
      'dist/index.mjs.map': JSON.stringify({ version: 3, sources: ['../src/index.ts'] }),
    })
    const r = runIn(dir)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Package contents OK/)
  })

  test('a leaking package fails with every problem listed', () => {
    const dir = makePackage({
      'package.json': { ...manifest, engines: { node: '>=24' } },
      'README.md': '# x\n',
      'dist/index.mjs': 'export const a = 1\n',
      'dist/index.mjs.map': JSON.stringify({ version: 3, sources: ['C:\\dev\\src\\index.ts'] }),
      'dist/fixtures/data.json': '{}',
    })
    const r = runIn(dir)
    assert.equal(r.status, 1)
    for (const expected of [
      /dist\/fixtures\/data\.json: test, fixture or coverage folder/,
      /LICENSE is missing/,
      /engines\.node is ">=24"/,
      /dist\/index\.mjs\.map: source map has local absolute paths/,
      /CHANGELOG\.md is missing/,
    ]) {
      assert.match(r.stderr, expected)
    }
  })

  test('a private package is skipped', () => {
    const r = runIn(makePackage({ 'package.json': { name: 'meta', private: true } }))
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /private, nothing is published/)
  })
})
