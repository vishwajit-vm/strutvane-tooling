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
    assert.deepEqual(m.files[0]?.profiles, ['library', 'site', 'meta', 'app-template'])
    assert.equal(m.files[0]?.source, 'a.json', 'source defaults to the target path')
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

describe('profile-specific variants (source)', () => {
  /** A library and an app template; the app template gets its own tsconfig and CI. */
  function variantFixture() {
    const canonicalDir = join(dir, 'canonical')
    const rootDir = join(dir, 'packages')
    write(join(canonicalDir, 'tsconfig.base.json'), '{ "isolatedDeclarations": true }\n')
    write(join(canonicalDir, 'app-template/tsconfig.base.json'), '{ "strict": true }\n')
    write(join(canonicalDir, 'release.yml'), 'name: Release\n')
    write(join(rootDir, 'lib/package.json'), '{}')
    write(join(rootDir, 'app/package.json'), '{}')
    const manifest = parseManifest({
      targets: [
        { name: 'lib', profile: 'library' },
        { name: 'app', profile: 'app-template' },
      ],
      files: [
        { path: 'tsconfig.base.json', when: 'hasPackageJson', profiles: ['library'] },
        {
          path: 'tsconfig.base.json',
          source: 'app-template/tsconfig.base.json',
          when: 'hasPackageJson',
          profiles: ['app-template'],
        },
        { path: 'release.yml', when: 'hasPackageJson', profiles: ['library'] },
      ],
    })
    return { canonicalDir, rootDir, manifest }
  }

  test('each profile gets its own source under the same target path', () => {
    const f = variantFixture()
    assert.equal(applySync(planSync(f)), 3)
    assert.equal(
      readFileSync(join(f.rootDir, 'lib/tsconfig.base.json'), 'utf8'),
      '{ "isolatedDeclarations": true }\n',
    )
    assert.equal(
      readFileSync(join(f.rootDir, 'app/tsconfig.base.json'), 'utf8'),
      '{ "strict": true }\n',
    )
    assert.ok(!existsSync(join(f.rootDir, 'app/release.yml')), 'library-only file skipped')
    assert.ok(!existsSync(join(f.rootDir, 'app/app-template')), 'the source folder is not copied')
    // Idempotent: the variant is compared with its own source, not with the library file.
    assert.deepEqual(
      planSync(f)
        .filter((a) => DRIFT.includes(a.status))
        .map((a) => a.path),
      [],
    )
  })

  test('an edited variant copy is drift that sync restores from the variant source', () => {
    const f = variantFixture()
    applySync(planSync(f))
    writeFileSync(join(f.rootDir, 'app/tsconfig.base.json'), '{ "isolatedDeclarations": true }\n')
    const actions = planSync(f)
    // The library entry is also planned for 'app' (as skipped-profile); look at the variant's.
    const app = actions.find(
      (a) => a.repo === 'app' && a.path === 'tsconfig.base.json' && a.status !== 'skipped-profile',
    )
    assert.equal(app?.status, 'update')
    applySync(actions)
    assert.equal(
      readFileSync(join(f.rootDir, 'app/tsconfig.base.json'), 'utf8'),
      '{ "strict": true }\n',
    )
  })

  test('a missing variant source fails loudly and names the source', () => {
    const f = variantFixture()
    rmSync(join(f.canonicalDir, 'app-template/tsconfig.base.json'))
    assert.throws(() => planSync(f), /canonical file missing: app-template\/tsconfig\.base\.json/)
  })

  test('source is validated like a path; one target path may not have two sources for a profile', () => {
    const targets = ['core']
    assert.throws(
      () => parseManifest({ targets, files: [{ path: 'a', source: '../a', when: 'always' }] }),
      /files\[0\]\.source must be a relative path/,
    )
    assert.throws(
      () => parseManifest({ targets, files: [{ path: 'a', source: '/a', when: 'always' }] }),
      /relative path/,
    )
    assert.throws(
      () =>
        parseManifest({
          targets,
          files: [
            { path: 'a', when: 'always', profiles: ['library', 'meta'] },
            { path: 'a', source: 'x/a', when: 'always', profiles: ['meta'] },
          ],
        }),
      /"a" is listed twice for profile "meta"/,
    )
    // Omitting profiles means every profile, so it clashes with any variant.
    assert.throws(
      () =>
        parseManifest({
          targets,
          files: [
            { path: 'a', when: 'always' },
            { path: 'a', source: 'x/a', when: 'always', profiles: ['app-template'] },
          ],
        }),
      /listed twice for profile "app-template"/,
    )
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
    // RELEASE-READINESS.md was created once; the repo can fill it in without causing drift.
    const readiness = join(dir, 'packages/framework/RELEASE-READINESS.md')
    assert.match(readFileSync(readiness, 'utf8'), /\| R9 Operations \|/)
    writeFileSync(readiness, '# filled in\n')
    assert.equal(cli('--check').status, 0)
    assert.equal(readFileSync(readiness, 'utf8'), '# filled in\n')
    // Profiles: the site repo and the hub got the shared memory but no library configs.
    assert.ok(existsSync(join(dir, 'packages/docs/.claude/ECOSYSTEM.md')))
    assert.ok(!existsSync(join(dir, 'packages/docs/.npmrc')))
    assert.ok(existsSync(join(dir, '.claude/ECOSYSTEM.md')))
    assert.ok(!existsSync(join(dir, '.github/workflows/ci.yml')))
  })

  test('the app template (skeleton) gets its own tsconfig and CI, and nothing release-related', () => {
    for (const repo of ['skeleton', 'npx']) write(join(dir, 'packages', repo, 'package.json'), '{}')
    const r = cli('--repo', 'skeleton', '--repo', 'npx')
    assert.equal(r.status, 0, r.stderr)
    const app = (path) => join(dir, 'packages/skeleton', path)
    const lib = (path) => join(dir, 'packages/npx', path)
    for (const path of [
      '.npmrc',
      'biome.base.json',
      '.editorconfig',
      '.gitattributes',
      '.claude/ECOSYSTEM.md',
      '.github/dependabot.yml',
      '.github/scripts/check-deps.mjs',
      '.github/scripts/check-code-rules.mjs',
    ]) {
      assert.equal(readFileSync(app(path), 'utf8'), readFileSync(lib(path), 'utf8'), path)
    }
    for (const path of [
      '.github/workflows/release.yml',
      '.github/scripts/publish-if-new.mjs',
      '.github/scripts/check-package.mjs',
      'RELEASE-READINESS.md',
      'vitest.shared.ts',
      'vitest.perf.config.ts',
    ]) {
      assert.ok(!existsSync(app(path)), `skeleton must not get ${path}`)
      assert.ok(existsSync(lib(path)), `npx (library) gets ${path}`)
    }
    assert.match(readFileSync(lib('tsconfig.base.json'), 'utf8'), /"isolatedDeclarations": true/)
    assert.doesNotMatch(readFileSync(app('tsconfig.base.json'), 'utf8'), /"isolatedDeclarations"/)
    assert.match(readFileSync(lib('.github/workflows/ci.yml'), 'utf8'), /publint/)
    // Comment lines explain what was left out, so only the YAML itself is checked.
    const appCi = readFileSync(app('.github/workflows/ci.yml'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    assert.doesNotMatch(appCi, /publint|attw|package-check|workflow_call/)
    assert.match(readFileSync(app('.gitignore'), 'utf8'), /^\/\.work\/$/m)
    assert.equal(cli('--check', '--repo', 'skeleton', '--repo', 'npx').status, 0)
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

describe('create-once files (once: true)', () => {
  /** One normal file and one create-once file, synced into `withcode`. */
  function onceFixture() {
    const f = fixture()
    write(join(f.canonicalDir, 'READY.md'), '# template\n')
    const manifest = parseManifest({
      targets: ['withcode', 'nocode'],
      files: [
        { path: '.editorconfig', when: 'always' },
        { path: 'READY.md', when: 'hasPackageJson', once: true },
      ],
    })
    return { ...f, manifest }
  }
  const statusOf = (actions, repo, path) =>
    actions.find((a) => a.repo === repo && a.path === path)?.status

  test('"once" must be a boolean and defaults to false', () => {
    const base = { targets: ['core'], files: [{ path: 'a', when: 'always' }] }
    assert.equal(parseManifest(base).files[0]?.once, false)
    assert.throws(
      () => parseManifest({ ...base, files: [{ path: 'a', when: 'always', once: 'yes' }] }),
      /once must be true or false/,
    )
  })

  test('created when missing (drift until then), and respects "when"', () => {
    const actions = planSync(onceFixture())
    assert.equal(statusOf(actions, 'withcode', 'READY.md'), 'create')
    assert.equal(statusOf(actions, 'nocode', 'READY.md'), 'skipped-no-package-json')
  })

  test('never compared or overwritten once the repo has it, and never drift', () => {
    const f = onceFixture()
    applySync(planSync(f))
    const file = join(f.rootDir, 'withcode/READY.md')
    writeFileSync(file, '# filled in by the repo\n| R1 | pass |\n')
    // The canonical template changes too: the repo's copy must still be left alone.
    writeFileSync(join(f.canonicalDir, 'READY.md'), '# template v2\n')
    const actions = planSync(f)
    assert.equal(statusOf(actions, 'withcode', 'READY.md'), 'kept')
    assert.ok(!DRIFT.includes('kept'))
    assert.equal(applySync(actions), 0)
    assert.equal(readFileSync(file, 'utf8'), '# filled in by the repo\n| R1 | pass |\n')
  })

  test('the report stays quiet about kept files', () => {
    const f = onceFixture()
    applySync(planSync(f))
    writeFileSync(join(f.rootDir, 'withcode/READY.md'), 'edited\n')
    assert.equal(
      formatReport(planSync(f), { check: true, dryRun: false }),
      'All repos are in sync.\n',
    )
  })
})
