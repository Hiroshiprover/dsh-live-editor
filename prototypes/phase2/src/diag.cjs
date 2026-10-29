/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * TEMPORARY diagnostics for the read-only viewer investigation.
 *
 * Fire-and-forget JSON lines posted to the dev Host (`/api/live-editor/diag`),
 * which appends them to `<test site>/.dsh-live-editor/diag.jsonl`. Remove this
 * module together with the Host diag route once the failure is explained; it
 * never affects product logic and never blocks a caller.
 */
const FNV_OFFSET = 2166136261

function fnv1a (text) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  let hash = FNV_OFFSET
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

let bodyCount = 0
const bootId = `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function newBodyId () {
  bodyCount += 1
  return `${bootId}-b${bodyCount}`
}

function describeElement (element) {
  if (element === null || typeof element !== 'object') return null
  try {
    // No textContent: element text can contain chat or source snippets.
    return {
      tag: typeof element.tagName === 'string' ? element.tagName : null,
      role: typeof element.getAttribute === 'function' ? element.getAttribute('role') : null,
      ariaLabel: typeof element.getAttribute === 'function'
        ? String(element.getAttribute('aria-label') ?? '').slice(0, 60) || null
        : null,
      inLiveEditor: typeof element.closest === 'function' ? element.closest('[data-dsh-live-editor="phase2"]') !== null : null,
      inViewer: typeof element.closest === 'function' ? element.closest('[aria-label="只读源码查看器"]') !== null : null,
    }
  } catch { return null }
}

function activeElementInfo () {
  try {
    if (typeof document === 'undefined' || document === null) return null
    return describeElement(document.activeElement)
  } catch { return null }
}

/**
 * Client diagnostics are retired after the read-only viewer Step.
 *
 * The high-frequency events (viewer lifecycle, keys, preview, body mounts) and
 * the /api/live-editor/diag route were removed to avoid log growth and path
 * exposure. This module is kept only for the lightweight helpers still used by
 * the low-volume save audit tags; log() is a no-op.
 */
function log () {
  /* diagnostics disabled */
}

module.exports = { log, fnv1a, newBodyId, describeElement, activeElementInfo }
