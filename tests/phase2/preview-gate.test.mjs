/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const GATE = path.resolve(import.meta.dirname, '../../prototypes/phase2/src/state/preview-gate.mjs')
const { decidePreviewWrite } = await import(pathToFileURL(GATE).href)

const base = {
  previewReady: true,
  schedulerEnabled: false,
  loadPhase: 'ready',
  text: '# doc\n',
  currentSession: null,
  currentText: null,
}

test('doc ready before the preview handshake waits, then writes once ready flips', () => {
  // Regression: the old effect returned early and never re-ran after readiness
  // flipped, leaving the pane on the previous staging frame.
  assert.equal(decidePreviewWrite({ ...base, previewReady: false }), 'wait')
  assert.equal(decidePreviewWrite({ ...base, previewReady: true }), 'write')
})

test('an already-written text in the same session is not submitted twice', () => {
  assert.equal(decidePreviewWrite({
    ...base, currentSession: 'session-a', currentText: '# doc\n',
  }), 'current')
})

test('changed text always writes, even within the same session', () => {
  assert.equal(decidePreviewWrite({
    ...base, text: '# doc changed\n', currentSession: 'session-a', currentText: '# doc\n',
  }), 'write')
})

test('a new session writes the current text even when it equals the last text', () => {
  assert.equal(decidePreviewWrite({
    ...base, currentSession: null, currentText: null,
  }), 'write')
})

test('scheduler mode always submits so A→B→A can replace B', () => {
  assert.equal(decidePreviewWrite({
    ...base, schedulerEnabled: true, currentSession: 'session-a', currentText: '# doc\n',
  }), 'write')
})

test('a document that is not ready yet is never written', () => {
  assert.equal(decidePreviewWrite({ ...base, loadPhase: 'loading' }), 'no-doc')
  assert.equal(decidePreviewWrite({ ...base, text: null }), 'no-doc')
})

test('rollback capability disables preview writes before readiness is considered', () => {
  assert.equal(decidePreviewWrite({ ...base, capability: false }), 'disabled')
  assert.equal(decidePreviewWrite({ ...base, previewReady: false, capability: false }), 'disabled')
  assert.equal(decidePreviewWrite({ ...base, capability: true }), 'write')
})
