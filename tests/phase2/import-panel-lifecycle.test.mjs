/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * E2 behavior tests at the component boundary. These catch the closed-mount
 * deletion and hidden-document cross-talk that source-matching tests missed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '../..')
const CLIENT = path.join(ROOT, 'prototypes/phase2/src/client.cjs')
const phaseRequire = createRequire(CLIENT)
const React = phaseRequire('react')
const TestRenderer = phaseRequire('react-test-renderer')
const { ImportPanel } = phaseRequire('./ui/ImportPanel.cjs')
const { act } = TestRenderer
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.FileReader = class {
  readAsDataURL () {
    this.result = 'data:image/png;base64,AAAA'
    this.onload?.()
  }
}

class FakeStorage {
  constructor () { this.map = new Map(); this.writes = [] }
  getItem (key) { return this.map.get(key) ?? null }
  setItem (key, value) {
    if (this.failWrites === true) throw new Error('quota exceeded')
    this.map.set(key, String(value)); this.writes.push({ key, value: String(value) })
  }
  removeItem (key) { this.map.delete(key) }
}

const props = (overrides = {}) => ({
  open: false,
  activePath: 'a.mdx',
  taskKey: 'task:a',
  onClose: () => {},
  onInsert: () => true,
  ...overrides,
})

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

const imageOk = (draft = 'DRAFT') => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, draft, usage: {}, uncertainties: [] }),
})

const capabilitiesOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, model: { supportsImage: true }, limits: {} }),
})

const selectImage = async (root) => {
  const input = root.root.findByType('input')
  await act(async () => {
    input.props.onChange({ target: { files: [{ name: 'x.png', type: 'image/png', size: 10 }] } })
  })
  await act(async () => {})
}

test('E2: a closed mount preserves a saved review for reopening', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  storage.setItem('task:a', JSON.stringify({
    result: { draft: 'SAVED-DRAFT', usage: {}, uncertainties: [] },
    draft: 'SAVED-DRAFT',
  }))
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, model: { supportsImage: true }, limits: {} }) })
  let root
  try {
    await act(async () => { root = TestRenderer.create(React.createElement(ImportPanel, props())) })
    await act(async () => {})
    assert.notEqual(storage.getItem('task:a'), null, 'closed mount must not delete the review')
    await act(async () => { root.update(React.createElement(ImportPanel, props({ open: true }))) })
    await act(async () => {})
    const textarea = root.root.findByType('textarea')
    assert.equal(textarea.props.value, 'SAVED-DRAFT')
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: A state is never transiently written under B key when both have results', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  storage.setItem('task:a', JSON.stringify({
    result: { draft: 'A-RESULT', usage: {}, uncertainties: [] }, draft: 'A-RESULT',
  }))
  storage.setItem('task:b', JSON.stringify({
    result: { draft: 'B-RESULT', usage: {}, uncertainties: [] }, draft: 'B-RESULT',
  }))
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, model: { supportsImage: true }, limits: {} }) })
  let root
  try {
    await act(async () => { root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true }))) })
    await act(async () => {})
    storage.writes.length = 0
    await act(async () => {
      root.update(React.createElement(ImportPanel, props({
        open: false, activePath: 'b.mdx', taskKey: 'task:b',
      })))
    })
    await act(async () => {})
    const bad = storage.writes.filter((write) => write.key === 'task:b' && write.value.includes('A-RESULT'))
    assert.deepEqual(bad, [], 'A result must never be written under task:b')
    await act(async () => { root.update(React.createElement(ImportPanel, props({ open: true, activePath: 'b.mdx', taskKey: 'task:b' }))) })
    await act(async () => {})
    assert.equal(root.root.findByType('textarea').props.value, 'B-RESULT')
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: a 409 cancel before the original response keeps the finalized draft', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  const image = deferred()
  let cancelCalls = 0
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/capabilities')) return capabilitiesOk()
    if (String(url).includes('/cancel')) {
      cancelCalls += 1
      return { ok: false, status: 409, json: async () => ({ ok: false, code: 'IMPORT_FINALIZING' }) }
    }
    if (String(url).includes('/image')) return image.promise
    throw new Error(`unexpected fetch: ${url}`)
  }
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true })))
    })
    await act(async () => {})
    await selectImage(root)
    await act(async () => { findButton(root, '开始转写').props.onClick() })
    await act(async () => {})
    await act(async () => { findButton(root, '取消').props.onClick() })
    await act(async () => {})
    assert.equal(cancelCalls, 1)
    assert.match(JSON.stringify(root.toJSON()), /正在接收审核草稿/)

    await act(async () => { image.resolve(imageOk('FINAL-DRAFT')) })
    await act(async () => {})
    assert.equal(root.root.findByType('textarea').props.value, 'FINAL-DRAFT')
    assert.match(storage.getItem('task:a') ?? '', /FINAL-DRAFT/)
    assert.equal(JSON.stringify(root.toJSON()).includes('已取消转写'), false)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: a late 409 cancel cannot overwrite a draft that already arrived', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  const image = deferred()
  const cancel = deferred()
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/capabilities')) return capabilitiesOk()
    if (String(url).includes('/cancel')) return cancel.promise
    if (String(url).includes('/image')) return image.promise
    throw new Error(`unexpected fetch: ${url}`)
  }
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true })))
    })
    await act(async () => {})
    await selectImage(root)
    await act(async () => { findButton(root, '开始转写').props.onClick() })
    await act(async () => {})
    await act(async () => { findButton(root, '取消').props.onClick() })
    await act(async () => {})
    assert.equal(findButton(root, '取消中…').props.disabled, true)

    await act(async () => { image.resolve(imageOk('ALREADY-ARRIVED')) })
    await act(async () => {})
    assert.equal(root.root.findByType('textarea').props.value, 'ALREADY-ARRIVED')

    await act(async () => {
      cancel.resolve({ ok: false, status: 409, json: async () => ({ ok: false, code: 'IMPORT_FINALIZING' }) })
    })
    await act(async () => {})
    assert.equal(root.root.findByType('textarea').props.value, 'ALREADY-ARRIVED')
    assert.match(storage.getItem('task:a') ?? '', /ALREADY-ARRIVED/)
    assert.equal(JSON.stringify(root.toJSON()).includes('无法取消'), false)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: a confirmed cancel aborts the request and clears the review', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/capabilities')) return capabilitiesOk()
    if (String(url).includes('/cancel')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, cancelled: true }) }
    }
    if (String(url).includes('/image')) {
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true })))
    })
    await act(async () => {})
    await selectImage(root)
    await act(async () => { findButton(root, '开始转写').props.onClick() })
    await act(async () => {})
    await act(async () => { findButton(root, '取消').props.onClick() })
    await act(async () => {})
    assert.equal(root.root.findAllByType('textarea').length, 0)
    assert.match(JSON.stringify(root.toJSON()), /已取消转写/)
    assert.equal(storage.getItem('task:a'), null)
    assert.equal(findButton(root, '开始转写').props.disabled, false)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: in-flight A is cancelled and cannot surface or persist under B', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  const image = deferred()
  let closed = 0
  let cancelCalls = 0
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/capabilities')) return capabilitiesOk()
    if (String(url).includes('/cancel')) {
      cancelCalls += 1
      return { ok: true, status: 200, json: async () => ({ ok: true, cancelled: true }) }
    }
    if (String(url).includes('/image')) return image.promise
    throw new Error(`unexpected fetch: ${url}`)
  }
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true, onClose: () => { closed += 1 } })))
    })
    await act(async () => {})
    await selectImage(root)
    await act(async () => { findButton(root, '开始转写').props.onClick() })
    await act(async () => {})

    await act(async () => {
      root.update(React.createElement(ImportPanel, props({
        open: true, activePath: 'b.mdx', taskKey: 'task:b', onClose: () => { closed += 1 },
      })))
    })
    await act(async () => {})
    assert.equal(closed, 1)
    assert.equal(cancelCalls, 1)

    await act(async () => { image.resolve(imageOk('A-MUST-NOT-APPEAR')) })
    await act(async () => {})
    assert.equal(root.root.findAllByType('textarea').length, 0)
    assert.equal(storage.getItem('task:b'), null)
    assert.equal(JSON.stringify(root.toJSON()).includes('A-MUST-NOT-APPEAR'), false)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: double-click insert calls onInsert once and clears the saved slot', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  storage.setItem('task:a', JSON.stringify({
    result: { draft: 'INSERT-ME', usage: {}, uncertainties: [] },
    draft: 'INSERT-ME',
  }))
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => capabilitiesOk()
  let inserts = 0
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({
        open: true, onInsert: () => { inserts += 1; return true },
      })))
    })
    await act(async () => {})
    const button = findButton(root, '插入到文档末尾')
    await act(async () => {
      button.props.onClick()
      button.props.onClick()
    })
    await act(async () => {})
    assert.equal(inserts, 1)
    assert.equal(storage.getItem('task:a'), null)
    assert.equal(root.root.findAllByType('textarea').length, 0)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: a refused insert keeps the review and explains why', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  storage.setItem('task:a', JSON.stringify({
    result: { draft: 'KEEP-ME', usage: {}, uncertainties: [] },
    draft: 'KEEP-ME',
  }))
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => capabilitiesOk()
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({
        open: true, onInsert: () => false,
      })))
    })
    await act(async () => {})
    await act(async () => { findButton(root, '插入到文档末尾').props.onClick() })
    await act(async () => {})
    assert.match(JSON.stringify(root.toJSON()), /草稿未插入/)
    assert.equal(root.root.findByType('textarea').props.value, 'KEEP-ME')
    assert.match(storage.getItem('task:a') ?? '', /KEEP-ME/)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: unmount during finalization keeps the draft under the original key', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  const image = deferred()
  let cancelCalls = 0
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/capabilities')) return capabilitiesOk()
    if (String(url).includes('/cancel')) {
      cancelCalls += 1
      return { ok: false, status: 409, json: async () => ({ ok: false, code: 'IMPORT_FINALIZING' }) }
    }
    if (String(url).includes('/image')) return image.promise
    throw new Error(`unexpected fetch: ${url}`)
  }
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true })))
    })
    await act(async () => {})
    await selectImage(root)
    await act(async () => { findButton(root, '开始转写').props.onClick() })
    await act(async () => {})
    await act(async () => { root.unmount() })
    root = null
    await act(async () => {})
    assert.equal(cancelCalls, 1)

    await act(async () => { image.resolve(imageOk('KEPT-AFTER-UNMOUNT')) })
    await act(async () => {})
    assert.match(storage.getItem('task:a') ?? '', /KEPT-AFTER-UNMOUNT/)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: document switch during finalization persists under A, never B', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  const image = deferred()
  let cancelCalls = 0
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/capabilities')) return capabilitiesOk()
    if (String(url).includes('/cancel')) {
      cancelCalls += 1
      return { ok: false, status: 409, json: async () => ({ ok: false, code: 'IMPORT_FINALIZING' }) }
    }
    if (String(url).includes('/image')) return image.promise
    throw new Error(`unexpected fetch: ${url}`)
  }
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true })))
    })
    await act(async () => {})
    await selectImage(root)
    await act(async () => { findButton(root, '开始转写').props.onClick() })
    await act(async () => {})

    await act(async () => {
      root.update(React.createElement(ImportPanel, props({
        open: true, activePath: 'b.mdx', taskKey: 'task:b',
      })))
    })
    await act(async () => {})
    assert.equal(cancelCalls, 1)

    await act(async () => { image.resolve(imageOk('KEPT-FOR-A')) })
    await act(async () => {})
    assert.match(storage.getItem('task:a') ?? '', /KEPT-FOR-A/)
    assert.equal(storage.getItem('task:b'), null)
    assert.equal(JSON.stringify(root.toJSON()).includes('KEPT-FOR-A'), false)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: a replaced file selection cannot publish the older read', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  const requests = []
  const oldFetch = globalThis.fetch
  const oldReader = globalThis.FileReader
  class DeferredReader {
    constructor () { this.onload = null; this.onerror = null; this.aborted = false; DeferredReader.instances.push(this) }
    readAsDataURL (file) { this.file = file; this.captured = this.onload }
    abort () { this.aborted = true }
    succeed () {
      this.result = `data:${this.file.type};base64,${this.file.name}`
      // Call the callback captured at read time so the component's sequence
      // guard, not the nulled handler, is what rejects a stale read.
      this.captured?.()
    }
  }
  DeferredReader.instances = []
  globalThis.FileReader = DeferredReader
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/capabilities')) return capabilitiesOk()
    if (String(url).includes('/image')) {
      requests.push(JSON.parse(options.body))
      return imageOk('RACE-DRAFT')
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true })))
    })
    await act(async () => {})
    const input = root.root.findByType('input')
    await act(async () => { input.props.onChange({ target: { files: [{ name: 'a.png', type: 'image/png', size: 10 }] } }) })
    await act(async () => {})
    const first = DeferredReader.instances[0]
    await act(async () => { input.props.onChange({ target: { files: [{ name: 'b.png', type: 'image/png', size: 20 }] } }) })
    await act(async () => {})
    const second = DeferredReader.instances[1]
    assert.equal(first.aborted, true)
    assert.equal(first.onload, null)

    await act(async () => { first.succeed() })
    await act(async () => {})
    assert.equal(findButton(root, '开始转写').props.disabled, true)
    assert.equal(root.root.findAllByType('img').length, 0)

    await act(async () => { second.succeed() })
    await act(async () => {})
    await act(async () => { findButton(root, '开始转写').props.onClick() })
    await act(async () => {})
    assert.equal(requests.length, 1)
    assert.equal(requests[0].name, 'b.png')
    assert.equal(requests[0].mediaType, 'image/png')
    assert.match(requests[0].dataBase64, /^b\.png$/)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
    globalThis.FileReader = oldReader
  }
})

test('E2: a document switch invalidates a pending file read', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  const oldFetch = globalThis.fetch
  const oldReader = globalThis.FileReader
  class DeferredReader {
    constructor () { this.onload = null; this.onerror = null; this.aborted = false; DeferredReader.instances.push(this) }
    readAsDataURL (file) { this.file = file; this.captured = this.onload }
    abort () { this.aborted = true }
    succeed () {
      this.result = `data:${this.file.type};base64,${this.file.name}`
      // Call the callback captured at read time so the component's sequence
      // guard, not the nulled handler, is what rejects a stale read.
      this.captured?.()
    }
  }
  DeferredReader.instances = []
  globalThis.FileReader = DeferredReader
  let requests = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('/capabilities')) return capabilitiesOk()
    requests += 1
    throw new Error(`unexpected fetch: ${url}`)
  }
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true })))
    })
    await act(async () => {})
    const input = root.root.findByType('input')
    await act(async () => { input.props.onChange({ target: { files: [{ name: 'a.png', type: 'image/png', size: 10 }] } }) })
    await act(async () => {})
    const reader = DeferredReader.instances[0]

    await act(async () => {
      root.update(React.createElement(ImportPanel, props({
        open: true, activePath: 'b.mdx', taskKey: 'task:b',
      })))
    })
    await act(async () => {})
    assert.equal(reader.aborted, true)
    await act(async () => { reader.succeed() })
    await act(async () => {})
    assert.equal(findButton(root, '开始转写').props.disabled, true)
    assert.equal(requests, 0)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
    globalThis.FileReader = oldReader
  }
})

test('E2: a hidden document switch does not expose document A result under B', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  storage.setItem('task:a', JSON.stringify({
    result: { draft: 'A-RESULT', usage: {}, uncertainties: [] },
    draft: 'A-RESULT',
  }))
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, model: { supportsImage: true }, limits: {} }) })
  let root
  try {
    await act(async () => { root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true }))) })
    await act(async () => {})
    assert.equal(root.root.findByType('textarea').props.value, 'A-RESULT')

    await act(async () => {
      root.update(React.createElement(ImportPanel, props({
        open: false, activePath: 'b.mdx', taskKey: 'task:b',
      })))
    })
    await act(async () => {})
    assert.equal(storage.getItem('task:b'), null, 'A result must not be written under B key')

    await act(async () => { root.update(React.createElement(ImportPanel, props({ open: true, activePath: 'b.mdx', taskKey: 'task:b' }))) })
    await act(async () => {})
    const areas = root.root.findAllByType('textarea')
    assert.equal(areas.length === 0 || areas[0].props.value !== 'A-RESULT', true)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: an older detached result cannot overwrite a newer review', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  const image1 = deferred()
  const image2 = deferred()
  let imageCalls = 0
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/capabilities')) return capabilitiesOk()
    if (String(url).includes('/cancel')) {
      return { ok: false, status: 409, json: async () => ({ ok: false, code: 'IMPORT_FINALIZING' }) }
    }
    if (String(url).includes('/image')) {
      imageCalls += 1
      return imageCalls === 1 ? image1.promise : image2.promise
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true })))
    })
    await act(async () => {})
    await selectImage(root)
    await act(async () => { findButton(root, '开始转写').props.onClick() })
    await act(async () => {})
    assert.equal(imageCalls, 1)

    // Detach A1 while it is finalizing, then start a newer A2.
    await act(async () => {
      root.update(React.createElement(ImportPanel, props({ open: true, activePath: 'b.mdx', taskKey: 'task:b' })))
    })
    await act(async () => {})
    await act(async () => {
      root.update(React.createElement(ImportPanel, props({ open: true, activePath: 'a.mdx', taskKey: 'task:a' })))
    })
    await act(async () => {})
    await selectImage(root)
    await act(async () => { findButton(root, '开始转写').props.onClick() })
    await act(async () => {})
    assert.equal(imageCalls, 2)

    await act(async () => { image2.resolve(imageOk('NEWER')) })
    await act(async () => {})
    assert.equal(root.root.findByType('textarea').props.value, 'NEWER')
    assert.match(storage.getItem('task:a') ?? '', /NEWER/)

    await act(async () => { image1.resolve(imageOk('OLDER')) })
    await act(async () => {})
    assert.equal(root.root.findByType('textarea').props.value, 'NEWER')
    assert.match(storage.getItem('task:a') ?? '', /NEWER/)
    assert.doesNotMatch(storage.getItem('task:a') ?? '', /OLDER/)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: a detached result arriving after returning to A appears in the panel', async () => {
  const storage = new FakeStorage()
  globalThis.sessionStorage = storage
  const image = deferred()
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/capabilities')) return capabilitiesOk()
    if (String(url).includes('/cancel')) {
      return { ok: false, status: 409, json: async () => ({ ok: false, code: 'IMPORT_FINALIZING' }) }
    }
    if (String(url).includes('/image')) return image.promise
    throw new Error(`unexpected fetch: ${url}`)
  }
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true })))
    })
    await act(async () => {})
    await selectImage(root)
    await act(async () => { findButton(root, '开始转写').props.onClick() })
    await act(async () => {})

    await act(async () => {
      root.update(React.createElement(ImportPanel, props({ open: true, activePath: 'b.mdx', taskKey: 'task:b' })))
    })
    await act(async () => {})
    await act(async () => {
      root.update(React.createElement(ImportPanel, props({ open: true, activePath: 'a.mdx', taskKey: 'task:a' })))
    })
    await act(async () => {})
    assert.equal(root.root.findAllByType('textarea').length, 0)

    await act(async () => { image.resolve(imageOk('LATE-RESULT')) })
    await act(async () => {})
    assert.equal(root.root.findByType('textarea').props.value, 'LATE-RESULT')
    assert.match(storage.getItem('task:a') ?? '', /LATE-RESULT/)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})

test('E2: a failed storage write keeps an in-memory fallback and warns', async () => {
  const storage = new FakeStorage()
  storage.failWrites = true
  globalThis.sessionStorage = storage
  const image = deferred()
  const key = `task:storage-failure-${Date.now()}`
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('/capabilities')) return capabilitiesOk()
    if (String(url).includes('/cancel')) {
      return { ok: false, status: 409, json: async () => ({ ok: false, code: 'IMPORT_FINALIZING' }) }
    }
    if (String(url).includes('/image')) return image.promise
    throw new Error(`unexpected fetch: ${url}`)
  }
  let root
  try {
    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true, taskKey: key })))
    })
    await act(async () => {})
    await selectImage(root)
    await act(async () => { findButton(root, '开始转写').props.onClick() })
    await act(async () => {})
    await act(async () => { root.unmount() })
    root = null
    await act(async () => {})
    await act(async () => { image.resolve(imageOk('FALLBACK-DRAFT')) })
    await act(async () => {})

    await act(async () => {
      root = TestRenderer.create(React.createElement(ImportPanel, props({ open: true, taskKey: key })))
    })
    await act(async () => {})
    assert.equal(root.root.findByType('textarea').props.value, 'FALLBACK-DRAFT')
    assert.match(JSON.stringify(root.toJSON()), /暂存写入失败/)
  } finally {
    if (root) await act(async () => { root.unmount() })
    globalThis.fetch = oldFetch
  }
})
