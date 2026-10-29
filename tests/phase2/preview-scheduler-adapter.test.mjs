/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const MODULE = path.resolve(import.meta.dirname, '../../prototypes/phase2/src/state/preview-scheduler.mjs')
const { createPreviewScheduler, createSerializedPreviewWriter, createPreviewWriter, isPreviewSchedulerEnabled, PREVIEW_SCHEDULER_POLICY } = await import(pathToFileURL(MODULE).href)

test('preview scheduler policy is bounded and default-off adapter is lazy', () => {
  assert.deepEqual(PREVIEW_SCHEDULER_POLICY, { debounceMs: 150, maxWaitMs: 300, minIntervalMs: 200 })
  assert.throws(() => createPreviewScheduler({}), /write must be a function/)
})

test('adapter writes only the latest snapshot and supports final flush', async () => {
  const writes = []
  const scheduler = createPreviewScheduler({ write: async (value) => { writes.push(value) } })
  scheduler.submit('a')
  scheduler.submit('b')
  await scheduler.flush()
  assert.deepEqual(writes, ['b'])
  assert.equal(scheduler.snapshot().pending, false)
})


test('replacement scheduler cannot commit old content after a newer write', async () => {
  let release
  let startedResolve
  const started = new Promise((resolve) => { startedResolve = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const writes = []
  let active = 0
  let maxActive = 0
  const serialized = createSerializedPreviewWriter(async (value) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    writes.push(value)
    if (value === 'old') { startedResolve(); await gate }
    active -= 1
  })
  const first = createPreviewScheduler({ write: (value) => serialized('doc-a', value) })
  const second = createPreviewScheduler({ write: (value) => serialized('doc-a', value) })
  first.submit('old')
  await started
  second.submit('new')
  assert.deepEqual(writes, ['old'])
  release()
  await Promise.all([first.flush(), second.flush()])
  assert.deepEqual(writes, ['old', 'new'])
  assert.equal(maxActive, 1)
})


test('scheduler gate requires both active and scheduler flags', () => {
  assert.equal(isPreviewSchedulerEnabled({}), false)
  assert.equal(isPreviewSchedulerEnabled({ __DSH_LIVE_EDITOR_R2__: { active: false, scheduler: true } }), false)
  assert.equal(isPreviewSchedulerEnabled({ __DSH_LIVE_EDITOR_R2__: { active: true, scheduler: false } }), false)
  assert.equal(isPreviewSchedulerEnabled({ __DSH_LIVE_EDITOR_R2__: { active: true, scheduler: true } }), true)
})

test('serialized writer continues after a failed old write and keeps keys independent', async () => {
  const writes = []
  const serialized = createSerializedPreviewWriter(async (value) => {
    writes.push(value)
    if (value === 'bad') throw new Error('bad')
    return value
  })
  await assert.rejects(() => serialized('doc-a', 'bad'))
  await serialized('doc-a', 'good')
  await serialized('doc-b', 'other')
  assert.deepEqual(writes, ['bad', 'good', 'other'])
})


test('serializer strips only the key and forwards preview arguments unchanged', async () => {
  const calls = []
  const serialized = createSerializedPreviewWriter((...args) => { calls.push(args); return args })
  const result = await serialized('docs/a.mdx', 'doc', 'docs/a.mdx', 'text', { session: 's' })
  assert.deepEqual(calls, [['doc', 'docs/a.mdx', 'text', { session: 's' }]])
  assert.deepEqual(result, ['doc', 'docs/a.mdx', 'text', { session: 's' }])
})


test('keyed preview writer passes the original current snapshot to writePreview', async () => {
  const calls = []
  const writer = createPreviewWriter(async (...args) => { calls.push(args); return args })
  const current = { session: 's-1' }
  await writer({ path: 'a' }, 'docs/a.mdx', 'text', current)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [{ path: 'a' }, 'docs/a.mdx', 'text', current])
})


test('formal client uses the tested keyed wrapper, not a hand-written mapping', () => {
  const client = fs.readFileSync(path.resolve(import.meta.dirname, '../../prototypes/phase2/src/client.cjs'), 'utf8')
  assert.match(client, /createPreviewWriter\(writePreview\)/)
  assert.match(client, /isPreviewSchedulerEnabled\(window\)/)
  assert.equal(client.includes('createSerializedPreviewWriter((_key'), false)
})
