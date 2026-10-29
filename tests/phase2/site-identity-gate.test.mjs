/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * P1-B: the editor body must not mount (and therefore must not create draft
 * stores) before a valid site identity is confirmed. A failed check must offer
 * retry and must never fall back to a hard-coded site id.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '../..')
const req = createRequire(path.join(ROOT, 'prototypes/phase2/src/client.cjs'))
const React = req('react')
const TestRenderer = req('react-test-renderer')
const { SiteIdentityGate } = req('./ui/SiteIdentityGate.cjs')
const { act } = TestRenderer
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const text = (children) => Array.isArray(children)
  ? children.map(text).join('')
  : (typeof children === 'string' ? children : '')

const findButton = (root, label) => root.root.findAllByType('button')
  .find((button) => text(button.props.children).includes(label))

test('the body waits for a valid site identity', async () => {
  const pending = deferred()
  const seen = []
  let root
  await act(async () => {
    root = TestRenderer.create(React.createElement(SiteIdentityGate, {
      loadSite: () => pending.promise,
      renderBody: (site) => { seen.push(site); return React.createElement('div', null, `BODY:${site.siteId}`) },
    }))
  })
  await act(async () => {})
  assert.deepEqual(seen, [], 'body must not render before identity is known')
  assert.match(JSON.stringify(root.toJSON()), /正在确认站点身份/)

  await act(async () => { pending.resolve({ siteId: 'phase2' }) })
  await act(async () => {})
  assert.deepEqual(seen, [{ siteId: 'phase2' }])
  assert.match(JSON.stringify(root.toJSON()), /BODY:phase2/)
  await act(async () => { root.unmount() })
})

test('a failed identity check shows an error and retries without a fallback id', async () => {
  const first = deferred()
  const second = deferred()
  let calls = 0
  const seen = []
  let root
  await act(async () => {
    root = TestRenderer.create(React.createElement(SiteIdentityGate, {
      loadSite: () => { calls += 1; return calls === 1 ? first.promise : second.promise },
      renderBody: (site) => { seen.push(site.siteId); return React.createElement('div', null, `BODY:${site.siteId}`) },
    }))
  })
  await act(async () => { first.reject(new Error('502 site unavailable')) })
  await act(async () => {})
  assert.match(JSON.stringify(root.toJSON()), /无法确认当前站点身份/)
  assert.match(JSON.stringify(root.toJSON()), /502 site unavailable/)
  assert.deepEqual(seen, [])
  assert.equal(JSON.stringify(root.toJSON()).includes('phase2'), false)

  await act(async () => { findButton(root, '重试').props.onClick() })
  await act(async () => {})
  assert.equal(calls, 2)
  await act(async () => { second.resolve({ siteId: 'site-0123456789abcdef' }) })
  await act(async () => {})
  assert.deepEqual(seen, ['site-0123456789abcdef'])
  await act(async () => { root.unmount() })
})

test('an invalid identity payload is treated as a failure', async () => {
  let root
  await act(async () => {
    root = TestRenderer.create(React.createElement(SiteIdentityGate, {
      loadSite: async () => ({ siteId: '' }),
      renderBody: () => React.createElement('div', null, 'MUST-NOT-RENDER'),
    }))
  })
  await act(async () => {})
  assert.match(JSON.stringify(root.toJSON()), /站点身份无效/)
  assert.equal(JSON.stringify(root.toJSON()).includes('MUST-NOT-RENDER'), false)
  await act(async () => { root.unmount() })
})
