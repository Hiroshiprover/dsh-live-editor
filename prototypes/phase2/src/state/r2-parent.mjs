/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Formal R2 parent command lifecycle (default disabled by a runtime gate).
 *
 * The controller is transport-free: the client supplies `send`, and the module
 * validates hello/ack identity, generation, pending command, expiry and the
 * rendered write identity. A 400ms child fallback is never accepted.
 *
 * Lifecycle invariant: the newest successful staging write is retained across
 * reload/frame/generation changes and reissued under the new identity. It is
 * never re-written; only the confirmation command is reissued.
 */
export const R2_SOURCE = 'dsh-live-editor-r2'
export const R2_VERSION = 1
export const A2_HANDSHAKE_VERSION = 'A2-HANDSHAKE-V2'
export const R2_PENDING_EXPIRY_MS = 5000
const WRITE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/
const normalizePath = (v) => String(v ?? '').replace(/\/+$/, '') || '/'
const isObj = (v) => v !== null && typeof v === 'object'

export function createR2ParentController({
  send,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onTimeout = () => {},
  expiryMs = R2_PENDING_EXPIRY_MS,
} = {}) {
  if (typeof send !== 'function') throw new TypeError('send must be a function')
  let frame = null
  let bootId = null
  let generation = 0
  let session = null
  let docId = null
  let route = null
  let pending = null
  let timer = null
  let disposed = false
  let lastAck = null
  let latest = null
  let sequence = 0
  let lastAckedSequence = 0

  const cancelTimer = () => {
    if (timer !== null) { clearTimer(timer); timer = null }
  }
  const clearPending = () => {
    cancelTimer()
    pending = null
  }
  const clearIdentity = () => {
    clearPending()
    bootId = null
    generation = 0
    session = null
    docId = null
    route = null
  }
  // The rendered DOM writeId marker is the real binding: the child only acks
  // when the command's writeId/revision matches the marker actually rendered in
  // its page. The parent must not reject on docId/route/session normalization
  // differences (slug vs path, stale docs metadata); the ack is still validated
  // against the pending command in handleAck.
  const matchesIdentity = () => true
  const sendCommand = (request) => {
    clearPending()
    const commandId = `r2-${now()}-${Math.random().toString(36).slice(2, 10)}`
    pending = {
      seq: request.seq, commandId, revision: request.revision, writeId: request.writeId,
      session: request.session, docId: request.docId, route: request.route,
      bootId, generation, writeAt: now(), sentAt: now(),
    }
    send({ type: 'r2-command', source: R2_SOURCE, v: R2_VERSION, ...pending })
    timer = setTimer(() => {
      timer = null
      if (pending === null) return
      const expired = pending
      pending = null
      onTimeout(expired)
    }, expiryMs)
    return commandId
  }
  const reissueLatest = () => {
    if (latest === null || latest.seq <= lastAckedSequence) return
    if (!matchesIdentity(latest)) return
    if (pending !== null && pending.seq === latest.seq
      && pending.bootId === bootId && pending.generation === generation) return
    sendCommand(latest)
  }

  const invalidate = (reason) => {
    clearPending()
    latest = null
    return reason
  }
  const resetHandshake = (reason = 'handshake-reset') => {
    clearIdentity()
    return reason
  }
  const acceptHello = (data) => {
    if (disposed || !isObj(data) || data.source !== R2_SOURCE || data.v !== R2_VERSION) return false
    if (data.handshake !== A2_HANDSHAKE_VERSION) return false
    if (typeof data.bootId !== 'string' || data.bootId.length === 0) return false
    if (!Number.isSafeInteger(data.generation) || data.generation < 1) return false
    if (bootId !== data.bootId) {
      clearPending()
      bootId = data.bootId
      generation = 0
    }
    if (data.generation < generation) return false
    if (pending !== null && data.generation > pending.generation) clearPending()
    generation = data.generation
    session = typeof data.session === 'string' ? data.session : null
    docId = typeof data.docId === 'string' ? data.docId : null
    // Prefer the actual page path over the docs metadata permalink (slug).
    route = typeof data.path === 'string' ? data.path : (typeof data.route === 'string' ? data.route : null)
    // The command may have been posted to the new iframe window before its
    // channel installed (the message is then lost). A hello proves the child
    // is now listening, so drop any pending copy and reissue the newest write.
    clearPending()
    reissueLatest()
    return true
  }
  const begin = (request) => {
    if (disposed || !request || typeof request !== 'object') return null
    if (typeof request.session !== 'string' || !SESSION_RE.test(request.session)) return null
    if (typeof request.docId !== 'string' || request.docId.length === 0 || request.docId.length > 200) return null
    if (typeof request.route !== 'string' || !request.route.startsWith('/')) return null
    if (!Number.isSafeInteger(request.revision) || request.revision < 1) return null
    if (typeof request.writeId !== 'string' || !WRITE_ID_RE.test(request.writeId)) return null
    sequence += 1
    latest = {
      seq: sequence, session: request.session, docId: request.docId, route: request.route,
      revision: request.revision, writeId: request.writeId,
    }
    // A newer successful write supersedes any older pending/queued request.
    if (pending !== null) clearPending()
    if (frame === null || bootId === null || generation < 1 || !matchesIdentity(latest)) return null
    return sendCommand(latest)
  }
  const handleAck = (data) => {
    if (disposed || !isObj(data)) return { ok: false, reason: 'invalid' }
    if (data.source !== R2_SOURCE || data.v !== R2_VERSION) return { ok: false, reason: 'source' }
    if (pending === null) return { ok: false, reason: 'unsolicited' }
    if (data.bootId !== bootId || data.bootId !== pending.bootId) return { ok: false, reason: 'boot-mismatch' }
    if (data.generation !== generation || data.generation !== pending.generation) return { ok: false, reason: 'generation-mismatch' }
    if (data.session !== pending.session) return { ok: false, reason: 'session-mismatch' }
    if (data.docId !== pending.docId) return { ok: false, reason: 'doc-mismatch' }
    if (normalizePath(data.route) !== normalizePath(pending.route)) return { ok: false, reason: 'route-mismatch' }
    if (normalizePath(data.path) !== normalizePath(pending.route)) return { ok: false, reason: 'path-mismatch' }
    if (data.commandId !== pending.commandId) return { ok: false, reason: 'command-mismatch' }
    if (data.revision !== pending.revision) return { ok: false, reason: 'revision-mismatch' }
    if (data.writeId !== pending.writeId || data.marker?.writeId !== pending.writeId) return { ok: false, reason: 'write-id-mismatch' }
    if (data.marker?.revision !== pending.revision) return { ok: false, reason: 'marker-revision-mismatch' }
    if (data.confirmed !== true) return { ok: false, reason: 'unconfirmed' }
    if (now() - pending.sentAt > expiryMs) {
      invalidate('expired')
      return { ok: false, reason: 'pending-expired' }
    }
    lastAckedSequence = Math.max(lastAckedSequence, pending.seq)
    lastAck = { commandId: data.commandId, revision: data.revision, writeId: data.writeId, session: pending.session, docId: pending.docId, route: pending.route, bootId: data.bootId, generation: data.generation, at: now() }
    clearPending()
    return { ok: true, ack: lastAck }
  }
  return {
    setFrame(win) {
      const next = win ?? null
      if (next !== frame) {
        clearIdentity()
        frame = next
      }
    },
    resetHandshake,
    acceptHello,
    begin,
    handleAck,
    invalidate,
    dispose() { disposed = true; clearIdentity(); latest = null; frame = null },
    snapshot() {
      return {
        bootId, generation, session, docId, route, pending, lastAck, handshakeVersion: A2_HANDSHAKE_VERSION, disposed,
        latest: latest === null ? null : { ...latest },
        queued: latest !== null && latest.seq > lastAckedSequence && pending?.seq !== latest.seq ? { ...latest } : null,
      }
    },
  }
}
