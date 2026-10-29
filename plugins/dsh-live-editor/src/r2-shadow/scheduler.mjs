/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Bounded preview scheduler for the R2 shadow path.
 *
 * Starting policy (not production constants):
 *   150ms trailing debounce, 300ms maximum wait, 200ms minimum interval,
 *   one in-flight write + one replaceable latest snapshot.
 *
 * Contracts:
 * - submit() replaces an unwritten snapshot; it never queues intermediates.
 * - flush() waits for in-flight work, the minimum interval and the latest
 *   snapshot, then reports the last failure if the drain ended in error.
 * - A timeout is fail-closed: no newer write starts while the timed-out
 *   underlying operation is unresolved, so a late commit cannot overwrite it.
 * - dispose() prevents queued work from starting; an already-started transport
 *   cannot be cancelled, but its result is ignored.
 */
export const R2_SCHEDULER_DEFAULTS = Object.freeze({
  debounceMs: 150,
  maxWaitMs: 300,
  minIntervalMs: 200,
  writeTimeoutMs: 10000,
})

export function createBoundedPreviewScheduler(options = {}) {
  const write = options.write
  if (typeof write !== 'function') throw new TypeError('write must be a function')
  const debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : R2_SCHEDULER_DEFAULTS.debounceMs
  const maxWaitMs = Number.isFinite(options.maxWaitMs) ? Math.max(0, options.maxWaitMs) : R2_SCHEDULER_DEFAULTS.maxWaitMs
  const minIntervalMs = Number.isFinite(options.minIntervalMs) ? Math.max(0, options.minIntervalMs) : R2_SCHEDULER_DEFAULTS.minIntervalMs
  const writeTimeoutMs = Number.isFinite(options.writeTimeoutMs) ? Math.max(0, options.writeTimeoutMs) : R2_SCHEDULER_DEFAULTS.writeTimeoutMs
  const now = typeof options.now === 'function' ? options.now : Date.now
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout
  const onError = typeof options.onError === 'function' ? options.onError : () => {}

  let latest = null
  let sequence = 0
  let timer = null
  let firstPendingAt = null
  let lastWriteAt = -Infinity
  let inFlight = null
  let disposed = false
  let lastError = null
  let fatalError = null

  const clear = () => {
    if (timer !== null) { clearTimer(timer); timer = null }
  }

  const waitFor = (ms) => new Promise((resolve) => {
    if (ms <= 0) { resolve(); return }
    setTimer(resolve, ms)
  })

  const arm = () => {
    if (disposed || fatalError !== null || latest === null || inFlight !== null) return
    clear()
    const t = now()
    const remainingMax = Math.max(0, firstPendingAt + maxWaitMs - t)
    const minWait = Math.max(0, minIntervalMs - (t - lastWriteAt))
    let delay = Math.max(debounceMs, minWait)
    if (remainingMax <= 0) delay = minWait
    else delay = Math.min(delay, remainingMax)
    timer = setTimer(() => {
      timer = null
      void run()
    }, Math.max(0, delay))
  }

  const raceTimeout = async (promise) => {
    if (writeTimeoutMs <= 0) return promise
    let id = null
    const timeout = new Promise((_, reject) => {
      id = setTimer(() => reject(Object.assign(new Error('preview write timeout'), { timeout: true })), writeTimeoutMs)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (id !== null) clearTimer(id)
    }
  }

  const run = async () => {
    if (disposed || fatalError !== null || inFlight !== null || latest === null) return
    const t = now()
    if (t - lastWriteAt < minIntervalMs) { arm(); return }
    const item = latest
    latest = null
    firstPendingAt = null
    lastWriteAt = t
    const operation = Promise.resolve().then(async () => {
      if (disposed) return undefined
      return write(item.value, item.seq)
    })
    inFlight = operation
    try {
      await raceTimeout(operation)
      lastError = null
    } catch (error) {
      lastError = error
      if (error?.timeout === true) fatalError = error
      if (!disposed) {
        try { onError(error) } catch { /* onError must not escape */ }
      }
    } finally {
      if (fatalError !== null) {
        // Keep the slot occupied until the transport settles, so no newer write
        // can start and be overwritten by this late commit.
        operation.finally(() => {
          if (inFlight === operation) inFlight = null
        }).catch(() => {})
        return
      }
      if (inFlight === operation) inFlight = null
      if (!disposed && latest !== null) {
        if (firstPendingAt === null) firstPendingAt = now()
        arm()
      }
    }
  }

  return {
    submit(value) {
      if (disposed || fatalError !== null) return false
      sequence += 1
      latest = { value, seq: sequence }
      if (firstPendingAt === null) firstPendingAt = now()
      if (inFlight === null) arm()
      return true
    },
    async flush() {
      if (disposed) return
      clear()
      let error = null
      while (!disposed) {
        if (fatalError !== null) { error = fatalError; break }
        if (inFlight !== null) {
          let timeoutId = null
          const settled = await Promise.race([
            inFlight.then(() => ({ ok: true }), (caught) => ({ error: caught })),
            new Promise((resolve) => {
              timeoutId = setTimer(() => resolve({ timeout: true }), writeTimeoutMs)
            }),
          ])
          if (timeoutId !== null) clearTimer(timeoutId)
          if (settled.timeout === true) {
            const timeout = Object.assign(new Error('preview write timeout'), { timeout: true })
            fatalError = timeout
            lastError = timeout
            error = timeout
            break
          }
          if (settled.error) error = settled.error
          continue
        }
        const wait = Math.max(0, minIntervalMs - (now() - lastWriteAt))
        if (wait > 0) await waitFor(wait)
        await run()
        if (fatalError !== null) { error = fatalError; break }
        if (latest === null && inFlight === null) break
      }
      if (error !== null || lastError !== null) throw error ?? lastError
    },
    dispose() {
      disposed = true
      clear()
      latest = null
      firstPendingAt = null
    },
    snapshot() {
      return {
        disposed,
        pending: latest !== null,
        inFlight: inFlight !== null,
        failed: fatalError !== null,
        sequence,
        lastWriteAt,
        lastError,
        debounceMs,
        maxWaitMs,
        minIntervalMs,
      }
    },
  }
}
