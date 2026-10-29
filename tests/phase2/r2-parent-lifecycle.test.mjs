/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const MODULE = path.resolve(import.meta.dirname, '../../prototypes/phase2/src/state/r2-parent.mjs')
const { createR2ParentController, R2_SOURCE, R2_VERSION } = await import(pathToFileURL(MODULE).href)

function makeHarness() {
  let now = 1000
  let timerId = 0
  const timers = new Map()
  const sent = []
  const controller = createR2ParentController({
    send: (message) => sent.push(message),
    now: () => now,
    setTimer: (fn, ms) => { timerId += 1; timers.set(timerId, { fn, at: now + ms }); return timerId },
    clearTimer: (id) => timers.delete(id),
    expiryMs: 5000,
  })
  return {
    controller, sent,
    tick(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn() }
      }
    },
    now: () => now,
    timers,
  }
}

const hello = (over = {}) => ({
  source: R2_SOURCE, v: R2_VERSION, type: 'r2-hello', bootId: 'boot-1', generation: 1,
  session: 'session-1', docId: 'doc-a', route: '/__live-preview/a/', handshake: 'A2-HANDSHAKE-V2', ...over,
})
const ack = (pending, over = {}) => ({
  source: R2_SOURCE, v: R2_VERSION, type: 'r2-ack',
  bootId: pending.bootId, generation: pending.generation,
  commandId: pending.commandId, revision: pending.revision, writeId: pending.writeId,
  session: pending.session, docId: pending.docId, route: pending.route, path: pending.route,
  marker: { writeId: pending.writeId, revision: pending.revision }, confirmed: true, ...over,
})

test('parent accepts hello, sends an exact command, and accepts a matching ACK', () => {
  const h = makeHarness()
  h.controller.setFrame({ id: 'frame' })
  assert.equal(h.controller.acceptHello(hello()), true)
  const commandId = h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 3, writeId: 'w-3' })
  assert.ok(commandId)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].type, 'r2-command')
  const pending = h.controller.snapshot().pending
  assert.deepEqual(h.controller.handleAck(ack(pending)), { ok: true, ack: { commandId, revision: 3, writeId: 'w-3', session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', bootId: 'boot-1', generation: 1, at: 1000 } })
  assert.equal(h.controller.snapshot().pending, null)
})

test('hello with a different handshake version is rejected (fail closed)', () => {
  const h = makeHarness()
  h.controller.setFrame({})
  assert.equal(h.controller.acceptHello({ ...hello(), handshake: 'A2-HANDSHAKE-V1' }), false)
  assert.equal(h.controller.snapshot().bootId, null)
})

test('old DOM writeId, wrong generation and unconfirmed fallback are rejected', () => {
  const h = makeHarness()
  h.controller.setFrame({})
  h.controller.acceptHello(hello())
  h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 3, writeId: 'w-3' })
  const p = h.controller.snapshot().pending
  assert.equal(h.controller.handleAck(ack(p, { writeId: 'w-2', marker: { writeId: 'w-2', revision: 3 } })).reason, 'write-id-mismatch')
  assert.equal(h.controller.handleAck(ack(p, { generation: 2 })).reason, 'generation-mismatch')
  assert.equal(h.controller.handleAck(ack(p, { docId: 'doc-b' })).reason, 'doc-mismatch')
  assert.equal(h.controller.handleAck(ack(p, { route: '/__live-preview/b' })).reason, 'route-mismatch')
  assert.equal(h.controller.handleAck(ack(p, { confirmed: false })).reason, 'unconfirmed')
  assert.equal(h.controller.snapshot().pending.commandId, p.commandId)
})

test('pending expiry rejects a late ACK and cannot be revived', () => {
  const h = makeHarness()
  h.controller.setFrame({})
  h.controller.acceptHello(hello())
  h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 3, writeId: 'w-3' })
  const p = h.controller.snapshot().pending
  h.tick(5001)
  assert.equal(h.controller.snapshot().pending, null)
  assert.equal(h.controller.handleAck(ack(p)).reason, 'unsolicited')
})

test('route/session invalidate drops pending work', () => {
  const h = makeHarness()
  h.controller.setFrame({})
  h.controller.acceptHello(hello())
  h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 3, writeId: 'w-3' })
  h.controller.invalidate('route-change')
  assert.equal(h.controller.snapshot().pending, null)
  assert.equal(h.controller.handleAck(ack({ source: R2_SOURCE, v: R2_VERSION, bootId: 'boot-1', generation: 1, commandId: 'x', revision: 3, writeId: 'w-3', session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', marker: { writeId: 'w-3', revision: 3 } })).reason, 'unsolicited')
})


test('a write arriving before hello is queued and released on matching hello', () => {
  const h = makeHarness()
  h.controller.setFrame({})
  assert.equal(h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 3, writeId: 'w-3' }), null)
  assert.equal(h.sent.length, 0)
  assert.equal(h.controller.acceptHello(hello()), true)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].type, 'r2-command')
  assert.equal(h.sent[0].writeId, 'w-3')
  const pending = h.controller.snapshot().pending
  const result = h.controller.handleAck(ack(pending))
  assert.equal(result.ok, true)
  assert.equal(result.ack.session, pending.session)
  assert.equal(result.ack.docId, pending.docId)
  assert.equal(result.ack.route, pending.route)
})

test('a command with a newer session is sent despite a stale hello session', () => {
  const h = makeHarness()
  h.controller.setFrame({})
  assert.equal(h.controller.acceptHello({ ...hello(), session: 'stale-session' }), true)
  const commandId = h.controller.begin({
    session: 'current-session', docId: 'doc-a', route: '/__live-preview/a', revision: 4, writeId: 'w-4',
  })
  assert.equal(typeof commandId, 'string')
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].session, 'current-session')
  const pending = h.controller.snapshot().pending
  assert.equal(h.controller.handleAck({
    ...ack(pending), session: 'current-session', revision: 4, writeId: 'w-4', marker: { writeId: 'w-4', revision: 4 },
  }).ok, true)
})

test('a duplicate hello reissues a command that was posted before the channel was ready', () => {
  const h = makeHarness()
  h.controller.setFrame({})
  assert.equal(h.controller.acceptHello(hello()), true)
  const first = h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 5, writeId: 'w-5' })
  assert.equal(typeof first, 'string')
  assert.equal(h.sent.length, 1)
  // Same boot/generation: the earlier postMessage may have been lost before
  // the child installed its listener. The parent must reissue, not trust pending.
  assert.equal(h.controller.acceptHello(hello()), true)
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].writeId, 'w-5')
  const pending = h.controller.snapshot().pending
  assert.equal(h.controller.handleAck(ack(pending)).ok, true)
})

test('changing the frame invalidates queued work', () => {
  const h = makeHarness()
  h.controller.setFrame({})
  h.controller.acceptHello(hello())
  h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 3, writeId: 'w-3' })
  h.controller.setFrame({ other: true })
  assert.equal(h.controller.snapshot().pending, null)
  assert.equal(h.sent.length, 1)
})


test('a newer hello reissues the newest successful write instead of dropping it', () => {
  const h = makeHarness()
  h.controller.setFrame({})
  h.controller.acceptHello(hello())
  h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 3, writeId: 'w-3' })
  assert.equal(h.sent.length, 1)
  h.controller.acceptHello(hello({ generation: 2 }))
  assert.equal(h.sent.length, 2, 'same write is reissued under generation 2')
  assert.equal(h.sent[1].generation, 2)
  assert.equal(h.sent[1].writeId, 'w-3')
  const pending = h.controller.snapshot().pending
  assert.equal(pending.generation, 2)
  assert.equal(h.controller.handleAck(ack(pending)).ok, true)
})


test('new boot at generation 1 reissues the latest successful write', () => {
  const h = makeHarness()
  h.controller.setFrame({})
  h.controller.acceptHello(hello())
  h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 3, writeId: 'w-3' })
  assert.equal(h.sent.length, 1)
  h.controller.acceptHello(hello({ bootId: 'boot-2', generation: 1 }))
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].bootId, 'boot-2')
  assert.equal(h.sent[1].writeId, 'w-3')
  assert.equal(h.controller.snapshot().pending.generation, 1)
})

test('frame replacement preserves and reissues the latest write', () => {
  const h = makeHarness()
  h.controller.setFrame({ id: 'old' })
  h.controller.acceptHello(hello())
  h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 3, writeId: 'w-3' })
  h.controller.setFrame({ id: 'new' })
  assert.equal(h.controller.snapshot().pending, null)
  h.controller.acceptHello(hello())
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].writeId, 'w-3')
})

test('a newer successful write replaces an older queued write before hello', () => {
  const h = makeHarness()
  h.controller.setFrame({})
  h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 3, writeId: 'w-3' })
  h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 4, writeId: 'w-4' })
  h.controller.acceptHello(hello())
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].writeId, 'w-4')
  assert.equal(h.sent[0].revision, 4)
})


test('structural restart invalidates old ACK and reissues latest under new generation', () => {
  const h = makeHarness()
  h.controller.setFrame({})
  h.controller.acceptHello(hello())
  h.controller.begin({ session: 'session-1', docId: 'doc-a', route: '/__live-preview/a', revision: 3, writeId: 'w-3' })
  const oldPending = h.controller.snapshot().pending
  h.controller.resetHandshake('structural-restart')
  assert.equal(h.controller.snapshot().pending, null)
  h.controller.acceptHello(hello({ generation: 2 }))
  const newPending = h.controller.snapshot().pending
  assert.equal(newPending.generation, 2)
  assert.equal(newPending.writeId, 'w-3')
  assert.equal(h.controller.handleAck(ack(oldPending)).reason, 'generation-mismatch')
  assert.equal(h.controller.handleAck(ack(newPending)).ok, true)
})
