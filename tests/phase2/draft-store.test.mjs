/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Phase 3.2 — local draft storage unit tests (in-memory backend + helpers).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const MODULE = path.resolve(import.meta.dirname, '../../prototypes/phase2/src/state/draft-store.mjs')
const {
  createMemoryDraftStore, hashText, latestId,
  writeEmergency, readEmergencies, deleteEmergency,
  markEmergencyError, readEmergencyErrors, clearEmergencyError,
} = await import(pathToFileURL(MODULE).href)

class FakeStorage {
  constructor () { this.map = new Map() }
  get length () { return this.map.size }
  key (index) { return [...this.map.keys()][index] ?? null }
  getItem (key) { return this.map.get(key) ?? null }
  setItem (key, value) { this.map.set(key, String(value)) }
  removeItem (key) { this.map.delete(key) }
}

const record = (overrides = {}) => ({
  siteId: 'test',
  path: 'a.mdx',
  tabId: 'tab1',
  text: 'A',
  textHash: hashText('A'),
  baseDiskHash: 'H0',
  baseDiskVersion: 1,
  updatedAt: 10,
  writeSeq: 1,
  schemaVersion: 1,
  ...overrides,
})

test('hashText is stable and distinguishes text', () => {
  assert.equal(hashText('abc'), hashText('abc'))
  assert.notEqual(hashText('abc'), hashText('abd'))
  assert.match(hashText('abc'), /^[0-9a-f]{16}$/)
})

test('putLatest: per-tab isolation and writeSeq guard', async () => {
  const store = createMemoryDraftStore({ siteId: 'test', tabId: 'tab1' })
  await store.open()
  await store.putLatest(record({ id: latestId('test', 'a.mdx', 'tab1'), writeSeq: 2, text: 'new' }))
  const skipped = await store.putLatest(record({ id: latestId('test', 'a.mdx', 'tab1'), writeSeq: 1, text: 'old' }))
  assert.equal(skipped.skipped, true)
  const current = await store.getLatest('a.mdx', 'tab1')
  assert.equal(current.text, 'new')
  assert.equal(current.writeSeq, 2)

  await store.putLatest(record({ id: latestId('test', 'a.mdx', 'tab2'), tabId: 'tab2', text: 'other', writeSeq: 1 }))
  const all = await store.listLatest('a.mdx')
  assert.equal(all.length, 2)
  assert.deepEqual(all.map((item) => item.tabId).sort(), ['tab1', 'tab2'])
})

test('history: append/list/mark saved/prune only saved', async () => {
  const store = createMemoryDraftStore({ siteId: 'test', tabId: 'tab1' })
  const first = await store.appendHistory({ ...record({ text: 'old', createdAt: 1, saved: false }), textHash: hashText('old') })
  await store.appendHistory({ ...record({ text: 'new', createdAt: 2, saved: false }), textHash: hashText('new') })
  await store.appendHistory({ ...record({ text: 'saved', createdAt: 3, saved: true }), textHash: hashText('saved') })
  assert.equal((await store.listHistory('a.mdx')).length, 3)
  assert.equal((await store.listHistory('a.mdx'))[0].text, 'saved')
  const marked = await store.markHistorySaved('a.mdx', hashText('old'))
  assert.equal(marked, 1)
  const pruned = await store.pruneHistory('a.mdx', { keep: 1, maxAgeMs: 1e9, now: 100 })
  // saved entries are candidates; keep the newest saved, prune the older saved
  assert.deepEqual(pruned, [first.id])
  const remaining = await store.listHistory('a.mdx')
  assert.equal(remaining.length, 2)
  assert.ok(remaining.some((item) => item.text === 'new' && item.saved === false))
  assert.ok(remaining.some((item) => item.text === 'saved' && item.saved === true))
})

test('emergency helpers read/write/delete and error markers', () => {
  const storage = new FakeStorage()
  const ok = writeEmergency(storage, record({ tabId: 't1' }))
  assert.deepEqual(ok, { ok: true })
  const records = readEmergencies(storage, 'test')
  assert.equal(records.length, 1)
  assert.equal(records[0].text, 'A')
  deleteEmergency(storage, 'test', 'a.mdx', 't1')
  assert.equal(readEmergencies(storage, 'test').length, 0)

  markEmergencyError(storage, 't1', { path: 'a.mdx', at: 1, reason: 'QUOTA' })
  assert.equal(readEmergencyErrors(storage, 't1').length, 1)
  clearEmergencyError(storage, 't1')
  assert.equal(readEmergencyErrors(storage, 't1').length, 0)
})

test('emergency write rejects oversized payloads without throwing', () => {
  const storage = new FakeStorage()
  const result = writeEmergency(storage, record({ text: 'x'.repeat(50) }), { limit: 10 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'EMERGENCY_TOO_LARGE')
})
