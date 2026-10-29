/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Step 3.3-B — staging preview helpers and Host write/ack/recover.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computePreviewPermalink,
  injectPreviewMeta,
  readPreviewMeta,
  stripStagingSlug,
  previewTarget,
  normalizePreviewSource,
  previewRelPath,
} from '../../prototypes/phase2/dsh-bundle/lib/preview.mjs'
import { computeDocId } from '../../prototypes/phase2/dsh-bundle/lib/docindex.js'
import { backupDirName, legacyBackupDirName } from '../../prototypes/phase2/dsh-bundle/lib/backup-path.mjs'
import {
  handlePreview,
  handlePreviewAck,
  handlePreviewRecover,
  handleSave,
  ensurePreviewMirror,
  previewReady,
  PREVIEW_ROOT,
  PREVIEW_MANIFEST,
} from '../../prototypes/phase2/dsh-bundle/lib/index.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SOURCE = 'docs/ASM/Chapter7/02-energy-fluctuations.mdx'
const SESSION = 'test-preview-session'

test('preview helpers: source-based permalink, dedupe, slug strip, meta injection', () => {
  assert.equal(normalizePreviewSource(SOURCE), SOURCE)
  assert.equal(computePreviewPermalink(SOURCE), '/__live-preview/ASM/Chapter7/energy-fluctuations/')
  assert.equal(computePreviewPermalink('docs/ASM/Chapter7/index.mdx'), '/__live-preview/ASM/Chapter7/')
  assert.equal(previewTarget(PREVIEW_ROOT, SOURCE), path.join(PREVIEW_ROOT, 'ASM/Chapter7/02-energy-fluctuations.mdx'))
  assert.equal(previewTarget(PREVIEW_ROOT, 'docs/../package.json'), null)
  const stripped = stripStagingSlug('---\ntitle: x\nslug: /ASM/chapter-7\n---\n# hi\n')
  assert.equal(stripped.includes('slug:'), false)
  assert.equal(stripped.includes('title: x'), true)
  const withMeta = injectPreviewMeta(stripped, { session: SESSION, revision: 2 })
  assert.deepEqual(readPreviewMeta(withMeta), { session: SESSION, revision: 2 })
  const replaced = injectPreviewMeta(withMeta, { session: 's2', revision: 3 })
  assert.deepEqual(readPreviewMeta(replaced), { session: 's2', revision: 3 })
})

test('Host preview write/ack/recover only touches the staging root', async () => {
  await ensurePreviewMirror()
  assert.equal(await previewReady(), true)
  assert.ok(await fs.stat(PREVIEW_MANIFEST))
  const real = path.join(ROOT, 'prototypes/phase2/site/docs/ASM/Chapter7/02-energy-fluctuations.mdx')
  const before = await fs.readFile(real, 'utf8')
  const staging = path.join(PREVIEW_ROOT, 'ASM/Chapter7/02-energy-fluctuations.mdx')
  const call = (fn, body) => fn(null, new Request('http://dsh.local/api/live-editor/preview', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  const valid = before.replace('# Synthetic 02 Energy Fluctuations', '# Synthetic 02 Energy Fluctuations (preview test)')
  const docId = computeDocId(previewRelPath(SOURCE))
  const first = await call(handlePreview, { source: SOURCE, docId, text: valid, session: SESSION, revision: 1, epoch: 1 })
  assert.equal(first.status, 200)
  const firstBody = await first.clone().json()
  assert.equal(firstBody.structural, false, 'first write compares against existing staging')
  const staged = await fs.readFile(staging, 'utf8')
  assert.deepEqual(readPreviewMeta(staged), { session: SESSION, revision: 1 })
  assert.equal(staged.includes('(preview test)'), true)
  const ack = await call(handlePreviewAck, { source: SOURCE, docId, session: SESSION, revision: 1, epoch: 1 })
  assert.equal(ack.status, 200)
  const structuralText = valid.replace(/^title: .+$/m, 'title: Structural preview test')
  const structural = await call(handlePreview, { source: SOURCE, docId, text: structuralText, session: SESSION, revision: 2, epoch: 1 })
  assert.equal(structural.status, 200)
  const structuralBody = await structural.clone().json()
  assert.equal(structuralBody.structural, true)
  const invalid = await call(handlePreview, { source: SOURCE, docId, text: `${before}\n\n<Broken\n`, session: SESSION, revision: 3, epoch: 1 })
  assert.equal(invalid.status, 200)
  const recover = await call(handlePreviewRecover, { source: SOURCE, docId, session: SESSION, epoch: 1 })
  assert.equal(recover.status, 200)
  const recovered = await fs.readFile(staging, 'utf8')
  assert.deepEqual(readPreviewMeta(recovered), { session: SESSION, revision: 1 })
  assert.equal(recovered.includes('<Broken'), false)
  assert.equal(await fs.readFile(real, 'utf8'), before)
})

function callApi(fn, body, { origin = 'dsh-app://app' } = {}) {
  return fn(null, new Request('http://dsh.local/api/live-editor/preview', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

const REAL = path.join(ROOT, 'prototypes/phase2/site/docs/ASM/Chapter7/02-energy-fluctuations.mdx')
const BACKUPS = path.join(ROOT, 'prototypes/phase2/site/.dsh-live-editor/backups')
const docIdFor = (source) => computeDocId(previewRelPath(source))

test('模型 B：连续 staging 写入不改变真实 docs/备份，frontmatter 只进 staging', async () => {
  await ensurePreviewMirror()
  const beforeText = await fs.readFile(REAL, 'utf8')
  const beforeHash = (await import('node:crypto')).createHash('sha256').update(beforeText).digest('hex')
  const beforeStat = await fs.stat(REAL)
  const backupsBefore = await fs.readdir(BACKUPS).catch(() => [])
  const docId = docIdFor(SOURCE)
  for (let revision = 1; revision <= 3; revision += 1) {
    const response = await callApi(handlePreview, {
      source: SOURCE, docId, text: beforeText.replace('# Synthetic 02 Energy Fluctuations', `# Synthetic 02 Energy Fluctuations model-b-${revision}`),
      session: 'model-b-session', revision, epoch: 50,
    })
    assert.equal(response.status, 200)
  }
  const afterText = await fs.readFile(REAL, 'utf8')
  const afterStat = await fs.stat(REAL)
  const afterHash = (await import('node:crypto')).createHash('sha256').update(afterText).digest('hex')
  assert.equal(afterHash, beforeHash)
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs)
  assert.equal(afterText.includes('dsh_preview_session'), false)
  const staged = await fs.readFile(path.join(PREVIEW_ROOT, 'ASM/Chapter7/02-energy-fluctuations.mdx'), 'utf8')
  assert.equal(staged.includes('dsh_preview_session'), true)
  assert.equal(staged.includes('model-b-3'), true)
  const backupsAfter = await fs.readdir(BACKUPS).catch(() => [])
  assert.deepEqual(backupsAfter, backupsBefore)
})

test('preview API 安全：路径/allowlist/docId/session/revision/epoch/origin/大小', async () => {
  await ensurePreviewMirror()
  const docId = docIdFor(SOURCE)
  const text = await fs.readFile(REAL, 'utf8')
  const base = { source: SOURCE, docId, session: 'security-session', revision: 1, epoch: 60, text }
  assert.equal((await callApi(handlePreview, { ...base, source: 'docs/../package.json' })).status, 400)
  assert.equal((await callApi(handlePreview, { ...base, source: '/tmp/dsh-absolute-test.mdx' })).status, 400)
  assert.equal((await callApi(handlePreview, { ...base, source: 'docs/__not_in_docs__.mdx' })).status, 404)
  assert.equal((await callApi(handlePreview, { ...base, docId: 'wrong/doc' })).status, 400)
  assert.equal((await callApi(handlePreview, { ...base, session: 'bad session with spaces' })).status, 400)
  assert.equal((await callApi(handlePreview, { ...base, revision: 0 })).status, 400)
  assert.equal((await callApi(handlePreview, { ...base, revision: -1 })).status, 400)
  assert.equal((await callApi(handlePreview, { ...base, epoch: -1 })).status, 400)
  assert.equal((await callApi(handlePreview, base, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await callApi(handlePreview, { ...base, text: 'x'.repeat(4 * 1024 * 1024 + 1) })).status, 413)
  const link = path.join(ROOT, 'prototypes/phase2/site/docs/__preview_symlink.mdx')
  await fs.symlink('/tmp/__dsh_preview_nope__.mdx', link)
  try {
    assert.equal((await callApi(handlePreview, { ...base, source: 'docs/__preview_symlink.mdx' })).status, 400)
  } finally {
    await fs.rm(link, { force: true })
  }
})

test('preview session/revision 竞态：旧 epoch/旧 revision/旧 ack/recover 不得覆盖当前', async () => {
  await ensurePreviewMirror()
  const docId = docIdFor(SOURCE)
  const text = await fs.readFile(REAL, 'utf8')
  const body = (overrides = {}) => ({
    source: SOURCE, docId, session: 'race-A', revision: 1, epoch: 100, text, ...overrides,
  })
  assert.equal((await callApi(handlePreview, body())).status, 200)
  assert.equal((await callApi(handlePreview, body({ epoch: 99, revision: 2, session: 'race-old' }))).status, 409)
  assert.equal((await callApi(handlePreview, body({ revision: 1 }))).status, 409)
  assert.equal((await callApi(handlePreview, body({ revision: 2, session: 'race-B', text: text.replace('# Synthetic 02 Energy Fluctuations', '# Synthetic 02 Energy Fluctuations B') }))).status, 409)
  assert.equal((await callApi(handlePreview, body({ revision: 2, text: text.replace('# Synthetic 02 Energy Fluctuations', '# Synthetic 02 Energy Fluctuations rev2') }))).status, 200)
  assert.equal((await callApi(handlePreviewAck, body({ revision: 2 }))).status, 200)
  assert.equal((await callApi(handlePreviewAck, body({ revision: 1 }))).status, 409)
  assert.equal((await callApi(handlePreviewRecover, body({ epoch: 99 }))).status, 409)
  assert.equal((await callApi(handlePreviewRecover, body())).status, 200)
  const staged = await fs.readFile(path.join(PREVIEW_ROOT, 'ASM/Chapter7/02-energy-fluctuations.mdx'), 'utf8')
  assert.equal(staged.includes('rev2'), true)
})

test('staging 生命周期：manifest、陈旧/缺失文件、真实 docs 变化与恢复', async () => {
  await ensurePreviewMirror()
  assert.equal(await previewReady(), true)
  const manifest = JSON.parse(await fs.readFile(PREVIEW_MANIFEST, 'utf8'))
  assert.equal(manifest.docsCount, 32)
  assert.equal(typeof manifest.sourceDigest, 'string')
  assert.ok(Array.isArray(manifest.files))
  assert.equal(manifest.files.length, manifest.fileCount)

  // 陈旧 staging 文件：digest 不再匹配
  const stale = path.join(PREVIEW_ROOT, 'STALE.mdx')
  await fs.writeFile(stale, '# stale')
  assert.equal(await previewReady(), false)
  assert.equal((await callApi(handlePreview, {
    source: SOURCE, docId: docIdFor(SOURCE), session: 'lifecycle-session', revision: 1, epoch: 70,
    text: await fs.readFile(REAL, 'utf8'),
  })).status, 503)
  await ensurePreviewMirror()
  assert.equal(await fs.stat(stale).then(() => true).catch(() => false), false)
  assert.equal(await previewReady(), true)

  // 缺失 staging 文件
  const missing = path.join(PREVIEW_ROOT, 'ASM/Chapter7/index.mdx')
  await fs.rm(missing, { force: true })
  assert.equal(await previewReady(), false)
  await ensurePreviewMirror()
  assert.equal(await fs.readFile(missing, 'utf8').then(() => true).catch(() => false), true)
  assert.equal(await previewReady(), true)

  // 损坏 manifest
  await fs.writeFile(PREVIEW_MANIFEST, '{}')
  assert.equal(await previewReady(), false)
  await ensurePreviewMirror()
  assert.equal(await previewReady(), true)

  // 真实 docs 在 manifest 之后变化 -> stale，镜像重建后恢复
  const temp = path.join(ROOT, 'prototypes/phase2/site/docs/__preview_lifecycle_tmp.mdx')
  await fs.writeFile(temp, '# temp\n')
  try {
    assert.equal(await previewReady(), false)
    await ensurePreviewMirror()
    assert.equal(await previewReady(), true)
  } finally {
    await fs.rm(temp, { force: true })
  }
  await ensurePreviewMirror()
  assert.equal(await previewReady(), true)
})


test('Cmd+S 刷新 sourceDigest，不使 previewReady 失效', async () => {
  await ensurePreviewMirror()
  const { createHash } = await import('node:crypto')
  // Use a dedicated probe file: this test must never write the GUI fixture
  // (docs/01-intro.mdx), which may be open in a running DSH session.
  const probeFile = path.join(ROOT, 'prototypes/phase2/site/docs/__preview_save_probe.mdx')
  const probeRel = 'docs/__preview_save_probe.mdx'
  const before = '# probe base\n'
  await fs.mkdir(path.dirname(probeFile), { recursive: true })
  await fs.writeFile(probeFile, before)
  await ensurePreviewMirror()
  const expectedHash = createHash('sha1').update(before).digest('hex')
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    fs: {
      resolve: async () => probeFile,
      stat: async () => ({ type: 'file', version: 1 }),
      readText: async () => before,
      writeText: async (_target, content) => { await fs.writeFile(probeFile, content); return { version: 2, after: content } },
    },
  }
  try {
    const response = await handleSave(ctx, new Request('http://dsh.local/api/live-editor/save', {
      method: 'POST',
      headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
      body: JSON.stringify({ path: probeRel, expectedHash, content: '# saved probe\n' }),
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.previewReady, true)
    assert.equal(await previewReady(), true)
    const manifest = JSON.parse(await fs.readFile(PREVIEW_MANIFEST, 'utf8'))
    // The real file changed, but the manifest sourceDigest must have been refreshed.
    assert.equal(typeof manifest.sourceDigest, 'string')
    assert.equal(await fs.readFile(probeFile, 'utf8'), '# saved probe\n')
  } finally {
    await fs.rm(probeFile, { force: true })
    for (const name of [backupDirName(probeRel), legacyBackupDirName(probeRel)]) {
      await fs.rm(path.join(ROOT, 'prototypes/phase2/site/.dsh-live-editor/backups', name), { recursive: true, force: true })
    }
    await ensurePreviewMirror()
  }
  assert.equal(await previewReady(), true)
})

test('new preview session cannot inherit previous lastGood', async () => {
  await ensurePreviewMirror()
  const docId = docIdFor(SOURCE)
  const text = await fs.readFile(REAL, 'utf8')
  const epochA = 4000000000000
  const sessionA = 'session-A-lastgood'
  const sessionB = 'session-B-lastgood'
  const baseA = { source: SOURCE, docId, text, session: sessionA, epoch: epochA }
  assert.equal((await callApi(handlePreview, { ...baseA, revision: 1 })).status, 200)
  assert.equal((await callApi(handlePreviewAck, { ...baseA, revision: 1 })).status, 200)

  const baseB = { source: SOURCE, docId, text: text.replace('# Synthetic 02 Energy Fluctuations', '# Synthetic 02 Energy Fluctuations B'), session: sessionB, epoch: epochA + 1 }
  assert.equal((await callApi(handlePreview, { ...baseB, revision: 1 })).status, 200)
  // Old lastGood (session A) must not be recoverable by the new session B.
  assert.equal((await callApi(handlePreviewRecover, { ...baseB })).status, 409)
  assert.equal((await callApi(handlePreviewAck, { ...baseB, revision: 1 })).status, 200)
  assert.equal((await callApi(handlePreviewRecover, { ...baseB })).status, 200)
})


test('multi-tab: later session epoch wins; older session cannot overwrite', async () => {
  await ensurePreviewMirror()
  const source = 'docs/ASM/Chapter7/index.mdx'
  const real = path.join(ROOT, 'prototypes/phase2/site/docs/ASM/Chapter7/index.mdx')
  const staging = path.join(PREVIEW_ROOT, 'ASM/Chapter7/index.mdx')
  const before = await fs.readFile(real, 'utf8')
  const docId = computeDocId(previewRelPath(source))
  const call = (body) => handlePreview(null, new Request('http://dsh.local/api/live-editor/preview', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ source, docId, ...body }),
  }))
  const epoch = Date.now() + 1000
  const sessionA = `mt-a-${epoch}`
  const sessionB = `mt-b-${epoch}`
  assert.equal((await call({ text: `${before}\n\nMT-A1`, session: sessionA, revision: 1, epoch })).status, 200)
  assert.equal((await call({ text: `${before}\n\nMT-B1`, session: sessionB, revision: 1, epoch: epoch + 1 })).status, 200)
  const old = await call({ text: `${before}\n\nMT-A2`, session: sessionA, revision: 2, epoch })
  assert.equal(old.status, 409)
  assert.equal((await old.clone().json()).code, 'STALE_SESSION')
  assert.equal((await call({ text: `${before}\n\nMT-B2`, session: sessionB, revision: 2, epoch: epoch + 1 })).status, 200)
  const staged = await fs.readFile(staging, 'utf8')
  assert.equal(staged.includes('MT-B2'), true)
  assert.equal(staged.includes('MT-A2'), false)
  assert.equal(await fs.readFile(real, 'utf8'), before)
  await ensurePreviewMirror()
})


test('stale requests cannot clear lastGood; concurrent writes are serialized', async () => {
  await ensurePreviewMirror()
  const source = 'docs/ASM/Chapter7/index.mdx'
  const real = path.join(ROOT, 'prototypes/phase2/site/docs/ASM/Chapter7/index.mdx')
  const staging = path.join(PREVIEW_ROOT, 'ASM/Chapter7/index.mdx')
  const before = await fs.readFile(real, 'utf8')
  const docId = computeDocId(previewRelPath(source))
  const call = (body) => handlePreview(null, new Request('http://dsh.local/api/live-editor/preview', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ source, docId, ...body }),
  }))
  const ackCall = (body) => handlePreviewAck(null, new Request('http://dsh.local/api/live-editor/preview/ack', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ source, docId, ...body }),
  }))
  const recoverCall = (body) => handlePreviewRecover(null, new Request('http://dsh.local/api/live-editor/preview/recover', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ source, docId, ...body }),
  }))
  const epoch = Date.now() + 5000
  const good = `sa-${epoch}`
  assert.equal((await call({ text: `${before}\n\nLKG`, session: good, revision: 1, epoch })).status, 200)
  assert.equal((await ackCall({ session: good, revision: 1, epoch })).status, 200)
  assert.equal((await call({ text: `${before}\n\nSTALE`, session: `stale-${epoch}`, revision: 1, epoch: epoch - 1 })).status, 409)
  assert.equal((await recoverCall({ session: good, epoch })).status, 200)

  const c = `c-${epoch}`
  const d = `d-${epoch}`
  const results = await Promise.all([
    call({ text: `${before}\n\nCONCURRENT-C`, session: c, revision: 1, epoch: epoch + 1 }),
    call({ text: `${before}\n\nCONCURRENT-D`, session: d, revision: 1, epoch: epoch + 2 }),
  ])
  assert.deepEqual(results.map((r) => r.status), [200, 200])
  const staged = await fs.readFile(staging, 'utf8')
  assert.equal(staged.includes('CONCURRENT-D'), true)
  assert.equal(staged.includes('CONCURRENT-C'), false)
  assert.equal(await fs.readFile(real, 'utf8'), before)
  await ensurePreviewMirror()
})
