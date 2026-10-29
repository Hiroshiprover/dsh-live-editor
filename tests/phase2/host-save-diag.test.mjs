/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Temporary diagnostics verification: a real save through handleSave must leave
 * a post-write readback (size + FNV) that matches the written content. This
 * exercises the fixed readback path (real file, not the DSH fs handle) with a
 * minimal ctx.fs mock; the file itself is written by the mock into the test
 * site and removed afterwards.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../..')
const DIAG = path.join(os.tmpdir(), `dsh-save-diag-${process.pid}-${Date.now()}.jsonl`)
// The Host reads this path at module load; keep the test out of the live log.
process.env.DSH_LIVE_EDITOR_DIAG_FILE = DIAG
delete process.env.DSH_LIVE_EDITOR_DIAG

const HOST = path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/index.js')
const { handleSave, ensurePreviewMirror } = await import(pathToFileURL(HOST).href)

function fnv1a (text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const SITE = path.join(ROOT, 'prototypes/phase2/site')
const REL = 'docs/__save_readback_test.mdx'
const ABS = path.join(SITE, REL)
const BACKUP_PATH = await import(pathToFileURL(path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/backup-path.mjs')).href)
const BACKUP_DIR = path.join(SITE, '.dsh-live-editor/backups', BACKUP_PATH.backupDirName(REL))
const LEGACY_BACKUP_DIR = path.join(SITE, '.dsh-live-editor/backups', BACKUP_PATH.legacyBackupDirName(REL))

test('save writes a post-write readback that matches the content', async () => {
  const before = '# before\n'
  const after = '# after readback\n'
  await fs.mkdir(path.dirname(ABS), { recursive: true })
  await fs.writeFile(ABS, before)
  await fs.rm(BACKUP_DIR, { recursive: true, force: true })
  const ctx = {
    fs: {
      resolve: async (abs) => `handle:${abs}`,
      stat: async () => ({ type: 'file', version: 'v1' }),
      readText: async (handle) => fs.readFile(handle.slice('handle:'.length), 'utf8'),
      writeText: async (handle, content) => {
        await fs.writeFile(handle.slice('handle:'.length), content)
        return { version: 'v2', after: content }
      },
    },
  }
  try {
    const response = await handleSave(ctx, new Request('http://dsh.local/api/live-editor/save', {
      method: 'POST',
      headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
      body: JSON.stringify({
        path: REL,
        expectedHash: createHash('sha1').update(before).digest('hex'),
        content: after,
      }),
    }))
    assert.equal(response.status, 200)
    assert.equal(await fs.readFile(ABS, 'utf8'), after)
    const lines = (await fs.readFile(DIAG, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const save = lines.filter((entry) => entry.event === 'save').at(-1)
    assert.ok(save !== undefined, 'save event missing')
    assert.equal(save.status, 200)
    assert.equal(save.hasOwnProperty('requestId'), true)
    assert.equal(save.after.len, Buffer.byteLength(after))
    assert.equal(save.after.fnv, fnv1a(after))
    assert.equal(save.verified, true)
  } finally {
    await fs.rm(ABS, { force: true })
    await fs.rm(BACKUP_DIR, { recursive: true, force: true })
    await ensurePreviewMirror()
    await fs.rm(DIAG, { force: true }).catch(() => {})
  }
})
