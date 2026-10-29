/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Phase 2 / Step 2A — Host route test (no DSH boot).
 *
 * Registers the phase2 host bundle into a fake Cordis context and exercises
 * GET /api/live-editor/index plus the path/origin guards. Auth (401) is
 * enforced by DSH's connection layer and is covered by the Phase 1B runtime
 * tests, not here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { promises as fs } from 'node:fs'

const BUNDLE = path.resolve(import.meta.dirname, '../../prototypes/phase2/dsh-bundle/lib/index.js')
const { apply } = await import(pathToFileURL(BUNDLE).href)

function boot(overrides = {}) {
  const routes = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { fn() },
    connection: { fetch: { register(route) { routes.set(route.path, route) } } },
    fs: {
      resolve: async (absolute) => absolute,
      stat: async () => ({ type: 'file', version: 1 }),
      readText: async () => 'hello',
      ...overrides,
    },
  }
  apply(ctx)
  return routes
}

const routes = boot()
const call = (routePath, init = {}) => {
  const [pathname] = routePath.split('?')
  return routes.get(pathname).fetch(new Request(`http://dsh.local${routePath}`, init))
}

test('GET /index returns the full docs index (read-only)', async () => {
  const response = await call('/api/live-editor/index?refresh=1', { headers: { origin: 'dsh-app://app' } })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.site.id, 'phase2-test')
  assert.equal(body.site.previewRouteBasePath, '/__live-preview')
  const withPreview = body.entries.find((entry) => entry.kind === 'doc' && entry.previewPermalink)
  assert.ok(withPreview)
  assert.match(withPreview.previewPermalink, /^\/__live-preview\//)
  assert.equal(body.site.writable, true)
  assert.deepEqual(body.counts, { dirs: 6, docs: 32, other: 6, skipped: 0 })
  assert.equal(body.entries.length, 44)
  assert.ok(body.entries.every((entry) => !entry.path.startsWith('/') && !entry.path.includes('..')))
  const sources = body.entries.filter((entry) => entry.kind === 'doc').map((entry) => entry.source)
  assert.ok(sources.every((source) => source.startsWith('docs/')))
  assert.ok(sources.includes('docs/QFT/03-classical-field-theory.mdx'))
})

test('GET /index rejects a foreign origin', async () => {
  const response = await call('/api/live-editor/index?refresh=1', { headers: { origin: 'https://evil.example' } })
  assert.equal(response.status, 403)
})

test('GET /source expects the docs/... contract, not docsRoot-relative paths', async () => {
  const ok = await call('/api/live-editor/source?path=docs/01-intro.mdx', { headers: { origin: 'dsh-app://app' } })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.ok, true)
  assert.equal(body.path, 'docs/01-intro.mdx')
  assert.equal(body.text, 'hello')

  const relative = await call('/api/live-editor/source?path=01-intro.mdx', { headers: { origin: 'dsh-app://app' } })
  assert.equal(relative.status, 400)
})

test('GET /source falls back to Node fs when ctx.fs.readText throws Illegal invocation', async () => {
  const fallbackRoutes = boot({
    readText: async () => { throw new Error('Illegal invocation') },
  })
  const response = await fallbackRoutes.get('/api/live-editor/source').fetch(new Request(
    'http://dsh.local/api/live-editor/source?path=docs/01-intro.mdx',
    { headers: { origin: 'dsh-app://app' } },
  ))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.ok(body.text.length > 100)
  assert.match(body.text, /python|Python|intro|前言|量子/)
})

test('POST /save rejects absolute and traversal paths before touching the disk', async () => {
  const post = (body) => call('/api/live-editor/save', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const absolute = await post({ path: '/tmp/dsh-absolute-test.mdx', expectedHash: 'x', content: 'y' })
  assert.equal(absolute.status, 400)
  const traversal = await post({ path: 'docs/../package.json', expectedHash: 'x', content: 'y' })
  assert.equal(traversal.status, 400)
})

test('registered routes are exactly the expected set', () => {
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/live-editor/backups',
    '/api/live-editor/import/cancel',
    '/api/live-editor/import/capabilities',
    '/api/live-editor/import/image',
    '/api/live-editor/index',
    '/api/live-editor/instances',
    '/api/live-editor/instances/docs',
    '/api/live-editor/instances/source',
    '/api/live-editor/preview',
    '/api/live-editor/preview/ack',
    '/api/live-editor/preview/recover',
    '/api/live-editor/restore',
    '/api/live-editor/save',
    '/api/live-editor/site',
    '/api/live-editor/source',
  ])
})


test('GET /index keeps legacy entries default-only while exposing proj discovery metadata', async () => {
  const projRoot = path.resolve(import.meta.dirname, '../../prototypes/phase2/site/proj')
  // Isolate this fixture: the shared proj/ directory also holds the GUI
  // verification documents and must never be deleted by a test run.
  const fixtureName = `test-fixture-${process.pid}-${Date.now()}`
  const projDir = path.join(projRoot, fixtureName)
  const descriptor = path.resolve(import.meta.dirname, '../../prototypes/phase2/site/.dsh-live-editor/instances.json')
  const before = await fs.readFile(descriptor, 'utf8').catch(() => null)
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'sample.mdx'), '---\ntitle: Sample\n---\n# Sample\n')
  await fs.mkdir(path.dirname(descriptor), { recursive: true })
  await fs.writeFile(descriptor, JSON.stringify({
    version: 1, generatedAt: 'test', errors: [],
    instances: [
      { pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'default', sourceRoots: ['docs'], routePath: '/docs', capability: 'docs-editable', preview: false, versions: [{ versionName: 'current', routePath: '/docs', sourceRoots: ['docs'] }] },
      { pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'proj', sourceRoots: ['proj'], routePath: '/proj', capability: 'docs-editable', preview: false, versions: [{ versionName: 'current', routePath: '/proj', sourceRoots: ['proj'] }] },
    ],
  }))
  try {
    const response = await call('/api/live-editor/index?refresh=1', { headers: { origin: 'dsh-app://app' } })
    assert.equal(response.status, 200)
    const body = await response.json()
    const sample = body.entries.find((entry) => entry.source === `proj/${fixtureName}/sample.mdx`)
    assert.equal(sample, undefined, 'proj entries must not feed the default-only index')
    assert.equal(body.entries.some((entry) => entry.instanceId === 'proj'), false)
    const intro = body.entries.find((entry) => entry.source === 'docs/01-intro.mdx')
    assert.equal(intro.instanceId, 'default')
    assert.equal(intro.versionName, 'current')
    assert.equal(intro.sourceRoot, 'docs')
    assert.equal(intro.editable, true)
    assert.equal(body.instances.some((i) => i.instanceId === 'proj'), true)
  } finally {
    await fs.rm(projDir, { recursive: true, force: true })
    if (before !== null) await fs.writeFile(descriptor, before)
    else await fs.rm(descriptor, { force: true })
  }
})
