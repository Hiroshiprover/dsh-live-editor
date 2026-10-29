/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Phase 5-P0 — save safety failure injection.
 *
 * These tests exercise the Host save/restore boundary with a minimal ctx.fs
 * mock backed by the real test-site filesystem. They cover the cases the
 * happy-path tests cannot: backup failure, adapter write verification,
 * post-write external change, stale CAS, multi-writer ordering, durable
 * backup shape, and restore failure audit.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../..')
const DIAG = path.join(os.tmpdir(), `dsh-save-safety-${process.pid}-${Date.now()}.jsonl`)
process.env.DSH_LIVE_EDITOR_DIAG_FILE = DIAG
delete process.env.DSH_LIVE_EDITOR_DIAG

const HOST = path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/index.js')
const { handleSave, handleRestore, ensurePreviewMirror } = await import(pathToFileURL(HOST).href)

const SITE = path.join(ROOT, 'prototypes/phase2/site')
const REL = 'docs/__save_safety_probe.mdx'
const ABS = path.join(SITE, REL)
const BACKUP_PATH = await import(pathToFileURL(path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/backup-path.mjs')).href)
const BACKUP_DIR = path.join(SITE, '.dsh-live-editor/backups', BACKUP_PATH.backupDirName(REL))
const LEGACY_BACKUP_DIR = path.join(SITE, '.dsh-live-editor/backups', BACKUP_PATH.legacyBackupDirName(REL))
const BEFORE = '# before\n'
const AFTER = '# after\n'

const sha1 = (text) => createHash('sha1').update(text).digest('hex')

function makeCtx (writeText) {
  return {
    logger: { info () {}, warn () {}, error () {} },
    fs: {
      resolve: async (abs) => `handle:${abs}`,
      stat: async () => ({ type: 'file', version: 'v1' }),
      readText: async (handle) => fs.readFile(handle.slice('handle:'.length), 'utf8'),
      writeText,
    },
  }
}

function saveRequest (body) {
  return new Request('http://dsh.local/api/live-editor/save', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function restoreRequest (body) {
  return new Request('http://dsh.local/api/live-editor/restore', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function resetProbe () {
  await fs.mkdir(path.dirname(ABS), { recursive: true })
  await fs.writeFile(ABS, BEFORE)
  await fs.rm(BACKUP_DIR, { recursive: true, force: true })
  await fs.rm(DIAG, { force: true }).catch(() => {})
}

async function cleanupProbe () {
  await fs.rm(ABS, { force: true })
  await fs.rm(BACKUP_DIR, { recursive: true, force: true })
  await ensurePreviewMirror().catch(() => {})
}

async function readAudit () {
  try {
    const text = await fs.readFile(DIAG, 'utf8')
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('backup failure returns 503 and never calls the formal write', async () => {
  await resetProbe()
  // Make the per-document backup directory path a regular file: mkdir fails
  // before the backup can be written, so the formal write must not start.
  await fs.mkdir(path.dirname(BACKUP_DIR), { recursive: true })
  await fs.writeFile(BACKUP_DIR, 'not a directory')
  let writes = 0
  const ctx = makeCtx(async (handle, content) => {
    writes += 1
    await fs.writeFile(handle.slice('handle:'.length), content)
    return { version: 'v2', after: content }
  })
  try {
    const response = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1(BEFORE), content: AFTER }))
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.code, 'BACKUP_FAILED')
    assert.equal(writes, 0, 'writeText must not be called when the backup fails')
    assert.equal(await fs.readFile(ABS, 'utf8'), BEFORE)
    const audit = await readAudit()
    const rejected = audit.filter((entry) => entry.event === 'save' && entry.code === 'BACKUP_FAILED')
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].status, 503)
    assert.equal(rejected[0].path, REL)
  } finally {
    await fs.rm(BACKUP_DIR, { force: true })
    await cleanupProbe()
  }
})

test('adapter write-verification mismatch returns 500, not a false success', async () => {
  await resetProbe()
  const ctx = makeCtx(async (handle, content) => {
    // Simulate an adapter that reports a different committed payload.
    await fs.writeFile(handle.slice('handle:'.length), `${content} tampered`)
    return { version: 'v2', after: `${content} tampered` }
  })
  try {
    const response = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1(BEFORE), content: AFTER }))
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.code, 'WRITE_VERIFY_FAILED')
    const audit = await readAudit()
    const failed = audit.find((entry) => entry.event === 'save' && entry.code === 'WRITE_VERIFY_FAILED')
    assert.ok(failed !== undefined)
    assert.equal(failed.adapterAfterLen, Buffer.byteLength(AFTER) + ' tampered'.length)
  } finally {
    await cleanupProbe()
  }
})

test('CRLF content is verified against the adapter LF-normalized outcome', async () => {
  await resetProbe()
  const crlfBefore = '# before\r\n\r\nline\r\n'
  const crlfAfter = '# after\r\n\r\nnew line\r\n'
  await fs.writeFile(ABS, crlfBefore)
  const ctx = makeCtx(async (handle, content) => {
    await fs.writeFile(handle.slice('handle:'.length), content)
    return { version: 'v2', after: content.replaceAll('\r\n', '\n') }
  })
  try {
    const response = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1(crlfBefore), content: crlfAfter }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.verified, true)
    assert.equal(await fs.readFile(ABS, 'utf8'), crlfAfter)
  } finally {
    await cleanupProbe()
  }
})

test('post-write external change returns 409 POST_WRITE_CHANGED and keeps the conflict evidence', async () => {
  await resetProbe()
  const ctx = makeCtx(async (handle, content) => {
    await fs.writeFile(handle.slice('handle:'.length), content)
    // Another writer replaces the file immediately after our commit.
    await fs.writeFile(ABS, 'OTHER WRITER\n')
    return { version: 'v2', after: content }
  })
  try {
    const response = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1(BEFORE), content: AFTER }))
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.code, 'POST_WRITE_CHANGED')
    assert.equal(body.currentHash, sha1('OTHER WRITER\n'))
    assert.equal(await fs.readFile(ABS, 'utf8'), 'OTHER WRITER\n')
    const audit = await readAudit()
    const conflict = audit.find((entry) => entry.event === 'save' && entry.code === 'POST_WRITE_CHANGED')
    assert.ok(conflict !== undefined)
    assert.equal(conflict.currentHash, sha1('OTHER WRITER\n'))
    assert.equal(typeof conflict.after.fnv, 'string') // readback recorded
    assert.equal(conflict.backup.endsWith('.mdx'), true)
  } finally {
    await cleanupProbe()
  }
})

test('stale expectedHash is rejected before any backup or write', async () => {
  await resetProbe()
  let writes = 0
  const ctx = makeCtx(async (handle, content) => {
    writes += 1
    await fs.writeFile(handle.slice('handle:'.length), content)
    return { version: 'v2', after: content }
  })
  try {
    const response = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1('something else'), content: AFTER }))
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.code, 'STALE')
    assert.equal(writes, 0)
    assert.equal(await fs.readFile(ABS, 'utf8'), BEFORE)
    await assert.rejects(fs.stat(BACKUP_DIR))
    const audit = await readAudit()
    assert.ok(audit.some((entry) => entry.event === 'save' && entry.status === 409 && entry.code === 'STALE'))
  } finally {
    await cleanupProbe()
  }
})

test('two writers with the same expectedHash: first wins, second gets STALE', async () => {
  await resetProbe()
  let writes = 0
  const ctx = makeCtx(async (handle, content) => {
    writes += 1
    await fs.writeFile(handle.slice('handle:'.length), content)
    return { version: `v${writes + 1}`, after: content }
  })
  try {
    const first = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1(BEFORE), content: 'FIRST\n' }))
    assert.equal(first.status, 200)
    const second = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1(BEFORE), content: 'SECOND\n' }))
    assert.equal(second.status, 409)
    const body = await second.json()
    assert.equal(body.code, 'STALE')
    assert.equal(writes, 1, 'the losing writer must not reach the adapter')
    assert.equal(await fs.readFile(ABS, 'utf8'), 'FIRST\n')
  } finally {
    await cleanupProbe()
  }
})

test('FS_STALE_VERSION from the adapter maps to 409 and is audited', async () => {
  await resetProbe()
  const ctx = makeCtx(async () => {
    throw Object.assign(new Error('file changed since it was read'), { code: 'FS_STALE_VERSION' })
  })
  try {
    const response = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1(BEFORE), content: AFTER }))
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.code, 'STALE')
    const audit = await readAudit()
    assert.ok(audit.some((entry) => entry.event === 'save' && entry.code === 'FS_STALE_VERSION'))
    assert.equal(await fs.readFile(ABS, 'utf8'), BEFORE)
  } finally {
    await cleanupProbe()
  }
})

test('a successful save leaves one durable backup and no temp residue', async () => {
  await resetProbe()
  const ctx = makeCtx(async (handle, content) => {
    await fs.writeFile(handle.slice('handle:'.length), content)
    return { version: 'v2', after: content }
  })
  try {
    const response = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1(BEFORE), content: AFTER }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.verified, true)
    const entries = await fs.readdir(BACKUP_DIR)
    const backups = entries.filter((name) => name.endsWith('.mdx'))
    assert.equal(backups.length, 1)
    assert.equal(entries.some((name) => name.endsWith('.tmp')), false)
    assert.equal(await fs.readFile(path.join(BACKUP_DIR, backups[0]), 'utf8'), BEFORE)
    const audit = await readAudit()
    const saved = audit.filter((entry) => entry.event === 'save' && entry.status === 200).at(-1)
    assert.equal(saved.backupBytes, Buffer.byteLength(BEFORE))
    assert.equal(saved.adapterVerified, true)
    assert.equal(saved.verified, true)
    assert.ok(['ok', 'unsupported'].includes(saved.backupDirSync) || String(saved.backupDirSync).startsWith('error:'))
  } finally {
    await cleanupProbe()
  }
})

test('a readback failure is WRITE_UNCONFIRMED, not a clean success', async () => {
  await resetProbe()
  const ctx = makeCtx(async (handle, content) => {
    await fs.writeFile(handle.slice('handle:'.length), content)
    // Simulate the file disappearing before the Host readback.
    await fs.rm(ABS, { force: true })
    return { version: 'v2', after: content }
  })
  try {
    const response = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1(BEFORE), content: AFTER }))
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.code, 'WRITE_UNCONFIRMED')
    const audit = await readAudit()
    const entry = audit.find((item) => item.event === 'save' && item.code === 'WRITE_UNCONFIRMED')
    assert.ok(entry !== undefined)
    assert.equal(entry.backup.endsWith('.mdx'), true)
    assert.ok(entry.readbackError)
  } finally {
    await cleanupProbe()
  }
})

test('a missing adapter after value is not a clean success', async () => {
  await resetProbe()
  const ctx = makeCtx(async (handle, content) => {
    await fs.writeFile(handle.slice('handle:'.length), content)
    return { version: 'v2' }
  })
  try {
    const response = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1(BEFORE), content: AFTER }))
    assert.equal(response.status, 500)
    const body = await response.json()
    assert.equal(body.code, 'WRITE_VERIFY_FAILED')
    assert.equal(await fs.readFile(ABS, 'utf8'), AFTER)
  } finally {
    await cleanupProbe()
  }
})

test('backup content-write failure (read-only backup dir) stops the formal write', async () => {
  await resetProbe()
  await fs.mkdir(BACKUP_DIR, { recursive: true })
  await fs.chmod(BACKUP_DIR, 0o500)
  let writes = 0
  const ctx = makeCtx(async (handle, content) => {
    writes += 1
    await fs.writeFile(handle.slice('handle:'.length), content)
    return { version: 'v2', after: content }
  })
  try {
    const response = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1(BEFORE), content: AFTER }))
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, 'BACKUP_FAILED')
    assert.equal(writes, 0)
    assert.equal(await fs.readFile(ABS, 'utf8'), BEFORE)
  } finally {
    await fs.chmod(BACKUP_DIR, 0o700).catch(() => {})
    await cleanupProbe()
  }
})

test('retention never prunes the backup it just created', async () => {
  await resetProbe()
  await fs.mkdir(BACKUP_DIR, { recursive: true })
  for (let index = 0; index < 20; index += 1) {
    // Future-dated names simulate clock skew: a naive oldest-first prune would
    // delete the just-created 2026 backup before these.
    await fs.writeFile(path.join(BACKUP_DIR, `2099-01-01T00-00-${String(index).padStart(2, '0')}-000Z-aaaaaaaaaaaa.mdx`), `old-${index}`)
  }
  const ctx = makeCtx(async (handle, content) => {
    await fs.writeFile(handle.slice('handle:'.length), content)
    return { version: 'v2', after: content }
  })
  try {
    const response = await handleSave(ctx, saveRequest({ path: REL, expectedHash: sha1(BEFORE), content: AFTER }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.backup.endsWith('.mdx'), true)
    assert.equal((await fs.stat(body.backup)).isFile(), true)
    const backups = (await fs.readdir(BACKUP_DIR)).filter((name) => name.endsWith('.mdx'))
    assert.equal(backups.length, 20)
    assert.equal(backups.includes(path.basename(body.backup)), true)
  } finally {
    await cleanupProbe()
  }
})

test('restore success and failure are audited separately', async () => {
  await resetProbe()
  const backupFile = '2026-10-26T00-00-00-000Z-aaaaaaaaaaaa.mdx'
  const backupText = '# restored\n'
  await fs.mkdir(BACKUP_DIR, { recursive: true })
  await fs.writeFile(path.join(BACKUP_DIR, backupFile), backupText)
  const ctx = makeCtx(async (handle, content) => {
    await fs.writeFile(handle.slice('handle:'.length), content)
    return { version: 'v2', after: content }
  })
  try {
    const ok = await handleRestore(ctx, restoreRequest({ path: REL, backupFile, expectedHash: sha1(BEFORE) }))
    assert.equal(ok.status, 200)
    assert.equal(await fs.readFile(ABS, 'utf8'), backupText)
    let audit = await readAudit()
    const result = audit.filter((entry) => entry.event === 'restore-result').at(-1)
    assert.equal(result.status, 200)

    const stale = await handleRestore(ctx, restoreRequest({ path: REL, backupFile, expectedHash: sha1(BEFORE) }))
    assert.equal(stale.status, 409)
    audit = await readAudit()
    const staleResult = audit.filter((entry) => entry.event === 'restore-result').at(-1)
    assert.equal(staleResult.status, 409)

    const missing = await handleRestore(ctx, restoreRequest({
      path: REL, backupFile: '2026-10-26T00-00-00-000Z-bbbbbbbbbbbb.mdx', expectedHash: sha1(backupText),
    }))
    assert.equal(missing.status, 500)
    audit = await readAudit()
    assert.ok(audit.some((entry) => entry.event === 'restore-error'))
  } finally {
    await cleanupProbe()
  }
})
