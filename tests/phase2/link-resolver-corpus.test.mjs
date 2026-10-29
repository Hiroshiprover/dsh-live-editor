/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Corpus regression for the source link guard.
 *
 * The 32 synthetic docs are the best oracle for the two false-positive classes the
 * overnight study found: 216 Lezer link/image nodes inside math, and 75
 * no-target bracket nodes. The mdast math ranges are test-only; production
 * parsing stays Lezer + the lightweight math scanner.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const REPO = path.resolve(import.meta.dirname, '../..')
const SITE = path.join(REPO, 'prototypes/phase2/site')
const DOCS = path.join(SITE, 'docs')
const req = createRequire(path.join(REPO, 'prototypes/phase2/src/client.cjs'))
const siteReq = createRequire(path.join(SITE, 'package.json'))

const { markdownLanguage } = await import(pathToFileURL(req.resolve('@codemirror/lang-markdown')).href)
const { EditorState } = await import(pathToFileURL(req.resolve('@codemirror/state')).href)
const { markdown } = await import(pathToFileURL(req.resolve('@codemirror/lang-markdown')).href)
const { ensureSyntaxTree } = await import(pathToFileURL(req.resolve('@codemirror/language')).href)
const { findMathRanges, findLinkAt } = req(path.join(REPO, 'prototypes/phase2/src/state/link-resolver.cjs'))
const { fromMarkdown } = await import(pathToFileURL(siteReq.resolve('mdast-util-from-markdown')).href)
const { mathFromMarkdown } = await import(pathToFileURL(siteReq.resolve('mdast-util-math')).href)
const { math } = await import(pathToFileURL(siteReq.resolve('micromark-extension-math')).href)

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(absolute, out)
    else if (/\.mdx?$/.test(entry.name)) out.push(absolute)
  }
  return out
}

function mdastMathRanges(text) {
  const ranges = []
  // MDX would parse <Anchor/> as a JSX tag; CommonMark would start an HTML
  // block and swallow the following math. Equal-length spaces preserve offsets.
  const cleaned = text.replace(/<[^>\n]*>/g, (tag) => ' '.repeat(tag.length))
  let tree
  try {
    tree = fromMarkdown(cleaned, { extensions: [math()], mdastExtensions: [mathFromMarkdown()] })
  } catch {
    return ranges
  }
  const visit = (node) => {
    if (node.type === 'math' || node.type === 'inlineMath') {
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (typeof start === 'number' && typeof end === 'number') ranges.push([start, end])
    }
    if (Array.isArray(node.children)) for (const child of node.children) visit(child)
  }
  visit(tree)
  return ranges
}

function directChild(node, name, source) {
  let child = node.firstChild
  while (child !== null) {
    if (child.name === name) return source.slice(child.from, child.to)
    child = child.nextSibling
  }
  return null
}

test('32 synthetic docs: math, no-target and real links classify correctly', () => {
  const files = walk(DOCS)
  assert.equal(files.length, 32, 'test site should contain the 32 synthetic docs')

  let nodes = 0
  let mathNodes = 0
  let noTargetNodes = 0
  let realLinks = 0
  let images = 0

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const oracle = mdastMathRanges(source)
    const state = EditorState.create({ doc: source, extensions: [markdown()] })
    // EditorState parses lazily by viewport; force the full document for a
    // corpus-level classification test.
    ensureSyntaxTree(state, source.length, 10000)
    const tree = markdownLanguage.parser.parse(source)
    const cursor = tree.cursor()
    do {
      const node = cursor.node
      if (node.name !== 'Link' && node.name !== 'Image' && node.name !== 'Autolink') continue
      nodes += 1
      const position = Math.min(node.from + 1, source.length - 1)
      const result = findLinkAt(state, position)
      const inMath = oracle.some(([start, end]) => node.from >= start && node.from < end)
      const url = directChild(node, 'URL', source)

      if (inMath) {
        mathNodes += 1
        assert.equal(result, null, `${path.relative(SITE, file)}:${node.from} math node must not be clickable`)
        assert.ok(
          findMathRanges(source).some(([start, end]) => node.from >= start && node.from < end),
          `${path.relative(SITE, file)}:${node.from} math scanner missed a link node`,
        )
        continue
      }
      if (node.name === 'Image') {
        images += 1
        assert.equal(result, null, `${path.relative(SITE, file)}:${node.from} image must not be clickable`)
        continue
      }
      if (node.name === 'Link' && url === null) {
        noTargetNodes += 1
        assert.equal(result, null, `${path.relative(SITE, file)}:${node.from} no-target node must be ignored`)
        continue
      }
      realLinks += 1
      assert.ok(result, `${path.relative(SITE, file)}:${node.from} real link should be found`)
    } while (cursor.next())
  }

  // The overnight study measured 216 math nodes and 75 no-target nodes in
  // these exact docs. Keep them as corpus-level regression invariants.
  assert.equal(nodes, 480)
  assert.equal(mathNodes, 216)
  assert.equal(noTargetNodes, 75)
  assert.equal(realLinks + images, 189)
  assert.equal(images, 11)
})
