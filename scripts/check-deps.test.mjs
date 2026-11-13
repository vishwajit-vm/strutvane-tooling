// Tests for canonical/.github/scripts/check-deps.mjs (node --test).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { findLocalDeps } from '../canonical/.github/scripts/check-deps.mjs'

describe('findLocalDeps', () => {
  test('accepts registry versions and ranges', () => {
    const pkg = { dependencies: { '@strutvane/contracts': '0.1.0-next.0', zod: '^4.6.7' } }
    assert.deepEqual(findLocalDeps(pkg, ''), [])
  })
  test('flags link:, file:, workspace: and path specs in any dependency field', () => {
    const pkg = {
      dependencies: { a: 'link:../a', b: 'workspace:^' },
      devDependencies: { c: 'file:../c', d: '../d', e: 'C:\\x\\e' },
      peerDependencies: { f: '/abs/f' },
    }
    assert.equal(findLocalDeps(pkg, '').length, 6)
  })
  test('flags local overrides in pnpm-workspace.yaml, ignores normal settings', () => {
    const yaml =
      "overrides:\n  '@strutvane/contracts': link:../contracts\nonlyBuiltDependencies:\n  - esbuild\n"
    assert.deepEqual(findLocalDeps({}, yaml), [
      'pnpm-workspace.yaml: @strutvane/contracts = "link:../contracts"',
    ])
  })
})
