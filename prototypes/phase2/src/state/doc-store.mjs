/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Phase 2B — tab-scoped document store.
 *
 * Owns: the Host doc index, per-document content/baseline/dirty/save state,
 * the active document, and navigation/load generations.
 *
 * Correctness rules (GPT review):
 *   - every load carries a per-document `loadEpoch`; stale responses are dropped;
 *   - only the latest `navSeq` may set the active document; older requests may
 *     fill their own document cache but never touch the active view;
 *   - save binds the text snapshot taken at request time; success moves the
 *     baseline to that snapshot, and `dirty` stays true if the user typed more;
 *   - route messages never mutate document content.
 *
 * The store is UI-agnostic (no React) so it can be unit-tested with a fake fetch.
 */

const HOST_INDEX = '/api/live-editor/index'
const HOST_SOURCE = '/api/live-editor/source'
const HOST_SAVE = '/api/live-editor/save'
const PREFERRED_INITIAL = '01-intro.mdx'

import { hashText, latestId } from './draft-store.mjs'

export function normalizePath(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.replace(/\/+$/, '')
  return trimmed === '' ? '/' : `${trimmed}/`
}

/** Accept @site/docs/... or docs/... (and i18n mirrors, read-only for now). */
export function normalizeSource(value) {
  if (typeof value !== 'string') return null
  let text = value.replaceAll('\\', '/').trim()
  if (text.startsWith('@site/')) text = text.slice('@site/'.length)
  if (text.length === 0 || text.startsWith('/')) return null
  if (text.split('/').some((part) => part === '..' || part === '.')) return null
  if (text.startsWith('docs/') && text.length > 'docs/'.length) return text
  if (/^i18n\/[^/]+\/docusaurus-plugin-content-docs\/current\/.+$/.test(text)) return text
  return null
}

export function docIdentityKey(entry) {
  const instanceId = typeof entry?.instanceId === 'string' && entry.instanceId.length > 0 ? entry.instanceId : 'default'
  const versionName = typeof entry?.versionName === 'string' && entry.versionName.length > 0 ? entry.versionName : 'current'
  const path = typeof entry?.path === 'string' ? entry.path : ''
  return `${instanceId}|${versionName}|${path}`
}

function createDoc(entry) {
  return {
    path: entry.path,
    entry,
    text: null,
    baseText: null,
    baseHash: null,
    version: null,
    dirty: false,
    loadPhase: 'idle',
    loadEpoch: 0,
    loadError: null,
    savePhase: 'idle',
    saveError: null,
    saveNotice: null,
    conflict: null,
    staleAfterSave: false,
    contentVersion: 0,
    loadedAt: null,
    draft: {
      status: 'none', // none | pending | writing | persisted | error | conflict | restored
      persistedHash: null,
      persistedAt: null,
      lastAttemptAt: null,
      error: null,
      baseDiskHash: null,
      baseDiskVersion: null,
      emergencyOnly: false,
      editSeq: 0,
      writeSeq: 0,
      inFlightWriteSeq: null,
      inFlight: null,
      queued: false,
      historyCount: 0,
      historyError: null,
    },
    reconcile: {
      required: false,
      busy: false,
      draftBaseDiskHash: null,
      diskHashAtRestore: null,
      restoredFrom: null,
    },
    recovery: {
      status: 'none', // none | available | conflict
      latest: [],
      history: [],
      conflict: false,
      dismissed: false,
    },
  }
}

export function createDocStore(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const clock = options.clock ?? (() => new Date())
  const indexUrl = options.indexUrl ?? HOST_INDEX
  const sourceUrl = options.sourceUrl ?? HOST_SOURCE
  const saveUrl = options.saveUrl ?? HOST_SAVE
  const now = options.now ?? (() => Date.now())
  const draftSiteId = options.draftSiteId ?? 'phase2'
  const draftTabId = options.draftTabId ?? 'tab'
  const draftSessionId = typeof options.draftSessionId === 'string' && options.draftSessionId.length > 0
    ? options.draftSessionId
    : null
  // A draft owned by another Live Editor tab that is still open must never be
  // offered as this tab's recovery. Drafts from closed tabs stay recoverable.
  const isTabLive = typeof options.isTabLive === 'function' ? options.isTabLive : () => false
  const draftDebounceMs = options.draftDebounceMs ?? 1000
  // Keep the timer calls as closures. Passing bare `globalThis.setTimeout`
  // and later invoking `scheduler.setTimeout(...)` rebinds `this` to the
  // scheduler object; Electron/Chromium then throws "Illegal invocation".
  const scheduler = options.scheduler ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  }
  let draftStore = options.draftStore ?? null
  let lifecycle = 'open' // open | disposing | disposed
  let disposePromise = null
  let historyIntervalMs = options.historyIntervalMs ?? 60 * 1000
  let historyMode = options.historyMode ?? 'interval' // interval | every-change
  let draftStorageError = null

  const docs = new Map()
  const listeners = new Set()
  let version = 0

  const state = {
    phase: 'init', // init | index-loading | ready | index-error
    index: {
      entries: [],
      docs: [],
      docByPath: new Map(),
      docBySource: new Map(),
      docByPermalink: new Map(),
      site: null,
      counts: null,
      error: null,
      loadedAt: null,
    },
    activePath: null,
    lastActivePath: null,
    page: null,
    notice: null,
    noticeMeta: null,
    navSeq: 0,
  }

  const buildSnapshot = () => ({
    version,
    phase: state.phase,
    index: state.index,
    activePath: state.activePath,
    activeDoc: state.activePath === null ? null : docs.get(state.activePath) ?? null,
    lastActivePath: state.lastActivePath,
    page: state.page,
    notice: state.notice,
    noticeMeta: state.notice === null ? null : state.noticeMeta,
    navSeq: state.navSeq,
    draftPaths: [...docs.values()].filter((doc) => doc.dirty).map((doc) => doc.path),
    recoveryPaths: [...docs.values()]
      .filter((doc) => doc.recovery.status === 'available')
      .map((doc) => doc.path),
    draftStorageError,
  })

  let snapshot = buildSnapshot()

  const emit = () => {
    version += 1
    snapshot = buildSnapshot()
    for (const listener of listeners) listener()
  }

  const subscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const getSnapshot = () => snapshot

  let noticeId = 0
  // A notice is a transient UI message, not a save conflict. Optional metadata
  // lets a caller mark a success notice and give it a lifetime; the default
  // keeps the previous persistent behavior for warnings/errors.
  const normalizeNoticeMeta = (options) => {
    if (options === null || typeof options !== 'object') return { tone: 'error', ttlMs: null, id: ++noticeId }
    const tone = options.tone === 'success' || options.tone === 'warning' || options.tone === 'info'
      ? options.tone
      : 'error'
    const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
      ? Math.min(Math.floor(options.ttlMs), 60_000)
      : null
    return { tone, ttlMs, id: ++noticeId }
  }

  const setNotice = (notice, options = null) => {
    state.notice = typeof notice === 'string' && notice.length > 0 ? notice : null
    state.noticeMeta = state.notice === null ? null : normalizeNoticeMeta(options)
    emit()
  }

  const clearNotice = () => {
    if (state.notice === null) return
    state.notice = null
    state.noticeMeta = null
    emit()
  }

  // Per-document save messages use a separate slot. Dismissing a notice from
  // the bar must clear whichever slot is currently displayed.
  const clearSaveNotice = (path = state.activePath) => {
    const doc = path === null || path === undefined ? null : docs.get(path) ?? null
    if (doc === null || doc.saveNotice === null) return
    doc.saveNotice = null
    emit()
  }

  const ensureDoc = (entry) => {
    let doc = docs.get(entry.path)
    if (doc === undefined) {
      doc = createDoc(entry)
      docs.set(entry.path, doc)
    } else {
      doc.entry = entry
    }
    return doc
  }

  // ── Model B draft lifecycle ────────────────────────────────────────────
  // Disk writes happen only through save(). Everything below is local draft
  // staging (IndexedDB) + emergency localStorage.

  const draftKeyFor = (path) => latestId(draftSiteId, path, draftTabId, draftSessionId)

  const canStage = (doc) => draftStore !== null && doc.baseText !== null && typeof doc.text === 'string'

  const clearDraftTimer = (doc) => {
    if (doc.draftTimer !== undefined && doc.draftTimer !== null) {
      scheduler.clearTimeout(doc.draftTimer)
      doc.draftTimer = null
    }
  }

  const clearHistoryTimer = (doc) => {
    if (doc.historyTimer !== undefined && doc.historyTimer !== null) {
      scheduler.clearTimeout(doc.historyTimer)
      doc.historyTimer = null
    }
  }

  const deleteLatestForCurrentTab = async (doc) => {
    if (draftStore === null) return
    try {
      await draftStore.deleteLatest(doc.path, draftTabId)
      await draftStore.deleteEmergency(doc.path, draftTabId, draftSessionId)
    } catch (error) {
      doc.draft.error = String(error?.message ?? error)
    }
  }

  function setDraftStorageError (error) {
    if (error === null) {
      draftStorageError = null
    } else {
      const message = String(error)
      draftStorageError = message.startsWith('draft:') ? message : `draft: ${message}`
    }
    if (draftStorageError !== null) {
      for (const doc of docs.values()) {
        if (doc.dirty) {
          doc.draft.status = 'error'
          doc.draft.error = draftStorageError
        }
      }
    }
    emit()
  }

  function scheduleLatest (doc, delay = draftDebounceMs) {
    if (lifecycle !== 'open') return
    if (doc.baseText === null || typeof doc.text !== 'string' || doc.dirty !== true) return
    if (draftStore === null) {
      if (doc.draft.status !== 'error') {
        doc.draft.status = 'error'
        doc.draft.error = draftStorageError ?? 'DRAFT_STORAGE_UNAVAILABLE'
        emit()
      }
      return
    }
    clearDraftTimer(doc)
    if (doc.draft.status !== 'pending' && doc.draft.status !== 'writing') {
      doc.draft.status = 'pending'
      doc.draft.error = null
      emit()
    }
    doc.draftTimer = scheduler.setTimeout(() => {
      doc.draftTimer = null
      void flushLatest(doc.path)
    }, Math.max(0, delay))
  }

  /**
   * A draft/history snapshot created while a conflict is unresolved belongs to
   * the old disk baseline, even though doc.baseHash points at the new disk.
   */
  function draftOriginHash (doc) {
    return doc.reconcile.required === true
      ? (doc.reconcile.draftBaseDiskHash ?? doc.baseHash)
      : doc.baseHash
  }

  /**
   * Persist the current text snapshot. C2: the success only records the
   * snapshot's hash; if the user typed while the write was in flight, the
   * status remains pending for the new text. Writes are serialized per doc and
   * the storage adapter also guards by writeSeq.
   */
  async function flushLatest (path) {
    const doc = docs.get(path)
    if (doc === undefined) return false
    if (!canStage(doc)) return false
    if (!doc.dirty) {
      await deleteLatestForCurrentTab(doc)
      doc.draft.status = 'none'
      doc.draft.persistedHash = hashText(doc.baseText)
      doc.draft.error = null
      emit()
      return true
    }
    if (doc.draft.inFlight !== null) {
      doc.draft.queued = true
      return doc.draft.inFlight
    }
    clearDraftTimer(doc)
    // While a conflict is unresolved, persist the draft's true origin hash.
    // Otherwise an auto-stash would relabel an old draft as based on the new
    // disk, and a later remount could bypass the explicit conflict.
    const draftBaseDiskHash = draftOriginHash(doc)
    const snapshot = {
      text: doc.text,
      textHash: hashText(doc.text),
      editSeq: doc.draft.editSeq,
      writeSeq: doc.draft.writeSeq + 1,
    }
    doc.draft.writeSeq = snapshot.writeSeq
    doc.draft.inFlightWriteSeq = snapshot.writeSeq
    doc.draft.lastAttemptAt = now()
    doc.draft.status = 'writing'
    emit()
    const promise = (async () => {
      try {
        const result = await draftStore.putLatest({
          id: draftKeyFor(path),
          siteId: draftSiteId,
          sessionId: draftSessionId,
          path,
          tabId: draftTabId,
          title: doc.entry.title ?? path,
          text: snapshot.text,
          textHash: snapshot.textHash,
          baseDiskHash: draftBaseDiskHash,
          baseDiskVersion: doc.version,
          updatedAt: now(),
          writeSeq: snapshot.writeSeq,
          editSeq: snapshot.editSeq,
          schemaVersion: 1,
        })
        if (result?.skipped === true) {
          doc.draft.status = 'pending'
          doc.draft.queued = true
        } else {
          doc.draft.persistedHash = snapshot.textHash
          doc.draft.persistedAt = now()
          doc.draft.baseDiskHash = draftBaseDiskHash
          doc.draft.baseDiskVersion = doc.version
          doc.draft.emergencyOnly = false
          doc.draft.error = null
          // A save/discard may have landed while this write was in flight; the
          // snapshot is then redundant (it equals the new disk baseline).
          if (doc.dirty !== true && doc.text === snapshot.text && doc.baseText === snapshot.text) {
            doc.draft.status = 'none'
            void deleteLatestForCurrentTab(doc)
          } else {
            const currentHash = doc.text === null ? null : hashText(doc.text)
            if (currentHash === snapshot.textHash) {
              doc.draft.status = 'persisted'
            } else {
              doc.draft.status = 'pending'
              doc.draft.queued = true
            }
          }
        }
      } catch (error) {
        doc.draft.status = 'error'
        doc.draft.error = String(error?.message ?? error)
        doc.draft.emergencyOnly = false
      }
      doc.draft.inFlightWriteSeq = null
      emit()
    })()
    doc.draft.inFlight = promise
    await promise
    doc.draft.inFlight = null
    if (doc.draft.queued === true) {
      doc.draft.queued = false
      if (doc.dirty) scheduleLatest(doc)
    }
    const currentHash = doc.text === null ? null : hashText(doc.text)
    return doc.draft.status === 'persisted' && doc.draft.persistedHash === currentHash
  }

  async function ensureDraftSafe (path) {
    const doc = docs.get(path)
    if (doc === undefined) return { ok: false, reason: 'missing' }
    if (!doc.dirty) return { ok: true }
    if (draftStore === null) return { ok: false, reason: 'storage-unavailable' }
    const currentHash = hashText(doc.text)
    if (doc.draft.status === 'persisted' && doc.draft.persistedHash === currentHash) {
      return { ok: true }
    }
    let ok = await flushLatest(path)
    // A write that was in flight at flush time may have queued the newer text;
    // flush once more so "safe" means the current text, not just an older one.
    for (let attempt = 0; !ok && attempt < 3 && doc.dirty && doc.draft.status !== 'error'; attempt += 1) {
      ok = await flushLatest(path)
    }
    if (ok) return { ok: true }
    return {
      ok: false,
      reason: doc.draft.status === 'error' ? 'storage-error' : 'pending',
      error: doc.draft.error,
    }
  }

  function scheduleHistory (doc) {
    if (lifecycle !== 'open') return
    if (draftStore === null || doc.baseText === null) return
    if (historyIntervalMs <= 0) return
    if (doc.historyTimer !== undefined && doc.historyTimer !== null) {
      if (historyMode !== 'every-change') return
      scheduler.clearTimeout(doc.historyTimer)
    }
    const delay = historyMode === 'every-change'
      ? Math.max(5000, draftDebounceMs)
      : Math.max(1000, historyIntervalMs)
    doc.historyTimer = scheduler.setTimeout(() => {
      doc.historyTimer = null
      void tickHistory(doc.path)
      scheduleHistory(doc)
    }, delay)
  }

  async function tickHistory (path) {
    const doc = docs.get(path)
    if (doc === undefined || draftStore === null || doc.baseText === null) return false
    const textHash = hashText(doc.text)
    if (doc.lastHistoryHash === undefined) {
      // Baseline an opened document on its first tick. Unchanged documents
      // therefore create no history; dirty documents start from disk so the
      // next tick captures the unsaved text.
      doc.lastHistoryHash = hashText(doc.dirty ? (doc.baseText ?? doc.text) : doc.text)
      return false
    }
    if (doc.lastHistoryHash === textHash) return false
    if (doc.draft.status === 'pending' || doc.draft.status === 'writing') return false
    try {
      await draftStore.appendHistory({
        siteId: draftSiteId,
        sessionId: draftSessionId,
        path,
        tabId: draftTabId,
        text: doc.text,
        textHash,
        baseDiskHash: draftOriginHash(doc),
        baseDiskVersion: doc.version,
        createdAt: now(),
        reason: historyMode === 'every-change' ? 'every-change' : 'interval',
        saved: false,
        schemaVersion: 1,
      })
      doc.lastHistoryHash = textHash
      doc.draft.historyCount += 1
      doc.draft.historyError = null
      emit()
      return true
    } catch (error) {
      doc.draft.historyError = String(error?.message ?? error)
      emit()
      return false
    }
  }

  async function checkRecovery (path) {
    const doc = docs.get(path)
    if (doc === undefined) return
    if (draftStore === null) return
    try {
      // Drafts from another DSH session must not be offered here. Legacy
      // records without a session stay readable for migration.
      const records = (await draftStore.listLatest(path))
        .filter((record) => record.sessionId === undefined || record.sessionId === null || record.sessionId === draftSessionId)
      // A session-scoped record supersedes a legacy record for the same tab.
      const byTab = new Map()
      for (const record of records) {
        if (record.sessionId === undefined || record.sessionId === null) byTab.set(record.tabId, record)
      }
      for (const record of records) {
        if (record.sessionId === draftSessionId) byTab.set(record.tabId, record)
      }
      const latest = [...byTab.values()]
        .filter((record) => record.tabId === draftTabId || !isTabLive(record.tabId))
      const history = (await draftStore.listHistory(path, { limit: 100 }))
        .filter((record) => record.sessionId === undefined || record.sessionId === null || record.sessionId === draftSessionId)
      const keep = []
      for (const record of latest) {
        // Draft textHash is a local (FNV) dedupe hash; disk baseHash is the
        // Host SHA-1. Compare text, and use baseDiskHash for version checks.
        const redundant = doc.baseText !== null && record.text === doc.baseText
        if (redundant) {
          await draftStore.deleteLatest(path, record.tabId)
          if (record.tabId === draftTabId) await draftStore.deleteEmergency(path, draftTabId, record.sessionId ?? draftSessionId)
        } else {
          keep.push(record)
        }
      }
      keep.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
      // D2: a rebuilt DocStore must continue after any persisted sequence, even
      // if the old draft is never recovered.
      const maxSeq = keep.reduce((max, record) => Math.max(max, Number(record.writeSeq) || 0), 0)
      if (maxSeq > doc.draft.writeSeq) doc.draft.writeSeq = maxSeq
      doc.recovery.latest = keep
      doc.recovery.history = history
      doc.recovery.conflict = keep.some((record) => record.baseDiskHash !== doc.baseHash)
      doc.recovery.status = keep.length > 0 ? 'available' : 'none'
      doc.recovery.dismissed = false
      doc.draft.historyCount = history.length
      emit()
    } catch (error) {
      setDraftStorageError(String(error?.message ?? error))
    }
  }

  /** C4: do not replace the editor until the current text is safe somewhere. */
  async function snapshotBeforeRestore (doc) {
    if (doc.baseText !== null && doc.text === doc.baseText) return { ok: true }
    if (doc.draft.status === 'persisted'
      && doc.draft.persistedHash === hashText(doc.text)) return { ok: true }
    if (draftStore === null) return { ok: false, error: 'DRAFT_STORAGE_UNAVAILABLE' }
    try {
      await draftStore.appendHistory({
        siteId: draftSiteId,
        sessionId: draftSessionId,
        path: doc.path,
        tabId: draftTabId,
        text: doc.text,
        textHash: hashText(doc.text),
        baseDiskHash: draftOriginHash(doc),
        baseDiskVersion: doc.version,
        createdAt: now(),
        reason: 'before-restore',
        saved: false,
        schemaVersion: 1,
      })
      return { ok: true }
    } catch (error) {
      doc.draft.error = `无法保存恢复前快照：${String(error?.message ?? error)}`
      emit()
      return { ok: false, error: doc.draft.error }
    }
  }

  function applyRestoredText (doc, record, kind) {
    doc.text = record.text
    doc.contentVersion += 1
    doc.dirty = record.text !== doc.baseText
    doc.draft.editSeq += 1
    doc.draft.persistedHash = record.textHash
    doc.draft.persistedAt = now()
    doc.draft.baseDiskHash = record.baseDiskHash
    doc.draft.baseDiskVersion = record.baseDiskVersion
    doc.draft.status = 'persisted'
    doc.draft.error = null
    // D2: continue after the persisted sequence instead of restarting at zero.
    doc.draft.writeSeq = Math.max(doc.draft.writeSeq, Number(record.writeSeq) || 0)
    doc.reconcile.required = record.baseDiskHash !== doc.baseHash
    doc.reconcile.draftBaseDiskHash = record.baseDiskHash ?? null
    doc.reconcile.diskHashAtRestore = doc.baseHash
    doc.reconcile.restoredFrom = kind
    if (kind === 'latest') {
      // Claim a closed tab's draft only after this tab's restored text is
      // safely persisted. A draft owned by another open Live Editor tab is
      // never offered here, so it can never be deleted by this recovery.
      doc.recovery.latest = doc.recovery.latest.filter((item) => item.tabId !== record.tabId)
      if (draftStore !== null && record.tabId !== draftTabId && !isTabLive(record.tabId)) {
        void flushLatest(doc.path).then((ok) => {
          if (!ok) return
          void draftStore.deleteLatest(doc.path, record.tabId)
          void draftStore.deleteEmergency(doc.path, record.tabId, record.sessionId ?? draftSessionId)
        }).catch(() => {})
      }
    }
    doc.recovery.conflict = doc.recovery.latest.some((item) => item.baseDiskHash !== doc.baseHash)
    doc.recovery.status = doc.recovery.latest.length > 0 ? 'available' : 'none'
    scheduleLatest(doc)
    emit()
  }

  async function recoverLatest (path, tabId = null) {
    const doc = docs.get(path)
    if (doc === undefined) return { ok: false, reason: 'missing' }
    if (doc.savePhase === 'saving' || doc.reconcile.busy === true) return { ok: false, reason: 'busy' }
    const record = doc.recovery.latest.find((item) => (item.sessionId === undefined || item.sessionId === null || item.sessionId === draftSessionId)
      && (tabId === null || item.tabId === tabId))
    if (record === undefined) return { ok: false, reason: 'no-draft' }
    const snapshot = await snapshotBeforeRestore(doc)
    if (!snapshot.ok) return snapshot
    applyRestoredText(doc, record, 'latest')
    return { ok: true, reconcile: doc.reconcile.required }
  }

  async function recoverHistory (path, historyId) {
    const doc = docs.get(path)
    if (doc === undefined || draftStore === null) return { ok: false, reason: 'missing' }
    if (doc.savePhase === 'saving' || doc.reconcile.busy === true) return { ok: false, reason: 'busy' }
    const record = doc.recovery.history.find((item) => item.id === historyId)
      ?? await draftStore.getHistory(historyId).catch(() => null)
    if (record === null || record === undefined) return { ok: false, reason: 'no-history' }
    if (record.sessionId !== undefined && record.sessionId !== null && record.sessionId !== draftSessionId) {
      return { ok: false, reason: 'no-history' }
    }
    const snapshot = await snapshotBeforeRestore(doc)
    if (!snapshot.ok) return snapshot
    applyRestoredText(doc, record, 'history')
    return { ok: true, reconcile: doc.reconcile.required }
  }

  async function appendConflictSnapshot (doc, text, reason) {
    if (draftStore === null) return { ok: false, error: 'DRAFT_STORAGE_UNAVAILABLE' }
    try {
      await draftStore.appendHistory({
        siteId: draftSiteId,
        sessionId: draftSessionId,
        path: doc.path,
        tabId: draftTabId,
        text,
        textHash: hashText(text),
        baseDiskHash: draftOriginHash(doc),
        baseDiskVersion: doc.version,
        createdAt: now(),
        reason,
        saved: false,
        schemaVersion: 1,
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `无法保存冲突前快照：${String(error?.message ?? error)}` }
    }
  }

  async function resolveWithDisk (doc) {
    const text = doc.text
    const editSeq = doc.draft.editSeq
    if (doc.dirty && text !== doc.baseText) {
      // `latest` is a mutable slot and is later replaced by normal editing.
      // Keep an independent history snapshot before replacing the editor.
      const history = await appendConflictSnapshot(doc, text, 'before-reconcile')
      if (!history.ok) {
        doc.saveError = history.error
        emit()
        return { ok: false, error: history.error }
      }
      const staged = await flushLatest(doc.path)
      // flushLatest may return the shared in-flight promise, whose resolution
      // value is not a boolean. Re-check the persisted state before refusing.
      const persisted = doc.draft.status === 'persisted'
        && doc.draft.persistedHash === hashText(text)
      if (!staged && !persisted) {
        doc.saveError = '无法先保存草稿快照；已取消“以磁盘为准”，请重试或导出内容'
        emit()
        return { ok: false, error: doc.saveError }
      }
    }
    const loaded = await loadDoc(doc.path, {
      guard: () => doc.draft.editSeq === editSeq && doc.text === text,
    })
    if (loaded === null) {
      if (doc.loadPhase === 'error') {
        doc.saveError = '重载磁盘失败；草稿仍保留，请稍后重试'
        emit()
        return { ok: false, error: doc.saveError }
      }
      doc.saveError = '冲突处理期间文本发生变化，已取消重载；草稿仍保留'
      emit()
      return { ok: false, reason: 'changed-during-reload', error: doc.saveError }
    }
    return { ok: true }
  }

  async function resolveOverwrite (doc, diag) {
    const text = doc.text
    const editSeq = doc.draft.editSeq
    try {
      const response = await fetchImpl(`${sourceUrl}?path=${encodeURIComponent(doc.entry.source)}`, { cache: 'no-store' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
      // Bind the write to the text the user confirmed. Typing during the GET
      // must not silently expand the overwrite scope.
      if (doc.draft.editSeq !== editSeq || doc.text !== text) {
        doc.saveError = '冲突处理期间文本发生变化，请重试；未覆盖磁盘'
        emit()
        return { ok: false, error: doc.saveError }
      }
      const saved = await save(doc.path, text, { expectedHash: data.hash, bypassReconcile: true, diag })
      if (saved) return { ok: true }
      return { ok: false, error: doc.saveError ?? '冲突处理失败' }
    } catch (error) {
      doc.saveError = `冲突处理失败：${String(error?.message ?? error)}`
      emit()
      return { ok: false, error: doc.saveError }
    }
  }

  async function resolveReconcile (path, action, diag = null) {
    const doc = docs.get(path)
    if (doc === undefined) return { ok: false, reason: 'missing' }
    if (doc.reconcile.required !== true) return { ok: true }
    if (doc.savePhase === 'saving' || doc.reconcile.busy === true) return { ok: false, reason: 'busy' }
    if (action !== 'disk' && action !== 'overwrite') return { ok: false, reason: 'unknown-action' }
    doc.reconcile.busy = true
    emit()
    try {
      return action === 'disk' ? await resolveWithDisk(doc) : await resolveOverwrite(doc, diag)
    } finally {
      doc.reconcile.busy = false
      emit()
    }
  }

  async function listDrafts () {
    if (draftStore === null) return []
    try {
      const allowed = (record) => record.sessionId === undefined || record.sessionId === null || record.sessionId === draftSessionId
      const latest = (await draftStore.listAllLatest()).filter(allowed)
      const allHistory = (typeof draftStore.listAllHistory === 'function'
        ? await draftStore.listAllHistory()
        : []).filter(allowed)
      const byPath = new Map()
      const bySlot = new Map()
      for (const record of latest) {
        const slot = `${record.path}::${record.tabId}`
        const previous = bySlot.get(slot)
        // A session-scoped record supersedes its legacy counterpart.
        if (previous?.sessionId === draftSessionId && record.sessionId !== draftSessionId) continue
        bySlot.set(slot, record)
      }
      for (const record of bySlot.values()) {
        if (!byPath.has(record.path)) byPath.set(record.path, [])
        byPath.get(record.path).push(record)
      }
      // A conflict snapshot may outlive its latest slot after a later save;
      // keep history-only documents visible in the drafts panel.
      for (const record of allHistory) {
        if (!byPath.has(record.path)) byPath.set(record.path, [])
      }
      const result = []
      for (const [path, records] of byPath) {
        const entry = state.index.docByPath.get(path)
        const history = allHistory
          .filter((record) => record.path === path)
          .slice(0, 100)
        if (records.length === 0 && history.length === 0) continue
        const currentDoc = docs.get(path)
        const baseHash = currentDoc?.baseHash ?? records[0]?.baseDiskHash ?? null
        result.push({
          path,
          title: entry?.title ?? records[0]?.title ?? history[0]?.title ?? path,
          latest: records.sort((a, b) => b.updatedAt - a.updatedAt),
          history,
          conflict: records.some((record) => record.baseDiskHash !== baseHash)
            || history.some((record) => baseHash !== null && record.baseDiskHash !== baseHash),
        })
      }
      return result
    } catch (error) {
      setDraftStorageError(String(error?.message ?? error))
      return []
    }
  }

  async function mergeEmergencies () {
    if (draftStore === null) return
    try {
      const emergencies = (await draftStore.listEmergencies())
        .filter((emergency) => emergency.sessionId === undefined || emergency.sessionId === null || emergency.sessionId === draftSessionId)
      for (const emergency of emergencies) {
        // Merge even when the doc is not in the current index; it will be
        // visible in the drafts panel and checked when the doc opens.
        const latest = await draftStore.getLatest(emergency.path, emergency.tabId)
        if (latest !== null && Number(latest.writeSeq ?? 0) >= Number(emergency.writeSeq ?? 0)
          && Number(latest.updatedAt ?? 0) >= Number(emergency.updatedAt ?? 0)) {
          await draftStore.deleteEmergency(emergency.path, emergency.tabId, emergency.sessionId ?? draftSessionId)
          continue
        }
        if (latest !== null && latest.textHash !== emergency.textHash) {
          await draftStore.appendHistory({
            ...latest,
            id: undefined,
            createdAt: now(),
            reason: 'emergency',
            saved: false,
          }).catch(() => {})
        }
        await draftStore.putLatest({
          ...emergency,
          sessionId: emergency.sessionId ?? draftSessionId,
          id: latestId(draftSiteId, emergency.path, emergency.tabId, emergency.sessionId ?? draftSessionId),
          writeSeq: Math.max(Number(latest?.writeSeq ?? 0), Number(emergency.writeSeq ?? 0)) + 1,
          updatedAt: Math.max(Number(latest?.updatedAt ?? 0), Number(emergency.updatedAt ?? 0)),
        })
        await draftStore.deleteEmergency(emergency.path, emergency.tabId, emergency.sessionId ?? draftSessionId)
      }
      for (const doc of docs.values()) {
        await checkRecovery(doc.path)
      }
    } catch (error) {
      setDraftStorageError(String(error?.message ?? error))
    }
  }

  /**
   * C3: pagehide writes only content that is not already safely staged.
   * The localStorage write inside draftStore.writeEmergency is synchronous;
   * callers may use { sync: true } to avoid awaiting during unload.
   */
  async function flushEmergencyAll ({ sync = false } = {}) {
    if (draftStore === null) return
    const tasks = []
    for (const doc of docs.values()) {
      if (doc.baseText === null) continue
      const currentHash = doc.text === null ? null : hashText(doc.text)
      const safe = doc.draft.status === 'persisted' && doc.draft.persistedHash === currentHash
      if (!doc.dirty || safe) {
        if (doc.draft.status !== 'error') {
          const task = draftStore.deleteEmergency(doc.path, draftTabId, draftSessionId).catch(() => {})
          if (!sync) tasks.push(task)
        }
        continue
      }
      const record = {
        siteId: draftSiteId,
        sessionId: draftSessionId,
        path: doc.path,
        tabId: draftTabId,
        title: doc.entry.title ?? doc.path,
        text: doc.text,
        textHash: currentHash,
        baseDiskHash: draftOriginHash(doc),
        baseDiskVersion: doc.version,
        updatedAt: now(),
        writeSeq: doc.draft.writeSeq + 1,
        schemaVersion: 1,
      }
      const task = Promise.resolve(draftStore.writeEmergency(record)).then((result) => {
        if (result && result.ok === false) {
          return draftStore.markEmergencyError({ path: doc.path, at: now(), reason: result.error })
        }
        return undefined
      }).catch(() => {})
      if (!sync) tasks.push(task)
    }
    if (!sync) await Promise.all(tasks)
  }

  function attachDraftStore (store) {
    draftStore = store
    draftStorageError = null
    for (const doc of docs.values()) {
      if (doc.dirty) scheduleLatest(doc)
      if (doc.loadPhase === 'ready') scheduleHistory(doc)
    }
    void initDrafts()
  }

  async function initDrafts () {
    if (draftStore === null) return
    await mergeEmergencies()
    for (const doc of docs.values()) {
      if (doc.loadPhase === 'ready') await checkRecovery(doc.path)
    }
  }

  function setHistoryInterval (ms, mode = historyMode) {
    if (lifecycle !== 'open') return
    historyIntervalMs = ms
    historyMode = mode === 'every-change' ? 'every-change' : 'interval'
    for (const doc of docs.values()) {
      clearHistoryTimer(doc)
      scheduleHistory(doc)
    }
    emit()
  }

  async function loadIndex({ refresh = false, preferredPath = null } = {}) {
    state.phase = 'index-loading'
    state.index = { ...state.index, error: null }
    emit()
    try {
      const url = refresh ? `${indexUrl}?refresh=1` : indexUrl
      const response = await fetchImpl(url, { cache: 'no-store' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)

      const entries = Array.isArray(data.entries) ? data.entries : []
      const docEntries = entries.filter((entry) => entry.kind === 'doc' && typeof entry.path === 'string')
      const docByPath = new Map(docEntries.map((entry) => [entry.path, entry]))
      const docBySource = new Map(docEntries.map((entry) => [entry.source, entry]))
      const docByPermalink = new Map(docEntries.map((entry) => [normalizePath(entry.permalink), entry]))
      const docByKey = new Map(docEntries.map((entry) => [docIdentityKey(entry), entry]))
      state.index = {
        entries,
        docs: docEntries,
        docByPath,
        docBySource,
        docByPermalink,
        docByKey,
        site: data.site ?? null,
        counts: data.counts ?? null,
        error: null,
        loadedAt: clock().toISOString(),
      }
      state.phase = 'ready'
      state.notice = null
      emit()

      const preferred = preferredPath && docByPath.has(preferredPath) ? preferredPath : null
      const initial = preferred
        ?? (docByPath.has(PREFERRED_INITIAL) ? PREFERRED_INITIAL : null)
        ?? [...docByPath.keys()].sort()[0]
        ?? null
      if (state.activePath === null && state.page === null) {
        if (initial !== null) openDoc(initial, { reason: 'init' })
        else {
          state.page = { source: null, permalink: null, title: '空站点', reason: 'empty-index' }
          emit()
        }
      }
      return state.index
    } catch (error) {
      state.phase = 'index-error'
      state.index = { ...state.index, error: String(error?.message ?? error) }
      state.notice = `文件索引加载失败：${String(error?.message ?? error)}`
      state.noticeMeta = null
      emit()
      return null
    }
  }

  async function loadDoc(path, { guard = null } = {}) {
    const doc = docs.get(path)
    if (doc === undefined) return null
    const previousPhase = doc.loadPhase
    const previousError = doc.loadError
    doc.loadEpoch += 1
    const epoch = doc.loadEpoch
    doc.loadPhase = 'loading'
    doc.loadError = null
    emit()
    try {
      // The Host source/save contract uses the `docs/...` source path, while
      // the index `path` is relative to docsRoot. Always send entry.source.
      let response
      try {
        response = await fetchImpl(`${sourceUrl}?path=${encodeURIComponent(doc.entry.source)}`, { cache: 'no-store' })
      } catch (error) {
        throw new Error(`fetch: ${String(error?.message ?? error)}`)
      }
      const data = await response.json().catch(() => null)
      if (doc.loadEpoch !== epoch) return null // a newer load for this doc won
      if (!response.ok || !data?.ok) throw new Error(`host: ${data?.error ?? `HTTP ${response.status}`}`)
      let sourceText = data.text
      // Defensive: if a host/API change returns a Buffer-like JSON payload,
      // decode it; otherwise fail loudly instead of showing a blank editor.
      if (typeof sourceText !== 'string' && sourceText !== null
        && typeof sourceText === 'object' && Array.isArray(sourceText.data)) {
        try { sourceText = new TextDecoder().decode(new Uint8Array(sourceText.data)) } catch { /* handled below */ }
      }
      if (typeof sourceText !== 'string') {
        throw new Error(`源码响应不是文本（${sourceText === null ? 'null' : typeof sourceText}）`)
      }
      // A conflict/reload may have started while this fetch was in flight; do
      // not overwrite text the user typed after the snapshot was taken.
      if (typeof guard === 'function' && guard() !== true) {
        doc.loadPhase = previousPhase === 'loading' ? 'ready' : previousPhase
        doc.loadError = previousError
        emit()
        return null
      }
      doc.text = sourceText
      doc.baseText = sourceText
      doc.contentVersion += 1
      doc.baseHash = data.hash
      doc.version = data.version
      doc.dirty = false
      doc.loadPhase = 'ready'
      doc.loadError = null
      // A load must never end an in-flight save or clear a conflict it did
      // not resolve. Only a load invoked outside a save may reset these.
      if (doc.savePhase !== 'saving') {
        doc.savePhase = 'idle'
        doc.saveError = null
        doc.saveNotice = null
        doc.conflict = null
        doc.staleAfterSave = false
        doc.reconcile.required = false
        doc.reconcile.draftBaseDiskHash = null
        doc.reconcile.diskHashAtRestore = null
        doc.reconcile.restoredFrom = null
      }
      doc.loadedAt = clock().toISOString()
      void checkRecovery(path)
      scheduleHistory(doc)
      emit()
      return doc
    } catch (error) {
      if (doc.loadEpoch !== epoch) return null
      doc.loadPhase = 'error'
      doc.loadError = String(error?.message ?? error)
      emit()
      return null
    }
  }

  function openDoc(path, { reason = 'user' } = {}) {
    const entry = state.index.docByPath.get(path)
    if (entry === undefined) {
      setNotice(`文件不在索引中：${path}`)
      return false
    }
    const hadNotice = state.notice !== null
    if (hadNotice) state.notice = null
    state.lastActivePath = path
    if (state.activePath === path) {
      if (state.page !== null || hadNotice) {
        state.page = null
        emit()
      }
      return true
    }
    // The latest navigation wins; older async loads may still fill their doc.
    state.navSeq += 1
    state.activePath = path
    state.page = null
    const doc = ensureDoc(entry)
    if (doc.text === null) {
      void loadDoc(path)
      // loadDoc emits; ensure activePath is visible even while loading.
    } else if (doc.loadPhase === 'error' && doc.reconcile.required !== true) {
      // Re-entering a failed document must not overwrite text the user typed
      // or bypass an unresolved conflict; refuse to auto-reload the latter.
      const editSeq = doc.draft.editSeq
      const text = doc.text
      void loadDoc(path, { guard: () => doc.draft.editSeq === editSeq && doc.text === text })
    }
    emit()
    void reason
    return true
  }

  function reload(path, { force = false } = {}) {
    const doc = docs.get(path)
    if (doc === undefined) return { ok: false, reason: 'missing' }
    // Do not reload underneath an in-flight save unless explicitly forced;
    // a forced reload is handled by the save's loadEpoch guard (see save()).
    if (doc.savePhase === 'saving' && force !== true) return { ok: false, reason: 'saving' }
    // An unresolved conflict must go through resolveReconcile so the current
    // text is snapshotted first. A generic reload must not clear it.
    if (doc.reconcile.required === true && force !== true) return { ok: false, reason: 'reconcile' }
    // A reload answers the "preview jumped while dirty" notice too. The state
    // is cleared only after loadDoc succeeds, never before the fetch.
    state.notice = null
    const editSeq = doc.draft.editSeq
    const text = doc.text
    void loadDoc(path, { guard: () => doc.draft.editSeq === editSeq && doc.text === text })
    return { ok: true }
  }

  /**
   * Route messages are advisory: resolve by exact source first, then by
   * permalink. Unknown routes become page mode (never a guessed document).
   */
  function activateRoute({ source = null, permalink = null, title = null } = {}) {
    const normalizedSource = normalizeSource(source)
    const entry = (normalizedSource !== null ? state.index.docBySource.get(normalizedSource) : undefined)
      ?? (permalink !== null ? state.index.docByPermalink.get(normalizePath(permalink)) : undefined)
    if (entry === undefined) {
      const nextPage = { source: normalizedSource, permalink, title, reason: 'unmapped' }
      const changed = state.activePath !== null
        || JSON.stringify(state.page) !== JSON.stringify(nextPage)
      state.activePath = null
      state.page = nextPage
      state.notice = null
      if (changed) emit()
      return false
    }
    return openDoc(entry.path, { reason: 'route' })
  }

  /**
   * Route entry used by the parent bridge: refuse to switch source while the
   * active document is dirty. The preview may already have navigated (Step 4's
   * link interception is not implemented yet), but the draft and active view
   * stay on the dirty document.
   */
  function previewRoute({ source = null, permalink = null, title = null } = {}) {
    const active = state.activePath === null ? null : docs.get(state.activePath) ?? null
    if (active?.dirty === true) {
      // Model B: only a safely persisted draft may leave without a prompt.
      const safe = active.draft.status === 'persisted'
        && active.draft.persistedHash === hashText(active.text)
      if (!safe) {
        setNotice('预览已跳转；源码有未保存修改且草稿尚未安全暂存，未自动切换。')
        return { ok: false, reason: 'dirty', activePath: state.activePath }
      }
    }
    const ok = activateRoute({ source, permalink, title })
    return { ok, reason: ok ? 'activated' : 'unmapped', activePath: state.activePath }
  }

  /** Drop an unsaved draft and return the document to its loaded baseline. */
  function discardDraft(path, tabId = null) {
    const doc = docs.get(path)
    if (doc === undefined) return false
    if (doc.savePhase === 'saving' || doc.reconcile.busy === true) return false
    const targetTab = typeof tabId === 'string' ? tabId : draftTabId
    clearDraftTimer(doc)
    if (doc.baseText !== null) doc.text = doc.baseText
    doc.contentVersion += 1
    doc.dirty = false
    doc.saveError = null
    doc.saveNotice = null
    doc.conflict = null
    doc.savePhase = 'idle'
    doc.staleAfterSave = false
    doc.draft.status = 'none'
    doc.draft.error = null
    doc.draft.queued = false
    doc.draft.editSeq += 1
    doc.draft.persistedHash = doc.baseText === null ? null : hashText(doc.baseText)
    doc.reconcile.required = false
    doc.recovery.latest = doc.recovery.latest.filter((record) => record.tabId !== targetTab && record.tabId !== draftTabId)
    doc.recovery.conflict = doc.recovery.latest.some((record) => record.baseDiskHash !== doc.baseHash)
    doc.recovery.status = doc.recovery.latest.length > 0 ? 'available' : 'none'
    if (draftStore !== null) {
      void draftStore.deleteLatest(path, targetTab)
      void draftStore.deleteEmergency(path, targetTab, draftSessionId)
      if (targetTab !== draftTabId) {
        void draftStore.deleteLatest(path, draftTabId)
        void draftStore.deleteEmergency(path, draftTabId, draftSessionId)
      }
    }
    emit()
    return true
  }

  function dismissRecovery (path) {
    const doc = docs.get(path)
    if (doc === undefined) return false
    doc.recovery.dismissed = true
    emit()
    return true
  }

  function setPage(page) {
    state.activePath = null
    state.page = page
    state.notice = null
    emit()
  }

  /** Called on every editor change; only dirty transitions re-render. */
  function setEditorText(path, text) {
    const doc = docs.get(path)
    if (doc === undefined || typeof text !== 'string') return
    if (doc.text === text) return
    doc.text = text
    if (doc.baseText === null) return
    doc.draft.editSeq += 1
    const dirty = text !== doc.baseText
    const wasDirty = doc.dirty
    doc.dirty = dirty
    if (!dirty) {
      clearDraftTimer(doc)
      // Returning to the old baseline does not resolve a disk conflict. Keep
      // the conflict state and its recoverable draft until the user chooses.
      if (doc.reconcile.required !== true) {
        doc.draft.status = 'none'
        doc.draft.error = null
        void deleteLatestForCurrentTab(doc)
      }
    } else {
      scheduleLatest(doc)
      scheduleHistory(doc)
    }
    if (wasDirty !== dirty) emit()
  }

  function enterUnconfirmed (doc, message, data = null) {
    // An unknown transport/response outcome may have committed the write.
    // Keep the true draft origin, require explicit reconciliation, and never
    // advance the baseline or clear the draft.
    const origin = doc.reconcile.required === true
      ? (doc.reconcile.draftBaseDiskHash ?? doc.baseHash)
      : doc.baseHash
    doc.savePhase = 'conflict'
    doc.conflict = {
      currentHash: data?.currentHash ?? null,
      code: typeof data?.code === 'string' ? data.code : 'WRITE_UNCONFIRMED',
      at: now(),
    }
    doc.reconcile.required = true
    doc.reconcile.draftBaseDiskHash = origin
    doc.reconcile.diskHashAtRestore = origin
    doc.reconcile.restoredFrom = 'write-unconfirmed'
    doc.saveError = message
    emit()
    return false
  }

  /**
   * Save binds the text snapshot at request time. The baseline moves to that
   * snapshot, not to whatever the editor contains when the response arrives.
   */
  async function save(path, text, { expectedHash = null, bypassReconcile = false, diag = null } = {}) {
    const doc = docs.get(path)
    if (doc === undefined) return false
    if (doc.savePhase === 'saving') return false
    if (doc.baseHash === null) {
      doc.savePhase = 'error'
      doc.saveError = '源码尚未读取完成，无法保存'
      emit()
      return false
    }
    // C1: a restored old draft may coexist with a newer disk baseline. CAS
    // alone cannot catch this (the baseline is current; the content is old).
    if (doc.reconcile.required === true && bypassReconcile !== true) {
      doc.savePhase = 'conflict'
      doc.saveError = '磁盘版本已变化；请先处理冲突（以磁盘为准，或明确覆盖）。'
      emit()
      return false
    }
    const snapshotText = text
    const snapshotHash = hashText(snapshotText)
    const loadEpoch = doc.loadEpoch
    doc.savePhase = 'saving'
    doc.saveError = null
    doc.saveNotice = null
    doc.conflict = null
    doc.staleAfterSave = false
    emit()
    try {
      const response = await fetchImpl(saveUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: doc.entry.source,
          expectedHash: expectedHash ?? doc.baseHash,
          content: snapshotText,
          ...(diag === null ? {} : {
            diagBodyId: typeof diag.bodyId === 'string' ? diag.bodyId : undefined,
            diagSource: typeof diag.source === 'string' ? diag.source : undefined,
            diagViewerOpen: diag.viewerOpen === true,
          }),
        }),
      })
      const data = await response.json().catch(() => null)
      const code = typeof data?.code === 'string' ? data.code : null
      const unconfirmed = code === 'WRITE_UNCONFIRMED' || code === 'WRITE_VERIFY_FAILED'
      if (data === null && response.status !== 400 && response.status !== 403 && response.status !== 413) {
        return enterUnconfirmed(doc, '保存响应无法解析，写入结果未确认；草稿已保留，请以磁盘为准核对或明确覆盖。')
      }
      // Resolve the HTTP result before the loadEpoch guard. A 409/503 must
      // never be displayed as "saved, but reloaded".
      if (response.status === 409 || unconfirmed) {
        const conflictOrigin = doc.reconcile.required === true
          ? (doc.reconcile.draftBaseDiskHash ?? doc.baseHash)
          : doc.baseHash
        doc.savePhase = 'conflict'
        doc.conflict = {
          currentHash: data?.currentHash ?? null,
          code: code ?? 'STALE',
          at: now(),
        }
        // A live save conflict is the same safety problem as a restored old
        // draft: the baseline no longer describes the disk. Preserve the
        // draft's true origin if one was already in conflict.
        doc.reconcile.required = true
        doc.reconcile.draftBaseDiskHash = conflictOrigin
        doc.reconcile.diskHashAtRestore = conflictOrigin
        doc.reconcile.restoredFrom = unconfirmed ? 'write-unconfirmed' : 'external-change'
        doc.saveError = unconfirmed
          ? '写入结果未确认；草稿已保留，请以磁盘为准核对，或明确覆盖。'
          : code === 'POST_WRITE_CHANGED'
            ? '写入已提交，但磁盘随后被外部修改；未确认保存成功。草稿已保留，请选择以磁盘为准或明确覆盖。'
            : '文件已被外部修改；保存已取消，未覆盖磁盘内容；草稿已保留。'
        emit()
        return false
      }
      if (!response.ok || !data?.ok) {
        // 4xx here is a definite pre-write rejection; 5xx/unknown may have
        // committed. Do not turn the latter into a retryable clean failure.
        if (response.status >= 400 && response.status < 500) {
          doc.savePhase = 'error'
          doc.saveError = `保存失败：${data?.error ?? `HTTP ${response.status}`}`
          emit()
          return false
        }
        return enterUnconfirmed(doc, '保存服务返回异常，写入结果未确认；草稿已保留，请以磁盘为准核对或明确覆盖。')
      }
      if (doc.loadEpoch !== loadEpoch) {
        // The save wrote the snapshot, but the document was reloaded while the
        // request was in flight. Never claim clean and never move the baseline
        // to a version the reload may not have read; ask for a reload instead.
        doc.savePhase = 'stale'
        doc.staleAfterSave = true
        doc.dirty = true
        doc.saveNotice = '已保存，但文档在保存期间被重新加载；请重载确认磁盘版本。'
        emit()
        return false
      }
      doc.baseText = snapshotText
      doc.baseHash = data.hash
      doc.version = data.version
      doc.savePhase = 'saved'
      doc.saveNotice = `文件已保存 ${clock().toLocaleTimeString()}`
      doc.saveError = null
      doc.conflict = null
      doc.staleAfterSave = false
      doc.dirty = doc.text !== snapshotText
      doc.reconcile.required = false
      doc.reconcile.draftBaseDiskHash = null
      doc.reconcile.diskHashAtRestore = null
      doc.reconcile.restoredFrom = null
      // The current tab's draft is redundant once the disk holds this text.
      // If the user typed during the save, keep the newer draft pending.
      if (doc.text === snapshotText) {
        clearDraftTimer(doc)
        doc.draft.status = 'none'
        doc.draft.persistedHash = snapshotHash
        doc.draft.persistedAt = now()
        doc.draft.baseDiskHash = data.hash
        doc.draft.baseDiskVersion = data.version
        doc.draft.queued = false
        doc.draft.error = null
        await deleteLatestForCurrentTab(doc).catch(() => {})
      } else {
        doc.draft.status = 'pending'
        scheduleLatest(doc)
      }
      doc.recovery.latest = doc.recovery.latest.filter((record) => record.tabId !== draftTabId)
      doc.recovery.conflict = doc.recovery.latest.some((record) => record.baseDiskHash !== doc.baseHash)
      doc.recovery.status = doc.recovery.latest.length > 0 ? 'available' : 'none'
      if (draftStore !== null) {
        void draftStore.markHistorySaved(path, snapshotHash)
          .then(() => draftStore.pruneHistory(path, { keep: 30, maxAgeMs: 7 * 24 * 3600 * 1000 }))
          .catch(() => {})
      }
      emit()
      return true
    } catch (error) {
      // A transport failure / lost response may have committed the write.
      // Treat it as unconfirmed so the draft is kept and reconciliation is
      // explicit; a definite 4xx was already handled above.
      return enterUnconfirmed(doc, `保存请求结果未确认：${String(error?.message ?? error)}；草稿已保留，请以磁盘为准核对或明确覆盖。`)
    }
  }

  /**
   * D3: stop every timer first, then flush the latest dirty draft, then release
   * listeners. The caller closes the IndexedDB connection after this resolves.
   */
  async function dispose () {
    if (lifecycle === 'disposed') return
    if (lifecycle === 'disposing') return disposePromise
    lifecycle = 'disposing'
    for (const doc of docs.values()) {
      clearDraftTimer(doc)
      clearHistoryTimer(doc)
    }
    listeners.clear()
    disposePromise = (async () => {
      try {
        for (const doc of docs.values()) {
          if (doc.draft.inFlight !== null) await Promise.resolve(doc.draft.inFlight).catch(() => {})
          if (doc.dirty === true) await flushLatest(doc.path).catch(() => {})
        }
      } finally {
        lifecycle = 'disposed'
      }
    })()
    return disposePromise
  }

  return {
    subscribe,
    getSnapshot,
    dispose,
    loadIndex,
    openDoc,
    reload,
    activateRoute,
    previewRoute,
    discardDraft,
    dismissRecovery,
    setPage,
    setEditorText,
    setNotice,
    clearNotice,
    clearSaveNotice,
    save,
    attachDraftStore,
    ensureDraftSafe,
    flushLatest,
    flushEmergencyAll,
    checkRecovery,
    recoverLatest,
    recoverHistory,
    listDrafts,
    resolveReconcile,
    setHistoryInterval,
    setDraftStorageError,
    getDraftStorageError: () => draftStorageError,
    getDoc: (path) => docs.get(path) ?? null,
    getActivePath: () => state.activePath,
  }
}
