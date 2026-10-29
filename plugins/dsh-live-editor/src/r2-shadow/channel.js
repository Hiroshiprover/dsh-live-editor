/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Formal R2 child channel (default disabled by the R2 shadow flag).
 *
 * This is deliberately small: it observes a staging-only DOM marker written by
 * the Host, accepts commands from the trusted DSH parent, and acknowledges only
 * after two animation frames with an exact bootId/generation/commandId/writeId
 * match. A 400ms fallback is reported as unconfirmed and must not be accepted.
 */
export const R2_SOURCE = 'dsh-live-editor-r2'
export const R2_VERSION = 1
export const A2_HANDSHAKE_VERSION = 'A2-HANDSHAKE-V2'
export const R2_WRITE_ID = 'dsh-r2-write-id'
export const R2_REVISION = 'dsh-r2-revision'
export const R2_FALLBACK_MS = 400
export const R2_COMMAND_EXPIRY_MS = 5000

const WRITE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/
const isString = (v) => typeof v === 'string'
const normalizePath = (v) => String(v ?? '').replace(/\/+$/, '') || '/'
const parseRevision = (v) => {
  const n = Number(String(v ?? '').replace(/^REV\s+/i, '').trim())
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export function isValidR2Command(data) {
  return Boolean(data && typeof data === 'object'
    && data.source === R2_SOURCE && data.v === R2_VERSION
    && data.type === 'r2-command'
    && isString(data.commandId) && data.commandId.length > 0 && data.commandId.length <= 160
    && Number.isSafeInteger(data.revision) && data.revision > 0
    && isString(data.writeId) && WRITE_ID_RE.test(data.writeId)
    && isString(data.session) && SESSION_RE.test(data.session)
    && isString(data.docId) && data.docId.length > 0 && data.docId.length <= 200
    && isString(data.route) && data.route.startsWith('/')
    && isString(data.bootId) && data.bootId.length > 0
    && Number.isSafeInteger(data.generation) && data.generation > 0
    && Number.isSafeInteger(data.writeAt))
}

export function readR2Marker(documentRef = document) {
  const writeId = documentRef.querySelector(`#${R2_WRITE_ID}`)?.textContent?.trim() ?? null
  const revision = parseRevision(documentRef.querySelector(`#${R2_REVISION}`)?.textContent)
  return { writeId, revision }
}

export function installR2Channel({ metadata = null, parentOrigin = null, enabled = true } = {}) {
  if (typeof window === 'undefined' || !enabled) return () => {}
  if (window.parent === window) return () => {}
  const origin = parentOrigin
    || window.location.ancestorOrigins?.[0]
    || (document.referrer ? new URL(document.referrer).origin : null)
  if (!origin) return () => {}
  if (window.__R2_CHANNEL__?.installed) {
    const existing = window.__R2_CHANNEL__
    existing.metadata = metadata ?? existing.metadata
    existing.session = metadata?.previewSession ?? null
    existing.docId = isString(metadata?.docId) ? metadata.docId : null
    existing.route = isString(metadata?.permalink) ? metadata.permalink : window.location.pathname
    existing.generation += 1
    existing.pending = null
    existing.postHello()
    return existing.dispose ?? (() => {})
  }

  const bootId = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const state = {
    installed: true,
    metadata: metadata ?? null,
    bootId,
    generation: 1,
    session: metadata?.previewSession ?? null,
    docId: isString(metadata?.docId) ? metadata.docId : null,
    route: isString(metadata?.permalink) ? metadata.permalink : window.location.pathname,
    pending: null,
    lastAck: null,
    dispose: null,
    disposed: false,
  }

  const post = (message) => {
    if (state.disposed) return
    try { window.parent.postMessage({ source: R2_SOURCE, v: R2_VERSION, bootId: state.bootId, ...message }, origin) } catch { /* ignore */ }
  }
  const postHello = () => post({
    type: 'r2-hello',
    handshake: A2_HANDSHAKE_VERSION,
    generation: state.generation,
    session: state.session,
    docId: state.docId,
    route: state.route,
    path: window.location.pathname,
    marker: readR2Marker(document),
    timeOrigin: performance.timeOrigin,
  })
  state.postHello = postHello
  window.__R2_CHANNEL__ = state
  document.documentElement.dataset.dshR2 = '1'

  const sendAck = (pending, confirmed) => {
    if (state.disposed || state.pending !== pending || pending.acked) return false
    const marker = readR2Marker(document)
    if (marker.writeId !== pending.writeId || marker.revision !== pending.revision) return false
    if (confirmed !== true) {
      if (pending.fallbackSent === true) return false
      pending.fallbackSent = true
    } else {
      pending.acked = true
    }
    state.lastAck = {
      commandId: pending.commandId, revision: pending.revision, writeId: pending.writeId,
      marker, confirmed: confirmed === true, at: Date.now(),
    }
    post({
      type: 'r2-ack', generation: state.generation, session: state.session, docId: state.docId,
      route: state.route, path: window.location.pathname, ...state.lastAck,
    })
    return true
  }
  const maybeAck = (pending) => {
    if (state.disposed || state.pending !== pending || pending.acked) return
    const marker = readR2Marker(document)
    if (marker.writeId !== pending.writeId || marker.revision !== pending.revision) return
    if (pending.rAFScheduled === true) return
    pending.rAFScheduled = true
    requestAnimationFrame(() => requestAnimationFrame(() => {
      pending.rAFScheduled = false
      if (state.pending === pending) {
        sendAck(pending, true)
      } else if (state.pending !== null) {
        // A superseding command arrived while this callback was queued; it must
        // get its own completion scheduling.
        maybeAck(state.pending)
      }
    }))
    if (pending.fallbackScheduled !== true) {
      pending.fallbackScheduled = true
      setTimeout(() => {
        if (state.pending === pending && !pending.acked) sendAck(pending, false)
      }, R2_FALLBACK_MS)
    }
  }

  const onMessage = (event) => {
    if (event.origin !== origin || event.source !== window.parent) return
    const data = event.data
    if (!data || data.source !== R2_SOURCE || data.v !== R2_VERSION) return
    if (data.type === 'r2-hello-request') { postHello(); return }
    if (!isValidR2Command(data)) return
    // docId/session/route can differ from (or be staler than) the docs metadata.
    // The rendered writeId/revision marker is the binding: maybeAck only confirms
    // a command whose writeId/revision is the marker actually in this page.
    state.session = data.session
    state.docId = data.docId
    state.route = data.route
    if (data.bootId !== state.bootId) return
    if (data.generation !== state.generation) return
    const pending = {
      commandId: data.commandId, revision: data.revision, writeId: data.writeId,
      session: data.session, docId: data.docId, route: data.route,
      writeAt: data.writeAt, acked: false, rAFScheduled: false, fallbackScheduled: false, fallbackSent: false,
    }
    state.pending = pending
    maybeAck(pending)
  }

  const observer = new MutationObserver(() => {
    if (state.pending) maybeAck(state.pending)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
  window.addEventListener('message', onMessage)
  postHello()

  const dispose = () => {
    if (window.__R2_CHANNEL__ !== state) return
    state.disposed = true
    if (state.pending) state.pending.acked = true
    state.pending = null
    window.removeEventListener('message', onMessage)
    observer.disconnect()
    delete window.__R2_CHANNEL__
    delete document.documentElement.dataset.dshR2
  }
  state.dispose = dispose
  window.addEventListener('pagehide', dispose, { once: true })
  return dispose
}
