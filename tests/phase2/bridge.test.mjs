/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Phase 2 / Step 4 — bridge protocol v2 unit test (no browser).
 *
 * Checks the v2 handshake, doc/doc-map/route-state, nav-intent link capture,
 * navigate dispatch, sidebars, guard and the v1 rejection boundary.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const BRIDGE = path.resolve(import.meta.dirname, '../../plugins/dsh-live-editor/src/client/bridge.js')
const PARENT_ORIGIN = 'dsh-app://app'
const SOURCE = 'dsh-live-editor-bridge'
const CHILD_ORIGIN = 'http://localhost:3000'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeElement {}

function createHarness() {
  const sent = []
  const listeners = []
  const clicks = []
  const parent = {}
  const win = {
    parent,
    location: {
      pathname: '/docs/QFT/classical-field-theory/',
      href: `${CHILD_ORIGIN}/docs/QFT/classical-field-theory/`,
      origin: CHILD_ORIGIN,
    },
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn) },
  }
  parent.postMessage = (data, targetOrigin) => { sent.push({ data, targetOrigin }) }
  const document = {
    title: '经典场论',
    documentElement: { setAttribute() {} },
    addEventListener(type, fn) { if (type === 'click') clicks.push(fn) },
    querySelectorAll() { return [] },
  }
  globalThis.window = win
  globalThis.document = document
  globalThis.Element = FakeElement
  return { win, parent, sent, listeners, clicks, document }
}

function docPayload(overrides = {}) {
  return {
    source: 'docs/QFT/03-classical-field-theory.mdx',
    docId: 'QFT/classical-field-theory',
    permalink: '/docs/QFT/classical-field-theory/',
    title: '经典场论',
    locale: 'zh',
    routeBasePath: '/docs',
    instanceId: 'default',
    versionName: 'current',
    sourceRoot: 'docs',
    baseUrl: '/',
    docs: [{ source: 'docs/QFT/03-classical-field-theory.mdx', permalink: '/docs/QFT/classical-field-theory/' }],
    sidebars: {
      version: 'current',
      generatedAt: '2026-10-22T00:00:00.000Z',
      trees: { defaultSidebar: [{ type: 'doc', id: 'QFT/classical-field-theory' }] },
    },
    ...overrides,
  }
}

test('v2: handshake carries bootId, ready-ack carries docMap/doc, route-state is authoritative', async () => {
  const { parent, sent, listeners } = createHarness()
  const { createBridge } = await import(pathToFileURL(BRIDGE).href)
  const navigated = []
  const api = createBridge({ nonce: 'nonce-v2', parentOrigin: PARENT_ORIGIN })
  api.publishDoc(docPayload({ navigate: (href) => navigated.push(href) }))
  api.start()
  await sleep(300)

  const hello = sent.find((item) => item.data.type === 'hello')
  assert.ok(hello, 'hello should be sent')
  assert.equal(hello.data.v, 2)
  assert.equal(hello.data.source, SOURCE)
  assert.equal(hello.data.nonce, 'nonce-v2')
  assert.equal(typeof hello.data.bootId, 'string')
  assert.equal(hello.data.pathname, '/docs/QFT/classical-field-theory/')
  assert.equal(hello.data.href, `${CHILD_ORIGIN}/docs/QFT/classical-field-theory/`)
  assert.equal(hello.data.doc.source, 'docs/QFT/03-classical-field-theory.mdx')
  assert.equal(hello.data.doc.instanceId, 'default')
  assert.equal(hello.data.doc.versionName, 'current')
  assert.equal(hello.data.doc.sourceRoot, 'docs')

  const message = (data, origin = PARENT_ORIGIN, source = parent) => {
    for (const fn of listeners) fn({ data, origin, source })
  }
  message({ source: SOURCE, v: 1, nonce: 'nonce-v2', type: 'ready' })
  assert.equal(api.ready, false, 'v1 must not handshake')
  message({ source: SOURCE, v: 2, nonce: 'wrong', type: 'ready' })
  message({ source: SOURCE, v: 2, nonce: 'nonce-v2', type: 'ready' }, 'https://evil.example')
  assert.equal(api.ready, false)

  message({ source: SOURCE, v: 2, nonce: 'nonce-v2', type: 'ready' })
  assert.equal(api.ready, true)
  const ack = sent.find((item) => item.data.type === 'ready-ack')
  assert.ok(ack)
  assert.equal(ack.data.bootId, hello.data.bootId)
  assert.equal(ack.data.doc.source, 'docs/QFT/03-classical-field-theory.mdx')
  assert.equal(ack.data.docMap.length, 1)
  assert.equal(ack.data.sidebars.generatedAt, '2026-10-22T00:00:00.000Z')
  assert.equal(ack.data.routeBasePath, '/docs')
  assert.equal(sent.some((item) => item.data.type === 'route-change'), false, 'v1 route-change is gone')

  api.onRouteDidUpdate({
    pathname: '/docs/QFT/classical-field-theory/',
    href: `${CHILD_ORIGIN}/docs/QFT/classical-field-theory/`,
  })
  await sleep(80)
  const route = sent.find((item) => item.data.type === 'route-state')
  assert.ok(route, 'route-state should be sent')
  assert.equal(route.data.doc.source, 'docs/QFT/03-classical-field-theory.mdx')
  assert.equal(route.data.pathname, '/docs/QFT/classical-field-theory/')
  assert.equal(route.data.bootId, hello.data.bootId)

  const changedMap = [{
    source: 'docs/QFT/03-classical-field-theory.mdx',
    permalink: '/docs/QFT/classical-field-theory-renamed/',
    title: '经典场论（重命名）',
  }]
  api.publishDoc(docPayload({
    permalink: '/docs/QFT/classical-field-theory-renamed/',
    title: '经典场论（重命名）',
    docs: changedMap,
    sidebars: {
      version: 'current',
      generatedAt: '2026-10-22T00:01:00.000Z',
      trees: { defaultSidebar: [{ type: 'doc', id: 'QFT/classical-field-theory' }] },
    },
    navigate: (href) => navigated.push(href),
  }))
  const doc = sent.filter((item) => item.data.type === 'doc')
  assert.ok(doc.length >= 1)
  assert.equal(doc.at(-1).data.doc.title, '经典场论（重命名）')
  const map = sent.find((item) => item.data.type === 'doc-map')
  assert.ok(map)
  assert.equal(map.data.docMap[0].permalink, '/docs/QFT/classical-field-theory-renamed/')
  const sidebars = sent.filter((item) => item.data.type === 'sidebars')
  assert.equal(sidebars.at(-1).data.sidebars.generatedAt, '2026-10-22T00:01:00.000Z')

  message({
    source: SOURCE, v: 2, nonce: 'nonce-v2', type: 'navigate',
    href: `${CHILD_ORIGIN}/docs/QFT/07-field-quantization/`, navId: 'nav-1',
  })
  assert.deepEqual(navigated, ['/docs/QFT/07-field-quantization/'])

  message({ source: SOURCE, v: 2, nonce: 'nonce-v2', type: 'guard', dirty: true })
  assert.equal(api.guardDirty, undefined) // not exposed; guard is deliberately side-effect only
})

test('v2: internal preview links become nav-intent and never navigate directly', async () => {
  const { sent, listeners, clicks } = createHarness()
  const { createBridge } = await import(pathToFileURL(BRIDGE).href)
  const api = createBridge({ nonce: 'nonce-link', parentOrigin: PARENT_ORIGIN })
  api.publishDoc(docPayload())
  api.start()
  await sleep(200)
  const message = (data) => {
    for (const fn of listeners) fn({ data, origin: PARENT_ORIGIN, source: globalThis.window.parent })
  }
  message({ source: SOURCE, v: 2, nonce: 'nonce-link', type: 'ready' })
  assert.equal(api.ready, true)

  const anchor = {
    href: `${CHILD_ORIGIN}/docs/QFT/07-field-quantization/`,
    target: '',
    hasAttribute: () => false,
  }
  const target = new FakeElement()
  target.closest = () => anchor
  let prevented = false
  let stopped = false
  const event = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target,
    preventDefault: () => { prevented = true },
    stopPropagation: () => { stopped = true },
  }
  assert.equal(clicks.length, 1)
  clicks[0](event)
  assert.equal(prevented, true)
  assert.equal(stopped, true)
  const intent = sent.find((item) => item.data.type === 'nav-intent')
  assert.ok(intent)
  assert.equal(intent.data.kind, 'link')
  assert.equal(intent.data.pathname, '/docs/QFT/07-field-quantization/')
  assert.equal(intent.data.href, `${CHILD_ORIGIN}/docs/QFT/07-field-quantization/`)
})


test('v2: proj identity is carried without changing source or preview flags', async () => {
  const { sent, listeners } = createHarness()
  const { createBridge } = await import(pathToFileURL(BRIDGE).href)
  const api = createBridge({ nonce: 'nonce-proj', parentOrigin: PARENT_ORIGIN })
  api.publishDoc(docPayload({
    source: 'proj/docs/index.mdx',
    docId: 'index',
    permalink: '/proj/',
    routeBasePath: '/proj',
    instanceId: 'proj',
    versionName: 'current',
    sourceRoot: 'proj',
    docs: [{ source: 'proj/docs/index.mdx', permalink: '/proj/', instanceId: 'proj', versionName: 'current', sourceRoot: 'proj' }],
  }))
  api.start()
  await sleep(250)
  const hello = sent.find((item) => item.data.type === 'hello')
  assert.equal(hello.data.doc.source, 'proj/docs/index.mdx')
  assert.equal(hello.data.doc.instanceId, 'proj')
  assert.equal(hello.data.doc.sourceRoot, 'proj')
  assert.equal(hello.data.doc.preview, false)
  const message = (data) => { for (const fn of listeners) fn({ data, origin: PARENT_ORIGIN, source: globalThis.window.parent }) }
  message({ source: SOURCE, v: 2, nonce: 'nonce-proj', type: 'ready' })
  const ack = sent.find((item) => item.data.type === 'ready-ack')
  assert.equal(ack.data.doc.instanceId, 'proj')
  assert.equal(ack.data.docMap[0].source, 'proj/docs/index.mdx')
  const snapshot = api.snapshot()
  assert.equal(snapshot.current.instanceId, 'proj')
  assert.equal(snapshot.current.sourceRoot, 'proj')
  assert.equal(snapshot.current.preview, false)
})
