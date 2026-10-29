/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const MODULE = path.resolve(import.meta.dirname, '../../plugins/dsh-live-editor/src/r2-shadow/scheduler.mjs')
const { createBoundedPreviewScheduler } = await import(pathToFileURL(MODULE).href)

function makeClock() {
  let now = 0
  let nextId = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      nextId += 1
      timers.set(nextId, { at: now + Math.max(0, ms), fn })
      return nextId
    },
    clearTimer: (id) => timers.delete(id),
    async advance(ms) {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, timer] = due
        timers.delete(id)
        now = timer.at
        timer.fn()
        await new Promise((resolve) => setImmediate(resolve))
      }
      now = target
      await new Promise((resolve) => setImmediate(resolve))
    },
    pending: () => timers.size,
  }
}

test('150ms trailing debounce keeps only the latest snapshot', async () => {
  const clock = makeClock()
  const writes = []
  const s = createBoundedPreviewScheduler({
    write: async (value) => writes.push(value),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  })
  s.submit('a')
  await clock.advance(50)
  s.submit('b')
  await clock.advance(50)
  s.submit('c')
  await clock.advance(200)
  assert.deepEqual(writes, ['c'])
})

test('continuous input flushes at most once per 300ms max wait and ends with latest', async () => {
  const clock = makeClock()
  const writes = []
  const s = createBoundedPreviewScheduler({
    write: async (value) => writes.push(value),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  })
  for (let i = 0; i < 12; i += 1) {
    s.submit(`v${i}`)
    await clock.advance(50)
  }
  await clock.advance(500)
  assert.ok(writes.length >= 2, `expected bounded writes, got ${writes.length}`)
  assert.equal(writes.at(-1), 'v11')
})

test('single-flight replaces queued snapshots instead of writing them all', async () => {
  const clock = makeClock()
  const writes = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const s = createBoundedPreviewScheduler({
    write: async (value) => { writes.push(value); await gate },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  })
  s.submit('first')
  await clock.advance(150)
  assert.deepEqual(writes, ['first'])
  s.submit('second')
  s.submit('third')
  release()
  await new Promise((resolve) => setImmediate(resolve))
  await clock.advance(200)
  assert.equal(writes.length, 2)
  assert.equal(writes[1], 'third')
})

test('dispose drops pending work and does not write', async () => {
  const clock = makeClock()
  const writes = []
  const s = createBoundedPreviewScheduler({
    write: async (value) => writes.push(value),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  })
  s.submit('a')
  s.dispose()
  await clock.advance(500)
  assert.deepEqual(writes, [])
  assert.equal(s.snapshot().pending, false)
})


test('flush drains the latest snapshot after an in-flight write', async () => {
  const clock = makeClock()
  const writes = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const s = createBoundedPreviewScheduler({
    write: async (value) => { writes.push(value); if (value === 'first') await gate },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    minIntervalMs: 0,
  })
  s.submit('first')
  await clock.advance(150)
  s.submit('second')
  release()
  await s.flush()
  assert.deepEqual(writes, ['first', 'second'])
})

test('flush rejects a failed write instead of silently resolving', async () => {
  const clock = makeClock()
  const s = createBoundedPreviewScheduler({
    write: async () => { throw new Error('boom') },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    minIntervalMs: 0,
  })
  s.submit('a')
  await assert.rejects(() => s.flush(), /boom/)
})

test('dispose before a queued write starts prevents the write', async () => {
  const clock = makeClock()
  let writes = 0
  const s = createBoundedPreviewScheduler({
    write: async () => { writes += 1 },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  })
  s.submit('a')
  s.dispose()
  await s.flush()
  assert.equal(writes, 0)
})


test('timeout is fail-closed and a late commit cannot overwrite a newer write', async () => {
  const clock = makeClock()
  const writes = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const s = createBoundedPreviewScheduler({
    write: async (value) => { writes.push(value); if (value === 'first') await gate },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    minIntervalMs: 0, writeTimeoutMs: 100,
  })
  s.submit('first')
  await clock.advance(150)
  await clock.advance(120)
  assert.equal(s.snapshot().failed, true)
  assert.equal(s.submit('second'), false)
  release()
  await clock.advance(50)
  await assert.rejects(() => s.flush(), /timeout/)
  assert.deepEqual(writes, ['first'])
})

test('flush drains a newer snapshot after an earlier rejection', async () => {
  const clock = makeClock()
  const writes = []
  const s = createBoundedPreviewScheduler({
    write: async (value) => { writes.push(value); if (value === 'first') throw new Error('bad') },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    minIntervalMs: 0,
  })
  s.submit('first')
  await clock.advance(150)
  s.submit('second')
  await s.flush()
  assert.deepEqual(writes, ['first', 'second'])
  assert.equal(s.snapshot().lastError, null)
})

test('dispose during settlement does not start pending work', async () => {
  const clock = makeClock()
  const writes = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const s = createBoundedPreviewScheduler({
    write: async (value) => { writes.push(value); await gate },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    minIntervalMs: 0,
  })
  s.submit('first')
  await clock.advance(150)
  s.submit('second')
  s.dispose()
  release()
  await clock.advance(50)
  assert.deepEqual(writes, ['first'])
})


test('A→B→A before completion ends with A', async () => {
  const clock = makeClock()
  const writes = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const s = createBoundedPreviewScheduler({
    write: async (value) => { writes.push(value); if (value === 'A') await gate },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    minIntervalMs: 0,
  })
  s.submit('A')
  await clock.advance(150)
  s.submit('B')
  s.submit('A')
  release()
  await s.flush()
  assert.equal(writes.at(-1), 'A')
})


test('flush rejects instead of hanging when a raw transport never settles', async () => {
  const clock = makeClock()
  const s = createBoundedPreviewScheduler({
    write: () => new Promise(() => {}),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    minIntervalMs: 0, writeTimeoutMs: 100,
  })
  s.submit('hang')
  const pendingFlush = s.flush().then(() => null, (error) => error)
  await clock.advance(150)
  const error = await pendingFlush
  assert.match(String(error?.message ?? error), /timeout/)
  assert.equal(s.snapshot().failed, true)
})
