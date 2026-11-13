// Tests for canonical/.github/scripts/publish-if-new.mjs (node --test).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { compareStable, decide, distTagFor } from '../canonical/.github/scripts/publish-if-new.mjs'

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
  test('publishes new pre-releases to their tag, even when only placeholders exist', () => {
    assert.deepEqual(
      decide({
        version: '0.1.0-next.0',
        published: ['0.0.0-reserved.0'],
        latest: '0.0.0-reserved.0',
      }),
      { action: 'publish', tag: 'next' },
    )
  })
  test('publishes a first stable release to latest', () => {
    assert.deepEqual(decide({ version: '1.0.0', published: [], latest: undefined }), {
      action: 'publish',
      tag: 'latest',
    })
  })
  test('refuses to move latest backwards', () => {
    assert.throws(
      () => decide({ version: '1.2.0', published: ['1.3.0'], latest: '1.3.0' }),
      /higher latest/,
    )
  })
})
