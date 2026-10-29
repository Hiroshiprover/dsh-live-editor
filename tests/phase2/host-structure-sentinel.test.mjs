/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Structural save must publish the one-shot staging reload sentinel; a
 * body-only save must not. Uses the real test-site file system with a probe
 * document, like the other Host save tests, and a temp sentinel path so the
 * live site signal is untouched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../..')
const DIAG = path.join(os.tmpdir(), `dsh-structure-sentinel-${process.pid}-${Date.now()}.jsonl`)
const SENTINEL = path.join(os.tmpdir(), `dsh-structure-sentinel-${process.pid}-${Date.now()}.json`)
process.env.DSH_LIVE_EDITOR_DIAG_FILE = DIAG
process.env.DSH_LIVE_EDITOR_STRUCTURE_SENTINEL = SENTINEL

const HOST = path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/index.js')
const { handleSave, ensurePreviewMirror } = await import(pathToFileURL(HOST).href)
const { backupDirName, legacyBackupDirName } = await import(pathToFileURL(path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/backup-path.mjs')).href)

const SITE = path.join(ROOT, 'prototypes/phase2/site')
const REL = 'docs/__structure_sentinel_test.mdx'
const ABS = path.join(SITE, REL)
const BACKUP_DIR = path.join(SITE, '.dsh-live-editor/backups', backupDirName(REL))
const LEGACY_BACKUP_DIR = path.join(SITE, '.dsh-live-editor/backups', legacyBackupDirName(REL))

const bodyOnly = (title) => `---\ntitle: ${title}\n---\n\n# Heading\n`
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

async function save (content, expectedText) {
  return handleSave(ctx, new Request('http://dsh.local/api/live-editor/save', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({
      path: REL,
      expectedHash: createHash('sha1').update(expectedText).digest('hex'),
      content,
    }),
  }))
}

test('structural save publishes one sentinel; body-only save does not', async () => {
  const before = bodyOnly('A').replace('# Heading', '# Heading A')
  const bodyOnlyAfter = bodyOnly('A').replace('# Heading', '# Heading B')
  const structuralAfter = bodyOnly('B').replace('# Heading', '# Heading B')
  await fs.mkdir(path.dirname(ABS), { recursive: true })
  await fs.writeFile(ABS, before)
  await fs.rm(BACKUP_DIR, { recursive: true, force: true })
  await fs.rm(LEGACY_BACKUP_DIR, { recursive: true, force: true })
  await fs.rm(SENTINEL, { force: true })
  try {
    const bodyResponse = await save(bodyOnlyAfter, before)
    assert.equal(bodyResponse.status, 200)
    await assert.rejects(fs.readFile(SENTINEL, 'utf8'))

    const structuralResponse = await save(structuralAfter, bodyOnlyAfter)
    assert.equal(structuralResponse.status, 200)
    const sentinel = JSON.parse(await fs.readFile(SENTINEL, 'utf8'))
    assert.equal(sentinel.version, 1)
    assert.equal(sentinel.path, REL)
    assert.equal(typeof sentinel.requestId, 'string')

    const lines = (await fs.readFile(DIAG, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const saveEvent = lines.filter((entry) => entry.event === 'save' && entry.path === REL).at(-1)
    assert.equal(saveEvent.structural, true)
    assert.equal(saveEvent.requestId, sentinel.requestId)
  } finally {
    await fs.rm(ABS, { force: true })
    await fs.rm(BACKUP_DIR, { recursive: true, force: true })
  await fs.rm(LEGACY_BACKUP_DIR, { recursive: true, force: true })
    await fs.rm(SENTINEL, { force: true })
    await ensurePreviewMirror()
    await fs.rm(DIAG, { force: true }).catch(() => {})
  }
})
