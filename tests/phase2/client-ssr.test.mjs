/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Phase 2B — tab body render smoke (SSR, no browser).
 *
 * Catches hook-order / initial-render errors (blank tab class of bugs) before
 * the bundle is installed. Effects (index fetch, editor mount) are not run.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Module from 'node:module'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')
const CLIENT = path.join(REPO, 'prototypes/phase2/src/client.cjs')

// React lives in the site's node_modules (it is external in the DSH bundle),
// while CodeMirror/esbuild live in the phase1a prototype node_modules.
process.env.NODE_PATH = [
  path.join(REPO, 'prototypes/phase1a/node_modules'),
  path.join(REPO, 'prototypes/phase2/site/node_modules'),
  process.env.NODE_PATH ?? '',
].filter(Boolean).join(path.delimiter)
Module._initPaths()

globalThis.localStorage = { getItem: () => null, setItem: () => {} }
const fakeElement = () => ({
  style: {},
  setAttribute: () => {},
  appendChild: () => {},
  removeChild: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
})
globalThis.document = {
  body: { hasAttribute: () => false, appendChild: () => {}, style: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  documentElement: { setAttribute: () => {}, style: {} },
  createElement: fakeElement,
  createTextNode: () => ({}),
  querySelector: () => null,
  querySelectorAll: () => [],
}
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  confirm: () => true,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
}

const req = createRequire(CLIENT)
const React = req('react')
const { renderToString } = req('react-dom/server')
const { __Body, __LiveEditorBody } = req(CLIENT)

test('tab body gates on site identity before mounting the editor', () => {
  const html = renderToString(React.createElement(__Body))
  assert.match(html, /正在确认站点身份/)
  assert.equal(html.includes('data-dsh-live-editor'), false)
})

test('editor body renders its initial (index-loading) state once identity is known', () => {
  const html = renderToString(React.createElement(__LiveEditorBody, { siteIdentity: { siteId: 'phase2' } }))
  assert.match(html, /data-dsh-live-editor="phase2"/)
  assert.match(html, /读取文件索引/)
  assert.match(html, /保存/)
  assert.match(html, /Ln 1, Col 1/)
})


test('a read-only site disables the save action', () => {
  const html = renderToString(React.createElement(__LiveEditorBody, {
    siteIdentity: { siteId: 'site-0123456789abcdef', writable: false, label: '真实站只读镜像' },
  }))
  assert.match(html, /只读站点，保存已停用/)
  assert.match(html, /只读 · 真实站只读镜像/)
  assert.match(html, /site-0123456789abcdef/)
})
