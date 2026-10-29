/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * R2 shadow feature gate (default off).
 *
 * This module is intentionally inert until the command-lifecycle and scheduler
 * gates pass. `enabled` records the requested experiment flag, while `active`
 * is the only value that may enable channel/watcher/sentinel behavior. Keeping
 * a single gate object prevents a partial rollout (for example watcher filter
 * on but sentinel or channel off).
 */
import { resolveR2Gate, R2_GATE_ENV } from './gate.mjs'

export const R2_SHADOW_ENV = R2_GATE_ENV

export function readR2ShadowConfig(env = process.env, runtime = globalThis) {
  const gate = resolveR2Gate(env, runtime)
  return Object.freeze({
    enabled: gate.requested,
    activationReady: gate.activationReady,
    active: gate.active,
    channel: gate.channel,
    scheduler: gate.scheduler,
    watcherFilter: gate.watcherFilter,
    sentinel: gate.sentinel,
    // Formal behavior is 250ms until the whole R2 path is activation-ready.
    debounceMs: gate.debounceMs,
    requestedDebounceMs: gate.requestedDebounceMs,
    failClosed: gate.failClosed,
    mode: gate.mode,
  })
}
