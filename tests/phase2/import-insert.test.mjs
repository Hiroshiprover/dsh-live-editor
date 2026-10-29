/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MODULE = path.resolve(import.meta.dirname, '../../prototypes/phase2/src/state/import-insert.mjs')
const SAFETY = path.resolve(import.meta.dirname, '../../prototypes/phase2/dsh-bundle/lib/mdx-safety.mjs')
const { buildImportInsertion, endsInOpenFence } = await import(pathToFileURL(MODULE).href)
const { validateGeneratedMdx } = await import(pathToFileURL(SAFETY).href)
const { markdownLanguage } = await import(pathToFileURL(path.resolve(
  import.meta.dirname,
  '../../prototypes/phase2/node_modules/@codemirror/lang-markdown/dist/index.js',
)).href)

test('import insertion appends a separate block, not into a list item', () => {
  const current = '# Note\n\n3. 高等统计物理'
  const result = buildImportInsertion(current, '③ Schrödinger equation\n$$x$$')
  assert.equal(result.at, current.length)
  assert.equal(result.insertion.startsWith('\n\n'), true)
  assert.equal(result.insertion.endsWith('\n'), true)
  assert.equal(`${current}${result.insertion}`.includes('高等统计物理③'), false)
})

test('import insertion normalizes blank lines at the document end', () => {
  assert.equal(buildImportInsertion('x', 'd').insertion, '\n\nd\n')
  assert.equal(buildImportInsertion('x\n', 'd').insertion, '\nd\n')
  assert.equal(buildImportInsertion('x\n\n', 'd').insertion, 'd\n')
  assert.equal(buildImportInsertion('', 'd').insertion, 'd\n')
})

test('empty drafts are rejected', () => {
  assert.equal(buildImportInsertion('x', ''), null)
  assert.equal(buildImportInsertion('x', '   \n'), null)
  assert.equal(buildImportInsertion(null, 'd'), null)
})

test('E3: an unclosed fence at EOF is detected for backticks, tildes and nesting', () => {
  const open = [
    '```',
    '```\n',
    '```js\nconst x = 1\n',
    '````\ncode\n',
    '~~~\ncode\n',
    '~~~js\ncode\n',
    '> ```js\n> const x = 1\n',
    '- item\n  ```js\n  const x=1\n',
    'text\n\n```\ncode\n\n',
  ]
  for (const doc of open) {
    const tree = markdownLanguage.parser.parse(doc)
    assert.equal(endsInOpenFence(tree, doc.length), true, JSON.stringify(doc))
  }
})

test('E3: a code-block draft that passes standalone validation is still blocked in an open fence', () => {
  const current = '```js\nconst x = 1\n'
  const draft = '```\n{globalThis.__DSH_E3_FENCE__=1}\n```'
  assert.equal(validateGeneratedMdx(draft).ok, true)
  const tree = markdownLanguage.parser.parse(current)
  assert.equal(endsInOpenFence(tree, current.length), true)
})

test('E3: closed fences, including different lengths and nested containers, are safe', () => {
  const closed = [
    '```\n```\n',
    '```js\nconst x = 1\n```\n',
    '````\ncode\n```\n````\n',
    '~~~\ncode\n~~~\n',
    '~~~~\ncode\n~~~\n~~~~\n',
    '> ```js\n> const x = 1\n> ```\n',
    '- item\n  ```js\n  const x=1\n  ```\n',
    '```\ncode\n```\n\n',
    'plain paragraph\n',
    '',
  ]
  for (const doc of closed) {
    const tree = markdownLanguage.parser.parse(doc)
    assert.equal(endsInOpenFence(tree, doc.length), false, JSON.stringify(doc))
  }
})

test('E3: fence detection fails closed when the tree is absent or incomplete', () => {
  assert.equal(endsInOpenFence(null, 10), true)
  assert.equal(endsInOpenFence(markdownLanguage.parser.parse('plain'), 6), true)
  assert.equal(endsInOpenFence(markdownLanguage.parser.parse('plain'), 0), false)
})
