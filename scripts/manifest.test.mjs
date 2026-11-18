// Tests for the real manifest.json and canonical/ tree, and for this repo's own synced copies
// (node --test). The sync engine itself is tested with fixtures in sync.test.mjs.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DRIFT, normalize, parseManifest, planSync } from './sync.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CANONICAL = join(ROOT, 'canonical')
const manifest = parseManifest(JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')))

/** Every file under `dir`, as `/`-separated paths relative to `dir`. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/'))
    .sort()
}

describe('manifest.json', () => {
  test('is valid', () => {
    assert.ok(manifest.targets.length > 0)
  })

  test('no longer targets the repos the framework absorbed (contracts, core, cli, devkit)', () => {
    const names = manifest.targets.map((t) => t.name)
    for (const gone of ['contracts', 'core', 'cli', 'devkit'])
      assert.ok(!names.includes(gone), gone)
    for (const kept of ['framework', 'auth', 'ui', 'create-strutvane', 'logs', 'docs', 'hub']) {
      assert.ok(names.includes(kept), kept)
    }
  })

  test('the logs target carries a note about its log-viewer future', () => {
    const logs = manifest.targets.find((t) => t.name === 'logs')
    assert.match(logs?.note ?? '', /log-viewer/)
  })

  test('every listed source exists in canonical/, and every canonical file is listed', () => {
    const listed = [...new Set(manifest.files.map((f) => f.source))].sort()
    assert.deepEqual(walk(CANONICAL), listed)
  })

  test('variants live under canonical/<profile>/ and are used by that profile only', () => {
    const variants = manifest.files.filter((f) => f.source !== f.path)
    assert.ok(variants.length > 0)
    for (const f of variants) {
      assert.equal(f.profiles.length, 1, f.source)
      assert.equal(f.source, `${f.profiles[0]}/${f.path}`)
    }
  })

  test('retired files are gone from canonical/ and say why', () => {
    assert.ok(manifest.retired.some((r) => r.path === '.github/scripts/workspace-packages.mjs'))
    const canonical = new Set(walk(CANONICAL))
    for (const r of manifest.retired) {
      assert.ok(!canonical.has(r.path), r.path)
      assert.ok(r.reason.length > 10, r.path)
    }
  })

  test('.npmrc goes to library and app-template repos that have a package.json', () => {
    const npmrc = manifest.files.find((f) => f.path === '.npmrc')
    assert.deepEqual(npmrc, {
      path: '.npmrc',
      source: '.npmrc',
      when: 'hasPackageJson',
      profiles: ['library', 'app-template'],
      once: false,
    })
  })

  test('RELEASE-READINESS.md is create-once, one row per gate R1–R9 (hub docs/19)', () => {
    const entry = manifest.files.find((f) => f.path === 'RELEASE-READINESS.md')
    assert.deepEqual(entry, {
      path: 'RELEASE-READINESS.md',
      source: 'RELEASE-READINESS.md',
      when: 'hasPackageJson',
      profiles: ['library'],
      once: true,
    })
    assert.deepEqual(
      manifest.files.filter((f) => f.once).map((f) => f.path),
      ['RELEASE-READINESS.md'],
      'only the readiness file is create-once; every config must stay in sync',
    )
    const text = readFileSync(join(CANONICAL, 'RELEASE-READINESS.md'), 'utf8')
    const rows = text.split(/\r?\n/).filter((l) => /^\| R\d /.test(l))
    assert.deepEqual(
      rows.map((r) => r.slice(2, 4)),
      ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'],
    )
    assert.match(text, /\| Gate \| .* \| Status \| Evidence \| Date \|/)
  })

  test('the R1 code rules go to libraries and the app template; the R5 tarball check to libraries only', () => {
    for (const [path, profiles] of [
      ['.github/scripts/check-code-rules.mjs', ['library', 'app-template']],
      ['.github/scripts/check-package.mjs', ['library']],
    ]) {
      const f = manifest.files.find((x) => x.path === path)
      assert.deepEqual(f?.profiles, profiles, path)
      assert.equal(f?.once, false, path)
    }
  })

  test('npx is a library target; skeleton is the app-template target', () => {
    const profileOf = (name) => manifest.targets.find((t) => t.name === name)?.profile
    assert.equal(profileOf('npx'), 'library')
    assert.equal(profileOf('skeleton'), 'app-template')
  })
})

/** Parse JSON with `//` comments (tsconfig files): strip comments outside strings, then parse. */
function parseJsonc(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i]
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else out += c
  }
  return JSON.parse(out)
}

describe('the app-template profile (an application template, never published)', () => {
  /** The canonical source each target path resolves to for the app-template profile. */
  const appFiles = new Map(
    manifest.files.filter((f) => f.profiles.includes('app-template')).map((f) => [f.path, f]),
  )

  test('gets the npm guards, Biome, its own tsconfig and CI, and nothing release-related', () => {
    assert.deepEqual([...appFiles.keys()].sort(), [
      '.claude/ECOSYSTEM.md',
      '.claude/agents/strutvane-ecosystem-guardian.md',
      '.claude/skills/strutvane-contribute/SKILL.md',
      '.editorconfig',
      '.gitattributes',
      '.github/dependabot.yml',
      '.github/scripts/check-code-rules.mjs',
      '.github/scripts/check-deps.mjs',
      '.github/workflows/ci.yml',
      '.github/workflows/scorecard.yml',
      '.gitignore',
      '.npmrc',
      'biome.base.json',
      'tsconfig.base.json',
    ])
    for (const path of ['tsconfig.base.json', '.github/workflows/ci.yml', '.gitignore']) {
      assert.equal(appFiles.get(path)?.source, `app-template/${path}`, path)
    }
  })

  test('its tsconfig keeps every library flag except the declaration settings', () => {
    const library = parseJsonc(readFileSync(join(CANONICAL, 'tsconfig.base.json'), 'utf8'))
    const app = parseJsonc(readFileSync(join(CANONICAL, 'app-template/tsconfig.base.json'), 'utf8'))
    const { isolatedDeclarations, declaration, declarationMap, ...shared } = library.compilerOptions
    assert.equal(isolatedDeclarations, true, 'the library base still has it')
    assert.ok(declaration && declarationMap)
    assert.deepEqual(app.compilerOptions, shared)
    assert.equal(app.$schema, library.$schema)
  })

  test('its .gitignore is the library one plus the integration-test scratch output', () => {
    const library = normalize(readFileSync(join(CANONICAL, '.gitignore'), 'utf8'))
    const app = normalize(readFileSync(join(CANONICAL, 'app-template/.gitignore'), 'utf8'))
    assert.ok(app.startsWith(library), 'every library rule, in order (env, Docker, secrets)')
    const extra = app
      .slice(library.length)
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
    assert.deepEqual(extra, ['/.work/', '*.tgz'])
  })
})

describe('canonical .npmrc and .gitignore', () => {
  const npmrc = readFileSync(join(CANONICAL, '.npmrc'), 'utf8')
  /** Active settings only (comments and blank lines removed). */
  const settings = npmrc
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

  test('has exactly the npm supply-chain guards', () => {
    assert.deepEqual(settings, [
      'strict-allow-scripts=true',
      'min-release-age=1',
      'min-release-age-exclude[]=@strutvane/*',
      'allow-git=none',
      'engine-strict=true',
    ])
  })

  test('explains devEngines, and never holds a token or registry credential', () => {
    assert.match(npmrc, /"devEngines"/)
    assert.match(npmrc, /">=11\.19\.0"/)
    assert.doesNotMatch(npmrc, /_authToken|_auth=|_password|registry=/)
  })

  test('.gitignore anchors logs/ to the repo root (dry run B1) and still ignores Docker and env files', () => {
    const lines = readFileSync(join(CANONICAL, '.gitignore'), 'utf8').split(/\r?\n/)
    assert.ok(lines.includes('/logs/'))
    assert.ok(!lines.includes('logs/'))
    for (const required of ['.env', '.env.*', '!.env.example', 'Dockerfile*', 'docker/']) {
      assert.ok(lines.includes(required), required)
    }
  })
})

describe('this repo', () => {
  test('its own synced copies (meta profile) match canonical/', () => {
    const actions = planSync({
      canonicalDir: CANONICAL,
      rootDir: dirname(ROOT),
      manifest,
      repos: ['tooling'],
    }).filter((a) => DRIFT.includes(a.status))
    assert.deepEqual(
      actions.map((a) => `${a.status} ${a.path}`),
      [],
    )
  })

  test('uses the canonical .npmrc and .gitignore (they are not synced into meta repos)', () => {
    for (const file of ['.npmrc', '.gitignore']) {
      assert.equal(
        normalize(readFileSync(join(ROOT, file), 'utf8')),
        normalize(readFileSync(join(CANONICAL, file), 'utf8')),
        file,
      )
    }
  })

  test('is an npm repo: devEngines pins npm, no pnpm left', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    assert.deepEqual(pkg.devEngines?.packageManager, {
      name: 'npm',
      version: '>=11.19.0',
      onFail: 'error',
    })
    assert.equal(pkg.packageManager, undefined)
    const files = readdirSync(ROOT)
    assert.ok(files.includes('package-lock.json'))
    assert.ok(!files.includes('pnpm-lock.yaml'))
    assert.ok(!files.includes('pnpm-workspace.yaml'))
  })

  test('the shared memory, skill and agent never tell anyone to use pnpm or corepack', () => {
    for (const file of [
      '.claude/ECOSYSTEM.md',
      '.claude/skills/strutvane-contribute/SKILL.md',
      '.claude/agents/strutvane-ecosystem-guardian.md',
    ]) {
      const text = readFileSync(join(CANONICAL, file), 'utf8')
      // Naming pnpm or corepack to forbid them is fine; telling anyone to run them is not.
      assert.doesNotMatch(
        text,
        /corepack (pnpm|enable|prepare)|pnpm@\d|\bpnpm (install|i|run|sync|dev|changeset|add|sv|exec|dlx)\b/,
        file,
      )
    }
  })
})
