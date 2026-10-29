/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const MODULE = path.resolve(import.meta.dirname, '../../prototypes/phase2/dsh-bundle/lib/preview.mjs')
const { injectR2Markers, injectPreviewMeta } = await import(pathToFileURL(MODULE).href)

test('R2 markers carry the rendered write identity and revision', () => {
  const text = injectR2Markers('# Title\n\nBody\n', { writeId: 'w-1:abc', revision: 7 })
  assert.match(text, /id="dsh-r2-write-id"[^>]*>w-1:abc<\/span>/)
  assert.match(text, /id="dsh-r2-revision"[^>]*>7<\/span>/)
  assert.match(text, /^# Title/)
})

test('R2 markers replace old markers instead of accumulating', () => {
  const first = injectR2Markers('# T\n', { writeId: 'old', revision: 1 })
  const second = injectR2Markers(first, { writeId: 'new', revision: 2 })
  assert.equal((second.match(/id="dsh-r2-write-id"/g) ?? []).length, 1)
  assert.match(second, />new<\/span>/)
  assert.doesNotMatch(second, />old<\/span>/)
})

test('markers are added after preview frontmatter, not inside it', () => {
  const meta = injectPreviewMeta('# T\n', { session: 's', revision: 3 })
  const text = injectR2Markers(meta, { writeId: 'w', revision: 3 })
  assert.match(text, /^---\ndsh_preview_session:/)
  assert.ok(text.indexOf('</span>') > text.indexOf('---\n\n# T'))
})

test('invalid write identity is rejected', () => {
  assert.throws(() => injectR2Markers('# T', { writeId: '', revision: 1 }), /invalid preview writeId/)
  assert.throws(() => injectR2Markers('# T', { writeId: 'bad id', revision: 1 }), /invalid preview writeId/)
})
