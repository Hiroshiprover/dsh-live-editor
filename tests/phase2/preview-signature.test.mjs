/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const MODULE = path.resolve(import.meta.dirname, '../../plugins/dsh-live-editor/src/preview-signature.mjs')
const { previewContentSignature } = await import(pathToFileURL(MODULE).href)

const base = {
  docs: [{ id: 'a', title: 'About', permalink: '/docs/a/', frontMatter: { title: 'About' } }],
  sidebars: { defaultSidebar: [{ type: 'doc', id: 'a' }] },
}

test('preview signature changes when staged title changes', () => {
  const next = {
    ...base,
    docs: [{ ...base.docs[0], title: 'About test', frontMatter: { title: 'About test' } }],
  }
  assert.notEqual(previewContentSignature(base), previewContentSignature(next))
})

test('preview signature is stable when only generatedAt changes', () => {
  const withStamp = { ...base, sidebars: { ...base.sidebars, generatedAt: '2026-10-25T00:00:00.000Z' } }
  const withAnotherStamp = { ...base, sidebars: { ...base.sidebars, generatedAt: '2026-10-25T00:01:00.000Z' } }
  assert.equal(previewContentSignature(withStamp), previewContentSignature(withAnotherStamp))
})

test('preview signature changes when the staged sidebar changes', () => {
  const next = { ...base, sidebars: { defaultSidebar: [{ type: 'doc', id: 'a', label: 'Renamed' }] } }
  assert.notEqual(previewContentSignature(base), previewContentSignature(next))
})
