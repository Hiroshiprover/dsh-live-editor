/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * P1-B: site identity must be stable per site root, the test site keeps its
 * historical namespace, and an import review key cannot cross sites.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOST = path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/index.js')
const { deriveSiteId, handleSite, previewMirrorEnabled } = await import(pathToFileURL(HOST).href)
const { importTaskKey } = await import(pathToFileURL(path.join(ROOT, 'prototypes/phase2/src/state/site-identity.cjs')).href)
const { createMemoryDraftStore, latestId } = await import(pathToFileURL(path.join(ROOT, 'prototypes/phase2/src/state/draft-store.mjs')).href)

const TEST_SITE = path.join(ROOT, 'prototypes/phase2/site')

test('site identity is path-stable and the test site keeps the phase2 namespace', () => {
  assert.equal(deriveSiteId({ root: TEST_SITE }), 'phase2')
  const one = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-site-a-'))
  const two = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-site-b-'))
  try {
    const a = deriveSiteId({ root: one })
    const b = deriveSiteId({ root: two })
    assert.match(a, /^site-[0-9a-f]{16}$/)
    assert.equal(a, deriveSiteId({ root: one }), 'same root must be stable')
    assert.notEqual(a, b)
    assert.notEqual(a, 'phase2')
  } finally {
    fs.rmSync(one, { recursive: true, force: true })
    fs.rmSync(two, { recursive: true, force: true })
  }
})

test('site endpoint reports the identity and rejects a foreign origin', async () => {
  const ok = await handleSite(new Request('http://dsh.local/api/live-editor/site', {
    headers: { origin: 'dsh-app://app' },
  }))
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.ok, true)
  assert.equal(body.siteId, 'phase2')
  const denied = await handleSite(new Request('http://dsh.local/api/live-editor/site', {
    headers: { origin: 'http://evil.example' },
  }))
  assert.equal(denied.status, 403)
})

test('import review keys include the site identity', () => {
  const base = { sessionId: 's1', tabId: 'tab3', path: 'docs/01-intro.mdx' }
  const a = importTaskKey({ siteId: 'phase2', ...base })
  const b = importTaskKey({ siteId: 'site-0123456789abcdef', ...base })
  assert.notEqual(a, b)
  assert.ok(a.includes(':v2:phase2:'))
  assert.ok(b.includes(':v2:site-0123456789abcdef:'))
  assert.notEqual(a, importTaskKey({ siteId: 'phase2', sessionId: 's1', tabId: 'tab4', path: 'docs/01-intro.mdx' }))
  assert.notEqual(a, importTaskKey({ siteId: 'phase2', sessionId: 's2', tabId: 'tab3', path: 'docs/01-intro.mdx' }))
  assert.throws(() => importTaskKey({ ...base }), /siteId is required/)
})

test('draft stores from two sites never see each other at the same path', async () => {
  const pathName = 'docs/01-intro.mdx'
  const siteA = createMemoryDraftStore({ siteId: 'phase2', tabId: 'tab3', sessionId: 's1' })
  const siteB = createMemoryDraftStore({ siteId: 'site-0123456789abcdef', tabId: 'tab3', sessionId: 's1' })
  await siteA.putLatest({
    id: latestId('phase2', pathName, 'tab3', 's1'),
    siteId: 'phase2', path: pathName, tabId: 'tab3', text: 'A-DRAFT', writeSeq: 1,
  })
  await siteB.putLatest({
    id: latestId('site-0123456789abcdef', pathName, 'tab3', 's1'),
    siteId: 'site-0123456789abcdef', path: pathName, tabId: 'tab3', text: 'B-DRAFT', writeSeq: 1,
  })
  assert.equal((await siteA.getLatest(pathName)).text, 'A-DRAFT')
  assert.equal((await siteB.getLatest(pathName)).text, 'B-DRAFT')
  assert.deepEqual((await siteA.listAllLatest()).map((record) => record.text), ['A-DRAFT'])
  assert.deepEqual((await siteB.listAllLatest()).map((record) => record.text), ['B-DRAFT'])
})

test('preview mirror is disabled by either preview switch', () => {
  assert.equal(previewMirrorEnabled({}), true)
  assert.equal(previewMirrorEnabled({ DSH_LIVE_EDITOR_PREVIEW: 'off' }), false)
  assert.equal(previewMirrorEnabled({ DSH_LIVE_EDITOR_PREVIEW_CHANNEL: 'off' }), false)
  assert.equal(previewMirrorEnabled({ DSH_LIVE_EDITOR_PREVIEW: 'off', DSH_LIVE_EDITOR_PREVIEW_CHANNEL: 'off' }), false)
})
