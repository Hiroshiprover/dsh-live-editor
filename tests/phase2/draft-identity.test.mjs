/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * 9.0D D1/D2 regression tests (written before the fix):
 * - draft identity includes the DSH session, so two sessions with the same tab
 *   number do not share a draft; legacy keys remain readable;
 * - a rebuilt DocStore resumes the persisted writeSeq and can stage a new draft;
 * - emergency copies are session-scoped.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../..')
const DRAFTS = path.join(ROOT, 'prototypes/phase2/src/state/draft-store.mjs')
const DOC_STORE = path.join(ROOT, 'prototypes/phase2/src/state/doc-store.mjs')
const {
  createMemoryDraftStore, hashText, latestId, writeEmergency, readEmergencies, deleteEmergency,
} = await import(pathToFileURL(DRAFTS).href)
const { createDocStore } = await import(pathToFileURL(DOC_STORE).href)

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
function makeFetch () {
  return async (url) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 1 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: 'DISK', hash: 'H0', version: 1 })
    }
    throw new Error(`unexpected url ${url}`)
  }
}
function makeStore (shared, sessionId) {
  return createDocStore({
    fetchImpl: makeFetch(),
    draftStore: shared,
    draftSiteId: 'test',
    draftTabId: 'tab1',
    draftSessionId: sessionId,
    draftDebounceMs: 1000,
    historyIntervalMs: 0,
    scheduler: { setTimeout: () => 0, clearTimeout: () => {} },
  })
}
function latestRecord (overrides = {}) {
  return {
    siteId: 'test',
    path: 'a.mdx',
    tabId: 'tab1',
    text: 'DRAFT',
    textHash: hashText('DRAFT'),
    baseDiskHash: 'H0',
    baseDiskVersion: 1,
    updatedAt: 10,
    writeSeq: 1,
    schemaVersion: 1,
    ...overrides,
  }
}

test('D1: session-scoped draft keys differ and legacy keys stay readable', async () => {
  const a = latestId('test', 'a.mdx', 'tab1', 'session-A')
  const b = latestId('test', 'a.mdx', 'tab1', 'session-B')
  assert.notEqual(a, b, 'session must be part of the draft key')

  const shared = createMemoryDraftStore({ siteId: 'test', tabId: 'tab1' })
  await shared.putLatest({ ...latestRecord({ id: a, sessionId: 'session-A', text: 'A-DRAFT', textHash: hashText('A-DRAFT') }) })
  await shared.putLatest({ ...latestRecord({ id: b, sessionId: 'session-B', text: 'B-DRAFT', textHash: hashText('B-DRAFT') }) })

  const storeA = makeStore(shared, 'session-A')
  await storeA.loadIndex()
  await waitFor(() => storeA.getSnapshot().activeDoc?.loadPhase === 'ready')
  await storeA.checkRecovery('a.mdx')
  await waitFor(() => storeA.getDoc('a.mdx').recovery.status === 'available')
  assert.deepEqual(storeA.getDoc('a.mdx').recovery.latest.map((r) => r.sessionId), ['session-A'])

  const storeB = makeStore(shared, 'session-B')
  await storeB.loadIndex()
  await waitFor(() => storeB.getSnapshot().activeDoc?.loadPhase === 'ready')
  await storeB.checkRecovery('a.mdx')
  await waitFor(() => storeB.getDoc('a.mdx').recovery.status === 'available')
  assert.deepEqual(storeB.getDoc('a.mdx').recovery.latest.map((r) => r.sessionId), ['session-B'])

  // Legacy record (no session) is still offered so old drafts are not lost.
  const legacyId = latestId('test', 'a.mdx', 'tab1')
  await shared.putLatest({ ...latestRecord({ id: legacyId, text: 'LEGACY', textHash: hashText('LEGACY') }) })
  const storeC = makeStore(shared, 'session-C')
  await storeC.loadIndex()
  await waitFor(() => storeC.getSnapshot().activeDoc?.loadPhase === 'ready')
  await storeC.checkRecovery('a.mdx')
  await waitFor(() => storeC.getDoc('a.mdx').recovery.status === 'available')
  assert.ok(storeC.getDoc('a.mdx').recovery.latest.some((r) => r.text === 'LEGACY'))
})

test('D2: recovery resumes the persisted writeSeq and stages the next edit', async () => {
  const shared = createMemoryDraftStore({ siteId: 'test', tabId: 'tab1' })
  const id = latestId('test', 'a.mdx', 'tab1', 'session-A')
  await shared.putLatest({
    ...latestRecord({
      id, sessionId: 'session-A', text: 'OLD-DRAFT', textHash: hashText('OLD-DRAFT'), writeSeq: 100,
    }),
  })
  const store = makeStore(shared, 'session-A')
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  await store.checkRecovery('a.mdx')
  await waitFor(() => store.getDoc('a.mdx').recovery.status === 'available')
  const recovered = await store.recoverLatest('a.mdx')
  assert.equal(recovered.ok, true)
  assert.ok(store.getDoc('a.mdx').draft.writeSeq >= 100, 'restored draft must resume writeSeq')

  store.setEditorText('a.mdx', 'NEW-DRAFT')
  const flushed = await store.flushLatest('a.mdx')
  assert.equal(flushed, true)
  const records = await shared.listLatest('a.mdx')
  const current = records.find((record) => record.text === 'NEW-DRAFT')
  assert.ok(current !== undefined, 'new draft missing')
  assert.equal(current.sessionId, 'session-A')
  assert.ok(Number(current.writeSeq) > 100, `writeSeq must advance past 100, got ${current.writeSeq}`)
})

test('D2: an unrecovered high-seq draft still raises the next writeSeq', async () => {
  const shared = createMemoryDraftStore({ siteId: 'test', tabId: 'tab1' })
  const id = latestId('test', 'a.mdx', 'tab1', 'session-A')
  await shared.putLatest({
    ...latestRecord({
      id, sessionId: 'session-A', text: 'OLD-DRAFT', textHash: hashText('OLD-DRAFT'), writeSeq: 100,
    }),
  })
  const store = makeStore(shared, 'session-A')
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  await store.checkRecovery('a.mdx')
  await waitFor(() => store.getDoc('a.mdx').recovery.status === 'available')
  store.setEditorText('a.mdx', 'NEW-DRAFT-WITHOUT-RECOVERY')
  const flushed = await store.flushLatest('a.mdx')
  assert.equal(flushed, true)
  const records = await shared.listLatest('a.mdx')
  const current = records.find((record) => record.text === 'NEW-DRAFT-WITHOUT-RECOVERY')
  assert.ok(current !== undefined, 'new draft missing')
  assert.ok(Number(current.writeSeq) > 100, `writeSeq must advance past 100, got ${current.writeSeq}`)
})

test('D1: deleting one session draft does not delete another session or legacy record', async () => {
  const storeA = createMemoryDraftStore({ siteId: 'test', tabId: 'tab1', sessionId: 'session-A' })
  const a = latestId('test', 'a.mdx', 'tab1', 'session-A')
  const b = latestId('test', 'a.mdx', 'tab1', 'session-B')
  const legacy = latestId('test', 'a.mdx', 'tab1')
  await storeA.putLatest({ ...latestRecord({ id: a, sessionId: 'session-A', text: 'A', textHash: hashText('A') }) })
  await storeA.putLatest({ ...latestRecord({ id: b, sessionId: 'session-B', text: 'B', textHash: hashText('B') }) })
  await storeA.putLatest({ ...latestRecord({ id: legacy, text: 'LEGACY', textHash: hashText('LEGACY') }) })
  await storeA.deleteLatest('a.mdx', 'tab1')
  const remaining = await storeA.listLatest('a.mdx')
  assert.equal(remaining.some((record) => record.sessionId === 'session-A'), false)
  assert.equal(remaining.some((record) => record.sessionId === 'session-B'), true)
  assert.equal(remaining.some((record) => record.sessionId === undefined), true)
})

test('D1: emergency copies are session-scoped', () => {
  const storage = {
    map: new Map(),
    get length () { return this.map.size },
    key (i) { return [...this.map.keys()][i] ?? null },
    getItem (key) { return this.map.get(key) ?? null },
    setItem (key, value) { this.map.set(key, String(value)) },
    removeItem (key) { this.map.delete(key) },
  }
  writeEmergency(storage, latestRecord({ sessionId: 'session-A', text: 'A-EMERGENCY', textHash: hashText('A-EMERGENCY') }))
  writeEmergency(storage, latestRecord({ path: 'b.mdx', sessionId: 'session-B', text: 'B-EMERGENCY', textHash: hashText('B-EMERGENCY') }))
  assert.equal(readEmergencies(storage, 'test').length, 2, 'two sessions must not overwrite one emergency slot')
  deleteEmergency(storage, 'test', 'a.mdx', 'tab1', 'session-A')
  const remaining = readEmergencies(storage, 'test')
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].sessionId, 'session-B')
})
