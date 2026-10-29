/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const MODULE = path.resolve(import.meta.dirname, '../../prototypes/phase2/src/state/structural-sync.mjs')
const { decideStructuralSync } = await import(pathToFileURL(MODULE).href)

test('structural sync is inert without a captured signature', () => {
  assert.equal(decideStructuralSync({ pendingSignature: null, observedSignature: 's2', attempts: 0 }), 'none')
  assert.equal(decideStructuralSync({ pendingSignature: '', observedSignature: 's2', attempts: 0 }), 'none')
})

test('structural sync clears only after the staged content signature changes', () => {
  assert.equal(decideStructuralSync({ pendingSignature: 's1', observedSignature: 's1', attempts: 0 }), 'retry')
  assert.equal(decideStructuralSync({ pendingSignature: 's1', observedSignature: 's2', attempts: 0 }), 'synced')
  assert.equal(decideStructuralSync({ pendingSignature: 's1', observedSignature: null, attempts: 1 }), 'retry')
})

test('structural sync retries are bounded', () => {
  assert.equal(decideStructuralSync({ pendingSignature: 's1', observedSignature: 's1', attempts: 2, maxAttempts: 3 }), 'retry')
  assert.equal(decideStructuralSync({ pendingSignature: 's1', observedSignature: 's1', attempts: 3, maxAttempts: 3 }), 'gave-up')
  assert.equal(decideStructuralSync({ pendingSignature: 's1', observedSignature: 's1', attempts: -1, maxAttempts: 3 }), 'gave-up')
})
