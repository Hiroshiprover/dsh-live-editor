/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const MODULE = path.resolve(import.meta.dirname, '../../prototypes/phase2/site/r2-watch.mjs')
const { filterStagingWatchPaths } = await import(pathToFileURL(MODULE).href)

const paths = [
  '/site/.dsh-live-editor/preview-docs/**/*.{md,mdx}',
  '/site/.dsh-live-editor/preview-docs/**/_category_.json',
  '/site/.dsh-live-editor/preview-docs/**/tags.yml',
]

test('body MDX glob is removed; category/tag paths remain', () => {
  const out = filterStagingWatchPaths(paths)
  assert.deepEqual(out, [
    '/site/.dsh-live-editor/preview-docs/**/_category_.json',
    '/site/.dsh-live-editor/preview-docs/**/tags.yml',
  ])
})

test('sentinel path is appended only when the gate requires it', () => {
  const sentinel = '/site/.dsh-live-editor/.dsh-r2-sentinel.json'
  assert.deepEqual(filterStagingWatchPaths(paths, { watchSentinel: false, sentinelPath: sentinel }), filterStagingWatchPaths(paths))
  const out = filterStagingWatchPaths(paths, { watchSentinel: true, sentinelPath: sentinel })
  assert.equal(out.at(-1), sentinel)
  assert.equal(out.includes('/site/.dsh-live-editor/preview-docs/**/*.{md,mdx}'), false)
})

test('invalid watcher output fails closed', () => {
  assert.throws(() => filterStagingWatchPaths(null), /must return an array/)
})
