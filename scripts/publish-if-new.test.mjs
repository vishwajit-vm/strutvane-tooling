// Tests for canonical/.github/scripts/publish-if-new.mjs. Run with node --test.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  compareStable,
  decide,
  declaresWorkspaces,
  distTagFor,
  isPublishConflict,
  releaseTarget,
  resolveConflict,
  stagedVersions,
} from '../canonical/.github/scripts/publish-if-new.mjs'

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../canonical/.github/scripts/publish-if-new.mjs',
)

/** Temp folders created by tests, removed at the end even if a test fails. */
const tempDirs = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Create a temp folder holding `files` (relative path → content; objects become JSON). */
function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'sv-publish-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  return root
}

describe('distTagFor', () => {
  test('stable versions go to latest, pre-releases to their id', () => {
    assert.equal(distTagFor('1.2.3'), 'latest')
    assert.equal(distTagFor('0.1.0-next.0'), 'next')
    assert.equal(distTagFor('0.1.0-canary.20261114'), 'canary')
    assert.equal(distTagFor('2.0.0-rc.1+build.5'), 'rc')
  })
  test('rejects invalid versions and unsafe pre-release ids', () => {
    assert.throws(() => distTagFor('1.2'), /valid semver/)
    assert.throws(() => distTagFor('v1.2.3'), /valid semver/)
    assert.throws(() => distTagFor('1.0.0-latest.1'), /pre-release id/)
    assert.throws(() => distTagFor('1.0.0-0.1'), /pre-release id/)
  })
})

describe('compareStable', () => {
  test('compares numerically, not as text', () => {
    assert.ok(compareStable('1.10.0', '1.9.0') > 0)
    assert.ok(compareStable('0.2.0', '0.10.0') < 0)
    assert.equal(compareStable('1.0.0', '1.0.0'), 0)
  })
})

describe('decide', () => {
  test('skips versions already on npm (idempotent re-runs)', () => {
    assert.deepEqual(
      decide({ version: '0.1.0-next.0', published: ['0.1.0-next.0'], latest: undefined }),
      { action: 'skip', reason: '0.1.0-next.0 is already on npm' },
    )
  })
  test('stages new pre-releases to their tag, even when only placeholders exist', () => {
    assert.deepEqual(
      decide({
        version: '0.1.0-next.0',
        published: ['0.0.0-reserved.0'],
        latest: '0.0.0-reserved.0',
      }),
      { action: 'stage', tag: 'next' },
    )
  })
  test('stages a first stable release to latest', () => {
    assert.deepEqual(decide({ version: '1.0.0', published: [], latest: undefined }), {
      action: 'stage',
      tag: 'latest',
    })
  })
  test('skips a version that is already staged and waiting for approval', () => {
    assert.deepEqual(
      decide({
        version: '0.1.0-next.1',
        published: ['0.1.0-next.0'],
        latest: undefined,
        staged: ['0.1.0-next.1'],
      }),
      { action: 'skip', reason: '0.1.0-next.1 is already staged and waiting for approval' },
    )
  })
  test('a different staged version does not block staging this one', () => {
    assert.deepEqual(
      decide({
        version: '0.1.0-next.2',
        published: [],
        latest: undefined,
        staged: ['0.1.0-next.1'],
      }),
      { action: 'stage', tag: 'next' },
    )
  })
  test('refuses to move latest backwards', () => {
    assert.throws(
      () => decide({ version: '1.2.0', published: ['1.3.0'], latest: '1.3.0' }),
      /higher latest/,
    )
  })
})

describe('stagedVersions', () => {
  test('reads versions from flat and nested shapes, filtered by package name', () => {
    const data = {
      staged: [
        { name: '@strutvane/core', version: '0.1.0-next.0', id: 'a' },
        { name: '@strutvane/other', version: '9.9.9', id: 'b' },
        { package: '@strutvane/core', details: { version: '0.1.0-next.1' } },
      ],
    }
    assert.deepEqual(stagedVersions(data, '@strutvane/core').sort(), [
      '0.1.0-next.0',
      '0.1.0-next.1',
    ])
  })
  test('an array of entries without names is accepted (list already scoped to the package)', () => {
    assert.deepEqual(stagedVersions([{ version: '1.0.0' }, { version: '1.0.0' }], 'x'), ['1.0.0'])
  })
  test('garbage yields nothing instead of throwing', () => {
    for (const bad of [null, 42, 'text', [], {}, [{ version: 3 }]]) {
      assert.deepEqual(stagedVersions(bad, 'x'), [])
    }
  })
})

describe('isPublishConflict', () => {
  test('recognises the forms npm and the registry use for "this version exists"', () => {
    assert.ok(isPublishConflict('npm error code E409\nnpm error 409 Conflict - PUT https://x'))
    assert.ok(isPublishConflict('You cannot publish over the previously published versions: 1.0.0'))
    assert.ok(isPublishConflict('npm ERR! 409 Conflict'))
  })
  test('other failures are not conflicts', () => {
    for (const out of ['npm error code E403', 'npm error code E404', 'E4090', 'ENEEDAUTH', '']) {
      assert.equal(isPublishConflict(out), false, out)
    }
  })
})

describe('resolveConflict (409 = skip, but never hide a foreign tarball)', () => {
  const version = '0.2.0'
  test('staged only: skip, and name the integrity to check on approval', () => {
    const r = resolveConflict({
      version,
      localIntegrity: 'sha512-A',
      publishedIntegrity: undefined,
    })
    assert.equal(r.status, 'skipped')
    assert.match(r.detail, /already staged.*sha512-A/)
  })
  test('published with the same tarball: skip', () => {
    const r = resolveConflict({
      version,
      localIntegrity: 'sha512-A',
      publishedIntegrity: 'sha512-A',
    })
    assert.equal(r.status, 'skipped')
  })
  test('published with another tarball: fail', () => {
    const r = resolveConflict({
      version,
      localIntegrity: 'sha512-A',
      publishedIntegrity: 'sha512-B',
    })
    assert.equal(r.status, 'failed')
    assert.match(r.detail, /sha512-B.*sha512-A/)
  })
  test('published but our integrity is unknown: fail closed', () => {
    const r = resolveConflict({
      version,
      localIntegrity: undefined,
      publishedIntegrity: 'sha512-B',
    })
    assert.equal(r.status, 'failed')
  })
})

describe('releaseTarget', () => {
  test('a non-private root is the one package to stage', () => {
    assert.deepEqual(
      releaseTarget({ name: '@strutvane/framework', version: '0.2.0' }, { hasWorkspaces: false }),
      { name: '@strutvane/framework', version: '0.2.0' },
    )
  })
  test('a private root has nothing to publish', () => {
    assert.equal(releaseTarget({ name: 'x', private: true }, { hasWorkspaces: false }), undefined)
  })
  test('workspaces fail closed, private root or not', () => {
    for (const root of [
      { name: 'x', version: '1.0.0' },
      { name: 'x', private: true },
    ]) {
      assert.throws(() => releaseTarget(root, { hasWorkspaces: true }), /one package/)
    }
  })
  test('a publishable root needs a name and a version', () => {
    assert.throws(() => releaseTarget({ version: '1.0.0' }, { hasWorkspaces: false }), /name/)
    assert.throws(() => releaseTarget({ name: 'x' }, { hasWorkspaces: false }), /version/)
  })
})

describe('declaresWorkspaces', () => {
  test('npm "workspaces" or a pnpm "packages:" list counts; pnpm settings alone do not', () => {
    assert.equal(declaresWorkspaces(makeTree({}), { workspaces: ['a'] }), true)
    assert.equal(
      declaresWorkspaces(makeTree({ 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' }), {}),
      true,
    )
    const settingsOnly = makeTree({
      'pnpm-workspace.yaml': 'minimumReleaseAgeExclude:\n  - "@strutvane/*"\n',
    })
    assert.equal(declaresWorkspaces(settingsOnly, {}), false)
    assert.equal(declaresWorkspaces(makeTree({}), {}), false)
  })
})

// End to end: run the real script against a temp repo with a fake `npm` first on PATH. The fake
// records each call and never touches the network.
describe('publish-if-new.mjs end to end (fake npm)', () => {
  const FAKE_NPM = `
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ args }) + '\\n')
const published = JSON.parse(process.env.FAKE_NPM_PUBLISHED || '[]')
const mode = process.env.FAKE_NPM_STAGE || 'ok'
if (args[0] === 'view' && args[2] === 'dist.integrity') {
  const remote = process.env.FAKE_NPM_REMOTE_INTEGRITY
  if (remote) process.stdout.write(JSON.stringify(remote))
  process.exit(0)
}
if (args[0] === 'view') {
  if (published.length) {
    process.stdout.write(JSON.stringify({ versions: published, 'dist-tags': {} }))
    process.exit(0)
  }
  process.stderr.write('npm error code E404')
  process.exit(1)
}
if (args[0] === 'pack') {
  process.stdout.write(JSON.stringify([{ integrity: 'sha512-LOCAL' }]))
  process.exit(0)
}
if (args[0] === 'stage' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0) }
if (args[0] === 'stage' && args[1] === 'publish') {
  if (mode === 'conflict') {
    process.stderr.write('npm error code E409\\nnpm error 409 Conflict - PUT')
    process.exit(1)
  }
  if (mode === 'fail') { process.stderr.write('npm error code E403'); process.exit(3) }
  process.exit(0)
}
process.exit(2)
`

  function fakeNpmBin() {
    const bin = makeTree({ 'fake-npm.mjs': FAKE_NPM })
    const fake = join(bin, 'fake-npm.mjs')
    writeFileSync(join(bin, 'npm.cmd'), `@"${process.execPath}" "${fake}" %*\r\n`)
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
    chmodSync(join(bin, 'npm'), 0o755)
    return bin
  }

  /** Run the script in `repo`; returns exit status, output and the recorded npm calls. */
  function run(repo, extraEnv = {}) {
    const bin = fakeNpmBin()
    const log = join(bin, 'calls.log')
    writeFileSync(log, '')
    /** @type {Record<string, string | undefined>} */
    const env = { ...process.env, ...extraEnv, FAKE_NPM_LOG: log }
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
    env[pathKey] = `${bin}${delimiter}${env[pathKey] ?? ''}`
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: repo, env, encoding: 'utf8' })
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).args.join(' '))
    return { status: r.status, out: r.stdout, err: r.stderr, calls }
  }

  const repo = () =>
    makeTree({ 'package.json': { name: '@strutvane/framework', version: '0.2.0' } })
  const stages = (calls) => calls.filter((c) => c.startsWith('stage publish'))

  test('stages a new version with provenance and its dist-tag', () => {
    const r = run(repo())
    assert.equal(r.status, 0, r.err)
    assert.deepEqual(stages(r.calls), ['stage publish --access public --provenance --tag latest'])
    assert.match(r.out, /staged: @strutvane\/framework@0\.2\.0/)
  })

  test('re-runs are idempotent: a published version is skipped without staging', () => {
    const r = run(repo(), { FAKE_NPM_PUBLISHED: JSON.stringify(['0.2.0']) })
    assert.equal(r.status, 0, r.err)
    assert.deepEqual(stages(r.calls), [])
    assert.match(r.out, /skip: .*already on npm/)
  })

  test('409 on a staged-only version is a skip that prints the integrity to check', () => {
    const r = run(repo(), { FAKE_NPM_STAGE: 'conflict' })
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /skip: .*already staged \(npm 409\).*sha512-LOCAL/)
    assert.ok(r.calls.some((c) => c.startsWith('pack --dry-run --json --ignore-scripts')))
  })

  test('409 on a published version with the same tarball is a skip', () => {
    const r = run(repo(), {
      FAKE_NPM_STAGE: 'conflict',
      FAKE_NPM_REMOTE_INTEGRITY: 'sha512-LOCAL',
    })
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /skip: .*this exact tarball/)
  })

  test('409 on a published version with a different tarball fails', () => {
    const r = run(repo(), {
      FAKE_NPM_STAGE: 'conflict',
      FAKE_NPM_REMOTE_INTEGRITY: 'sha512-EVIL',
    })
    assert.equal(r.status, 1)
    assert.match(r.out, /failed: .*sha512-EVIL/)
  })

  test('any other npm failure passes its exit code through', () => {
    const r = run(repo(), { FAKE_NPM_STAGE: 'fail' })
    assert.equal(r.status, 3)
    assert.match(r.out, /failed: .*exited with code 3/)
  })

  test('a private root has nothing to publish and calls npm not at all', () => {
    const r = run(makeTree({ 'package.json': { name: 'meta', private: true } }))
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /meta is private, nothing to publish/)
    assert.deepEqual(r.calls, [])
  })

  test('a repo with workspaces fails before any npm call', () => {
    const r = run(
      makeTree({
        'package.json': { name: 'ws', private: true },
        'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      }),
    )
    assert.equal(r.status, 1)
    assert.match(r.err, /publish failed: .*one package/)
    assert.deepEqual(r.calls, [])
  })
})
