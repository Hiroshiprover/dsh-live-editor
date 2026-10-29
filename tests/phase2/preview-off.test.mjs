/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * P2: with preview explicitly off, the Host must reject preview writes rather
 * than creating a staging mirror. The module reads the switch at import time,
 * so exercise it in a child process.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOST = pathToFileURL(path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/index.js')).href

test('preview off rejects preview writes', () => {
  const code = `
    const m = await import(${JSON.stringify(HOST)})
    const response = await m.handlePreview(null, new Request('http://dsh.local/api/live-editor/preview', {
      method: 'POST', headers: { origin: 'dsh-app://app' }, body: '{}',
    }))
    console.log(response.status)
    console.log(await m.previewReady())
  `
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, DSH_LIVE_EDITOR_PREVIEW_CHANNEL: 'off' },
    encoding: 'utf8',
  })
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(out.stdout.trim().split('\n'), ['403', 'false'])
})
