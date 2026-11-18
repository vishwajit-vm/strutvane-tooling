// Tests for the GitHub Actions workflows: the canonical ones synced into package repos and this
// repo's own. They parse every workflow as YAML and check the rules a reviewer would otherwise
// have to remember: npm only, actions pinned to commit SHAs, least-privilege permissions,
// timeouts, the OS × Node matrix and the gated, staged release (node --test).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_CI = 'canonical/app-template/.github/workflows/ci.yml'
const DIRS = [
  'canonical/.github/workflows',
  'canonical/app-template/.github/workflows',
  '.github/workflows',
]

/** Every workflow file, as { rel, text, doc }. */
const workflows = DIRS.flatMap((dir) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => {
      const rel = `${dir}/${f}`
      const text = readFileSync(join(ROOT, rel), 'utf8')
      return { rel, text, doc: parse(text) }
    }),
)

/** @param {string} rel */
const byPath = (rel) => {
  const w = workflows.find((x) => x.rel === rel)
  assert.ok(w, `${rel} exists`)
  return w
}

/** All `run:` commands of a workflow's steps. */
const runs = (doc) =>
  Object.values(doc.jobs).flatMap((job) => (job.steps ?? []).map((s) => s.run).filter(Boolean))

/** All `uses:` lines (raw text, so the trailing tag comment can be checked). */
const usesLines = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => /^\s*(-\s+)?uses:/.test(line))
    .map((line) => line.trim().replace(/^-\s+/, ''))

describe('every workflow', () => {
  test('there are workflows to check, and each parses as a YAML mapping with jobs', () => {
    assert.ok(workflows.length >= 5)
    for (const { rel, doc } of workflows) {
      assert.equal(typeof doc, 'object', rel)
      assert.ok(doc.name && doc.on && doc.jobs, `${rel}: name, on and jobs`)
    }
  })

  test('npm only: no pnpm, no corepack anywhere', () => {
    for (const { rel, text } of workflows) {
      assert.doesNotMatch(text, /pnpm|corepack/i, rel)
    }
  })

  test('every action is pinned to a full 40-character commit SHA with its tag in a comment', () => {
    for (const { rel, text } of workflows) {
      const lines = usesLines(text)
      assert.ok(lines.length > 0, `${rel} uses actions`)
      // A reusable workflow from this same repo (`./.github/workflows/x.yml`) runs the commit
      // being built, so it needs no pin.
      const remote = lines.filter((l) => !/^uses: \.\/\.github\/workflows\/[\w.-]+\.ya?ml$/.test(l))
      for (const line of remote) {
        assert.match(
          line,
          /^uses: [\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40} # v\d+(\.\d+){0,2}$/,
          `${rel}: ${line}`,
        )
      }
    }
  })

  test('top-level permissions are read-only; write scopes appear only on jobs that need them', () => {
    const allowedWrites = new Set(['id-token', 'security-events'])
    for (const { rel, doc } of workflows) {
      assert.ok(
        doc.permissions === 'read-all' || doc.permissions?.contents === 'read',
        `${rel}: top-level permissions`,
      )
      if (typeof doc.permissions === 'object') {
        for (const [scope, level] of Object.entries(doc.permissions)) {
          assert.notEqual(level, 'write', `${rel}: top-level ${scope}: write`)
        }
      }
      for (const [name, job] of Object.entries(doc.jobs)) {
        for (const [scope, level] of Object.entries(job.permissions ?? {})) {
          if (level === 'write') {
            assert.ok(allowedWrites.has(scope), `${rel} job ${name}: ${scope}: write`)
          }
        }
      }
    }
  })

  test('only the release and scorecard workflows can mint an OIDC token', () => {
    for (const { rel, doc } of workflows) {
      const mints = Object.values(doc.jobs).some((j) => j.permissions?.['id-token'] === 'write')
      assert.equal(mints, /(release|scorecard)\.yml$/.test(rel), rel)
    }
  })

  test('every job has a timeout (reusable-workflow calls excepted); checkouts drop the token', () => {
    for (const { rel, doc } of workflows) {
      for (const [name, job] of Object.entries(doc.jobs)) {
        // A job that calls a reusable workflow can't set timeout-minutes; the called jobs do.
        if (job.uses) {
          assert.equal(job['timeout-minutes'], undefined, `${rel} job ${name}`)
          assert.match(job.uses, /^\.\/\.github\/workflows\//, `${rel} job ${name}: local only`)
          continue
        }
        assert.ok(Number.isInteger(job['timeout-minutes']), `${rel} job ${name}: timeout`)
        for (const step of job.steps ?? []) {
          if (String(step.uses ?? '').startsWith('actions/checkout@')) {
            assert.equal(step.with?.['persist-credentials'], false, `${rel} job ${name}`)
          }
        }
      }
    }
  })
})

describe('CI workflows (canonical, app template and this repo)', () => {
  for (const rel of ['canonical/.github/workflows/ci.yml', APP_CI, '.github/workflows/ci.yml']) {
    test(`${rel}: Linux, Windows and macOS × Node 24 and 26`, () => {
      const { matrix } = byPath(rel).doc.jobs.verify.strategy
      assert.deepEqual(matrix.os, ['ubuntu-latest', 'windows-latest', 'macos-latest'])
      assert.deepEqual(matrix.node, [24, 26])
    })

    test(`${rel}: setup-node with the npm cache, pinned npm, check-deps, npm ci, audit, npm run ci`, () => {
      const { doc } = byPath(rel)
      const setup = doc.jobs.verify.steps.find((s) =>
        String(s.uses).startsWith('actions/setup-node@'),
      )
      assert.equal(setup?.with?.cache, 'npm')
      assert.equal(doc.env?.NODE_OPTIONS, '--unhandled-rejections=strict', 'R2: strict rejections')
      const commands = doc.jobs.verify.steps.map((s) => s.run).filter(Boolean)
      const order = [
        'npm install --global npm@11.19.0',
        /check-deps\.mjs$/,
        'npm ci',
        'npm audit signatures',
        'npm run ci',
      ]
      let at = -1
      for (const expected of order) {
        const index = commands.findIndex(
          (c, i) => i > at && (typeof expected === 'string' ? c === expected : expected.test(c)),
        )
        assert.ok(index > at, `${rel}: "${expected}" after the previous step`)
        at = index
      }
      assert.ok(!commands.some((c) => /npm install(?! --global npm@)/.test(c)), 'never npm install')
    })
  }
})

describe('canonical CI: the production-readiness gates (hub docs/19)', () => {
  const { doc } = byPath('canonical/.github/workflows/ci.yml')
  /** The `run:` commands of one job. */
  const jobRuns = (name) => (doc.jobs[name]?.steps ?? []).map((s) => s.run).filter(Boolean)
  /** The step of a job that uses an action whose name starts with `prefix`. */
  const stepUsing = (name, prefix) =>
    (doc.jobs[name]?.steps ?? []).find((s) => String(s.uses ?? '').startsWith(prefix))

  test('can be called by release.yml, and only pull requests cancel superseded runs', () => {
    assert.ok(Object.hasOwn(doc.on, 'workflow_call'))
    assert.match(
      String(doc.concurrency['cancel-in-progress']),
      /^\$\{\{ github\.event_name == 'pull_request' \}\}$/,
    )
  })

  test('R1: the code rules run in the matrix job', () => {
    assert.ok(jobRuns('verify').includes('node .github/scripts/check-code-rules.mjs'))
  })

  test('R2: a repeat job runs the whole test suite three times; all must pass', () => {
    const loop = jobRuns('repeat').find((c) => /for run in 1 2 3/.test(c))
    assert.ok(loop, 'a 3-run loop')
    assert.match(loop, /\bnpm test\b/)
    assert.doesNotMatch(loop, /\|\| *true|continue-on-error/)
    assert.equal(doc.jobs.repeat['continue-on-error'], undefined)
  })

  test('R3: production audit at high, and a TruffleHog scan pinned by action SHA and image digest', () => {
    assert.ok(jobRuns('security').includes('npm audit --omit=dev --audit-level=high'))
    const scan = stepUsing('security', 'trufflesecurity/trufflehog@')
    assert.ok(scan, 'trufflehog step')
    assert.match(scan.with.version, /^\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/)
    const checkout = stepUsing('security', 'actions/checkout@')
    assert.equal(checkout?.with?.['fetch-depth'], 0, 'full history for the secrets scan')
  })

  test('R5: package-check builds, checks contents, packs, then runs exact-pinned publint and attw', () => {
    const commands = jobRuns('package-check')
    const find = (re) => commands.findIndex((c) => re.test(c))
    const order = [
      /^npm ci$/,
      /^npm run build$/,
      /check-package\.mjs$/,
      /npm pack --ignore-scripts --pack-destination/,
      /--package=publint@\d+\.\d+\.\d+ -- publint run .*\.tgz --strict$/,
      /--package=@arethetypeswrong\/cli@\d+\.\d+\.\d+ -- attw .*\.tgz --profile esm-only$/,
    ]
    let at = -1
    for (const re of order) {
      const index = find(re)
      assert.ok(index > at, `package-check: ${re} after the previous step`)
      at = index
    }
  })

  test('no gate is allowed to fail softly', () => {
    for (const [name, job] of Object.entries(doc.jobs)) {
      assert.equal(job['continue-on-error'], undefined, name)
      for (const step of job.steps ?? []) assert.equal(step['continue-on-error'], undefined, name)
    }
  })
})

describe('app-template CI: the library gates minus what only a published package needs', () => {
  const library = byPath('canonical/.github/workflows/ci.yml')
  const app = byPath(APP_CI)

  test('verify and security are the library jobs, unchanged', () => {
    assert.deepEqual(app.doc.jobs.verify, library.doc.jobs.verify)
    assert.deepEqual(app.doc.jobs.security, library.doc.jobs.security)
    assert.ok(
      app.doc.jobs.verify.steps.some((s) => s.run === 'node .github/scripts/check-code-rules.mjs'),
    )
  })

  test('repeat is the library job without the build step (an app template builds nothing)', () => {
    const { steps: librarySteps, ...libraryJob } = library.doc.jobs.repeat
    const { steps: appSteps, ...appJob } = app.doc.jobs.repeat
    assert.deepEqual(appJob, libraryJob)
    assert.deepEqual(
      appSteps,
      librarySteps.filter((s) => s.run !== 'npm run build'),
    )
    assert.ok(appSteps.length === librarySteps.length - 1, 'exactly the build step is gone')
  })

  test('no package-check, release hook or publishing tool; same triggers, env and concurrency', () => {
    assert.deepEqual(Object.keys(app.doc.jobs).sort(), ['repeat', 'security', 'verify'])
    assert.ok(!Object.hasOwn(app.doc.on, 'workflow_call'), 'nothing calls it')
    // The header comment names what was left out; only the YAML itself must not use it.
    const yaml = app.text
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    assert.doesNotMatch(yaml, /publint|attw|npm pack|publish|check-package|workflow_call/)
    const { workflow_call: _call, ...libraryOn } = library.doc.on
    assert.deepEqual(app.doc.on, libraryOn)
    assert.deepEqual(app.doc.env, library.doc.env)
    assert.deepEqual(app.doc.concurrency, library.doc.concurrency)
    assert.deepEqual(app.doc.permissions, { contents: 'read' })
  })
})

describe('canonical release workflow', () => {
  const { doc } = byPath('canonical/.github/workflows/release.yml')
  const job = doc.jobs.release

  test('runs only in the org and only once RELEASE_ENABLED is set', () => {
    assert.match(job.if, /github\.repository_owner == 'vishwajit-vm'/)
    assert.match(job.if, /vars\.RELEASE_ENABLED == 'true'/)
    assert.equal(doc.jobs.ci.if, job.if, 'the CI call has the same condition')
  })

  test('stages nothing unless every CI gate is green: it calls ci.yml and needs it', () => {
    assert.equal(doc.jobs.ci.uses, './.github/workflows/ci.yml')
    assert.deepEqual(doc.jobs.ci.permissions, { contents: 'read' })
    assert.ok([job.needs].flat().includes('ci'))
  })

  test('never cancels a release half-way', () => {
    assert.equal(doc.concurrency['cancel-in-progress'], false)
  })

  test('installs, gates, then stages with the pinned npm; no token anywhere', () => {
    const commands = runs(doc)
    assert.ok(commands.includes('npm install --global npm@11.19.0'))
    assert.ok(commands.includes('npm ci'))
    assert.ok(commands.includes('npm audit signatures'))
    assert.ok(
      commands.indexOf('npm run ci') < commands.indexOf('node .github/scripts/publish-if-new.mjs'),
    )
    assert.equal(commands.at(-1), 'node .github/scripts/publish-if-new.mjs')
    const text = byPath('canonical/.github/workflows/release.yml').text
    assert.doesNotMatch(text, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./)
  })

  test('OIDC for trusted publishing; contents stay read-only', () => {
    assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' })
  })
})
