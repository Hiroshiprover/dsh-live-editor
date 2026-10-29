/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')
const CLIENT = path.join(REPO, 'prototypes/phase2/src/client.cjs')
const RESOLVER = path.join(REPO, 'prototypes/phase2/src/state/link-resolver.cjs')
const req = createRequire(CLIENT)

const { EditorState } = await import(pathToFileURL(req.resolve('@codemirror/state')).href)
const { markdown } = await import(pathToFileURL(req.resolve('@codemirror/lang-markdown')).href)
const { findMathRanges, findOpaqueRanges, findLinkAt, resolveLinkTarget } = req(RESOLVER)

function stateFor(text) {
  return EditorState.create({ doc: text, extensions: [markdown()] })
}

function at(text, marker = '[') {
  return text.indexOf(marker)
}

function linkAt(text, marker = '[') {
  const position = at(text, marker)
  assert.ok(position >= 0, `marker ${marker} must exist`)
  return findLinkAt(stateFor(text), position + 1)
}

test('finds an inline link with title and an autolink', () => {
  assert.deepEqual(linkAt('[rel](../foo.mdx#x)'), {
    target: '../foo.mdx#x', node: 'Link', from: 0, to: 19,
  })
  assert.equal(linkAt('[title](y "t")').target, 'y')
  assert.equal(linkAt('<https://x>', '<').target, 'https://x')
})

test('rejects images, no-target brackets, footnotes and undefined references', () => {
  assert.equal(linkAt('![img](a.png)', '['), null)
  assert.equal(linkAt('[^1]'), null)
  assert.equal(linkAt('[plain]'), null)
  assert.equal(linkAt('[x][missing]'), null)
  const noTarget = stateFor('[plain]')
  assert.equal(findLinkAt(noTarget, 1), null)
})

test('resolves reference links, including collapsed labels', () => {
  assert.equal(linkAt('[ref][r]\n\n[r]: ../bar.mdx')?.target, '../bar.mdx')
  assert.equal(linkAt('[ref2][]\n\n[ref2]: <../baz.mdx>')?.target, '../baz.mdx')
})

test('rejects links in inline code, fenced code, math, comments and JSX tags', () => {
  assert.equal(linkAt('`[x](y)`', '['), null)
  assert.equal(linkAt('```\n[x](y)\n```', '['), null)
  assert.equal(linkAt('$$ [x](y) $$'), null)
  assert.equal(linkAt('$$\n[x](y)\n$$', '['), null)
  assert.equal(linkAt('$[x](y)$'), null)
  assert.equal(linkAt('\\[ [x](y) \\]', '['), null)
  assert.equal(linkAt('{/* [x](y) */}', '['), null)
  assert.equal(linkAt('<a href="[x](y)">z</a>', '['), null)
})

test('math ranges cover both display and inline formulas', () => {
  assert.deepEqual(findMathRanges('$$ [x](y) $$'), [[0, 12]])
  assert.deepEqual(findMathRanges('$[x](y)$'), [[0, 8]])
  assert.deepEqual(findMathRanges('\\[ [x](y) \\]'), [[0, 12]])
  assert.deepEqual(findMathRanges('`$ no $`'), [])
  assert.deepEqual(findOpaqueRanges('`[x](y)`').length, 1)
})

test('resolves relative paths, index docs, permalinks, anchors and query/hash', () => {
  const docs = [
    { path: 'ASM/Chapter7/a.mdx', docId: 'ASM/Chapter7/a', permalink: '/docs/ASM/chapter-7/a/' },
    { path: 'ASM/Chapter6/index.mdx', docId: 'ASM/Chapter6/index', permalink: '/docs/ASM/chapter-6/' },
    { path: '01-intro.mdx', docId: 'intro', permalink: '/docs/intro/' },
    { path: 'amb/foo.mdx', docId: 'amb/foo', permalink: '/docs/amb/foo/' },
    { path: 'amb/foo.md', docId: 'amb/foo-md', permalink: '/docs/amb/foo-md/' },
  ]
  const byPath = new Map(docs.map((entry) => [entry.path, entry]))
  const byPermalink = new Map(docs.map((entry) => {
    const trimmed = entry.permalink.replace(/\/+$/, '')
    return [trimmed === '' ? '/' : `${trimmed}/`, entry]
  }))
  const index = { docByPath: byPath, docByPermalink: byPermalink }

  assert.deepEqual(
    resolveLinkTarget('../Chapter6/index.mdx?x=1#section', 'ASM/Chapter7/a.mdx', index),
    { kind: 'doc', path: 'ASM/Chapter6/index.mdx', anchor: 'section' },
  )
  assert.deepEqual(
    resolveLinkTarget('../Chapter6#sec', 'ASM/Chapter7/a.mdx', index),
    { kind: 'doc', path: 'ASM/Chapter6/index.mdx', anchor: 'sec' },
  )
  assert.deepEqual(resolveLinkTarget('/docs/ASM/chapter-6/#x', 'ASM/Chapter7/a.mdx', index), {
    kind: 'doc', path: 'ASM/Chapter6/index.mdx', anchor: 'x',
  })
  assert.deepEqual(resolveLinkTarget('#local', 'ASM/Chapter7/a.mdx', index), {
    kind: 'doc', path: 'ASM/Chapter7/a.mdx', anchor: 'local',
  })
  assert.equal(resolveLinkTarget('https://example.com', '01-intro.mdx', index).kind, 'skip')
  assert.equal(resolveLinkTarget('/blog/post/', '01-intro.mdx', index).kind, 'skip')
  assert.equal(resolveLinkTarget('img/a.png', '01-intro.mdx', index).kind, 'skip')
  assert.equal(resolveLinkTarget('missing.mdx', '01-intro.mdx', index).kind, 'unmapped')
  assert.deepEqual(resolveLinkTarget('amb/foo', 'other.md', index), {
    kind: 'ambiguous',
    paths: ['amb/foo.mdx', 'amb/foo.md'],
    anchor: '',
  })
})
