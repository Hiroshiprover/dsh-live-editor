/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Client plugin registration smoke: QuickOpen must be registered through the
 * application shortcut service, not a raw window keydown. The fake context
 * checks the command shape, conflict-free defaults and target resolver.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Module from 'node:module'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')
const CLIENT = path.join(REPO, 'prototypes/phase2/src/client.cjs')

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
class FakeElement {}
globalThis.Element = FakeElement

const req = createRequire(CLIENT)
const client = req(CLIENT)

test('apply registers a conflict-free QuickOpen shortcut with the right defaults', () => {
  const commands = []
  const disposers = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    inject(_deps, callback) { callback(ctx) },
    slots: {
      inject() { return () => {} },
      register() { return () => {} },
    },
    sidebarRightTabs: { register() { return () => {} } },
    sidebarRight: {
      commandTarget: () => ({ sessionId: 's1', tabId: 't1' }),
      tabsIn: () => [{ id: 't1', kind: 'live-editor-phase2' }],
    },
    shortcuts: {
      describeBinding: () => ({ issue: null, conflicts: [] }),
      register(command) { commands.push(command); return () => {} },
    },
  }
  client.apply(ctx)
  assert.equal(commands.length, 2)
  const command = commands[0]
  assert.equal(command.id, 'liveEditor.quickOpen')
  assert.deepEqual(command.defaults['desktop:macos'], { code: 'KeyP', modifiers: ['primary', 'shift'] })
  assert.deepEqual(command.defaults['desktop:windows'], { code: 'KeyP', modifiers: ['primary', 'shift'] })
  assert.deepEqual(command.defaults['web:macos'], { code: 'KeyP', modifiers: ['primary', 'shift'] })
  assert.equal(command.defaults['web:linux'], undefined, 'Web/Linux does not admit KeyP')
  assert.ok(command.regions.includes('editable'))
  const target = new FakeElement()
  target.closest = () => null
  assert.deepEqual(command.resolve({ target }), { status: 'pass' })
  assert.deepEqual(command.resolve({ target: null }), { status: 'pass' })

  // Simulate native input with no DOM target while the active tab is Live
  // Editor: the fallback must open that visible root's controller.
  let opened = 0
  const root = new FakeElement()
  root.isConnected = true
  root.getClientRects = () => [{ width: 1 }]
  root.closest = () => null
  client.__quickOpenByRoot.set(root, () => { opened += 1 })
  const originalQuery = globalThis.document.querySelectorAll
  globalThis.document.querySelectorAll = () => [root]
  globalThis.document.activeElement = null
  const fallback = command.resolve({ target: null })
  assert.equal(fallback.status, 'handled')
  fallback.run()
  assert.equal(opened, 1)
  globalThis.document.querySelectorAll = originalQuery
  client.__quickOpenByRoot.delete(root)
  for (const dispose of disposers) dispose()
})

test('a conflicting primary candidate falls back to the next free combination', () => {
  const commands = []
  const ctx = {
    effect(fn) { const dispose = fn(); return dispose },
    inject(_deps, callback) { callback(ctx) },
    slots: { inject() { return () => {} }, register() { return () => {} } },
    sidebarRightTabs: { register() { return () => {} } },
    sidebarRight: {
      commandTarget: () => ({ sessionId: 's1', tabId: 't1' }),
      tabsIn: () => [{ id: 't1', kind: 'live-editor-phase2' }],
    },
    shortcuts: {
      describeBinding: (binding) => ({
        issue: null,
        conflicts: binding.modifiers.includes('alt') ? ['workspace.files'] : [],
      }),
      register(command) { commands.push(command); return () => {} },
    },
  }
  client.apply(ctx)
  assert.equal(commands.length, 2)
  assert.deepEqual(commands[0].defaults['desktop:macos'], { code: 'KeyP', modifiers: ['primary', 'shift'] })
  assert.deepEqual(commands[0].defaults['web:macos'], { code: 'KeyP', modifiers: ['primary', 'shift'] })
})
