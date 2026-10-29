/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Temporary diagnostics verification: restoring a Host backup must write the
 * backup content, produce a verified post-write readback, and carry a request
 * id plus a restore source tag. Uses a minimal ctx.fs mock against the real
 * test-site file system; the probe file and backup are removed afterwards.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../..')
const DIAG = path.join(os.tmpdir(), `dsh-restore-diag-${process.pid}-${Date.now()}.jsonl`)
process.env.DSH_LIVE_EDITOR_DIAG_FILE = DIAG
delete process.env.DSH_LIVE_EDITOR_DIAG

const HOST = path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/index.js')
const { handleRestore, ensurePreviewMirror } = await import(pathToFileURL(HOST).href)

function fnv1a (text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const SITE = path.join(ROOT, 'prototypes/phase2/site')
const REL = 'docs/__restore_probe.mdx'
const ABS = path.join(SITE, REL)
const BACKUP_PATH = await import(pathToFileURL(path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/backup-path.mjs')).href)
const BACKUP_DIR = path.join(SITE, '.dsh-live-editor/backups', BACKUP_PATH.backupDirName(REL))
const LEGACY_BACKUP_DIR = path.join(SITE, '.dsh-live-editor/backups', BACKUP_PATH.legacyBackupDirName(REL))
const BACKUP_FILE = '2026-10-24T00-00-00-000Z-aaaaaaaaaaaa.mdx'

test('restore writes the backup content and logs a verified readback', async () => {
  const original = '# restore base\n'
  const backupText = '# restored content\n'
  await fs.mkdir(path.dirname(ABS), { recursive: true })
  await fs.writeFile(ABS, original)
  await fs.mkdir(BACKUP_DIR, { recursive: true })
  await fs.writeFile(path.join(BACKUP_DIR, BACKUP_FILE), backupText)

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
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
    const response = await handleRestore(ctx, new Request('http://dsh.local/api/live-editor/restore', {
      method: 'POST',
      headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
      body: JSON.stringify({
        path: REL,
        backupFile: BACKUP_FILE,
        expectedHash: createHash('sha1').update(original).digest('hex'),
      }),
    }))
    assert.equal(response.status, 200)
    assert.equal(await fs.readFile(ABS, 'utf8'), backupText)

    const lines = (await fs.readFile(DIAG, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const entry = lines.filter((line) => line.event === 'restore-entry').at(-1)
    assert.equal(typeof entry.requestId, 'string')
    const save = lines.filter((line) => line.event === 'save').at(-1)
    assert.equal(save.status, 200)
    assert.equal(save.client.source, 'restore')
    assert.equal(save.requestId, entry.requestId)
    assert.equal(save.after.len, Buffer.byteLength(backupText))
    assert.equal(save.after.fnv, fnv1a(backupText))
    assert.equal(save.verified, true)
  } finally {
    await fs.rm(ABS, { force: true })
    await fs.rm(BACKUP_DIR, { recursive: true, force: true })
    await ensurePreviewMirror()
    await fs.rm(DIAG, { force: true }).catch(() => {})
  }
})
