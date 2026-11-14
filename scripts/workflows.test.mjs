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
const DIRS = ['canonical/.github/workflows', '.github/workflows']

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
      for (const line of lines) {
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

  test('every job has a timeout, and checkouts never keep the token', () => {
    for (const { rel, doc } of workflows) {
      for (const [name, job] of Object.entries(doc.jobs)) {
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

describe('CI workflows (canonical and this repo)', () => {
  for (const rel of ['canonical/.github/workflows/ci.yml', '.github/workflows/ci.yml']) {
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
      const commands = runs(doc)
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

describe('canonical release workflow', () => {
  const { doc } = byPath('canonical/.github/workflows/release.yml')
  const job = doc.jobs.release

  test('runs only in the org and only once RELEASE_ENABLED is set', () => {
    assert.match(job.if, /github\.repository_owner == 'vishwajit-vm'/)
    assert.match(job.if, /vars\.RELEASE_ENABLED == 'true'/)
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
