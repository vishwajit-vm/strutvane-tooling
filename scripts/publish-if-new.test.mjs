// Tests for canonical/.github/scripts/publish-if-new.mjs and the workspace helpers it uses
// (canonical/.github/scripts/workspace-packages.mjs). Run with node --test.
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
  distTagFor,
  formatSummary,
  hasFailures,
  releaseTargets,
  stageAll,
  stagedVersions,
} from '../canonical/.github/scripts/publish-if-new.mjs'
import {
  dependencyNames,
  expandWorkspaceEntries,
  fsListSubdirs,
  listWorkspacePackages,
  orderByDependencies,
  parseWorkspaceEntry,
  parseWorkspacePackages,
} from '../canonical/.github/scripts/workspace-packages.mjs'

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
      {
        action: 'skip',
        reason: '0.1.0-next.0 is already on npm',
      },
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

describe('parseWorkspacePackages', () => {
  test('reads the block list used by the CLI repo, ignoring the keys around it', () => {
    const yaml = [
      'packages:',
      '  - packages/*',
      '',
      '# TEMPORARY comment',
      'overrides:',
      '  "@strutvane/contracts": link:../contracts',
    ].join('\n')
    assert.deepEqual(parseWorkspacePackages(yaml), ['packages/*'])
  })
  test('handles quotes, comments, CRLF, a BOM, column-0 items and blank lines', () => {
    const yaml =
      "\uFEFFonlyBuiltDependencies:\r\n  - esbuild\r\npackages:\r\n- 'tools/a' # first\r\n\r\n  # note\r\n- \"tools/b\"\r\n- tools/c#not-a-comment\r\n- 'it''s'\r\nsettings: 1\r\n"
    assert.deepEqual(parseWorkspacePackages(yaml), [
      'tools/a',
      'tools/b',
      'tools/c#not-a-comment',
      "it's",
    ])
  })
  test('no packages key, or an empty inline list, means no workspace packages', () => {
    assert.deepEqual(parseWorkspacePackages(''), [])
    assert.deepEqual(parseWorkspacePackages("overrides:\n  a: '1.0.0'\n"), [])
    assert.deepEqual(parseWorkspacePackages('packages: [] # none\n'), [])
    assert.deepEqual(parseWorkspacePackages('packages:\nother: x\n'), [])
  })
  test('an indented "packages:" (a nested key) is not the workspace list', () => {
    assert.deepEqual(parseWorkspacePackages('catalog:\n  packages: 1.0.0\n'), [])
  })
  test('rejects forms it does not fully understand, with a clear error', () => {
    const bad = [
      ['packages: [a, b]\n', /inline/],
      ['packages: packages/*\n', /inline/],
      ['packages:\n  - a\npackages:\n  - b\n', /more than once/],
      ['packages:\n  - a\n    - b\n', /indentation/],
      ['packages:\n  - a\n   - b\n', /indentation/],
      ['packages:\n\t- a\n', /tabs/],
      ['packages:\n  a: b\n', /only "- path" items/],
      ['packages:\n  -a\n', /malformed list item/],
      ['packages:\n-a\n', /malformed list item/],
      ['packages:\n  - \n', /empty/],
      ['packages:\n  -\n', /empty/],
      ["packages:\n  - 'open\n", /single-quoted/],
      ['packages:\n  - "a\\tb"\n', /double-quoted/],
    ]
    for (const [yaml, error] of bad) {
      assert.throws(() => parseWorkspacePackages(yaml), error, JSON.stringify(yaml))
    }
  })
  test('fuzz: never throws anything but an Error, and always returns strings', () => {
    const pieces = ['packages:', '  - ', '- ', 'a/*', "'", '"', '#', ' ', '\n', '\t', 'x: 1', '[]']
    let seed = 42
    const rand = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let run = 0; run < 2000; run++) {
      let yaml = ''
      for (let i = rand(20); i > 0; i--) yaml += pieces[rand(pieces.length)]
      try {
        const out = parseWorkspacePackages(yaml)
        assert.ok(Array.isArray(out) && out.every((e) => typeof e === 'string' && e !== ''))
      } catch (error) {
        assert.ok(error instanceof Error, `non-Error thrown for ${JSON.stringify(yaml)}`)
      }
    }
  })
})

describe('parseWorkspaceEntry', () => {
  test('accepts plain paths and a trailing /*, normalising ./ and trailing slashes', () => {
    assert.deepEqual(parseWorkspaceEntry('packages/cli'), { kind: 'path', dir: 'packages/cli' })
    assert.deepEqual(parseWorkspaceEntry('./packages/cli/'), { kind: 'path', dir: 'packages/cli' })
    assert.deepEqual(parseWorkspaceEntry('packages/*'), { kind: 'glob', parent: 'packages' })
    assert.deepEqual(parseWorkspaceEntry('./a/b/*'), { kind: 'glob', parent: 'a/b' })
  })
  test('rejects every other form', () => {
    for (const bad of [
      '',
      '*',
      '.',
      './',
      '!packages/x',
      'packages/**',
      'packages/*/x',
      'packages/a*',
      'packages/{a,b}',
      'packages/[ab]',
      'packages/?',
      '../outside',
      'a/../b',
      'a//b',
      '/abs/path',
      'C:/abs',
      'packages\\cli',
    ]) {
      assert.throws(() => parseWorkspaceEntry(bad), /unsupported packages entry/, bad)
    }
  })
})

describe('expandWorkspaceEntries', () => {
  test('expands globs against a listing, skips hidden folders and node_modules, sorts, dedupes', () => {
    const listing = { packages: ['launcher', '.cache', 'cli', 'node_modules'], tools: ['x'] }
    const list = (dir) => listing[dir] ?? []
    assert.deepEqual(expandWorkspaceEntries(['packages/*', 'tools/x', 'packages/cli'], list), [
      { dir: 'packages/cli', fromGlob: false },
      { dir: 'packages/launcher', fromGlob: true },
      { dir: 'tools/x', fromGlob: false },
    ])
  })
  test('a glob over a missing folder matches nothing; a bad entry throws', () => {
    assert.deepEqual(
      expandWorkspaceEntries(['missing/*'], () => []),
      [],
    )
    assert.throws(() => expandWorkspaceEntries(['packages/**'], () => []), /unsupported/)
  })
  test('works against a real directory with fsListSubdirs', () => {
    const root = makeTree({ 'packages/b/x.txt': '', 'packages/a/x.txt': '', 'packages/file': '' })
    assert.deepEqual(
      expandWorkspaceEntries(['packages/*'], fsListSubdirs(root)).map((e) => e.dir),
      ['packages/a', 'packages/b'],
    )
    assert.deepEqual(fsListSubdirs(root)('nope'), [])
  })
})

describe('listWorkspacePackages', () => {
  test('reads package.json of each matched folder; glob folders without one are skipped', () => {
    const root = makeTree({
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'packages/cli/package.json': { name: '@x/cli', version: '1.0.0' },
      'packages/launcher/package.json': { name: 'x', version: '1.0.0' },
      'packages/notes/readme.md': 'not a package',
    })
    assert.deepEqual(
      listWorkspacePackages(root).map((p) => [p.dir, p.manifest.name]),
      [
        ['packages/cli', '@x/cli'],
        ['packages/launcher', 'x'],
      ],
    )
  })
  test('no workspace file means no packages', () => {
    assert.deepEqual(listWorkspacePackages(makeTree({ 'package.json': {} })), [])
  })
  test('an explicitly listed folder without package.json, or bad JSON, is an error', () => {
    const missing = makeTree({ 'pnpm-workspace.yaml': 'packages:\n  - tools/x\n' })
    assert.throws(() => listWorkspacePackages(missing), /tools\/x\/package\.json does not exist/)
    const broken = makeTree({
      'pnpm-workspace.yaml': 'packages:\n  - a\n',
      'a/package.json': '{ nope',
    })
    assert.throws(() => listWorkspacePackages(broken), /package\.json/)
    const notObject = makeTree({
      'pnpm-workspace.yaml': 'packages:\n  - a\n',
      'a/package.json': '[]',
    })
    assert.throws(() => listWorkspacePackages(notObject), /JSON object/)
  })
})

describe('dependencyNames', () => {
  test('reads dependencies, peer and optional dependencies, never devDependencies', () => {
    const manifest = {
      dependencies: { a: '1', b: '1' },
      peerDependencies: { b: '1', c: '1' },
      optionalDependencies: { d: '1' },
      devDependencies: { e: '1' },
    }
    assert.deepEqual(dependencyNames(manifest), ['a', 'b', 'c', 'd'])
    assert.deepEqual(dependencyNames({ dependencies: ['weird'] }), [])
  })
})

describe('orderByDependencies', () => {
  test('puts each item after what it depends on, keeping input order otherwise', () => {
    const items = [
      { name: 'launcher', deps: ['cli'] },
      { name: 'solo', deps: ['external'] },
      { name: 'cli', deps: ['core'] },
      { name: 'core', deps: [] },
    ]
    assert.deepEqual(
      orderByDependencies(items).map((i) => i.name),
      ['core', 'cli', 'launcher', 'solo'],
    )
  })
  test('a cycle is an error that names it, including a self-dependency', () => {
    assert.throws(
      () =>
        orderByDependencies([
          { name: 'a', deps: ['b'] },
          { name: 'b', deps: ['c'] },
          { name: 'c', deps: ['a'] },
        ]),
      /dependency cycle between workspace packages: a -> b -> c -> a/,
    )
    assert.throws(() => orderByDependencies([{ name: 'a', deps: ['a'] }]), /a -> a/)
  })
  test('duplicate names are an error', () => {
    assert.throws(
      () =>
        orderByDependencies([
          { name: 'a', deps: [] },
          { name: 'a', deps: [] },
        ]),
      /duplicate/,
    )
  })
})

describe('releaseTargets', () => {
  test('a non-private root is the single target, from the repo root (unchanged behaviour)', () => {
    const ws = [{ dir: 'packages/x', manifest: { name: 'x', version: '1.0.0' } }]
    assert.deepEqual(releaseTargets({ name: '@s/core', version: '0.1.0-next.0' }, ws), [
      { name: '@s/core', version: '0.1.0-next.0', dir: '.', deps: [] },
    ])
  })
  test('a private root yields non-private workspace packages in dependency order', () => {
    const ws = [
      {
        dir: 'packages/cli',
        manifest: { name: '@s/cli', version: '0.1.0-next.0', dependencies: { zod: '4' } },
      },
      {
        dir: 'packages/launcher',
        manifest: { name: 'strutvane', version: '0.1.0-next.0', peerDependencies: { z: '1' } },
      },
      {
        dir: 'packages/aaa',
        manifest: {
          name: 'aaa',
          version: '1.0.0',
          optionalDependencies: { strutvane: '0.1.0-next.0' },
          devDependencies: { internal: '1.0.0' },
        },
      },
      { dir: 'packages/internal', manifest: { name: 'internal', private: true } },
    ]
    const targets = releaseTargets({ name: 'ws', private: true }, ws)
    assert.deepEqual(
      targets.map((t) => [t.name, t.dir, t.deps]),
      [
        ['@s/cli', 'packages/cli', []],
        ['strutvane', 'packages/launcher', []],
        ['aaa', 'packages/aaa', ['strutvane']],
      ],
    )
  })
  test('a private root with no publishable packages yields nothing', () => {
    assert.deepEqual(releaseTargets({ private: true }, []), [])
    assert.deepEqual(
      releaseTargets({ private: true }, [{ dir: 'a', manifest: { private: true } }]),
      [],
    )
  })
  test('a publishable workspace package needs a name and version; cycles throw', () => {
    assert.throws(
      () => releaseTargets({ private: true }, [{ dir: 'a', manifest: { version: '1.0.0' } }]),
      /a\/package\.json: .*"name"/,
    )
    assert.throws(
      () => releaseTargets({ private: true }, [{ dir: 'a', manifest: { name: 'a' } }]),
      /"version"/,
    )
    const cyclic = [
      { dir: 'a', manifest: { name: 'a', version: '1.0.0', dependencies: { b: '1.0.0' } } },
      { dir: 'b', manifest: { name: 'b', version: '1.0.0', peerDependencies: { a: '1.0.0' } } },
    ]
    assert.throws(() => releaseTargets({ private: true }, cyclic), /cycle/)
  })
})

describe('stageAll', () => {
  const targets = [
    { name: 'core', version: '1.0.0', dir: 'p/core', deps: [] },
    { name: 'cli', version: '1.0.0', dir: 'p/cli', deps: ['core'] },
    { name: 'launcher', version: '1.0.0', dir: 'p/launcher', deps: ['cli'] },
    { name: 'other', version: '1.0.0', dir: 'p/other', deps: [] },
  ]
  test('stages and skips each target in order', () => {
    const seen = []
    const results = stageAll(targets, (t) => {
      seen.push(t.name)
      return t.name === 'core'
        ? { status: 'skipped', detail: '1.0.0 is already on npm' }
        : { status: 'staged', detail: 'ok' }
    })
    assert.deepEqual(seen, ['core', 'cli', 'launcher', 'other'])
    assert.deepEqual(
      results.map((r) => r.status),
      ['skipped', 'staged', 'staged', 'staged'],
    )
    assert.equal(hasFailures(results), false)
  })
  test('a failure blocks its dependents (transitively) but not unrelated packages', () => {
    const seen = []
    const results = stageAll(targets, (t) => {
      seen.push(t.name)
      if (t.name === 'core') throw new Error('npm view failed: boom')
      return { status: 'staged', detail: 'ok' }
    })
    assert.deepEqual(seen, ['core', 'other'])
    assert.deepEqual(
      results.map((r) => [r.name, r.status]),
      [
        ['core', 'failed'],
        ['cli', 'blocked'],
        ['launcher', 'blocked'],
        ['other', 'staged'],
      ],
    )
    assert.match(results[0]?.detail ?? '', /boom/)
    assert.match(results[1]?.detail ?? '', /depends on core/)
    assert.equal(hasFailures(results), true)
  })
  test('a returned failure (npm exit code) counts like a thrown one', () => {
    const results = stageAll(targets.slice(0, 2), (t) =>
      t.name === 'core'
        ? { status: 'failed', detail: 'npm stage publish exited with code 1', code: 1 }
        : { status: 'staged', detail: 'ok' },
    )
    assert.deepEqual(
      results.map((r) => r.status),
      ['failed', 'blocked'],
    )
  })
  test('non-Error throws are reported too', () => {
    const [result] = stageAll(targets.slice(0, 1), () => {
      throw 'plain string'
    })
    assert.equal(result?.status, 'failed')
    assert.equal(result?.detail, 'plain string')
  })
})

describe('formatSummary', () => {
  test('one line per package with status, name, version, folder and detail', () => {
    const text = formatSummary([
      { name: 'a', version: '1.0.0', dir: 'p/a', status: 'staged', detail: 'ok' },
      { name: 'b', version: '2.0.0', dir: 'p/b', status: 'blocked', detail: 'needs a' },
    ])
    assert.equal(
      text,
      'Summary: 2 package(s), 1 failed\n  staged  a@1.0.0 (p/a): ok\n  blocked b@2.0.0 (p/b): needs a\n',
    )
  })
})

// End to end: run the real script against a temp repo with a fake `npm` first on PATH. The fake
// records each call (working directory and arguments) and never touches the network.
describe('publish-if-new.mjs end to end (fake npm)', () => {
  const FAKE_NPM = `
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ pkg: pkg.name, args }) + '\\n')
const published = JSON.parse(process.env.FAKE_NPM_PUBLISHED || '{}')
const fail = (process.env.FAKE_NPM_FAIL || '').split(',')
if (args[0] === 'view') {
  if (published[args[1]]) {
    process.stdout.write(JSON.stringify({ versions: published[args[1]], 'dist-tags': {} }))
    process.exit(0)
  }
  process.stderr.write('npm error code E404')
  process.exit(1)
}
if (args[0] === 'stage' && args[1] === 'list') { process.stdout.write('[]'); process.exit(0) }
if (args[0] === 'stage' && args[1] === 'publish') process.exit(fail.includes(pkg.name) ? 3 : 0)
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
      .map((line) => JSON.parse(line))
    return { status: r.status, out: r.stdout, err: r.stderr, calls }
  }

  const cliRepo = () =>
    makeTree({
      'package.json': { name: 'strutvane-cli-workspace', version: '0.0.0', private: true },
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'packages/launcher/package.json': {
        name: 'strutvane',
        version: '0.1.0-next.0',
        dependencies: { '@strutvane/cli': '0.1.0-next.0' },
      },
      'packages/cli/package.json': { name: '@strutvane/cli', version: '0.1.0-next.0' },
      'packages/private-tool/package.json': { name: 'tool', version: '1.0.0', private: true },
    })

  const stageCalls = (calls) =>
    calls.filter((c) => c.args[0] === 'stage' && c.args[1] === 'publish').map((c) => c.pkg)

  test('private root: stages each workspace package from its own folder, deps first', () => {
    const r = run(cliRepo())
    assert.equal(r.status, 0, r.err)
    assert.deepEqual(stageCalls(r.calls), ['@strutvane/cli', 'strutvane'])
    // Every npm call ran inside the package's folder (the fake reads ./package.json).
    for (const call of r.calls) assert.ok(['@strutvane/cli', 'strutvane'].includes(call.pkg))
    assert.match(r.out, /staged +@strutvane\/cli@0\.1\.0-next\.0 \(packages\/cli\)/)
    assert.match(r.out, /staged +strutvane@0\.1\.0-next\.0 \(packages\/launcher\)/)
  })

  test('re-runs are idempotent: published versions are skipped', () => {
    const published = JSON.stringify({ '@strutvane/cli': ['0.1.0-next.0'] })
    const r = run(cliRepo(), { FAKE_NPM_PUBLISHED: published })
    assert.equal(r.status, 0, r.err)
    assert.deepEqual(stageCalls(r.calls), ['strutvane'])
    assert.match(r.out, /skipped @strutvane\/cli/)
  })

  test('a failed package blocks its dependents, others still run, exit is non-zero', () => {
    const repo = cliRepo()
    mkdirSync(join(repo, 'packages/other'))
    writeFileSync(
      join(repo, 'packages/other/package.json'),
      JSON.stringify({ name: 'other', version: '1.0.0' }),
    )
    const r = run(repo, { FAKE_NPM_FAIL: '@strutvane/cli' })
    assert.equal(r.status, 1)
    assert.deepEqual(stageCalls(r.calls), ['@strutvane/cli', 'other'])
    assert.match(r.out, /failed +@strutvane\/cli.*exited with code 3/)
    assert.match(r.out, /blocked strutvane.*depends on @strutvane\/cli/)
    assert.match(r.out, /staged +other@1\.0\.0/)
  })

  test('non-private root: one package from the repo root, as before', () => {
    const repo = makeTree({
      'package.json': { name: '@strutvane/core', version: '0.1.0-next.0' },
      'pnpm-workspace.yaml': "overrides:\n  '@strutvane/contracts': 0.1.0-next.0\n",
    })
    const r = run(repo)
    assert.equal(r.status, 0, r.err)
    assert.deepEqual(stageCalls(r.calls), ['@strutvane/core'])
    assert.match(r.out, /staging @strutvane\/core@0\.1\.0-next\.0 with tag "next"/)
    assert.doesNotMatch(r.out, /Summary/)
    const failed = run(repo, { FAKE_NPM_FAIL: '@strutvane/core' })
    assert.equal(failed.status, 3, 'the npm exit code is passed through, as before')
  })

  test('private root without workspace packages has nothing to publish', () => {
    const r = run(makeTree({ 'package.json': { name: 'meta', private: true } }))
    assert.equal(r.status, 0, r.err)
    assert.match(r.out, /meta is private, nothing to publish/)
    assert.deepEqual(r.calls, [])
  })

  test('an unsupported workspace entry fails before any npm call', () => {
    const repo = makeTree({
      'package.json': { name: 'ws', private: true },
      'pnpm-workspace.yaml': 'packages:\n  - packages/**\n',
    })
    const r = run(repo)
    assert.equal(r.status, 1)
    assert.match(r.err, /publish failed: .*unsupported packages entry "packages\/\*\*"/)
    assert.deepEqual(r.calls, [])
  })
})
