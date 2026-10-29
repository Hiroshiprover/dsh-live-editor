/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Coordinated R2 capability contract.
 *
 * All formal capabilities are derived from one gate. Incomplete combinations
 * fail closed: a client runtime that requests only some R2 capabilities must not
 * activate channel/watcher/sentinel/scheduler independently.
 *
 * `activationReady` is intentionally hardcoded false in the current baseline.
 */
export const R2_GATE_ENV = 'DSH_LIVE_EDITOR_R2_SHADOW'
export const R2_A2_EXPERIMENT_ENV = 'DSH_LIVE_EDITOR_A2_EXPERIMENT'
export const R2_SENTINEL_ENV = 'DSH_LIVE_EDITOR_R2_SENTINEL'
export const R2_DIAG_WATCH_ENV = 'DSH_DIAG_SUPPRESS_DOCS_WATCH'
export const R2_DIAG_SENTINEL_ENV = 'DSH_DIAG_R2_SENTINEL'

export function resolveR2Gate(env = process.env, runtime = globalThis) {
  const requested = env?.[R2_GATE_ENV] === '1'
  // Dev-only A2 experiment (body HMR + DOM-confirmed ack). It is deliberately
  // separate from the formal R2 gate: `active` stays false, `activationReady`
  // stays false, and only the preview transport/watch pieces are enabled.
  const experiment = env?.[R2_A2_EXPERIMENT_ENV] === '1'
  const activationReady = false
  const client = runtime?.__DSH_LIVE_EDITOR_R2__
  const clientRequested = client !== undefined && (
    client?.active === true || client?.scheduler === true || client?.sentinel === true
  )
  const active = requested && activationReady
  const experimentActive = experiment && !active
  const failClosed = clientRequested && !active && !experimentActive
  const diagnosticWatch = env?.[R2_DIAG_WATCH_ENV] === '1'
  const diagnosticSentinel = env?.[R2_DIAG_SENTINEL_ENV] === '1'
  return Object.freeze({
    mode: active ? 'active' : (experimentActive ? 'experiment' : (requested ? 'requested-shadow' : 'off')),
    requested,
    experiment: experimentActive,
    activationReady,
    active,
    channel: active || experimentActive,
    scheduler: active,
    watcherFilter: active || experimentActive,
    sentinel: active || experimentActive,
    debounceMs: active ? 150 : 250,
    requestedDebounceMs: requested ? 150 : 250,
    failClosed,
    diagnostic: Object.freeze({ watcher: diagnosticWatch, sentinel: diagnosticSentinel }),
  })
}


export function shouldRestartForStructural(runtime, response) {
  const client = runtime?.__DSH_LIVE_EDITOR_R2__
  return client?.active === true && client?.sentinel === true && response?.structural === true
}
