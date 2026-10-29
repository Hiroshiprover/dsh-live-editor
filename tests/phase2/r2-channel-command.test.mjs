/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const MODULE = path.resolve(import.meta.dirname, '../../plugins/dsh-live-editor/src/r2-shadow/channel.js')
const { isValidR2Command, readR2Marker, R2_SOURCE, R2_VERSION } = await import(pathToFileURL(MODULE).href)

const valid = {
  type: 'r2-command', source: R2_SOURCE, v: R2_VERSION,
  commandId: 'cmd-1', revision: 7, writeId: 'w-7', session: 's-1',
  docId: 'doc-a', route: '/__live-preview/a', bootId: 'boot-1', generation: 1, writeAt: Date.now(),
}

test('child accepts a complete command and rejects incomplete/unsafe commands', () => {
  assert.equal(isValidR2Command(valid), true)
  assert.equal(isValidR2Command({ ...valid, writeId: '' }), false)
  assert.equal(isValidR2Command({ ...valid, writeId: 'bad id' }), false)
  assert.equal(isValidR2Command({ ...valid, revision: 0 }), false)
  assert.equal(isValidR2Command({ ...valid, session: '' }), false)
  assert.equal(isValidR2Command({ ...valid, route: 'docs/a' }), false)
  assert.equal(isValidR2Command({ ...valid, source: 'other' }), false)
})

test('child reads write identity and revision from the rendered markers only', () => {
  const fake = (attrs) => ({
    querySelector: (selector) => {
      if (selector === '#dsh-r2-write-id') return attrs.writeId === undefined ? null : { textContent: attrs.writeId }
      if (selector === '#dsh-r2-revision') return attrs.revision === undefined ? null : { textContent: attrs.revision }
      return null
    },
  })
  assert.deepEqual(readR2Marker(fake({ writeId: 'w-7', revision: ' 7 ' })), { writeId: 'w-7', revision: 7 })
  assert.deepEqual(readR2Marker(fake({})), { writeId: null, revision: null })
  assert.deepEqual(readR2Marker(fake({ writeId: 'w-7', revision: 'not-a-revision' })), { writeId: 'w-7', revision: null })
})
