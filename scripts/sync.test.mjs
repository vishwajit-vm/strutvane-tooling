// Tests for scripts/sync.mjs, run with Node's built-in test runner: `node --test`.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { applySync, normalize, parseArgs, parseManifest, planSync } from './sync.mjs'

/** @type {string} */
let dir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sv-sync-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(path, content) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function fixture() {
  const canonicalDir = join(dir, 'canonical')
  const rootDir = join(dir, 'repos')
  write(join(canonicalDir, '.editorconfig'), 'root = true\n')
  write(join(canonicalDir, '.github/workflows/ci.yml'), 'name: CI\n')
  mkdirSync(join(rootDir, 'withcode'), { recursive: true })
  write(join(rootDir, 'withcode/package.json'), '{}')
  mkdirSync(join(rootDir, 'nocode'), { recursive: true })
  const manifest = parseManifest({
    targets: ['withcode', 'nocode', 'absent'],
    files: [
      { path: '.editorconfig', when: 'always' },
      { path: '.github/workflows/ci.yml', when: 'hasPackageJson' },
    ],
  })
  return { canonicalDir, rootDir, manifest }
}

describe('normalize', () => {
  test('converts CRLF and CR to LF and keeps exactly one trailing newline', () => {
    assert.equal(normalize('a\r\nb\rc\n\n\n'), 'a\nb\nc\n')
    assert.equal(normalize('x'), 'x\n')
  })
})

describe('parseManifest', () => {
  test('accepts a valid manifest; string targets are library repos, files default to all profiles', () => {
    const m = parseManifest({ targets: ['core'], files: [{ path: 'a.json', when: 'always' }] })
    assert.deepEqual(m.targets, [{ name: 'core', dir: 'core', profile: 'library' }])
    assert.deepEqual(m.files[0]?.profiles, ['library', 'site', 'meta'])
  })
  test('accepts object targets, including the hub at ".."', () => {
    const m = parseManifest({
      targets: [
        { name: 'docs', profile: 'site' },
        { name: 'hub', dir: '..', profile: 'meta' },
      ],
      files: [{ path: 'a.md', when: 'always', profiles: ['site', 'meta'] }],
    })
    assert.deepEqual(m.targets[1], { name: 'hub', dir: '..', profile: 'meta' })
  })
  test('rejects bad target dirs, unknown profiles and duplicate targets', () => {
    const files = [{ path: 'x', when: 'always' }]
    assert.throws(
      () => parseManifest({ targets: [{ name: 'x', dir: '../..', profile: 'meta' }], files }),
      /dir/,
    )
    assert.throws(
      () => parseManifest({ targets: [{ name: 'x', profile: 'website' }], files }),
      /profile/,
    )
    assert.throws(() => parseManifest({ targets: ['core', 'core'], files }), /duplicate/)
    assert.throws(
      () =>
        parseManifest({ targets: ['core'], files: [{ path: 'x', when: 'always', profiles: [] }] }),
      /profiles/,
    )
  })
  test('rejects path traversal, absolute paths and bad "when" values', () => {
    assert.throws(
      () => parseManifest({ targets: ['core'], files: [{ path: '../x', when: 'always' }] }),
      /relative path/,
    )
    assert.throws(
      () => parseManifest({ targets: ['core'], files: [{ path: '/x', when: 'always' }] }),
      /relative path/,
    )
    assert.throws(
      () => parseManifest({ targets: ['core'], files: [{ path: 'x', when: 'sometimes' }] }),
      /when/,
    )
  })
  test('rejects invalid targets and empty file lists', () => {
    assert.throws(
      () => parseManifest({ targets: ['Bad Name'], files: [{ path: 'x', when: 'always' }] }),
      /targets/,
    )
    assert.throws(() => parseManifest({ targets: ['core'], files: [] }), /files/)
    assert.throws(() => parseManifest(null), /object/)
  })
})

describe('profiles', () => {
  test('a file is only synced into repos whose profile it lists', () => {
    const canonicalDir = join(dir, 'canonical')
    const rootDir = join(dir, 'packages')
    write(join(canonicalDir, 'tsconfig.base.json'), '{}')
    write(join(canonicalDir, '.claude/ECOSYSTEM.md'), '# memory')
    mkdirSync(join(rootDir, 'lib'), { recursive: true })
    mkdirSync(join(rootDir, 'site'), { recursive: true })
    const manifest = parseManifest({
      targets: [
        { name: 'lib', profile: 'library' },
        { name: 'site', profile: 'site' },
        { name: 'hub', dir: '..', profile: 'meta' },
      ],
      files: [
        { path: 'tsconfig.base.json', when: 'always', profiles: ['library'] },
        { path: '.claude/ECOSYSTEM.md', when: 'always' },
      ],
    })
    const status = Object.fromEntries(
      planSync({ canonicalDir, rootDir, manifest }).map((a) => [`${a.repo}:${a.path}`, a.status]),
    )
    assert.equal(status['lib:tsconfig.base.json'], 'create')
    assert.equal(status['site:tsconfig.base.json'], 'skipped-profile')
    assert.equal(status['hub:tsconfig.base.json'], 'skipped-profile')
    assert.equal(status['lib:.claude/ECOSYSTEM.md'], 'create')
    assert.equal(status['site:.claude/ECOSYSTEM.md'], 'create')
    // The hub target resolves to the parent of rootDir (the temp dir itself), which exists.
    assert.equal(status['hub:.claude/ECOSYSTEM.md'], 'create')
  })
})

describe('planSync + applySync', () => {
  test('plans create / skip correctly for each repo state', () => {
    const actions = planSync(fixture())
    const status = Object.fromEntries(actions.map((a) => [`${a.repo}:${a.path}`, a.status]))
    assert.equal(status['withcode:.editorconfig'], 'create')
    assert.equal(status['withcode:.github/workflows/ci.yml'], 'create')
    assert.equal(status['nocode:.editorconfig'], 'create')
    assert.equal(status['nocode:.github/workflows/ci.yml'], 'skipped-no-package-json')
    assert.equal(status['absent:.editorconfig'], 'skipped-missing-repo')
  })

  test('applies changes, then reports everything unchanged (idempotent)', () => {
    const f = fixture()
    assert.equal(applySync(planSync(f)), 3)
    assert.equal(
      readFileSync(join(f.rootDir, 'withcode/.github/workflows/ci.yml'), 'utf8'),
      'name: CI\n',
    )
    const second = planSync(f).filter((a) => a.status === 'create' || a.status === 'update')
    assert.equal(second.length, 0)
  })

  test('CRLF-only differences are not drift', () => {
    const f = fixture()
    applySync(planSync(f))
    writeFileSync(join(f.rootDir, 'withcode/.editorconfig'), 'root = true\r\n')
    const drift = planSync(f).filter((a) => a.repo === 'withcode' && a.path === '.editorconfig')
    assert.equal(drift[0]?.status, 'unchanged')
  })

  test('detects a locally edited managed file as drift', () => {
    const f = fixture()
    applySync(planSync(f))
    writeFileSync(join(f.rootDir, 'withcode/.editorconfig'), 'root = false\n')
    const drift = planSync(f).filter((a) => a.repo === 'withcode' && a.path === '.editorconfig')
    assert.equal(drift[0]?.status, 'update')
  })

  test('rejects repos that are not in the manifest', () => {
    assert.throws(() => planSync({ ...fixture(), repos: ['nope'] }), /unknown repo/)
  })

  test('fails loudly when a canonical file is missing', () => {
    const f = fixture()
    rmSync(join(f.canonicalDir, '.editorconfig'))
    assert.throws(() => planSync(f), /canonical file missing/)
  })
})

describe('parseArgs', () => {
  test('parses flags and repeated --repo', () => {
    assert.deepEqual(parseArgs(['--check', '--repo', 'core', '--repo', 'ui', '--root', '..']), {
      check: true,
      dryRun: false,
      repos: ['core', 'ui'],
      root: '..',
    })
  })
  test('rejects unknown flags and missing values', () => {
    assert.throws(() => parseArgs(['--nope']), /unknown argument/)
    assert.throws(() => parseArgs(['--repo']), /needs a value/)
    assert.throws(() => parseArgs(['--repo', '--check']), /needs a value/)
  })
})
