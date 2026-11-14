// Tests for scripts/sync.mjs, run with Node's built-in test runner: `node --test`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  applySync,
  DRIFT,
  formatReport,
  normalize,
  parseArgs,
  parseManifest,
  planSync,
} from './sync.mjs'

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

describe('retired files and target notes', () => {
  /** A fixture with one retired file, present in one repo and absent from another. */
  function retiredFixture() {
    const f = fixture()
    write(join(f.rootDir, 'withcode/.github/scripts/old.mjs'), 'old\n')
    const manifest = parseManifest({
      targets: [{ name: 'withcode', profile: 'library', note: 'a note' }, 'nocode', 'absent'],
      files: [{ path: '.editorconfig', when: 'always' }],
      retired: [{ path: '.github/scripts/old.mjs', reason: 'replaced by new.mjs' }],
    })
    return { ...f, manifest }
  }

  test('a target note is kept; a non-string note is rejected', () => {
    const m = retiredFixture().manifest
    assert.equal(m.targets[0]?.note, 'a note')
    assert.throws(
      () =>
        parseManifest({
          targets: [{ name: 'x', profile: 'library', note: 3 }],
          files: [{ path: 'a', when: 'always' }],
        }),
      /note/,
    )
  })

  test('retired entries are validated like files and must give a reason', () => {
    const base = { targets: ['core'], files: [{ path: 'a', when: 'always' }] }
    assert.deepEqual(parseManifest(base).retired, [])
    assert.throws(() => parseManifest({ ...base, retired: {} }), /retired/)
    assert.throws(
      () => parseManifest({ ...base, retired: [{ path: '../x', reason: 'r' }] }),
      /relative/,
    )
    assert.throws(() => parseManifest({ ...base, retired: [{ path: 'x' }] }), /reason/)
    assert.throws(() => parseManifest({ ...base, retired: [{ path: 'a', reason: 'r' }] }), /both/)
  })

  test('a retired file still present is drift; absent, or in a missing repo, it is nothing', () => {
    const actions = planSync(retiredFixture())
    const retired = actions.filter((a) => a.status === 'retired')
    assert.deepEqual(
      retired.map((a) => [a.repo, a.path, a.reason]),
      [['withcode', '.github/scripts/old.mjs', 'replaced by new.mjs']],
    )
    assert.ok(DRIFT.includes('retired'))
  })

  test('sync never deletes a retired file', () => {
    const f = retiredFixture()
    applySync(planSync(f))
    assert.ok(existsSync(join(f.rootDir, 'withcode/.github/scripts/old.mjs')))
  })

  test('the report tells you to delete retired files and lists missing repos once', () => {
    const report = formatReport(planSync(retiredFixture()), { check: true, dryRun: false })
    assert.match(
      report,
      /! withcode\/\.github\/scripts\/old\.mjs \(retired: delete it in that repo\. replaced by new\.mjs\)/,
    )
    assert.match(report, /\? absent \(folder not found, skipped\)/)
    assert.equal(report.match(/\? absent/g)?.length, 1)
    assert.match(report, /Run: npm run sync/)
  })
})

// End to end: the real CLI, real manifest.json and real canonical/ files, against a throw-away
// copy of the repo layout. Proves idempotence and the --check / --dry-run contract.
describe('sync.mjs CLI on the real manifest', () => {
  const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'sync.mjs')
  /** Run the CLI with `--root <dir>/packages`, so the hub target is `<dir>`. */
  const cli = (...args) =>
    spawnSync(process.execPath, [SCRIPT, '--root', join(dir, 'packages'), ...args], {
      encoding: 'utf8',
    })
  /** Library repos with a package.json, a site repo, and the hub; other targets are missing. */
  function layout() {
    for (const repo of ['framework', 'auth', 'docs']) {
      write(join(dir, 'packages', repo, 'package.json'), '{}')
    }
  }

  test('--check fails on drift, sync fixes it, a second sync writes nothing, --check passes', () => {
    layout()
    const before = cli('--check')
    assert.equal(before.status, 1, before.stderr)
    assert.match(before.stdout, /\+ framework\/\.npmrc \(create\)/)
    assert.match(before.stdout, /\+ framework\/\.github\/workflows\/ci\.yml \(create\)/)
    // Missing repos are reported once each and never fail the check by themselves.
    assert.match(before.stdout, /\? ui \(folder not found, skipped\)/)
    assert.doesNotMatch(before.stdout, /\bcore\b|contracts|devkit/)

    const first = cli()
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /Wrote \d+ file\(s\)/)
    const second = cli()
    assert.match(second.stdout, /Wrote 0 file\(s\)/)
    const after = cli('--check')
    assert.equal(after.status, 0, after.stdout)
    assert.match(after.stdout, /All repos are in sync\./)
    // Profiles: the site repo and the hub got the shared memory but no library configs.
    assert.ok(existsSync(join(dir, 'packages/docs/.claude/ECOSYSTEM.md')))
    assert.ok(!existsSync(join(dir, 'packages/docs/.npmrc')))
    assert.ok(existsSync(join(dir, '.claude/ECOSYSTEM.md')))
    assert.ok(!existsSync(join(dir, '.github/workflows/ci.yml')))
  })

  test('a leftover retired file fails --check until it is deleted by hand', () => {
    layout()
    cli()
    write(join(dir, 'packages/auth/.github/scripts/workspace-packages.mjs'), '// old\n')
    const r = cli('--check')
    assert.equal(r.status, 1)
    assert.match(r.stdout, /! auth\/\.github\/scripts\/workspace-packages\.mjs \(retired/)
    rmSync(join(dir, 'packages/auth/.github/scripts/workspace-packages.mjs'))
    assert.equal(cli('--check').status, 0)
  })

  test('--dry-run reports and writes nothing; an absorbed repo name is refused', () => {
    layout()
    const r = cli('--dry-run')
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Dry run: \d+ file\(s\) out of sync/)
    assert.ok(!existsSync(join(dir, 'packages/framework/.npmrc')))
    const absorbed = cli('--repo', 'core')
    assert.equal(absorbed.status, 2)
    assert.match(absorbed.stderr, /unknown repo\(s\): core/)
  })

  test('a locally edited synced file is drift that sync restores', () => {
    layout()
    cli()
    const file = join(dir, 'packages/framework/.github/workflows/ci.yml')
    writeFileSync(file, readFileSync(file, 'utf8').replace('npm ci', 'npm install'))
    const r = cli('--check', '--repo', 'framework')
    assert.equal(r.status, 1)
    assert.match(r.stdout, /~ framework\/\.github\/workflows\/ci\.yml \(update\)/)
    cli('--repo', 'framework')
    assert.equal(cli('--check', '--repo', 'framework').status, 0)
  })
})
