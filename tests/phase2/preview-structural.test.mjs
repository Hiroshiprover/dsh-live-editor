/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'

const MODULE = path.resolve(import.meta.dirname, '../../prototypes/phase2/dsh-bundle/lib/preview.mjs')
const { hasStructuralPreviewChange, structuralFrontMatter, r2SentinelTarget, renderR2Sentinel } = await import(pathToFileURL(MODULE).href)
const { publishSentinelFile } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../prototypes/phase2/dsh-bundle/lib/index.js')).href)

const doc = (fm, body = 'Body') => `---\n${fm}\n---\n\n${body}\n`

test('body-only edits are not structural', () => {
  const a = doc('title: T\nsidebar_position: 1', 'A')
  const b = doc('title: T\nsidebar_position: 1', 'B')
  assert.equal(hasStructuralPreviewChange(a, b), false)
})

test('frontmatter changes are structural', () => {
  const a = doc('title: T\nsidebar_position: 1')
  const b = doc('title: T\nsidebar_position: 2')
  assert.equal(hasStructuralPreviewChange(a, b), true)
  assert.equal(hasStructuralPreviewChange(a, doc('slug: /new')), true)
  assert.equal(hasStructuralPreviewChange(a, doc('tags: [a, b]')), true)
})

test('preview-only metadata changes are ignored', () => {
  const a = doc('title: T\ndsh_preview_session: "one"\ndsh_preview_revision: 1')
  const b = doc('title: T\ndsh_preview_session: "two"\ndsh_preview_revision: 9')
  assert.equal(hasStructuralPreviewChange(a, b), false)
  assert.equal(structuralFrontMatter(a), 'title: T')
})

test('first write and missing frontmatter are safe', () => {
  assert.equal(hasStructuralPreviewChange(null, doc('title: T')), false)
  assert.equal(hasStructuralPreviewChange('', ''), false)
  assert.equal(hasStructuralPreviewChange(doc('title: T'), '# Body only'), true)
})


test('sentinel payload is staging-side metadata only', () => {
  const target = r2SentinelTarget('/site/.dsh-live-editor/preview-docs')
  assert.equal(target, '/site/.dsh-live-editor/.dsh-r2-sentinel.json')
  const text = renderR2Sentinel({ source: 'docs/a.mdx', session: 's', revision: 3, writeId: 'w-3' })
  const data = JSON.parse(text)
  assert.equal(data.source, 'docs/a.mdx')
  assert.equal(data.revision, 3)
  assert.equal(data.writeId, 'w-3')
  assert.equal(data.structural, true)
})


test('overlapping sentinel publications are serialized and use unique temp files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sentinel-'))
  const target = path.join(dir, 'sentinel.json')
  try {
    await Promise.all([
      publishSentinelFile(target, '{"n":1}\n'),
      publishSentinelFile(target, '{"n":2}\n'),
    ])
    assert.equal(await fs.readFile(target, 'utf8'), '{"n":2}\n')
    const entries = await fs.readdir(dir)
    assert.deepEqual(entries.sort(), ['sentinel.json'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})


test('H1 fallback title is structural only when frontmatter has no title', () => {
  const noTitleA = '# Alpha\n\nBody A\n'
  const noTitleB = '# Beta\n\nBody A\n'
  assert.equal(hasStructuralPreviewChange(noTitleA, noTitleB), true)
  const titledA = '---\ntitle: Fixed\n---\n\n# Alpha\n'
  const titledB = '---\ntitle: Fixed\n---\n\n# Beta\n'
  assert.equal(hasStructuralPreviewChange(titledA, titledB), false)
})

test('setext H1 fallback title is structural when frontmatter has no title', () => {
  const setextA = 'Alpha\n=====\n\nBody\n'
  const setextB = 'Beta\n=====\n\nBody\n'
  assert.equal(hasStructuralPreviewChange(setextA, setextB), true)
  const titledA = '---\ntitle: Fixed\n---\n\nAlpha\n=====\n'
  const titledB = '---\ntitle: Fixed\n---\n\nBeta\n=====\n'
  assert.equal(hasStructuralPreviewChange(titledA, titledB), false)
})
