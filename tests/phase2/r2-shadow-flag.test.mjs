/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const MODULE = path.resolve(import.meta.dirname, '../../plugins/dsh-live-editor/src/r2-shadow/flag.mjs')
const { readR2ShadowConfig, R2_SHADOW_ENV } = await import(pathToFileURL(MODULE).href)
const GATE = path.resolve(import.meta.dirname, '../../plugins/dsh-live-editor/src/r2-shadow/gate.mjs')
const { resolveR2Gate, shouldRestartForStructural, R2_A2_EXPERIMENT_ENV } = await import(pathToFileURL(GATE).href)

test('R2 shadow is inert by default', () => {
  const config = readR2ShadowConfig({})
  assert.equal(config.enabled, false)
  assert.equal(config.active, false)
  assert.equal(config.channel, false)
  assert.equal(config.watcherFilter, false)
  assert.equal(config.sentinel, false)
  assert.equal(config.debounceMs, 250)
})

test('R2 shadow request does not activate during the inert scaffold', () => {
  const config = readR2ShadowConfig({ [R2_SHADOW_ENV]: '1' })
  assert.equal(config.enabled, true)
  assert.equal(config.activationReady, false)
  assert.equal(config.active, false)
  assert.equal(config.channel, false, 'channel, watcher filter and sentinel stay disabled together')
  assert.equal(config.watcherFilter, false)
  assert.equal(config.sentinel, false)
  assert.equal(config.debounceMs, 250, 'formal client must stay at 250ms while inactive')
  assert.equal(config.requestedDebounceMs, 150, 'shadow request is diagnostic only')
})

test('R2 shadow flag is opt-in and JSON-safe', () => {
  const config = readR2ShadowConfig({ [R2_SHADOW_ENV]: '0' })
  assert.equal(config.enabled, false)
  assert.equal(config.active, false)
  assert.doesNotThrow(() => JSON.stringify(config))
})


test('coordinated gate fails closed for incomplete client requests', () => {
  assert.equal(resolveR2Gate({}, {}).mode, 'off')
  assert.equal(resolveR2Gate({}, {}).failClosed, false)
  const requested = resolveR2Gate({ [R2_SHADOW_ENV]: '1' }, {})
  assert.equal(requested.mode, 'requested-shadow')
  assert.equal(requested.active, false)
  assert.equal(requested.debounceMs, 250)
  assert.equal(requested.requestedDebounceMs, 150)
  assert.equal(resolveR2Gate({}, { __DSH_LIVE_EDITOR_R2__: { active: true } }).failClosed, true)
  assert.equal(resolveR2Gate({ [R2_SHADOW_ENV]: '1' }, { __DSH_LIVE_EDITOR_R2__: { scheduler: true } }).failClosed, true)
  assert.equal(resolveR2Gate({ [R2_SHADOW_ENV]: '1' }, { __DSH_LIVE_EDITOR_R2__: { sentinel: true } }).failClosed, true)
})

test('A2 experiment enables channnel/watch but not formal R2, scheduler or 250ms', () => {
  const gate = resolveR2Gate({ [R2_A2_EXPERIMENT_ENV]: '1' }, {})
  assert.equal(gate.mode, 'experiment')
  assert.equal(gate.active, false)
  assert.equal(gate.activationReady, false)
  assert.equal(gate.experiment, true)
  assert.equal(gate.channel, true)
  assert.equal(gate.watcherFilter, true)
  assert.equal(gate.sentinel, true)
  assert.equal(gate.scheduler, false)
  assert.equal(gate.debounceMs, 250)
})

test('diagnostic environments do not activate formal capabilities', () => {
  const gate = resolveR2Gate({ DSH_DIAG_SUPPRESS_DOCS_WATCH: '1', DSH_DIAG_R2_SENTINEL: '1' }, {})
  assert.equal(gate.active, false)
  assert.equal(gate.channel, false)
  assert.equal(gate.watcherFilter, false)
  assert.equal(gate.sentinel, false)
  assert.equal(gate.diagnostic.watcher, true)
  assert.equal(gate.diagnostic.sentinel, true)
})


test('structural restart requires both active and sentinel gates', () => {
  assert.equal(shouldRestartForStructural({}, { structural: true }), false)
  assert.equal(shouldRestartForStructural({ __DSH_LIVE_EDITOR_R2__: { active: true } }, { structural: true }), false)
  assert.equal(shouldRestartForStructural({ __DSH_LIVE_EDITOR_R2__: { sentinel: true } }, { structural: true }), false)
  assert.equal(shouldRestartForStructural({ __DSH_LIVE_EDITOR_R2__: { active: true, sentinel: true } }, { structural: false }), false)
  assert.equal(shouldRestartForStructural({ __DSH_LIVE_EDITOR_R2__: { active: true, sentinel: true } }, { structural: true }), true)
})
