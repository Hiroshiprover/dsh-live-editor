/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Formal preview-scheduler adapter, default-off.
 *
 * It wraps the already-tested bounded scheduler so the formal client can use
 * one in-flight staging write + latest snapshot without changing the ordinary
 * 250ms path. Callers must supply the actual write function.
 */
import { createBoundedPreviewScheduler } from '../../../../plugins/dsh-live-editor/src/r2-shadow/scheduler.mjs'

export function createPreviewScheduler({ write, onError } = {}) {
  if (typeof write !== 'function') throw new TypeError('write must be a function')
  return createBoundedPreviewScheduler({
    write,
    debounceMs: 150,
    maxWaitMs: 300,
    minIntervalMs: 200,
    onError,
  })
}

export function isPreviewSchedulerEnabled(runtime = globalThis) {
  const r2 = runtime?.__DSH_LIVE_EDITOR_R2__
  return r2?.active === true && r2?.scheduler === true
}

export const PREVIEW_SCHEDULER_POLICY = Object.freeze({
  debounceMs: 150,
  maxWaitMs: 300,
  minIntervalMs: 200,
})

/**
 * Serialize preview writes across scheduler instances by document/source key.
 * Disposing a scheduler cannot cancel an already-started transport; this shared
 * chain makes a replacement scheduler wait for the old transport to settle, so
 * an old revision cannot be committed after a newer one.
 */
export function createSerializedPreviewWriter(write) {
  if (typeof write !== 'function') throw new TypeError('write must be a function')
  const chains = new Map()
  return function serializedWrite(key, ...args) {
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => write(...args))
    let tracked
    tracked = next.finally(() => {
      if (chains.get(key) === tracked) chains.delete(key)
    })
    chains.set(key, tracked)
    return tracked
  }
}

/**
 * Bind the shared serializer to a concrete preview writer. This wrapper owns
 * the key/argument mapping so the client never has to repeat it.
 */
export function createPreviewWriter(writePreview) {
  if (typeof writePreview !== 'function') throw new TypeError('writePreview must be a function')
  const serialized = createSerializedPreviewWriter((doc, source, text, current) => (
    writePreview(doc, source, text, current)
  ))
  return (doc, source, text, current) => serialized(source, doc, source, text, current)
}
