/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * 9.0D D3: a DocStore owns timers and in-flight draft writes. Disposing it must
 * stop every timer first, persist the last dirty draft, and be idempotent.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../..')
const DOC_STORE = path.join(ROOT, 'prototypes/phase2/src/state/doc-store.mjs')
const DRAFTS = path.join(ROOT, 'prototypes/phase2/src/state/draft-store.mjs')
const { createDocStore } = await import(pathToFileURL(DOC_STORE).href)
const { createMemoryDraftStore } = await import(pathToFileURL(DRAFTS).href)

const docs = [
  { kind: 'doc', path: 'a.mdx', source: 'docs/a.mdx', permalink: '/docs/a/', docId: 'a', editable: true },
]
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
})
const waitFor = async (fn, timeout = 1000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (fn()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('waitFor timeout')
}
function fetchImpl (url) {
  if (url.startsWith('/api/live-editor/index')) {
    return Promise.resolve(json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 1 }, entries: docs }))
  }
  if (url.startsWith('/api/live-editor/source')) {
    return Promise.resolve(json({ ok: true, text: 'DISK', hash: 'H0', version: 1 }))
  }
  return Promise.reject(new Error(`unexpected url ${url}`))
}

test('D3: dispose stops draft/history timers, flushes a dirty draft, and is idempotent', async () => {
  const timers = new Map()
  let nextTimer = 0
  const scheduler = {
    setTimeout (fn, ms) {
      const id = ++nextTimer
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout (id) { timers.delete(id) },
  }
  const shared = createMemoryDraftStore({ siteId: 'test', tabId: 'tab1', sessionId: 'session-A' })
  const store = createDocStore({
    fetchImpl,
    draftStore: shared,
    draftSiteId: 'test',
    draftTabId: 'tab1',
    draftSessionId: 'session-A',
    draftDebounceMs: 10000,
    historyIntervalMs: 5000,
    scheduler,
    now: () => 1000,
  })
  await store.loadIndex()
  await waitFor(() => store.getDoc('a.mdx')?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'DISPOSE-DRAFT')
  assert.ok(timers.size >= 1, 'editing should schedule at least one timer')

  await store.dispose()
  assert.equal(timers.size, 0, 'dispose must clear every draft/history timer')
  const records = await shared.listLatest('a.mdx')
  assert.ok(records.some((record) => record.text === 'DISPOSE-DRAFT'), 'dirty draft must be flushed before close')

  // A late edit cannot re-arm a timer on a disposed store.
  store.setEditorText('a.mdx', 'AFTER-DISPOSE')
  assert.equal(timers.size, 0, 'disposed store must not schedule new work')
  await store.dispose() // idempotent
})
