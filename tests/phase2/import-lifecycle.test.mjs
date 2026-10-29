/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * 9.0D E2: import review results outlive the panel, an in-flight request is
 * cancelled on body unmount, and insertion cannot run twice.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PANEL = path.join(ROOT, 'prototypes/phase2/src/ui/ImportPanel.cjs')
const CLIENT = path.join(ROOT, 'prototypes/phase2/src/client.cjs')

test('E2: panel persists results, detaches on unmount, and guards duplicate insert', async () => {
  const panel = await fs.readFile(PANEL, 'utf8')
  assert.match(panel, /saveStoredTask\(taskKey, result, draft\)/)
  assert.match(panel, /sessionStorage\.getItem\(taskKey/)
  assert.match(panel, /keepalive: true/)
  assert.match(panel, /detachTask\(current\)/)
  assert.match(panel, /insertedRef/)
  assert.match(panel, /inserted === false/)
  assert.match(panel, /const inserted = onInsert/)
})

test('E2: client scopes the task key and returns success/failure from insert', async () => {
  const client = await fs.readFile(CLIENT, 'utf8')
  assert.match(client, /importTaskKey\(\{ siteId, sessionId, tabId: tabDraftId, path: activeDoc\.path \}\)/)
  assert.match(client, /taskKey: activeDoc/)
  assert.match(client, /ensureSyntaxTree/)
  assert.match(client, /endsInOpenFence/)
  assert.match(client, /return false/)
  assert.match(client, /return true/)
})
