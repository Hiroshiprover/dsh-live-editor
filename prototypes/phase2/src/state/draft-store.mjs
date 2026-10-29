/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Phase 3.2 — local draft storage (Model B).
 *
 * Two backends with one interface:
 *   - IndexedDB: latest draft per tab + history snapshots + meta.
 *   - In-memory: used by node tests; same writeSeq / history semantics.
 *
 * Emergency localStorage is separate: it is the synchronous last-resort copy
 * written on pagehide. It is never the primary store.
 *
 * This module deliberately has no React/DSH dependency.
 */

export const DRAFT_DB = 'dsh-live-editor-drafts'
export const DRAFT_DB_VERSION = 1
export const EMERGENCY_PREFIX = 'live-editor:emergency:v1:'
export const EMERGENCY_ERROR_PREFIX = 'live-editor:emergency-error:v1:'
export const DEFAULT_EMERGENCY_LIMIT = 1024 * 1024

/** Non-crypto, synchronous text hash for dedupe/compare (FNV-1a 64). */
export function hashText (text) {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i += 1) {
    h ^= BigInt(text.charCodeAt(i))
    h = BigInt.asUintN(64, h * 0x100000001b3n)
  }
  return h.toString(16).padStart(16, '0')
}

/**
 * Session-scoped draft identity. Without a session id this remains the legacy
 * `site::path::tab` key so existing drafts stay readable; new callers pass the
 * DSH session id and get `site::session::path::tab`.
 */
export function latestId (siteId, path, tabId, sessionId = null) {
  return sessionId
    ? `${siteId}::${sessionId}::${path}::${tabId}`
    : `${siteId}::${path}::${tabId}`
}

function emergencyKey (siteId, path, tabId, sessionId = null) {
  return sessionId
    ? `${EMERGENCY_PREFIX}${siteId}::${sessionId}::${path}::${tabId}`
    : `${EMERGENCY_PREFIX}${siteId}::${path}::${tabId}`
}

function errorKey (tabId) {
  return `${EMERGENCY_ERROR_PREFIX}${tabId}`
}

function storageOf (override) {
  if (override !== undefined) return override
  try { return globalThis.localStorage ?? null } catch { return null }
}

function safeParse (value) {
  try { return JSON.parse(value) } catch { return null }
}

function emergencyRecord (raw) {
  if (raw === null || typeof raw !== 'object') return null
  if (typeof raw.siteId !== 'string' || typeof raw.path !== 'string'
    || typeof raw.tabId !== 'string' || typeof raw.text !== 'string') return null
  return raw
}

function listEmergencyByPrefix (storage, prefix) {
  if (storage === null) return []
  const values = []
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      if (typeof key !== 'string' || !key.startsWith(prefix)) continue
      const value = safeParse(storage.getItem(key))
      if (value !== null) values.push({ key, value })
    }
  } catch { /* storage unavailable */ }
  return values
}

export function writeEmergency (storage, record, { limit = DEFAULT_EMERGENCY_LIMIT } = {}) {
  const local = storageOf(storage)
  if (local === null) return { ok: false, error: 'LOCALSTORAGE_UNAVAILABLE' }
  const payload = JSON.stringify(record)
  if (payload.length > limit) return { ok: false, error: 'EMERGENCY_TOO_LARGE', limit }
  try {
    local.setItem(emergencyKey(record.siteId, record.path, record.tabId, record.sessionId ?? null), payload)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

export function readEmergencies (storage, siteId) {
  return listEmergencyByPrefix(storageOf(storage), EMERGENCY_PREFIX)
    .map(({ key, value }) => ({ ...emergencyRecord(value), key }))
    .filter((record) => record.siteId === siteId)
}

export function deleteEmergency (storage, siteId, path, tabId, sessionId = null) {
  const local = storageOf(storage)
  try {
    local?.removeItem(emergencyKey(siteId, path, tabId, sessionId))
  } catch { /* unavailable */ }
}

export function markEmergencyError (storage, tabId, record) {
  const local = storageOf(storage)
  try { local?.setItem(errorKey(tabId), JSON.stringify(record)) } catch { /* unavailable */ }
}

export function readEmergencyErrors (storage, tabId) {
  const local = storageOf(storage)
  if (local === null) return []
  const values = listEmergencyByPrefix(local, EMERGENCY_ERROR_PREFIX)
    .map(({ key, value }) => ({ ...value, key }))
  return tabId === undefined ? values : values.filter((value) => value.key === errorKey(tabId))
}

export function clearEmergencyError (storage, tabId) {
  try { storageOf(storage)?.removeItem(errorKey(tabId)) } catch { /* unavailable */ }
}

/**
 * In-memory implementation. It mirrors the IndexedDB semantics used by the
 * DocStore: writeSeq guard, per-tab latest keys, append-only history.
 */
export function createMemoryDraftStore ({ siteId, tabId, sessionId = null, storage } = {}) {
  const latest = new Map()
  const history = []
  const emergencies = new Map()
  let nextId = 1
  const local = storageOf(storage)
  return {
    kind: 'memory',
    siteId,
    tabId,
    sessionId,
    error: null,
    async open () { return true },
    async close () {},
    async putLatest (record) {
      const existing = latest.get(record.id)
      if (existing !== undefined && Number(existing.writeSeq ?? 0) > Number(record.writeSeq ?? 0)) {
        return { ok: true, skipped: true }
      }
      latest.set(record.id, { ...record })
      return { ok: true, skipped: false }
    },
    async getLatest (path, id = tabId) {
      return latest.get(latestId(siteId, path, id, sessionId))
        ?? (sessionId ? latest.get(latestId(siteId, path, id)) : null)
        ?? null
    },
    async listLatest (path) {
      return [...latest.values()].filter((record) => record.siteId === siteId && record.path === path)
    },
    async listAllLatest () {
      return [...latest.values()].filter((record) => record.siteId === siteId)
    },
    async listAllHistory () {
      return history
        .filter((record) => record.siteId === siteId)
        .sort((a, b) => b.createdAt - a.createdAt)
    },
    async deleteLatest (path, id = tabId) {
      latest.delete(latestId(siteId, path, id, sessionId))
    },
    async appendHistory (record) {
      const id = nextId++
      history.push({ ...record, id })
      return { id }
    },
    async listHistory (path, { limit = 100 } = {}) {
      return history
        .filter((record) => record.siteId === siteId && record.path === path)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
    },
    async getHistory (id) {
      return history.find((record) => record.id === id) ?? null
    },
    async markHistorySaved (path, textHash) {
      let changed = 0
      for (const record of history) {
        if (record.siteId === siteId && record.path === path
          && record.textHash === textHash && record.saved !== true) {
          record.saved = true
          changed += 1
        }
      }
      return changed
    },
    async pruneHistory (path, { keep = 30, maxAgeMs = 7 * 24 * 3600 * 1000, maxTotal = 120, now = Date.now() } = {}) {
      const all = history
        .filter((record) => record.siteId === siteId && record.path === path)
        .sort((a, b) => b.createdAt - a.createdAt)
      const candidates = all.filter((record) => record.saved === true)
      const remove = new Set()
      candidates.forEach((record, index) => {
        if (index >= keep || now - record.createdAt > maxAgeMs) remove.add(record.id)
      })
      // Unsaved autosave snapshots must also be bounded; otherwise a long
      // editing session grows history without limit.
      all.filter((record) => record.saved !== true).forEach((record, index) => {
        if (index >= maxTotal || now - record.createdAt > maxAgeMs) remove.add(record.id)
      })
      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (remove.has(history[i].id)) history.splice(i, 1)
      }
      return [...remove]
    },
    async deleteHistory (path) {
      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i].siteId === siteId && history[i].path === path) history.splice(i, 1)
      }
    },
    async deleteAllForDoc (path) {
      for (const key of [...latest.keys()]) {
        if (key.startsWith(`${siteId}::${path}::`)) latest.delete(key)
      }
      await this.deleteHistory(path)
    },
    async writeEmergency (record) {
      emergencies.set(`${record.sessionId ?? sessionId ?? ''}::${record.path}::${record.tabId}`, { ...record, sessionId: record.sessionId ?? sessionId })
      return { ok: true }
    },
    async listEmergencies () {
      return [...emergencies.values()].filter((record) => record.siteId === siteId)
    },
    async deleteEmergency (path, id = tabId) {
      emergencies.delete(`${sessionId ?? ''}::${path}::${id}`)
    },
    async markEmergencyError (record) {
      markEmergencyError(local, tabId, record)
    },
    async listEmergencyErrors () {
      return readEmergencyErrors(local, tabId)
    },
    async deleteEmergencyError () {
      clearEmergencyError(local, tabId)
    },
    async usage () { return null },
  }
}

function request (req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone (tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function historyKeyRange (siteId, path) {
  // history.byDoc is [siteId, path, createdAt]; only([siteId, path]) does not
  // match a three-component index key, so use an explicit numeric range.
  return IDBKeyRange.bound([siteId, path, 0], [siteId, path, Number.MAX_SAFE_INTEGER])
}

function openDatabase (indexedDB, dbName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DRAFT_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('latest')) {
        const store = db.createObjectStore('latest', { keyPath: 'id' })
        store.createIndex('byDoc', ['siteId', 'path'])
        store.createIndex('byUpdated', 'updatedAt')
      }
      if (!db.objectStoreNames.contains('history')) {
        const store = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true })
        store.createIndex('byDoc', ['siteId', 'path', 'createdAt'])
        store.createIndex('bySaved', 'saved')
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
    req.onblocked = () => reject(new Error('IndexedDB blocked by another connection'))
  })
}

/**
 * IndexedDB implementation. If IndexedDB is unavailable, open() returns false
 * and the caller must show an explicit storage error / use emergency storage.
 */
export function createDraftStore ({
  siteId, tabId, sessionId = null, dbName = DRAFT_DB, indexedDB: idb = globalThis.indexedDB,
  storage, emergencyLimit = DEFAULT_EMERGENCY_LIMIT,
} = {}) {
  let db = null
  let openError = null
  const local = storageOf(storage)
  const self = {
    kind: 'indexeddb',
    siteId,
    tabId,
    sessionId,
    openError,
    async open () {
      if (db !== null) return true
      if (idb === undefined || idb === null) {
        openError = 'INDEXEDDB_UNAVAILABLE'
        self.openError = openError
        return false
      }
      try {
        db = await openDatabase(idb, dbName)
        return true
      } catch (error) {
        openError = String(error?.message ?? error)
        self.openError = openError
        return false
      }
    },
    async close () {
      try { db?.close() } catch { /* already closed */ }
      db = null
    },
    requireDb () {
      if (db === null) {
        const error = new Error(openError ?? 'DRAFT_STORAGE_UNAVAILABLE')
        error.code = 'DRAFT_STORAGE_UNAVAILABLE'
        throw error
      }
      return db
    },
    async putLatest (record) {
      const database = self.requireDb()
      return new Promise((resolve, reject) => {
        const tx = database.transaction('latest', 'readwrite')
        const store = tx.objectStore('latest')
        let skipped = false
        const existing = store.get(record.id)
        existing.onsuccess = () => {
          if (existing.result !== undefined
            && Number(existing.result.writeSeq ?? 0) > Number(record.writeSeq ?? 0)) {
            skipped = true
            return
          }
          store.put(record)
        }
        tx.oncomplete = () => resolve({ ok: true, skipped })
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
      })
    },
    async getLatest (path, id = tabId) {
      const database = self.requireDb()
      const tx = database.transaction('latest', 'readonly')
      const value = await request(tx.objectStore('latest').get(latestId(siteId, path, id, sessionId)))
      await transactionDone(tx)
      if (value !== undefined && value !== null) return value
      if (!sessionId) return null
      const legacyTx = database.transaction('latest', 'readonly')
      const legacy = await request(legacyTx.objectStore('latest').get(latestId(siteId, path, id)))
      await transactionDone(legacyTx)
      return legacy ?? null
    },
    async listLatest (path) {
      const database = self.requireDb()
      const tx = database.transaction('latest', 'readonly')
      const index = tx.objectStore('latest').index('byDoc')
      const values = await request(index.getAll(IDBKeyRange.only([siteId, path])))
      await transactionDone(tx)
      return values
    },
    async listAllLatest () {
      const database = self.requireDb()
      const tx = database.transaction('latest', 'readonly')
      const values = await request(tx.objectStore('latest').getAll())
      await transactionDone(tx)
      return values.filter((record) => record.siteId === siteId)
    },
    async listAllHistory () {
      const database = self.requireDb()
      const tx = database.transaction('history', 'readonly')
      const values = await request(tx.objectStore('history').getAll())
      await transactionDone(tx)
      return values
        .filter((record) => record.siteId === siteId)
        .sort((a, b) => b.createdAt - a.createdAt)
    },
    async deleteLatest (path, id = tabId) {
      const database = self.requireDb()
      const tx = database.transaction('latest', 'readwrite')
      tx.objectStore('latest').delete(latestId(siteId, path, id, sessionId))
      await transactionDone(tx)
    },
    async appendHistory (record) {
      const database = self.requireDb()
      const tx = database.transaction('history', 'readwrite')
      const id = await request(tx.objectStore('history').add(record))
      await transactionDone(tx)
      return { id }
    },
    async listHistory (path, { limit = 100 } = {}) {
      const database = self.requireDb()
      const tx = database.transaction('history', 'readonly')
      const index = tx.objectStore('history').index('byDoc')
      const values = await request(index.getAll(historyKeyRange(siteId, path)))
      await transactionDone(tx)
      return values.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
    },
    async getHistory (id) {
      const database = self.requireDb()
      const tx = database.transaction('history', 'readonly')
      const value = await request(tx.objectStore('history').get(id))
      await transactionDone(tx)
      return value ?? null
    },
    async markHistorySaved (path, textHash) {
      const database = self.requireDb()
      const tx = database.transaction('history', 'readwrite')
      const index = tx.objectStore('history').index('byDoc')
      const values = await request(index.getAll(historyKeyRange(siteId, path)))
      let changed = 0
      for (const value of values) {
        if (value.textHash === textHash && value.saved !== true) {
          tx.objectStore('history').put({ ...value, saved: true })
          changed += 1
        }
      }
      await transactionDone(tx)
      return changed
    },
    async pruneHistory (path, { keep = 30, maxAgeMs = 7 * 24 * 3600 * 1000, maxTotal = 120, now = Date.now() } = {}) {
      const database = self.requireDb()
      const tx = database.transaction('history', 'readwrite')
      const index = tx.objectStore('history').index('byDoc')
      const values = await request(index.getAll(historyKeyRange(siteId, path)))
      const all = values.sort((a, b) => b.createdAt - a.createdAt)
      const candidates = all.filter((value) => value.saved === true)
      const remove = new Set()
      candidates.forEach((value, position) => {
        if (position >= keep || now - value.createdAt > maxAgeMs) remove.add(value.id)
      })
      all.filter((value) => value.saved !== true).forEach((value, position) => {
        if (position >= maxTotal || now - value.createdAt > maxAgeMs) remove.add(value.id)
      })
      for (const id of remove) tx.objectStore('history').delete(id)
      await transactionDone(tx)
      return [...remove]
    },
    async deleteHistory (path) {
      const database = self.requireDb()
      const tx = database.transaction('history', 'readwrite')
      const index = tx.objectStore('history').index('byDoc')
      const values = await request(index.getAll(historyKeyRange(siteId, path)))
      for (const value of values) tx.objectStore('history').delete(value.id)
      await transactionDone(tx)
    },
    async deleteAllForDoc (path) {
      await self.deleteLatest(path, tabId)
      const database = self.requireDb()
      const tx = database.transaction('latest', 'readwrite')
      const index = tx.objectStore('latest').index('byDoc')
      const values = await request(index.getAll(IDBKeyRange.only([siteId, path])))
      for (const value of values) tx.objectStore('latest').delete(value.id)
      await transactionDone(tx)
      await self.deleteHistory(path)
    },
    async writeEmergency (record) {
      return writeEmergency(local, { ...record, sessionId: record.sessionId ?? sessionId }, { limit: emergencyLimit })
    },
    async listEmergencies () {
      return readEmergencies(local, siteId)
    },
    async deleteEmergency (path, id = tabId) {
      deleteEmergency(local, siteId, path, id, sessionId)
    },
    async markEmergencyError (record) {
      markEmergencyError(local, tabId, record)
    },
    async listEmergencyErrors () {
      return readEmergencyErrors(local, tabId)
    },
    async deleteEmergencyError () {
      clearEmergencyError(local, tabId)
    },
    async usage () {
      try {
        return await globalThis.navigator?.storage?.estimate?.() ?? null
      } catch {
        return null
      }
    },
  }
  return self
}
