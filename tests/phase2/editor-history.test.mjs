/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * 9.0D E1: use CodeMirror's official history extension/keymap; a programmatic
 * insert (image/AI) is its own undo step, not merged with preceding typing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CLIENT = path.join(ROOT, 'prototypes/phase2/src/client.cjs')
// Resolve through the Phase 2 source tree, where its node_modules live.
const phaseRequire = createRequire(CLIENT)
const { EditorState, Transaction } = phaseRequire('@codemirror/state')
const { history, historyKeymap, isolateHistory, undo, redo } = phaseRequire('@codemirror/commands')

test('E1: official history supports undo and redo', () => {
  let state = EditorState.create({ doc: 'A', extensions: [history()] })
  const dispatch = (tr) => { state = tr.state }
  state = state.update({
    changes: { from: 1, insert: 'B' },
    annotations: Transaction.userEvent.of('input.type'),
  }).state
  assert.equal(state.doc.toString(), 'AB')
  undo({ state, dispatch })
  assert.equal(state.doc.toString(), 'A')
  redo({ state, dispatch })
  assert.equal(state.doc.toString(), 'AB')
  assert.ok(historyKeymap.some((binding) => binding.key === 'Mod-z'))
})

test('E1: an isolated programmatic insert is one undo step', () => {
  let state = EditorState.create({ doc: 'X', extensions: [history()] })
  const dispatch = (tr) => { state = tr.state }
  state = state.update({
    changes: { from: 1, insert: 'Y' },
    annotations: Transaction.userEvent.of('input.type'),
  }).state
  state = state.update({
    changes: { from: 2, insert: 'Z' },
    annotations: isolateHistory.of('full'),
  }).state
  assert.equal(state.doc.toString(), 'XYZ')
  undo({ state, dispatch })
  assert.equal(state.doc.toString(), 'XY')
  undo({ state, dispatch })
  assert.equal(state.doc.toString(), 'X')
})

test('E1: client wires history, keymap, per-document state and isolated insert', async () => {
  const source = await fs.readFile(CLIENT, 'utf8')
  assert.match(source, /require\('@codemirror\/commands'\)/)
  assert.match(source, /historyKeymap/)
  assert.match(source, /\bhistory\(\)/)
  assert.match(source, /editorStates/)
  assert.match(source, /isolateHistory\.of\('full'\)/)
})
