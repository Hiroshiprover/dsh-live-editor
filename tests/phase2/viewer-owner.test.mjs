/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Each test file runs in its own process; import a fresh module instance.
const MODULE = path.resolve(import.meta.dirname, '../../prototypes/phase2/src/state/viewer-owner.mjs')
const { acquireViewer, releaseViewer, isViewerActive, currentViewerOwner } = await import(pathToFileURL(MODULE).href)

test('one document may hold only one viewer owner', () => {
  const first = acquireViewer('body-a:viewer')
  assert.equal(first, 'body-a:viewer')
  assert.equal(isViewerActive(), true)
  assert.equal(currentViewerOwner(), 'body-a:viewer')
  // A second Live Editor body must not acquire while the first owns it.
  assert.equal(acquireViewer('body-b:viewer'), null)
  assert.equal(currentViewerOwner(), 'body-a:viewer')
})

test('only the current owner can release; other bodies cannot clear it', () => {
  assert.equal(releaseViewer('body-b:viewer'), undefined)
  assert.equal(isViewerActive(), true)
  releaseViewer('body-a:viewer')
  assert.equal(isViewerActive(), false)
  assert.equal(currentViewerOwner(), null)
})

test('released owner can be re-acquired and invalid ids are rejected', () => {
  assert.equal(acquireViewer(''), null)
  assert.equal(acquireViewer(null), null)
  assert.equal(isViewerActive(), false)
  assert.equal(acquireViewer('body-b:viewer'), 'body-b:viewer')
  assert.equal(acquireViewer('body-c:viewer'), null)
  releaseViewer('body-b:viewer')
  assert.equal(acquireViewer('body-c:viewer'), 'body-c:viewer')
  releaseViewer('body-c:viewer')
})
