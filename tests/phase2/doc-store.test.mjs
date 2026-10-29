/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Phase 2B — document store unit tests.
 *
 * Important contract: the index `path` is relative to docsRoot ("a.mdx"),
 * while the Host source/save API expects the `docs/...` source ("docs/a.mdx").
 * The fixtures below mirror the real `/index` shape to keep that regression
 * covered.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const STORE = path.resolve(import.meta.dirname, '../../prototypes/phase2/src/state/doc-store.mjs')
const DRAFTS = path.resolve(import.meta.dirname, '../../prototypes/phase2/src/state/draft-store.mjs')
const { createDocStore, normalizePath, normalizeSource, docIdentityKey } = await import(pathToFileURL(STORE).href)
const { createMemoryDraftStore, hashText } = await import(pathToFileURL(DRAFTS).href)

const docs = [
  { kind: 'doc', path: 'a.mdx', source: 'docs/a.mdx', permalink: '/docs/a/', docId: 'a', editable: true },
  { kind: 'doc', path: 'b.mdx', source: 'docs/b.mdx', permalink: '/docs/b/', docId: 'b', editable: true },
]
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const waitFor = async (fn, timeout = 1000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (fn()) return
    await tick()
  }
  throw new Error('waitFor timeout')
}

function makeFetch({ sourceText = (p) => `T:${p}`, saveResponse = null } = {}) {
  const sourceCalls = []
  const saveCalls = []
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      const target = new URL(url, 'http://dsh.local').searchParams.get('path')
      sourceCalls.push(target)
      return json({ ok: true, text: sourceText(target), hash: `H0:${target}`, version: 1 })
    }
    if (url.startsWith('/api/live-editor/save')) {
      saveCalls.push({ body: JSON.parse(init.body), init })
      return saveResponse ?? json({ ok: true, hash: 'H1', version: 2 })
    }
    throw new Error(`unexpected url ${url}`)
  }
  return { fetchImpl, sourceCalls, saveCalls }
}

const makeDraft = () => createMemoryDraftStore({ siteId: 'test', tabId: 'tab1' })
const makeDraftStore = (fetchImpl, extra = {}) => createDocStore({
  fetchImpl,
  draftStore: makeDraft(),
  draftSiteId: 'test',
  draftTabId: 'tab1',
  draftDebounceMs: 0,
  historyIntervalMs: 0,
  ...extra,
})

test('normalizePath / normalizeSource', () => {
  assert.equal(normalizePath('/docs/a/'), '/docs/a/')
  assert.equal(normalizePath('/docs/a'), '/docs/a/')
  assert.equal(normalizePath('/'), '/')
  assert.equal(normalizeSource('@site/docs/QFT/a.mdx'), 'docs/QFT/a.mdx')
  assert.equal(normalizeSource('docs/a.mdx'), 'docs/a.mdx')
  assert.equal(normalizeSource('@site/i18n/en/docusaurus-plugin-content-docs/current/a.mdx'), 'i18n/en/docusaurus-plugin-content-docs/current/a.mdx')
  assert.equal(normalizeSource('/abs/docs/a.mdx'), null)
  assert.equal(normalizeSource('docs/../secret.mdx'), null)
})

test('index path is relative; source fetch uses entry.source', async () => {
  const { fetchImpl, sourceCalls } = makeFetch()
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  const snap = store.getSnapshot()
  assert.equal(snap.phase, 'ready')
  assert.equal(snap.activePath, 'a.mdx')
  assert.equal(snap.activeDoc.text, 'T:docs/a.mdx')
  assert.equal(snap.activeDoc.baseHash, 'H0:docs/a.mdx')
  assert.equal(snap.activeDoc.dirty, false)
  // Regression: must not request docsRoot-relative "a.mdx".
  assert.deepEqual(sourceCalls, ['docs/a.mdx'])
})

test('rapid A->B keeps B active while A fills its own cache', async () => {
  const pending = new Map()
  const fetchImpl = async (url) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, entries: docs, site: {}, counts: {} })
    }
    if (url.startsWith('/api/live-editor/source')) {
      const target = new URL(url, 'http://dsh.local').searchParams.get('path')
      return new Promise((resolve) => pending.set(target, () => resolve(json({ ok: true, text: `T:${target}`, hash: `H:${target}`, version: 1 }))))
    }
    throw new Error('unexpected')
  }
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  store.openDoc('b.mdx')
  assert.equal(store.getSnapshot().activePath, 'b.mdx')
  pending.get('docs/b.mdx')?.()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  assert.equal(store.getSnapshot().activeDoc.text, 'T:docs/b.mdx')
  pending.get('docs/a.mdx')?.()
  await tick()
  assert.equal(store.getSnapshot().activePath, 'b.mdx')
  assert.equal(store.getDoc('a.mdx').text, 'T:docs/a.mdx')
})

test('reload drops a stale source response for the same document', async () => {
  const sourceResolvers = []
  const fetchImpl = async (url) => {
    if (url.startsWith('/api/live-editor/index')) return json({ ok: true, entries: docs, site: {}, counts: {} })
    if (url.startsWith('/api/live-editor/source')) {
      const target = new URL(url, 'http://dsh.local').searchParams.get('path')
      return new Promise((resolve) => sourceResolvers.push({ target, resolve: () => resolve(json({ ok: true, text: `T:${target}`, hash: `H:${target}`, version: 1 })) }))
    }
    throw new Error('unexpected')
  }
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  sourceResolvers[0].resolve()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.reload('a.mdx')
  assert.equal(sourceResolvers.length, 2)
  sourceResolvers[1].resolve()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  sourceResolvers[0].resolve()
  await tick()
  assert.equal(store.getDoc('a.mdx').text, 'T:docs/a.mdx')
})

test('save binds the submitted snapshot; typing during save keeps dirty', async () => {
  let resolveSave
  const saveResponse = new Promise((resolve) => { resolveSave = resolve })
  const { fetchImpl, saveCalls } = makeFetch({ saveResponse })
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')

  store.setEditorText('a.mdx', 'one')
  const saving = store.save('a.mdx', 'one')
  assert.equal(saveCalls[0].body.content, 'one')
  assert.equal(saveCalls[0].body.path, 'docs/a.mdx')
  assert.equal(saveCalls[0].body.expectedHash, 'H0:docs/a.mdx')
  store.setEditorText('a.mdx', 'one+two')
  resolveSave(json({ ok: true, hash: 'H1', version: 2 }))
  await saving

  const doc = store.getDoc('a.mdx')
  assert.equal(doc.baseText, 'one')
  assert.equal(doc.baseHash, 'H1')
  assert.equal(doc.text, 'one+two')
  assert.equal(doc.dirty, true)
  assert.equal(doc.savePhase, 'saved')
})

test('409 conflict keeps the baseline and dirty state', async () => {
  const { fetchImpl } = makeFetch({ saveResponse: json({ ok: false, code: 'STALE', currentHash: 'HX' }, 409) })
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'changed')
  const ok = await store.save('a.mdx', 'changed')
  const doc = store.getDoc('a.mdx')
  assert.equal(ok, false)
  assert.equal(doc.savePhase, 'conflict')
  assert.equal(doc.baseHash, 'H0:docs/a.mdx')
  assert.equal(doc.dirty, true)
  assert.equal(doc.conflict.currentHash, 'HX')
  // P0: a live 409 must reuse the explicit recovery bar, not dead-end.
  assert.equal(doc.reconcile.required, true)
  assert.equal(doc.reconcile.restoredFrom, 'external-change')
  assert.match(doc.saveError, /草稿已保留/)
  const reload = store.reload('a.mdx')
  assert.equal(reload.ok, false)
  assert.equal(reload.reason, 'reconcile')
})

test('P0: live 409 overwrite re-reads the disk hash and uses a fresh CAS', async () => {
  let saveCalls = 0
  const bodies = []
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: 'DISK-NEW', hash: 'H-DISK-NEW', version: 3 })
    }
    if (url.startsWith('/api/live-editor/save')) {
      saveCalls += 1
      bodies.push(JSON.parse(init.body))
      if (saveCalls === 1) return json({ ok: false, code: 'STALE', currentHash: 'H-DISK-NEW' }, 409)
      return json({ ok: true, hash: 'H-AFTER', version: 4 })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const store = createDocStore({
    fetchImpl, draftStore: makeDraft(), draftSiteId: 'test', draftTabId: 'tab1', draftDebounceMs: 10000, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'MY-CHANGED-TEXT')
  const ok = await store.save('a.mdx', 'MY-CHANGED-TEXT')
  assert.equal(ok, false)
  const doc = store.getDoc('a.mdx')
  assert.equal(doc.reconcile.required, true)
  assert.equal(doc.reconcile.restoredFrom, 'external-change')

  const resolved = await store.resolveReconcile('a.mdx', 'overwrite', {
    bodyId: 'boot-test-b1', source: 'reconcile-overwrite', viewerOpen: false,
  })
  assert.equal(resolved.ok, true)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[1].expectedHash, 'H-DISK-NEW', 'overwrite must re-read the current disk hash')
  assert.equal(bodies[1].content, 'MY-CHANGED-TEXT')
  assert.equal(doc.reconcile.required, false)
  assert.equal(doc.baseHash, 'H-AFTER')
})

test('P0: use-disk keeps a recoverable draft snapshot before replacing the editor', async () => {
  let diskText = 'DISK-OLD'
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: diskText, hash: `H:${diskText}`, version: 1 })
    }
    if (url.startsWith('/api/live-editor/save')) {
      return json({ ok: false, code: 'STALE', currentHash: 'H-OTHER' }, 409)
    }
    throw new Error(`unexpected url ${url}`)
  }
  const draftStore = makeDraft()
  const store = createDocStore({
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tab1', draftDebounceMs: 10000, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'UNSAVED-EDITOR-TEXT')
  const ok = await store.save('a.mdx', 'UNSAVED-EDITOR-TEXT')
  assert.equal(ok, false)
  diskText = 'DISK-AFTER'
  const resolved = await store.resolveReconcile('a.mdx', 'disk')
  assert.equal(resolved.ok, true)
  const doc = store.getDoc('a.mdx')
  assert.equal(doc.text, 'DISK-AFTER')
  assert.equal(doc.reconcile.required, false)
  const latest = await draftStore.listLatest('a.mdx')
  assert.equal(latest.some((record) => record.text === 'UNSAVED-EDITOR-TEXT'), true, 'editor text must remain recoverable')
  await waitFor(() => store.getDoc('a.mdx').recovery.latest.some((record) => record.text === 'UNSAVED-EDITOR-TEXT'))
})

test('activateRoute resolves by source/permalink; unknown routes become page mode', async () => {
  const { fetchImpl } = makeFetch()
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  assert.equal(store.activateRoute({ source: '@site/docs/b.mdx' }), true)
  await waitFor(() => store.getSnapshot().activeDoc?.path === 'b.mdx' && store.getSnapshot().activeDoc?.loadPhase === 'ready')
  assert.equal(store.activateRoute({ permalink: '/docs/a/' }), true)
  await waitFor(() => store.getSnapshot().activeDoc?.path === 'a.mdx')
  assert.equal(store.activateRoute({ permalink: '/blog/hello/' }), false)
  const snap = store.getSnapshot()
  assert.equal(snap.activePath, null)
  assert.equal(snap.page.reason, 'unmapped')
})

test('reload/open clears a stale route notice', async () => {
  const { fetchImpl } = makeFetch()
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')

  store.setNotice('预览已跳转；源码有未保存修改，未自动切换。请先保存或重载。')
  assert.notEqual(store.getSnapshot().notice, null)
  store.reload('a.mdx')
  assert.equal(store.getSnapshot().notice, null)
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')

  store.setNotice('again')
  store.openDoc('b.mdx')
  assert.equal(store.getSnapshot().notice, null)
})

test('notice metadata carries tone/lifetime and clearNotice dismisses it', async () => {
  const { fetchImpl } = makeFetch()
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')

  store.setNotice('已追加', { tone: 'success', ttlMs: 10_000 })
  let snap = store.getSnapshot()
  assert.equal(snap.notice, '已追加')
  assert.equal(snap.noticeMeta.tone, 'success')
  assert.equal(snap.noticeMeta.ttlMs, 10_000)
  const firstId = snap.noticeMeta.id
  assert.equal(typeof firstId, 'number')

  // Re-setting the same text must restart the timer, not keep the old one.
  store.setNotice('已追加', { tone: 'success', ttlMs: 10_000 })
  assert.ok(store.getSnapshot().noticeMeta.id > firstId)

  store.clearNotice()
  snap = store.getSnapshot()
  assert.equal(snap.notice, null)
  assert.equal(snap.noticeMeta, null)

  // Without options a notice keeps the previous persistent error-style shape.
  store.setNotice('普通提示')
  snap = store.getSnapshot()
  assert.equal(snap.noticeMeta.tone, 'error')
  assert.equal(snap.noticeMeta.ttlMs, null)
})

test('dirty clears when text returns to the loaded baseline', async () => {
  const { fetchImpl } = makeFetch()
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'T:docs/a.mdx + edit')
  assert.equal(store.getDoc('a.mdx').dirty, true)
  store.setEditorText('a.mdx', 'T:docs/a.mdx')
  assert.equal(store.getDoc('a.mdx').dirty, false)
})

test('dirty A + preview route B is blocked; page mode keeps the draft', async () => {
  const { fetchImpl } = makeFetch()
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'T:docs/a.mdx + draft')

  const blocked = store.previewRoute({ source: '@site/docs/b.mdx' })
  assert.deepEqual(blocked, { ok: false, reason: 'dirty', activePath: 'a.mdx' })
  assert.equal(store.getSnapshot().activePath, 'a.mdx')
  assert.match(store.getSnapshot().notice, /未自动切换/)

  // route-unmapped / page mode must not lose the draft
  store.setPage({ permalink: '/blog/', title: 'Blog', reason: 'unmapped' })
  assert.equal(store.getSnapshot().activePath, null)
  assert.equal(store.getSnapshot().lastActivePath, 'a.mdx')
  assert.equal(store.getDoc('a.mdx').text, 'T:docs/a.mdx + draft')
  assert.equal(store.getDoc('a.mdx').dirty, true)

  store.openDoc('a.mdx')
  assert.equal(store.getSnapshot().activePath, 'a.mdx')
  assert.equal(store.getSnapshot().activeDoc.dirty, true)
  assert.equal(store.getSnapshot().activeDoc.text, 'T:docs/a.mdx + draft')
})

test('save response applies to the saved doc after switching away', async () => {
  let resolveSave
  const saveResponse = new Promise((resolve) => { resolveSave = resolve })
  const { fetchImpl } = makeFetch({ saveResponse })
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')

  store.setEditorText('a.mdx', 'saved-A')
  const saving = store.save('a.mdx', 'saved-A')
  store.openDoc('b.mdx')
  await waitFor(() => store.getSnapshot().activeDoc?.path === 'b.mdx' && store.getSnapshot().activeDoc?.loadPhase === 'ready')

  resolveSave(json({ ok: true, hash: 'HA', version: 2 }))
  await saving
  const a = store.getDoc('a.mdx')
  assert.equal(a.baseHash, 'HA')
  assert.equal(a.dirty, false)
  assert.equal(store.getSnapshot().activePath, 'b.mdx')
})

test('successful save with a changed loadEpoch never claims clean', async () => {
  let resolveSave
  const sourceResolvers = []
  const fetchImpl = async (url) => {
    if (url.startsWith('/api/live-editor/index')) return json({ ok: true, entries: docs, site: {}, counts: {} })
    if (url.startsWith('/api/live-editor/source')) {
      return new Promise((resolve) => sourceResolvers.push(resolve))
    }
    if (url.startsWith('/api/live-editor/save')) {
      return new Promise((resolve) => { resolveSave = resolve })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  sourceResolvers[0](json({ ok: true, text: 'BASE', hash: 'H0', version: 1 }))
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')

  store.setEditorText('a.mdx', 'EDIT')
  const saving = store.save('a.mdx', 'EDIT')

  // user reload is refused while saving; a forced reload (test) changes the epoch
  const blocked = store.reload('a.mdx')
  assert.deepEqual(blocked, { ok: false, reason: 'saving' })
  const forced = store.reload('a.mdx', { force: true })
  assert.equal(forced.ok, true)
  assert.equal(sourceResolvers.length, 2)
  sourceResolvers[1](json({ ok: true, text: 'BASE', hash: 'H0', version: 1 }))
  await waitFor(() => store.getDoc('a.mdx').loadPhase === 'ready')

  resolveSave(json({ ok: true, hash: 'H1', version: 2 }))
  await saving

  const doc = store.getDoc('a.mdx')
  assert.equal(doc.savePhase, 'stale')
  assert.equal(doc.staleAfterSave, true)
  assert.equal(doc.dirty, true)
  assert.equal(doc.baseHash, 'H0')
  assert.match(doc.saveNotice, /重新加载/)
})

test('draftPaths + discardDraft reset the draft to the baseline', async () => {
  const { fetchImpl } = makeFetch()
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'T:docs/a.mdx edited')
  assert.deepEqual(store.getSnapshot().draftPaths, ['a.mdx'])
  store.discardDraft('a.mdx')
  const doc = store.getDoc('a.mdx')
  assert.equal(doc.text, 'T:docs/a.mdx')
  assert.equal(doc.dirty, false)
  assert.deepEqual(store.getSnapshot().draftPaths, [])
})

test('index failure surfaces index-error without crashing', async () => {
  const fetchImpl = async () => json({ ok: false, error: 'boom' }, 500)
  const store = createDocStore({ fetchImpl })
  await store.loadIndex()
  const snap = store.getSnapshot()
  assert.equal(snap.phase, 'index-error')
  assert.match(snap.notice, /文件索引加载失败/)
  assert.equal(snap.activeDoc, null)
})

test('Model B: edits stage a local draft and never call save', async () => {
  const { fetchImpl, saveCalls } = makeFetch({ sourceText: () => 'BASE' })
  const draftStore = makeDraft()
  const store = createDocStore({
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tab1', draftDebounceMs: 0, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'BASE + edit')
  await waitFor(() => store.getDoc('a.mdx').draft.status === 'persisted', 2000)
  assert.equal(saveCalls.length, 0)
  assert.equal(store.getDoc('a.mdx').dirty, true)
  const latest = await draftStore.getLatest('a.mdx', 'tab1')
  assert.equal(latest.text, 'BASE + edit')
  assert.equal(store.getDoc('a.mdx').draft.persistedHash, hashText('BASE + edit'))
  assert.deepEqual(await store.ensureDraftSafe('a.mdx'), { ok: true })
  const routed = store.previewRoute({ source: '@site/docs/b.mdx' })
  assert.equal(routed.ok, true)
  assert.equal(store.getSnapshot().activePath, 'b.mdx')
})

test('C2: write completion binds to the submitted snapshot', async () => {
  const { fetchImpl } = makeFetch({ sourceText: () => 'BASE' })
  const base = makeDraft()
  const pending = []
  const draftStore = {
    ...base,
    putLatest (record) {
      return new Promise((resolve, reject) => {
        pending.push({ record, resolve: () => base.putLatest(record).then(resolve, reject) })
      })
    },
  }
  const store = createDocStore({
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tab1', draftDebounceMs: 0, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'A')
  await waitFor(() => store.getDoc('a.mdx').draft.status === 'writing')
  store.setEditorText('a.mdx', 'B')
  await waitFor(() => pending.length === 1)
  pending[0].resolve()
  await waitFor(() => pending.length === 2)
  assert.equal(pending[0].record.text, 'A')
  assert.equal(pending[1].record.text, 'B')
  pending[1].resolve()
  await waitFor(() => store.getDoc('a.mdx').draft.status === 'persisted', 2000)
  const doc = store.getDoc('a.mdx')
  assert.equal(doc.draft.persistedHash, hashText('B'))
  const latest = await base.getLatest('a.mdx', 'tab1')
  assert.equal(latest.text, 'B')
  assert.equal(latest.writeSeq, 2)
})

test('C1: restoring an old draft blocks normal save until explicit overwrite', async () => {
  let diskText = 'BASE'
  let diskHash = 'H0:docs/a.mdx'
  const saveCalls = []
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, entries: docs, site: {}, counts: {} })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: diskText, hash: diskHash, version: 1 })
    }
    if (url.startsWith('/api/live-editor/save')) {
      saveCalls.push(JSON.parse(init.body))
      return json({ ok: true, hash: 'H-OVERWRITE', version: 2 })
    }
    throw new Error('unexpected')
  }
  const draftStore = makeDraft()
  const store = createDocStore({
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tab1', draftDebounceMs: 0, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'OLD-DRAFT')
  await waitFor(() => store.getDoc('a.mdx').draft.status === 'persisted')

  diskText = 'NEW-DISK'
  diskHash = 'H2:docs/a.mdx'
  store.reload('a.mdx')
  await waitFor(() => store.getDoc('a.mdx').loadPhase === 'ready' && store.getDoc('a.mdx').baseHash === 'H2:docs/a.mdx')
  await waitFor(() => store.getDoc('a.mdx').recovery.status === 'available')
  const doc = store.getDoc('a.mdx')
  assert.equal(doc.text, 'NEW-DISK')
  assert.equal(doc.recovery.conflict, true)

  const restored = await store.recoverLatest('a.mdx')
  assert.equal(restored.ok, true)
  assert.equal(doc.text, 'OLD-DRAFT')
  assert.equal(doc.reconcile.required, true)

  const saved = await store.save('a.mdx', 'OLD-DRAFT')
  assert.equal(saved, false)
  assert.equal(saveCalls.length, 0)
  assert.match(doc.saveError, /冲突|磁盘/)

  const resolved = await store.resolveReconcile('a.mdx', 'overwrite', {
    bodyId: 'boot-test-b1', source: 'reconcile-overwrite', viewerOpen: false,
  })
  assert.equal(resolved.ok, true)
  assert.equal(saveCalls.length, 1)
  assert.equal(saveCalls[0].expectedHash, 'H2:docs/a.mdx')
  assert.equal(saveCalls[0].diagBodyId, 'boot-test-b1')
  assert.equal(saveCalls[0].diagSource, 'reconcile-overwrite')
  assert.equal(doc.reconcile.required, false)
})

test('P0: a remounted tab with an unsaved draft stops on the changed disk', async () => {
  // Realistic multi-tab sequence under the current single-mounted-body UI:
  // tab B edited and its draft was persisted; tab A (or an external editor)
  // then saved a newer disk version; switching back remounts B and reloads
  // the disk. The draft must surface as a conflict and normal save must stop.
  let diskText = 'DISK-OLD'
  let diskHash = 'H-OLD'
  const saveCalls = []
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: diskText, hash: diskHash, version: 1 })
    }
    if (url.startsWith('/api/live-editor/save')) {
      saveCalls.push(JSON.parse(init.body))
      return json({ ok: true, hash: 'H-AFTER', version: 2 })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const draftStore = makeDraft()
  const options = {
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 0, historyIntervalMs: 0,
  }
  const first = createDocStore(options)
  await first.loadIndex()
  await waitFor(() => first.getSnapshot().activeDoc?.loadPhase === 'ready')
  first.setEditorText('a.mdx', 'B-UNSAVED-DRAFT')
  await waitFor(() => first.getDoc('a.mdx').draft.status === 'persisted')

  // Another tab saves a newer disk version while B is unmounted.
  diskText = 'A-SAVED-TEXT'
  diskHash = 'H-A-SAVED'

  const second = createDocStore(options)
  await second.loadIndex()
  await waitFor(() => second.getSnapshot().activeDoc?.loadPhase === 'ready')
  await waitFor(() => second.getDoc('a.mdx').recovery.status === 'available')
  const doc = second.getDoc('a.mdx')
  assert.equal(doc.text, 'A-SAVED-TEXT', 'remount reads the current disk')
  assert.equal(doc.recovery.conflict, true, 'the old draft is flagged against the new disk')
  assert.equal(doc.recovery.latest.some((record) => record.text === 'B-UNSAVED-DRAFT'), true)

  const restored = await second.recoverLatest('a.mdx')
  assert.equal(restored.ok, true)
  assert.equal(doc.text, 'B-UNSAVED-DRAFT')
  assert.equal(doc.reconcile.required, true)
  const blocked = await second.save('a.mdx', 'B-UNSAVED-DRAFT')
  assert.equal(blocked, false)
  assert.equal(saveCalls.length, 0, 'normal save must not overwrite the newer disk')
  assert.match(doc.saveError, /冲突|磁盘/)

  const resolved = await second.resolveReconcile('a.mdx', 'overwrite', {
    bodyId: 'boot-test-b1', source: 'reconcile-overwrite', viewerOpen: false,
  })
  assert.equal(resolved.ok, true)
  assert.equal(saveCalls.length, 1)
  assert.equal(saveCalls[0].expectedHash, 'H-A-SAVED')
})

test('P0: restored draft keeps its true origin across auto-stash and a second remount', async () => {
  let diskText = 'DISK-0'
  let diskHash = 'H0'
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: diskText, hash: diskHash, version: 1 })
    }
    if (url.startsWith('/api/live-editor/save')) {
      return json({ ok: false, code: 'STALE', currentHash: diskHash }, 409)
    }
    throw new Error(`unexpected url ${url}`)
  }
  const draftStore = makeDraft()
  const options = {
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 0, historyIntervalMs: 0,
  }
  const first = createDocStore(options)
  await first.loadIndex()
  await waitFor(() => first.getSnapshot().activeDoc?.loadPhase === 'ready')
  first.setEditorText('a.mdx', 'U-ON-H0')
  await waitFor(() => first.getDoc('a.mdx').draft.status === 'persisted')

  diskText = 'DISK-1'
  diskHash = 'H1'
  const second = createDocStore(options)
  await second.loadIndex()
  await waitFor(() => second.getSnapshot().activeDoc?.loadPhase === 'ready')
  await waitFor(() => second.getDoc('a.mdx').recovery.status === 'available')
  const restored = await second.recoverLatest('a.mdx')
  assert.equal(restored.ok, true)
  assert.equal(second.getDoc('a.mdx').reconcile.required, true)

  // Edit the restored draft: this auto-stashes it. The stored origin must stay
  // H0, otherwise a later remount would treat it as based on H1.
  second.setEditorText('a.mdx', 'U-ON-H0-EDITED')
  await waitFor(() => second.getDoc('a.mdx').draft.status === 'persisted')
  const records = await draftStore.listLatest('a.mdx')
  assert.equal(records[0].baseDiskHash, 'H0')

  const third = createDocStore(options)
  await third.loadIndex()
  await waitFor(() => third.getSnapshot().activeDoc?.loadPhase === 'ready')
  await waitFor(() => third.getDoc('a.mdx').recovery.status === 'available')
  const doc = third.getDoc('a.mdx')
  assert.equal(doc.recovery.conflict, true)
  const again = await third.recoverLatest('a.mdx')
  assert.equal(again.ok, true)
  assert.equal(doc.reconcile.required, true)
  const blocked = await third.save('a.mdx', 'U-ON-H0-EDITED')
  assert.equal(blocked, false)
  assert.match(doc.saveError, /冲突|磁盘/)
})

test('P0: use-disk writes an independent before-reconcile history snapshot', async () => {
  let diskText = 'DISK-0'
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: diskText, hash: `H:${diskText}`, version: 1 })
    }
    if (url.startsWith('/api/live-editor/save')) {
      return json({ ok: false, code: 'STALE', currentHash: 'H-OTHER' }, 409)
    }
    throw new Error(`unexpected url ${url}`)
  }
  const draftStore = makeDraft()
  const store = createDocStore({
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 10000, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'UNSAVED-CONFLICT-TEXT')
  await store.save('a.mdx', 'UNSAVED-CONFLICT-TEXT')
  diskText = 'DISK-1'
  const resolved = await store.resolveReconcile('a.mdx', 'disk')
  assert.equal(resolved.ok, true)
  const history = await draftStore.listHistory('a.mdx', { limit: 100 })
  const snapshot = history.find((record) => record.reason === 'before-reconcile')
  assert.ok(snapshot !== undefined, 'independent history snapshot missing')
  assert.equal(snapshot.text, 'UNSAVED-CONFLICT-TEXT')
})

test('P0: editing during a disk reload aborts the replace and keeps the new text', async () => {
  let sourceCalls = 0
  let releaseSource = null
  const sourcePending = deferred()
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      sourceCalls += 1
      if (sourceCalls === 1) return json({ ok: true, text: 'DISK-OLD', hash: 'H-OLD', version: 1 })
      sourcePending.resolve()
      return await new Promise((resolve) => {
        releaseSource = () => resolve(json({ ok: true, text: 'DISK-NEW', hash: 'H-NEW', version: 2 }))
      })
    }
    if (url.startsWith('/api/live-editor/save')) {
      return json({ ok: false, code: 'STALE', currentHash: 'H-NEW' }, 409)
    }
    throw new Error(`unexpected url ${url}`)
  }
  const store = createDocStore({
    fetchImpl, draftStore: makeDraft(), draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 0, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'OLD-DRAFT')
  await waitFor(() => store.getDoc('a.mdx').draft.status === 'persisted')
  await store.save('a.mdx', 'OLD-DRAFT')
  const pending = store.resolveReconcile('a.mdx', 'disk')
  await sourcePending.promise
  store.setEditorText('a.mdx', 'TYPED-DURING-RELOAD')
  releaseSource()
  const result = await pending
  const doc = store.getDoc('a.mdx')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'changed-during-reload')
  assert.equal(doc.text, 'TYPED-DURING-RELOAD')
  assert.equal(doc.reconcile.required, true)
})

test('P0: overwrite that receives another 409 stays in conflict', async () => {
  let saveCalls = 0
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: 'DISK-1', hash: 'H1', version: 2 })
    }
    if (url.startsWith('/api/live-editor/save')) {
      saveCalls += 1
      if (saveCalls === 1) return json({ ok: false, code: 'STALE', currentHash: 'H1' }, 409)
      return json({ ok: false, code: 'STALE', currentHash: 'H2' }, 409)
    }
    throw new Error(`unexpected url ${url}`)
  }
  const store = createDocStore({
    fetchImpl, draftStore: makeDraft(), draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 0, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'MY-TEXT')
  await store.save('a.mdx', 'MY-TEXT')
  const doc = store.getDoc('a.mdx')
  assert.equal(doc.reconcile.required, true)
  const resolved = await store.resolveReconcile('a.mdx', 'overwrite')
  assert.equal(resolved.ok, false)
  assert.equal(saveCalls, 2)
  assert.equal(doc.reconcile.required, true)
  assert.match(doc.saveError, /冲突|磁盘/)
})

test('P0: a forced reload does not turn a WRITE_UNCONFIRMED into "saved"', async () => {
  const saveDeferred = deferred()
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: 'DISK-NEW', hash: 'H-NEW', version: 2 })
    }
    if (url.startsWith('/api/live-editor/save')) {
      return await saveDeferred.promise
    }
    throw new Error(`unexpected url ${url}`)
  }
  const store = createDocStore({
    fetchImpl, draftStore: makeDraft(), draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 10000, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'MY-EDIT')
  const saving = store.save('a.mdx', 'MY-EDIT')
  await tick()
  store.reload('a.mdx', { force: true })
  await waitFor(() => store.getDoc('a.mdx').loadPhase === 'ready' && store.getDoc('a.mdx').baseHash === 'H-NEW')
  saveDeferred.resolve(json({ ok: false, code: 'WRITE_UNCONFIRMED', currentHash: null }, 500))
  const ok = await saving
  const doc = store.getDoc('a.mdx')
  assert.equal(ok, false)
  assert.equal(doc.savePhase, 'conflict')
  assert.equal(doc.reconcile.required, true)
  assert.match(doc.saveError, /未确认/)
  assert.equal(doc.saveNotice, null)
})

test('P0: a second conflict action is rejected while one is running', async () => {
  let sourceCalls = 0
  let saveCalls = 0
  const getDeferred = deferred()
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      sourceCalls += 1
      if (sourceCalls === 1) return json({ ok: true, text: 'DISK-0', hash: 'H0', version: 1 })
      return await getDeferred.promise
    }
    if (url.startsWith('/api/live-editor/save')) {
      saveCalls += 1
      if (saveCalls === 1) return json({ ok: false, code: 'STALE', currentHash: 'H1' }, 409)
      return json({ ok: true, hash: 'H2', version: 3 })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const store = createDocStore({
    fetchImpl, draftStore: makeDraft(), draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 10000, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'MY-TEXT')
  await store.save('a.mdx', 'MY-TEXT')
  const first = store.resolveReconcile('a.mdx', 'overwrite')
  await waitFor(() => sourceCalls === 2)
  const second = await store.resolveReconcile('a.mdx', 'overwrite')
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'busy')
  getDeferred.resolve(json({ ok: true, text: 'DISK-1', hash: 'H1', version: 2 }))
  const firstResult = await first
  assert.equal(firstResult.ok, true)
  assert.equal(store.getDoc('a.mdx').reconcile.required, false)
})

test('P0: emergency copy keeps the restored draft origin', async () => {
  let diskText = 'DISK-0'
  let diskHash = 'H0'
  const fetchImpl = async (url) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: diskText, hash: diskHash, version: 1 })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const draftStore = makeDraft()
  const options = {
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 0, historyIntervalMs: 0,
  }
  const first = createDocStore(options)
  await first.loadIndex()
  await waitFor(() => first.getSnapshot().activeDoc?.loadPhase === 'ready')
  first.setEditorText('a.mdx', 'U0')
  await waitFor(() => first.getDoc('a.mdx').draft.status === 'persisted')

  diskText = 'DISK-1'
  diskHash = 'H1'
  const second = createDocStore(options)
  await second.loadIndex()
  await waitFor(() => second.getSnapshot().activeDoc?.loadPhase === 'ready')
  await waitFor(() => second.getDoc('a.mdx').recovery.status === 'available')
  await second.recoverLatest('a.mdx')
  second.setEditorText('a.mdx', 'U1')
  await second.flushEmergencyAll()
  const emergencies = await draftStore.listEmergencies()
  const record = emergencies.find((item) => item.path === 'a.mdx')
  assert.ok(record !== undefined)
  assert.equal(record.baseDiskHash, 'H0')
})

test('P0: an unconfirmed overwrite preserves the restored draft origin', async () => {
  let diskText = 'DISK-0'
  let diskHash = 'H0'
  let saveCalls = 0
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: diskText, hash: diskHash, version: 1 })
    }
    if (url.startsWith('/api/live-editor/save')) {
      saveCalls += 1
      return json({ ok: false, code: 'WRITE_UNCONFIRMED', currentHash: null }, 500)
    }
    throw new Error(`unexpected url ${url}`)
  }
  const draftStore = makeDraft()
  const options = {
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 0, historyIntervalMs: 0,
  }
  const first = createDocStore(options)
  await first.loadIndex()
  await waitFor(() => first.getSnapshot().activeDoc?.loadPhase === 'ready')
  first.setEditorText('a.mdx', 'U0')
  await waitFor(() => first.getDoc('a.mdx').draft.status === 'persisted')

  diskText = 'DISK-1'
  diskHash = 'H1'
  const second = createDocStore(options)
  await second.loadIndex()
  await waitFor(() => second.getSnapshot().activeDoc?.loadPhase === 'ready')
  await waitFor(() => second.getDoc('a.mdx').recovery.status === 'available')
  await second.recoverLatest('a.mdx')
  const doc = second.getDoc('a.mdx')
  assert.equal(doc.reconcile.draftBaseDiskHash, 'H0')
  const resolved = await second.resolveReconcile('a.mdx', 'overwrite')
  assert.equal(resolved.ok, false)
  assert.equal(saveCalls, 1)
  assert.equal(doc.reconcile.required, true)
  assert.equal(doc.reconcile.draftBaseDiskHash, 'H0')
  assert.match(doc.saveError, /未确认/)
})

test('P0: recovery and discard are blocked while a save is in flight', async () => {
  const saveDeferred = deferred()
  const fetchImpl = async (url) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: 'DISK', hash: 'H0', version: 1 })
    }
    if (url.startsWith('/api/live-editor/save')) return await saveDeferred.promise
    throw new Error(`unexpected url ${url}`)
  }
  const store = createDocStore({
    fetchImpl, draftStore: makeDraft(), draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 0, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'U')
  await waitFor(() => store.getDoc('a.mdx').draft.status === 'persisted')
  await store.checkRecovery('a.mdx')
  const saving = store.save('a.mdx', 'U')
  await tick()
  const recovered = await store.recoverLatest('a.mdx')
  assert.equal(recovered.ok, false)
  assert.equal(recovered.reason, 'busy')
  assert.equal(store.discardDraft('a.mdx'), false)
  saveDeferred.resolve(json({ ok: true, hash: 'H1', version: 2 }))
  await saving
})

test('P0: ordinary reload does not overwrite text typed during the fetch', async () => {
  let sourceCalls = 0
  const sourcePending = deferred()
  let release = null
  const fetchImpl = async (url) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      sourceCalls += 1
      if (sourceCalls === 1) return json({ ok: true, text: 'DISK-0', hash: 'H0', version: 1 })
      sourcePending.resolve()
      return await new Promise((resolve) => {
        release = () => resolve(json({ ok: true, text: 'DISK-1', hash: 'H1', version: 2 }))
      })
    }
    throw new Error(`unexpected url ${url}`)
  }
  const store = createDocStore({
    fetchImpl, draftStore: makeDraft(), draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 0, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.reload('a.mdx')
  await sourcePending.promise
  store.setEditorText('a.mdx', 'TYPED-DURING-RELOAD')
  release()
  await waitFor(() => store.getDoc('a.mdx').loadPhase === 'ready')
  assert.equal(store.getDoc('a.mdx').text, 'TYPED-DURING-RELOAD')
  assert.equal(store.getDoc('a.mdx').dirty, true)
})

test('P0: a load during an in-flight save does not release the save lock', async () => {
  const saveDeferred = deferred()
  const fetchImpl = async (url) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: 'DISK-NEW', hash: 'H1', version: 2 })
    }
    if (url.startsWith('/api/live-editor/save')) return await saveDeferred.promise
    throw new Error(`unexpected url ${url}`)
  }
  const store = createDocStore({
    fetchImpl, draftStore: makeDraft(), draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 10000, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'U')
  const saving = store.save('a.mdx', 'U')
  await tick()
  store.reload('a.mdx', { force: true })
  await waitFor(() => store.getDoc('a.mdx').loadPhase === 'ready')
  assert.equal(store.getDoc('a.mdx').savePhase, 'saving')
  saveDeferred.resolve(json({ ok: true, hash: 'H2', version: 3 }))
  await saving
  assert.equal(store.getDoc('a.mdx').savePhase, 'stale')
})

test('P0: a transport failure enters the unconfirmed conflict state', async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith('/api/live-editor/index')) {
      return json({ ok: true, site: { id: 'test', writable: true }, counts: { docs: 2 }, entries: docs })
    }
    if (url.startsWith('/api/live-editor/source')) {
      return json({ ok: true, text: 'DISK', hash: 'H0', version: 1 })
    }
    throw new Error('network down')
  }
  const store = createDocStore({
    fetchImpl, draftStore: makeDraft(), draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 10000, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'U')
  const ok = await store.save('a.mdx', 'U')
  const doc = store.getDoc('a.mdx')
  assert.equal(ok, false)
  assert.equal(doc.savePhase, 'conflict')
  assert.equal(doc.reconcile.required, true)
  assert.equal(doc.reconcile.restoredFrom, 'write-unconfirmed')
  assert.match(doc.saveError, /未确认/)
})

test('P0: a history-only snapshot remains visible in the drafts list', async () => {
  const { fetchImpl } = makeFetch()
  const draftStore = makeDraft()
  const store = createDocStore({
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tabB', draftDebounceMs: 10000, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  await draftStore.appendHistory({
    siteId: 'test',
    path: 'a.mdx',
    tabId: 'tabB',
    text: 'HISTORY-ONLY',
    textHash: 'h-history',
    baseDiskHash: 'H0',
    baseDiskVersion: 1,
    createdAt: Date.now(),
    reason: 'before-reconcile',
    saved: false,
    schemaVersion: 1,
  })
  const groups = await store.listDrafts()
  const group = groups.find((item) => item.path === 'a.mdx')
  assert.ok(group !== undefined)
  assert.equal(group.latest.length, 0)
  assert.equal(group.history[0].text, 'HISTORY-ONLY')
})

test('C3: emergency copies follow safe drafts and clear on save/discard', async () => {
  const { fetchImpl, saveCalls } = makeFetch({ sourceText: () => 'BASE' })
  const draftStore = makeDraft()
  const store = createDocStore({
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tab1', draftDebounceMs: 0, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')

  store.setEditorText('a.mdx', 'UNSAVED-1')
  await store.flushEmergencyAll()
  assert.equal((await draftStore.listEmergencies()).length, 1)
  await waitFor(() => store.getDoc('a.mdx').draft.status === 'persisted')
  await store.flushEmergencyAll()
  assert.equal((await draftStore.listEmergencies()).length, 0)

  store.setEditorText('a.mdx', 'UNSAVED-2')
  await store.flushEmergencyAll()
  assert.equal((await draftStore.listEmergencies()).length, 1)
  const saved = await store.save('a.mdx', 'UNSAVED-2')
  assert.equal(saved, true)
  assert.equal(saveCalls.length, 1)
  await tick()
  assert.equal((await draftStore.listEmergencies()).length, 0)

  store.setEditorText('a.mdx', 'UNSAVED-3')
  await store.flushEmergencyAll()
  assert.equal((await draftStore.listEmergencies()).length, 1)
  store.discardDraft('a.mdx')
  await tick()
  assert.equal((await draftStore.listEmergencies()).length, 0)
})

test('C4: restore aborts when the before-restore snapshot cannot be written', async () => {
  const { fetchImpl } = makeFetch({ sourceText: () => 'BASE' })
  const base = makeDraft()
  await base.putLatest({
    id: 'test::a.mdx::tab1', siteId: 'test', path: 'a.mdx', tabId: 'tab1', title: 'A',
    text: 'DRAFT', textHash: hashText('DRAFT'), baseDiskHash: 'H0:docs/a.mdx',
    baseDiskVersion: 1, updatedAt: 1, writeSeq: 1, editSeq: 1, schemaVersion: 1,
  })
  const draftStore = {
    ...base,
    appendHistory: async () => { throw new Error('quota') },
  }
  const store = createDocStore({
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tab1', draftDebounceMs: 0, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  await waitFor(() => store.getDoc('a.mdx').recovery.status === 'available')
  store.setEditorText('a.mdx', 'CURRENT')
  const before = store.getDoc('a.mdx').text
  const result = await store.recoverLatest('a.mdx')
  assert.equal(result.ok, false)
  assert.match(String(result.error), /恢复前快照/)
  assert.equal(store.getDoc('a.mdx').text, before)
})

test('C4: switching back keeps the in-session draft without refetching', async () => {
  const { fetchImpl, sourceCalls } = makeFetch({ sourceText: () => 'BASE' })
  const store = makeDraftStore(fetchImpl)
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.setEditorText('a.mdx', 'EDIT')
  await waitFor(() => store.getDoc('a.mdx').draft.status === 'persisted')
  store.openDoc('b.mdx')
  await waitFor(() => store.getSnapshot().activeDoc?.path === 'b.mdx' && store.getSnapshot().activeDoc?.loadPhase === 'ready')
  store.openDoc('a.mdx')
  assert.equal(store.getDoc('a.mdx').text, 'EDIT')
  assert.equal(store.getDoc('a.mdx').dirty, true)
  assert.equal(store.getDoc('a.mdx').draft.status, 'persisted')
  assert.equal(sourceCalls.filter((item) => item === 'docs/a.mdx').length, 1)
})

test('recovery bumps contentVersion and discard removes the shown draft', async () => {
  const { fetchImpl } = makeFetch({ sourceText: () => 'BASE' })
  const draftStore = createMemoryDraftStore({ siteId: 'test', tabId: 'old' })
  await draftStore.putLatest({
    id: 'test::a.mdx::old', siteId: 'test', path: 'a.mdx', tabId: 'old', title: 'A',
    text: 'OLD', textHash: hashText('OLD'), baseDiskHash: 'H0:docs/a.mdx',
    baseDiskVersion: 1, updatedAt: 1, writeSeq: 1, editSeq: 1, schemaVersion: 1,
  })
  const store = createDocStore({
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tab1', draftDebounceMs: 0, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  await waitFor(() => store.getDoc('a.mdx').recovery.status === 'available')
  const doc = store.getDoc('a.mdx')
  const version = doc.contentVersion
  const result = await store.recoverLatest('a.mdx')
  assert.equal(result.ok, true)
  assert.equal(doc.text, 'OLD')
  assert.ok(doc.contentVersion > version)
  await tick()
  await tick()
  assert.equal(await draftStore.getLatest('a.mdx', 'old'), null)
  store.discardDraft('a.mdx')
  await tick()
  await tick()
  assert.equal(doc.text, 'BASE')
  assert.equal(doc.dirty, false)
  assert.equal(await draftStore.getLatest('a.mdx', 'tab1'), null)
})


test('a draft owned by another live Live Editor tab is not offered as recovery', async () => {
  const { fetchImpl } = makeFetch({ sourceText: () => 'BASE' })
  const draftStore = createMemoryDraftStore({ siteId: 'test', tabId: 'tab2' })
  await draftStore.putLatest({
    id: 'test::a.mdx::tab2', siteId: 'test', path: 'a.mdx', tabId: 'tab2', title: 'A',
    text: 'OTHER', textHash: hashText('OTHER'), baseDiskHash: 'H0:docs/a.mdx',
    baseDiskVersion: 1, updatedAt: 1, writeSeq: 1, editSeq: 1, schemaVersion: 1,
  })
  const store = createDocStore({
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tab1',
    isTabLive: (id) => id === 'tab2', draftDebounceMs: 0, historyIntervalMs: 0,
  })
  await store.loadIndex()
  await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
  await tick()
  await tick()
  const doc = store.getDoc('a.mdx')
  assert.equal(doc.recovery.status, 'none')
  assert.equal(doc.recovery.latest.length, 0)
  assert.notEqual(await draftStore.getLatest('a.mdx', 'tab2'), null)
})

test('docIdentityKey qualifies instance and version without changing default paths', async () => {
  assert.equal(docIdentityKey({ path: 'a.mdx' }), 'default|current|a.mdx')
  assert.equal(docIdentityKey({ instanceId: 'proj', versionName: 'current', path: 'index.mdx' }), 'proj|current|index.mdx')
  const store = makeDraftStore(makeFetch().fetchImpl)
  const index = await store.loadIndex()
  assert.equal(index.docByKey.get('default|current|a.mdx').source, 'docs/a.mdx')
})

test('history timer does not snapshot an unchanged open document', async () => {
  const { fetchImpl } = makeFetch()
  const draftStore = makeDraft()
  const store = createDocStore({
    fetchImpl, draftStore, draftSiteId: 'test', draftTabId: 'tab1',
    draftDebounceMs: 0, historyIntervalMs: 30, historyMode: 'interval',
  })
  try {
    await store.loadIndex()
    await waitFor(() => store.getSnapshot().activeDoc?.loadPhase === 'ready')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal((await draftStore.listHistory('a.mdx', { limit: 10 })).length, 0)

    store.setEditorText('a.mdx', 'CHANGED-AFTER-OPEN')
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const history = await draftStore.listHistory('a.mdx', { limit: 10 })
    assert.equal(history.some((record) => record.text === 'CHANGED-AFTER-OPEN'), true)
  } finally {
    await store.dispose()
  }
})
