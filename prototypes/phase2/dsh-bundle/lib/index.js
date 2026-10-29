/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * DSH Live Editor — Phase 2 host bundle.
 *
 * Routes (all owner-only via ctx.connection.fetch):
 *   GET  /api/live-editor/index    NEW: read-only docs index (tree + doc metadata)
 *   GET  /api/live-editor/source   unchanged from Phase 1B
 *   POST /api/live-editor/save     unchanged CAS/backup/path safety
 *   GET  /api/live-editor/backups  unchanged
 *   POST /api/live-editor/restore  unchanged
 *
 * The default write root is the bundled synthetic test site. An external root is
 * opt-in via the local runtime config, and SITE.writable gates every write.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, existsSync, promises as fs, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { backupDirName, backupDirsFor } from './backup-path.mjs'
import { buildIndex, computeDocId } from './docindex.js'
import { registerImportRoutes } from './import.mjs'
import {
  PREVIEW_ROUTE_BASE,
  MAX_PREVIEW_BYTES,
  normalizePreviewSource,
  previewRelPath,
  previewTarget,
  computePreviewPermalink,
  injectPreviewMeta,
  injectR2Markers,
  hasStructuralPreviewChange,
  r2SentinelTarget,
  renderR2Sentinel,
  readPreviewMeta,
  stripStagingSlug,
} from './preview.mjs'

export const name = 'dsh-live-editor-phase2'
export const inject = ['connection', 'fs', 'llm', 'attachments', 'agentDefaultModel']

const TEST_SITE_ROOT = path.resolve(import.meta.dirname, '../../site')
const SITE_CONFIG_FILE = path.join(TEST_SITE_ROOT, '.dsh-live-editor', 'site-config.json')

function safeDevOrigin (value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'http://localhost:3000'
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return 'http://localhost:3000'
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return 'http://localhost:3000'
    return url.origin
  } catch {
    return 'http://localhost:3000'
  }
}

/**
 * Optional runtime site config. It lives in the test site's gitignored state
 * directory. A root outside the bundled test site is accepted only when the
 * config explicitly sets allowExternalSite, so the default cannot silently
 * point at an arbitrary local directory.
 */
function readRuntimeSiteConfig () {
  let raw
  try {
    raw = JSON.parse(readFileSync(SITE_CONFIG_FILE, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`live-editor site config is invalid: ${String(error?.message ?? error)}`)
  }
  if (!raw || typeof raw.root !== 'string' || raw.root.trim().length === 0) {
    throw new Error('live-editor site config requires a non-empty root')
  }
  const root = realpathSync(path.resolve(raw.root))
  const stat = statSync(root)
  if (!stat.isDirectory()) throw new Error('live-editor site config root is not a directory')
  const testRoot = realpathSync(TEST_SITE_ROOT)
  if (root !== testRoot && raw.allowExternalSite !== true) {
    throw new Error('live-editor site config refuses an external root without allowExternalSite')
  }
  return {
    root,
    writable: raw.writable === true,
    devOrigin: safeDevOrigin(raw.devOrigin ?? 'http://localhost:3000'),
    label: typeof raw.label === 'string' ? raw.label : 'Configured site',
    id: typeof raw.id === 'string' ? raw.id : 'configured-site',
  }
}

const RUNTIME_SITE = readRuntimeSiteConfig()
const SITE_ROOT = RUNTIME_SITE === null ? TEST_SITE_ROOT : RUNTIME_SITE.root
const SITE = Object.freeze({
  id: RUNTIME_SITE === null ? 'phase2-test' : RUNTIME_SITE.id,
  label: RUNTIME_SITE === null ? 'Synthetic test site (original fixtures)' : RUNTIME_SITE.label,
  writable: RUNTIME_SITE === null ? true : RUNTIME_SITE.writable === true,
  root: SITE_ROOT,
  docsRoot: path.join(SITE_ROOT, 'docs'),
  devOrigin: RUNTIME_SITE === null ? 'http://localhost:3000' : RUNTIME_SITE.devOrigin,
  routeBasePath: '/docs',
  baseUrl: '/',
  trailingSlash: true,
})
// Stable per-site identity. The test site keeps its historical draft namespace
// ('phase2'), while any other site root gets a path-derived id. A site root
// change therefore cannot silently inherit the test site's drafts.
export function deriveSiteId ({ root, testRoot = TEST_SITE_ROOT } = {}) {
  let real = path.resolve(root)
  try { real = realpathSync(real) } catch { /* keep resolved path */ }
  let testReal = path.resolve(testRoot)
  try { testReal = realpathSync(testReal) } catch { /* keep resolved path */ }
  if (real === testReal) return 'phase2'
  return `site-${createHash('sha256').update(real).digest('hex').slice(0, 16)}`
}
const SITE_ID = (() => {
  const override = process.env.DSH_LIVE_EDITOR_SITE_ID
  if (typeof override === 'string' && override.trim().length > 0) return override.trim()
  return deriveSiteId({ root: SITE.root })
})()

const BACKUP_ROOT = path.join(SITE.root, '.dsh-live-editor', 'backups')
const PREVIEW_ROOT = path.join(SITE.root, '.dsh-live-editor', 'preview-docs')
// One-shot structural reload signal shared with the site adapter. A save that
// changes frontmatter/title/sidebar rewrites this file; the preview docs plugin
// watches it and reloads once, so the staged title/sidebar become current
// without reloading on every body write.
const STRUCTURE_SENTINEL = process.env.DSH_LIVE_EDITOR_STRUCTURE_SENTINEL
  ? path.resolve(process.env.DSH_LIVE_EDITOR_STRUCTURE_SENTINEL)
  : path.join(SITE.root, '.dsh-live-editor', 'structure-reload.json')
const PREVIEW_MANIFEST = path.join(SITE.root, '.dsh-live-editor', 'preview-manifest.json')
const INSTANCES_FILE = path.join(SITE.root, '.dsh-live-editor', 'instances.json')
// Low-volume save/restore audit (requestId, CAS hashes, post-write readback).
// The high-frequency client diagnostics were removed after the read-only viewer
// Step; this file is append-only and never used by product logic.
const DIAG_FILE = process.env.DSH_LIVE_EDITOR_DIAG_FILE || path.join(SITE.root, '.dsh-live-editor', 'save-audit.jsonl')
const DIAG_MAX_BYTES = 8 * 1024 * 1024
const HOST_BOOT_AT = new Date().toISOString()
const HOST_PID = process.pid
// One rollback switch shared with the site and client. Off means safe
// degradation: editing/draft recovery only, no live preview.
const PREVIEW_CHANNEL_ENABLED = process.env.DSH_LIVE_EDITOR_PREVIEW_CHANNEL !== 'off'
// Preview writes require both the preview switch and the shared channel switch.
// Keeping this false when preview is off prevents the Host from creating a
// staging mirror that the site cannot serve (and that would be a site write).
export function previewMirrorEnabled (env = process.env) {
  return env.DSH_LIVE_EDITOR_PREVIEW !== 'off' && env.DSH_LIVE_EDITOR_PREVIEW_CHANNEL !== 'off'
}
const PREVIEW_ENABLED = previewMirrorEnabled()
// Staging-only R2 shadow markers require the shadow env; the preview channel
// itself is enabled by PREVIEW_CHANNEL_ENABLED.
const R2_MARKERS_ENABLED = process.env.DSH_LIVE_EDITOR_R2_SHADOW === '1'
const R2_SENTINEL_ENABLED = process.env.DSH_LIVE_EDITOR_R2_SHADOW === '1'
  && process.env.DSH_LIVE_EDITOR_R2_SENTINEL === '1'
const PREVIEW_STATES = new Map()
const PREVIEW_SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/
const DOC_PATH = /^docs\/[A-Za-z0-9._\-\/]+\.mdx?$/
const MAX_BYTES = 4 * 1024 * 1024
const INDEX_TTL_MS = 5000
const ALLOWED_ORIGIN = (origin) => origin === 'dsh-app://app'
  || origin.startsWith('http://127.0.0.1:')
  || origin.startsWith('http://localhost:')

let indexCache = null

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

// TEMPORARY diagnostics (read-only viewer investigation). FNV-1a over UTF-16
// code units so the browser can compute the same fingerprint synchronously.
function fnv1a(text) {
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

async function appendDiag(entry) {
  // Tests and offline scripts may import this module; keep their probes out of
  // the live diagnostics log unless they opt into a dedicated file.
  if (process.env.DSH_LIVE_EDITOR_DIAG === 'off') return
  try {
    const stat = await fs.stat(DIAG_FILE).catch(() => null)
    if (stat !== null && stat.size > DIAG_MAX_BYTES) return
    await fs.mkdir(path.dirname(DIAG_FILE), { recursive: true })
    await fs.appendFile(DIAG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 })
  } catch { /* diagnostics must never break the feature */ }
}

const siteInfo = () => ({
  id: SITE.id,
  siteId: SITE_ID,
  label: SITE.label,
  writable: SITE.writable,
  devOrigin: SITE.devOrigin,
  routeBasePath: SITE.routeBasePath,
  baseUrl: SITE.baseUrl,
  trailingSlash: SITE.trailingSlash,
  previewEnabled: PREVIEW_ENABLED,
  previewRouteBasePath: PREVIEW_ROUTE_BASE,
})

function inside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep)
}

function originAllowed(request) {
  const origin = request.headers.get('origin')
  return origin === null || ALLOWED_ORIGIN(origin)
}

function handleSite (request) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'origin rejected' })
  return json(200, {
    ok: true,
    siteId: SITE_ID,
    label: SITE.label,
    writable: SITE.writable,
    devOrigin: SITE.devOrigin,
  })
}

async function resolveDoc(rel) {
  if (!DOC_PATH.test(rel) || rel.includes('..') || rel.includes('\\')) {
    throw Object.assign(new Error('path is not an allowed docs file'), { status: 400 })
  }
  const relFile = rel.replace(/^docs\//, '')
  const abs = path.resolve(SITE.docsRoot, relFile)
  if (!inside(SITE.docsRoot, abs)) throw Object.assign(new Error('path escapes docs root'), { status: 400 })

  // Reject every symlink in the path, not just the final target.
  let cursor = SITE.docsRoot
  for (const part of relFile.split('/')) {
    cursor = path.join(cursor, part)
    const info = await fs.lstat(cursor)
    if (info.isSymbolicLink()) throw Object.assign(new Error('symlink path rejected'), { status: 400 })
  }
  const realRoot = await fs.realpath(SITE.docsRoot)
  const real = await fs.realpath(abs)
  if (!inside(realRoot, real)) throw Object.assign(new Error('realpath escapes docs root'), { status: 400 })
  return { rel, abs: real }
}

/**
 * Best-effort directory-entry durability. POSIX filesystems differ: some
 * accept fsync on a directory, others reject it with EINVAL/ENOTSUP/EISDIR.
 * An unsupported result is recorded, not treated as a content failure; the
 * backup file itself is always fsynced before publication.
 */
async function syncDirectoryBestEffort(dir) {
  let handle = null
  try {
    handle = await fs.open(dir, 'r')
    await handle.sync()
    return 'ok'
  } catch (error) {
    const code = error?.code
    if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EISDIR' || code === 'EPERM' || code === 'EBADF') return 'unsupported'
    return `error:${String(code ?? error?.message ?? error).slice(0, 80)}`
  } finally {
    if (handle !== null) await handle.close().catch(() => {})
  }
}

/**
 * Retention is housekeeping: a prune failure must not block a valid backup.
 * The backup just created is always protected; clock skew must never make the
 * current backup the one we delete.
 */
async function pruneBackups(dir, keep = 20, protectFile = null) {
  try {
    const protectedName = protectFile === null ? null : path.basename(protectFile)
    const entries = (await fs.readdir(dir))
      .filter((name) => name.endsWith('.mdx') && name !== protectedName)
      .sort()
    const protectedCount = protectedName === null ? 0 : 1
    const keepOther = Math.max(1, keep) - protectedCount
    const remove = entries.slice(0, Math.max(0, entries.length - keepOther))
    for (const old of remove) await fs.rm(path.join(dir, old), { force: true })
    if (protectedName !== null) {
      const stillThere = await fs.stat(protectFile).catch(() => null)
      if (stillThere === null) {
        return { removed: remove.length, error: 'protected backup missing after prune', protectedMissing: true }
      }
    }
    return { removed: remove.length, error: null, protectedMissing: false }
  } catch (error) {
    return { removed: 0, error: String(error?.message ?? error).slice(0, 160) }
  }
}

/**
 * Durable pre-write backup: write a private temp file in the backup directory,
 * fsync its contents, then rename it to the final content-addressed name.
 * A crash before the rename leaves only a `.tmp` file; the restore path only
 * accepts `*.mdx`, so a partial backup can never be mistaken for a full one.
 * `durable` means the file contents were fsynced; directory-entry durability
 * is reported separately because it is platform-dependent.
 */
async function backupBeforeWrite(ctx, rel, before) {
  const dir = path.join(BACKUP_ROOT, backupDirName(rel))
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const digest = createHash('sha1').update(before).digest('hex').slice(0, 12)
  const file = path.join(dir, `${stamp}-${digest}.mdx`)
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let handle = null
  try {
    handle = await fs.open(temp, 'wx', 0o600)
    await handle.writeFile(before, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = null
    const existing = await fs.stat(file).catch(() => null)
    if (existing !== null) {
      // Same millisecond and same before-content: the existing backup is
      // byte-identical by construction, so keep it instead of replacing it.
      await fs.rm(temp, { force: true })
    } else {
      try {
        await fs.rename(temp, file)
      } catch (error) {
        const raced = await fs.stat(file).catch(() => null)
        if (raced === null) throw error
        await fs.rm(temp, { force: true })
      }
    }
    const dirSync = await syncDirectoryBestEffort(dir)
    const prune = await pruneBackups(dir, 20, file)
    if (prune.protectedMissing === true) {
      throw Object.assign(new Error('protected backup missing after prune'), { code: 'BACKUP_FAILED' })
    }
    return {
      file,
      bytes: Buffer.byteLength(before),
      durable: true,
      dirSync,
      pruned: prune.removed,
      pruneError: prune.error,
    }
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => {})
    await fs.rm(temp, { force: true }).catch(() => {})
    throw Object.assign(new Error(`backup failed: ${String(error?.message ?? error)}`), { code: 'BACKUP_FAILED', cause: error })
  }
}

async function readSource(ctx, rel) {
  const { abs } = await resolveDoc(rel)
  let target = null
  let version = null
  let text
  try {
    target = await ctx.fs.resolve(abs)
    const info = await ctx.fs.stat(target)
    if (info === undefined || info.type !== 'file') throw Object.assign(new Error('not a regular file'), { status: 404 })
    version = info.version
    text = await ctx.fs.readText(target)
  } catch (error) {
    const message = String(error?.message ?? error)
    // DSH runtime updates can leave the host fs read path throwing a DOM-style
    // "Illegal invocation". The path is already contained by resolveDoc, so a
    // defensive Node read keeps source viewing alive; the write path still
    // requires a valid ctx.fs target/version.
    if (!/Illegal invocation|Illegal constructor|not a function|undefined is not a function/i.test(message)) {
      throw error
    }
    const nodeInfo = await fs.stat(abs)
    if (!nodeInfo.isFile()) throw Object.assign(new Error('not a regular file'), { status: 404 })
    if (nodeInfo.size > MAX_BYTES) throw Object.assign(new Error('file too large'), { status: 413 })
    text = await fs.readFile(abs, 'utf8')
    try {
      target = await ctx.fs.resolve(abs)
      const info = await ctx.fs.stat(target)
      version = info?.version ?? null
    } catch { /* save path reports its own error */ }
  }
  return {
    target,
    version,
    hash: createHash('sha1').update(text).digest('hex'),
    text,
    size: Buffer.byteLength(text),
  }
}

async function digestDocsRoot(root) {
  const hash = createHash('sha256')
  const walk = async (rel) => {
    const dirents = await fs.readdir(path.join(root, rel), { withFileTypes: true })
    dirents.sort((a, b) => a.name.localeCompare(b.name))
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) continue
      const child = rel.length === 0 ? dirent.name : `${rel}/${dirent.name}`
      const abs = path.join(root, child)
      const info = await fs.lstat(abs)
      if (info.isSymbolicLink()) { hash.update(`L:${child}\n`); continue }
      if (info.isDirectory()) { hash.update(`D:${child}\n`); await walk(child); continue }
      if (!info.isFile()) continue
      hash.update(`F:${child}:${info.size}\n`)
      hash.update(await fs.readFile(abs))
    }
  }
  await walk('')
  return hash.digest('hex')
}

async function copyPreviewTree(source, target) {
  // Invalidate readiness before touching the staging content. A site process
  // must not observe a fresh manifest for a half-copied directory.
  await fs.rm(PREVIEW_MANIFEST, { force: true })
  // Never delete the staging directory: the running Docusaurus dev server keeps
  // module references to files under it, and a whole-directory rm produces
  // "Cannot find module '@site/.dsh-live-editor/preview-docs/...'" in the
  // preview iframe. Update files in place, one atomic rename per file.
  await fs.mkdir(target, { recursive: true })
  let docsCount = 0
  let fileCount = 0
  const files = []
  const expected = new Set()
  const writeAtomic = async (targetPath, data, mode) => {
    const temp = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(temp, data, { mode })
    try {
      await fs.rename(temp, targetPath)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }
  const walk = async (rel) => {
    const sourceDir = path.join(source, rel)
    const targetDir = path.join(target, rel)
    await fs.mkdir(targetDir, { recursive: true })
    for (const dirent of await fs.readdir(sourceDir, { withFileTypes: true })) {
      if (dirent.name.startsWith('.')) continue
      const child = rel.length === 0 ? dirent.name : `${rel}/${dirent.name}`
      const sourcePath = path.join(source, child)
      const targetPath = path.join(target, child)
      const info = await fs.lstat(sourcePath)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) { await walk(child); continue }
      if (!info.isFile()) continue
      expected.add(child)
      if (/\.mdx?$/i.test(dirent.name)) {
        const text = await fs.readFile(sourcePath, 'utf8')
        await writeAtomic(targetPath, stripStagingSlug(text), 0o600)
        docsCount += 1
      } else {
        await writeAtomic(targetPath, await fs.readFile(sourcePath), 0o600)
      }
      fileCount += 1
      files.push(child)
    }
  }
  await walk('')
  // Remove only files that no longer exist in the docs tree, one at a time.
  // Existing files were replaced atomically above, so a referenced module path
  // never disappears during the update.
  const prune = async (rel) => {
    const targetDir = path.join(target, rel)
    for (const dirent of await fs.readdir(targetDir, { withFileTypes: true })) {
      const child = rel.length === 0 ? dirent.name : `${rel}/${dirent.name}`
      const targetPath = path.join(target, child)
      if (dirent.isDirectory()) { await prune(child); continue }
      if (!dirent.isFile()) continue
      if (expected.has(child)) continue
      await fs.rm(targetPath, { force: true })
    }
  }
  await prune('')
  const sourceDigest = await digestDocsRoot(source)
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    docsCount,
    fileCount,
    sourceDigest,
    files: files.sort(),
  }
  const temp = `${PREVIEW_MANIFEST}.${process.pid}.tmp`
  await fs.mkdir(path.dirname(PREVIEW_MANIFEST), { recursive: true })
  await fs.writeFile(temp, JSON.stringify(manifest, null, 2), { mode: 0o600 })
  await fs.rename(temp, PREVIEW_MANIFEST)
  return manifest
}

async function previewManifest() {
  try {
    const text = await fs.readFile(PREVIEW_MANIFEST, 'utf8')
    const data = JSON.parse(text)
    if (data?.version !== 1 || !Number.isInteger(data.docsCount) || typeof data.sourceDigest !== 'string') return null
    return data
  } catch {
    return null
  }
}

async function refreshPreviewManifestSourceDigest() {
  const manifest = await previewManifest()
  if (manifest === null) return null
  try {
    const sourceDigest = await digestDocsRoot(SITE.docsRoot)
    if (sourceDigest === manifest.sourceDigest) return manifest
    const next = { ...manifest, sourceDigest, generatedAt: new Date().toISOString() }
    const temp = `${PREVIEW_MANIFEST}.${process.pid}.tmp`
    await fs.mkdir(path.dirname(PREVIEW_MANIFEST), { recursive: true })
    await fs.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 })
    await fs.rename(temp, PREVIEW_MANIFEST)
    return next
  } catch {
    return null
  }
}

async function previewReady() {
  if (!PREVIEW_ENABLED) return false
  const manifest = await previewManifest()
  if (manifest === null) return false
  try {
    const sourceDigest = await digestDocsRoot(SITE.docsRoot)
    if (sourceDigest !== manifest.sourceDigest) return false
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) return false
    const actual = (await fs.readdir(PREVIEW_ROOT, { recursive: true, withFileTypes: true }))
      .filter((dirent) => dirent.isFile())
      .map((dirent) => path.relative(PREVIEW_ROOT, path.join(dirent.parentPath ?? dirent.path, dirent.name)).replaceAll('\\', '/'))
      .sort()
    const expected = [...manifest.files].sort()
    return actual.length === expected.length && actual.every((file, index) => file === expected[index]) && actual.some((file) => file.endsWith('.mdx'))
  } catch {
    return false
  }
}

async function ensurePreviewMirror() {
  return copyPreviewTree(SITE.docsRoot, PREVIEW_ROOT)
}

function previewState(source) {
  let state = PREVIEW_STATES.get(source)
  if (state === undefined) {
    state = { epoch: -1, session: null, revision: -1, lastGood: null, lastGoodRevision: null }
    PREVIEW_STATES.set(source, state)
  }
  return state
}
let previewOperationQueue = Promise.resolve()

/** Serialize preview write/ACK/recover mutations. */
function withPreviewLock(operation) {
  const next = previewOperationQueue.then(operation, operation)
  previewOperationQueue = next.catch(() => {})
  return next
}

async function resolvePreviewTarget(source) {
  const target = previewTarget(PREVIEW_ROOT, source)
  if (target === null) throw Object.assign(new Error('invalid preview source'), { status: 400 })
  return target
}

const sentinelChains = new Map()

/**
 * Publish a sentinel atomically, serialized per target. Unique temp names avoid
 * collisions between concurrent structural writes to different sources.
 */
export async function publishSentinelFile(target, payload) {
  const previous = sentinelChains.get(target) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temp, payload, { mode: 0o600 })
      await fs.rename(temp, target)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {})
    }
  })
  let tracked
  tracked = task.finally(() => {
    if (sentinelChains.get(target) === tracked) sentinelChains.delete(target)
  })
  sentinelChains.set(target, tracked)
  return tracked
}

async function handlePreview(ctx, request) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'origin rejected' })
  if (!PREVIEW_ENABLED) return json(403, { ok: false, error: 'preview disabled' })
  let body
  try { body = await request.json() } catch { return json(400, { ok: false, error: 'invalid json' }) }
  const source = normalizePreviewSource(body?.source)
  const text = body?.text
  const docId = body?.docId
  const session = body?.session
  const revision = body?.revision
  const epoch = body?.epoch
  const writeId = body?.writeId
  if (writeId !== undefined && !R2_MARKERS_ENABLED && !PREVIEW_CHANNEL_ENABLED) {
    return json(403, { ok: false, error: 'R2 preview markers are disabled', code: 'R2_DISABLED' })
  }
  if (source === null || typeof text !== 'string' || typeof docId !== 'string'
    || typeof session !== 'string' || !PREVIEW_SESSION_RE.test(session)
    || !Number.isSafeInteger(revision) || revision < 1
    || !Number.isSafeInteger(epoch) || epoch < 0
    || (writeId !== undefined && (typeof writeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(writeId)))) {
    return json(400, { ok: false, error: 'source, text, docId, session, revision, epoch (and valid writeId) are required' })
  }
  if (Buffer.byteLength(text) > MAX_PREVIEW_BYTES) return json(413, { ok: false, error: 'preview text too large' })
  return withPreviewLock(async () => {
  try {
    // The source must be an existing, non-symlink real docs file (allowlist).
    const realDoc = await resolveDoc(source)
    const rel = previewRelPath(source)
    const expectedDocId = computeDocId(rel)
    if (docId !== expectedDocId) return json(400, { ok: false, error: 'docId does not match source', code: 'DOC_ID_MISMATCH' })
    if (!(await previewReady())) return json(503, { ok: false, error: 'staging preview is not ready', code: 'STAGING_NOT_READY' })
    const state = previewState(source)
    const newSession = state.session !== session || epoch > state.epoch
    const target = await resolvePreviewTarget(source)
    // Validate ownership before mutating recovery/structural state. A rejected
    // stale request must not clear the current session's lastGood.
    if (epoch < state.epoch) return json(409, { ok: false, error: 'stale preview session epoch', code: 'STALE_SESSION', epoch: state.epoch })
    if (epoch === state.epoch) {
      if (state.session !== null && session !== state.session) {
        return json(409, { ok: false, error: 'stale preview session', code: 'STALE_SESSION', session: state.session })
      }
      if (revision <= state.revision) {
        return json(409, { ok: false, error: 'stale preview revision', code: 'STALE_REVISION', revision: state.revision })
      }
    }
    if (newSession) {
      // A new preview session must not inherit the previous session's lastGood.
      state.lastGood = null
      state.lastGoodRevision = null
      // Use current staging as the structural baseline for the first write.
      try { state.lastInputText = await fs.readFile(target, 'utf8') } catch { state.lastInputText = null }
    }
    const structural = hasStructuralPreviewChange(state.lastInputText ?? null, text)
    // The preview page's title/slug/sidebar come from the real docs, not from
    // the staging body. Compare the draft's structural frontmatter against the
    // real saved doc so reverting a frontmatter edit clears the warning again.
    const realText = await fs.readFile(realDoc.abs, 'utf8')
    const structuralPending = hasStructuralPreviewChange(realText, text)
    const metaText = injectPreviewMeta(stripStagingSlug(text), { session, revision })
    const staged = writeId === undefined ? metaText : injectR2Markers(metaText, { writeId, revision })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, staged, { mode: 0o600 })
    state.epoch = epoch
    state.session = session
    state.revision = revision
    if (PREVIEW_CHANNEL_ENABLED) {
      await appendDiag({
        event: 'preview-experiment-write', source, session, revision, writeId,
        handshakeVersion: typeof body?.handshakeVersion === 'string' ? body.handshakeVersion.slice(0, 64) : null,
        textLen: Buffer.byteLength(text), textFnv: fnv1a(text), structural, structuralPending,
      })
    }
    let sentinelWritten = false
    if (structural && writeId !== undefined && R2_SENTINEL_ENABLED) {
      try {
        const sentinel = r2SentinelTarget(PREVIEW_ROOT)
        await publishSentinelFile(sentinel, renderR2Sentinel({ source, session, revision, writeId }))
        sentinelWritten = true
      } catch (error) {
        ctx?.logger?.error?.('[dsh-live-editor] R2 sentinel write failed', error)
        return json(503, { ok: false, error: 'R2 sentinel write failed', code: 'SENTINEL_WRITE_FAILED' })
      }
    }
    state.lastInputText = text
    state.lastWrite = { revision, writeId: writeId ?? null, structural, sentinelWritten, text: staged, at: new Date().toISOString() }
    ctx?.logger?.info?.('[dsh-live-editor][diag] preview write', {
      source, docId, session, revision, epoch,
      staging: path.relative(SITE.root, target),
      size: Buffer.byteLength(staged),
      at: state.lastWrite.at,
    })

    return json(200, {
      ok: true,
      source,
      docId,
      session,
      revision,
      epoch,
      writeId: writeId ?? null,
      structural,
      structuralPending,
      sentinelWritten,
      previewPermalink: computePreviewPermalink(source, { baseUrl: SITE.baseUrl, trailingSlash: SITE.trailingSlash }),
      staging: path.relative(SITE.root, target),
      size: Buffer.byteLength(staged),
      writtenAt: state.lastWrite.at,
    })
  } catch (error) {
    if (error?.code === 'ENOENT') return json(404, { ok: false, error: 'source is not in the docs allowlist', code: 'UNKNOWN_SOURCE' })
    return json(error?.status ?? 500, { ok: false, error: String(error?.message ?? error) })
  }
  })
}

async function handlePreviewAck(ctx, request) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'origin rejected' })
  let body
  try { body = await request.json() } catch { return json(400, { ok: false, error: 'invalid json' }) }
  const source = normalizePreviewSource(body?.source)
  const docId = body?.docId
  const session = body?.session
  const revision = body?.revision
  const epoch = body?.epoch
  if (source === null || typeof docId !== 'string' || typeof session !== 'string'
    || !Number.isSafeInteger(revision) || !Number.isSafeInteger(epoch)) {
    return json(400, { ok: false, error: 'source, docId, session, revision, epoch are required' })
  }
  return withPreviewLock(async () => {
  try {
    await resolveDoc(source)
    const expectedDocId = computeDocId(previewRelPath(source))
    if (docId !== expectedDocId) return json(400, { ok: false, error: 'docId does not match source', code: 'DOC_ID_MISMATCH' })
    const state = previewState(source)
    if (state.epoch !== epoch || state.session !== session || state.revision !== revision) {
      return json(409, { ok: false, error: 'ack does not match current preview state', code: 'STALE_ACK' })
    }
    // On the A2 preview path the client also sends the exact writeId it rendered.
    // Require it to match the last successful write so a stale ACK cannot settle
    // a newer write. The legacy path (no writeId) remains compatible.
    if (state.lastWrite?.writeId != null && body?.writeId !== state.lastWrite.writeId) {
      return json(409, { ok: false, error: 'ack writeId does not match current write', code: 'STALE_WRITE_ID' })
    }
    const target = await resolvePreviewTarget(source)
    const text = await fs.readFile(target, 'utf8')
    const meta = readPreviewMeta(text)
    if (meta.session !== session || meta.revision !== revision) {
      return json(409, { ok: false, error: 'staging revision does not match ack', meta })
    }
    state.lastGood = text
    state.lastGoodRevision = revision
    if (PREVIEW_CHANNEL_ENABLED) {
      await appendDiag({
        event: 'preview-experiment-ack',
        source,
        session,
        revision,
        epoch,
        writeId: typeof body?.writeId === 'string' ? body.writeId.slice(0, 128) : null,
      })
    }
    return json(200, { ok: true, source, docId, session, revision, epoch, staging: path.relative(SITE.root, target) })
  } catch (error) {
    if (error?.code === 'ENOENT') return json(404, { ok: false, error: 'source is not in the docs allowlist', code: 'UNKNOWN_SOURCE' })
    return json(error?.status ?? 500, { ok: false, error: String(error?.message ?? error) })
  }
  })
}

async function handlePreviewRecover(ctx, request) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'origin rejected' })
  if (!PREVIEW_ENABLED) return json(403, { ok: false, error: 'preview disabled' })
  let body
  try { body = await request.json() } catch { return json(400, { ok: false, error: 'invalid json' }) }
  const source = normalizePreviewSource(body?.source)
  const docId = body?.docId
  const session = body?.session
  const epoch = body?.epoch
  if (source === null || typeof docId !== 'string' || typeof session !== 'string' || !Number.isSafeInteger(epoch)) {
    return json(400, { ok: false, error: 'source, docId, session, epoch are required' })
  }
  return withPreviewLock(async () => {
  try {
    await resolveDoc(source)
    const expectedDocId = computeDocId(previewRelPath(source))
    if (docId !== expectedDocId) return json(400, { ok: false, error: 'docId does not match source', code: 'DOC_ID_MISMATCH' })
    const state = previewState(source)
    if (state.epoch !== epoch || state.session !== session) {
      return json(409, { ok: false, error: 'recover does not match current preview session', code: 'STALE_SESSION' })
    }
    if (state.lastGood === null) return json(409, { ok: false, error: 'no last successful preview for this session' })
    const target = await resolvePreviewTarget(source)
    await fs.writeFile(target, state.lastGood, { mode: 0o600 })
    return json(200, { ok: true, source, docId, session, epoch, revision: state.lastGoodRevision, staging: path.relative(SITE.root, target) })
  } catch (error) {
    if (error?.code === 'ENOENT') return json(404, { ok: false, error: 'source is not in the docs allowlist', code: 'UNKNOWN_SOURCE' })
    return json(error?.status ?? 500, { ok: false, error: String(error?.message ?? error) })
  }
  })
}

const INSTANCE_DESCRIPTOR_VERSION = 1
const INSTANCE_MAX = 32

function isSafeRelativeRoot(root) {
  if (typeof root !== 'string' || root.includes('\\') || root.startsWith('/') || /^[A-Za-z]:/.test(root) || root.includes('\0')) return false
  if (root.length === 0) return true
  return root.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function sanitizeInstanceVersions(entry, reject) {
  if (entry.versions === undefined) return []
  if (!Array.isArray(entry.versions)) { reject(); return [] }
  if (entry.versions.length > 16) { reject(); return [] }
  const versions = []
  for (const version of entry.versions) {
    if (!version || typeof version !== 'object' || typeof version.versionName !== 'string'
      || version.versionName.length === 0 || version.versionName.length > 128) { reject(); return [] }
    if (!Array.isArray(version.sourceRoots) || !version.sourceRoots.every(isSafeRelativeRoot)) { reject(); return [] }
    if (version.routePath !== null && (typeof version.routePath !== 'string' || !version.routePath.startsWith('/'))) { reject(); return [] }
    versions.push({
      versionName: version.versionName,
      routePath: version.routePath ?? null,
      sourceRoots: version.sourceRoots,
    })
  }
  return versions
}

const LEGACY_INSTANCE = Object.freeze({
  pluginType: 'docs',
  pluginName: 'docusaurus-plugin-content-docs',
  instanceId: 'default',
  routePath: SITE.routeBasePath,
  sourceRoots: ['docs'],
  capability: 'legacy',
  preview: false,
  versions: [{ versionName: 'current', routePath: SITE.routeBasePath, sourceRoots: ['docs'] }],
})

function parseInstanceDescriptor(parsed) {
  if (!parsed || parsed.version !== INSTANCE_DESCRIPTOR_VERSION
    || !Array.isArray(parsed.instances) || parsed.instances.length > INSTANCE_MAX) {
    return { ok: false, status: 500, body: { ok: false, error: 'invalid instance descriptor', code: 'INVALID_INSTANCE_DESCRIPTOR' } }
  }
  if (parsed.generatedAt !== null && (typeof parsed.generatedAt !== 'string' || parsed.generatedAt.length > 128)) {
    return { ok: false, status: 500, body: { ok: false, error: 'invalid instance descriptor', code: 'INVALID_INSTANCE_DESCRIPTOR' } }
  }
  if (!Array.isArray(parsed.errors)) {
    return { ok: false, status: 500, body: { ok: false, error: 'invalid instance descriptor', code: 'INVALID_INSTANCE_DESCRIPTOR' } }
  }
  if (parsed.errors.length > 0) {
    return {
      ok: false, status: 422,
      body: {
        ok: false, error: 'instance registry is invalid', code: 'INVALID_INSTANCE_REGISTRY',
        errors: parsed.errors.map((entry) => ({
          code: typeof entry?.error === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(entry.error) ? entry.error : 'unknown',
        })),
      },
    }
  }
  const safe = []
  for (const entry of parsed.instances) {
    if (!entry || typeof entry !== 'object' || typeof entry.instanceId !== 'string'
      || entry.instanceId.length === 0 || entry.instanceId.length > 128
      || typeof entry.pluginType !== 'string' || entry.pluginType.length === 0 || entry.pluginType.length > 64
      || (entry.pluginName !== null && (typeof entry.pluginName !== 'string' || entry.pluginName.length > 128))
      || !Array.isArray(entry.sourceRoots) || !entry.sourceRoots.every(isSafeRelativeRoot)
      || (entry.routePath !== undefined && entry.routePath !== null && (typeof entry.routePath !== 'string' || !entry.routePath.startsWith('/')))
      || (entry.capability !== undefined && entry.capability !== null && (typeof entry.capability !== 'string' || entry.capability.length > 64))
      || (entry.preview !== undefined && typeof entry.preview !== 'boolean')) {
      return { ok: false, status: 500, body: { ok: false, error: 'invalid instance descriptor entry', code: 'INVALID_INSTANCE_DESCRIPTOR' } }
    }
    let rejected = false
    const versions = sanitizeInstanceVersions(entry, () => { rejected = true })
    if (rejected) return { ok: false, status: 500, body: { ok: false, error: 'invalid instance descriptor entry', code: 'INVALID_INSTANCE_DESCRIPTOR' } }
    const routePath = versions.length === 1 ? versions[0].routePath : (entry.routePath ?? null)
    safe.push({
      pluginType: entry.pluginType,
      pluginName: entry.pluginName ?? null,
      instanceId: entry.instanceId,
      routePath,
      sourceRoots: entry.sourceRoots,
      capability: entry.capability ?? 'unsupported',
      preview: entry.preview === true,
      versions,
    })
  }
  return { ok: true, source: 'descriptor', generatedAt: parsed.generatedAt ?? null, instances: safe }
}

async function loadInstanceDescriptor() {
  try {
    return parseInstanceDescriptor(JSON.parse(await fs.readFile(INSTANCES_FILE, 'utf8')))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, source: 'legacy', generatedAt: null, instances: [LEGACY_INSTANCE] }
    }
    return { ok: false, status: 500, body: { ok: false, error: 'invalid instance descriptor', code: 'INVALID_INSTANCE_DESCRIPTOR' } }
  }
}

async function handleInstances(ctx, request) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'origin rejected' })
  const loaded = await loadInstanceDescriptor()
  if (!loaded.ok) return json(loaded.status, loaded.body)
  // The dev-only staging mirror (`live-preview`) is an internal preview
  // artifact, not a user-facing instance. Keep it out of read-only discovery
  // so duplicated staging documents never appear as browsable instances.
  const instances = loaded.instances.filter((entry) => entry.preview !== true)
  return json(200, {
    ok: true, source: loaded.source, generatedAt: loaded.generatedAt,
    a2Experiment: PREVIEW_CHANNEL_ENABLED, instances,
  })
}

const INSTANCE_DOC_MAX = 2000

function safeInstanceSource(source) {
  if (typeof source !== 'string' || source.length === 0 || source.startsWith('/') || source.includes('\\')
    || source.includes('\0') || /^[A-Za-z]:/.test(source)) return null
  const parts = source.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return source
}

async function handleInstanceDocuments(ctx, request) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'origin rejected' })
  const url = new URL(request.url, 'http://dsh.local')
  const instanceId = url.searchParams.get('instance')
  if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > 128) {
    return json(400, { ok: false, error: 'instance is required' })
  }
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(INSTANCES_FILE, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return json(404, { ok: false, error: 'no instance descriptor', code: 'NO_INSTANCE_DESCRIPTOR' })
    return json(500, { ok: false, error: 'invalid instance descriptor', code: 'INVALID_INSTANCE_DESCRIPTOR' })
  }
  if (!parsed || parsed.version !== INSTANCE_DESCRIPTOR_VERSION || !Array.isArray(parsed.errors)) {
    return json(500, { ok: false, error: 'invalid instance descriptor', code: 'INVALID_INSTANCE_DESCRIPTOR' })
  }
  if (parsed.errors.length > 0) {
    return json(422, { ok: false, error: 'instance registry is invalid', code: 'INVALID_INSTANCE_REGISTRY' })
  }
  const entry = Array.isArray(parsed.instances) ? parsed.instances.find((item) => item?.instanceId === instanceId) : null
  if (!entry || entry.pluginType !== 'docs') return json(404, { ok: false, error: 'unknown docs instance', code: 'UNKNOWN_INSTANCE' })
  const rawDocuments = Array.isArray(entry.docs) ? entry.docs : []
  if (rawDocuments.length > INSTANCE_DOC_MAX) {
    return json(500, { ok: false, error: 'instance document list too large', code: 'INVALID_INSTANCE_DESCRIPTOR' })
  }
  const documents = []
  for (const doc of rawDocuments) {
    if (!doc || typeof doc !== 'object') continue
    const source = safeInstanceSource(doc.sourcePath)
    if (source === null || typeof doc.docId !== 'string' || doc.docId.length === 0
      || typeof doc.permalink !== 'string' || !doc.permalink.startsWith('/')
      || (doc.title !== null && typeof doc.title !== 'string')) {
      return json(500, { ok: false, error: 'invalid instance document', code: 'INVALID_INSTANCE_DOCUMENT' })
    }
    documents.push({
      instanceId,
      versionName: typeof doc.versionName === 'string' ? doc.versionName : null,
      source,
      docId: doc.docId.slice(0, 512),
      permalink: doc.permalink.slice(0, 2048),
      title: typeof doc.title === 'string' ? doc.title.slice(0, 512) : null,
      sourceRoot: typeof doc.sourceRoot === 'string' ? doc.sourceRoot.slice(0, 1024) : null,
      editable: false,
    })
  }
  return json(200, { ok: true, instanceId, documents })
}

const INSTANCE_SOURCE_MAX_BYTES = 4 * 1024 * 1024

function safeInstanceRoot(root) {
  if (typeof root !== 'string' || root.includes('\\') || root.startsWith('/') || /^[A-Za-z]:/.test(root) || root.includes('\0')) return false
  if (root.length === 0) return true
  return root.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

async function assertNoSymlinkComponents(base, target) {
  const rel = path.relative(base, target)
  if (rel === '' ) return
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Object.assign(new Error('path escapes root'), { status: 403 })
  let current = base
  const parts = rel.split(path.sep)
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index])
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw Object.assign(new Error('symlink component rejected'), { status: 403 })
    if (index < parts.length - 1 && !stat.isDirectory()) throw Object.assign(new Error('path component is not a directory'), { status: 403 })
  }
}

async function handleInstanceSource(ctx, request) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'origin rejected' })
  const url = new URL(request.url, 'http://dsh.local')
  const instanceId = url.searchParams.get('instance')
  const docId = url.searchParams.get('docId')
  const source = safeInstanceSource(url.searchParams.get('source'))
  if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > 128
    || typeof docId !== 'string' || docId.length === 0 || docId.length > 512 || source === null) {
    return json(400, { ok: false, error: 'instance, docId, source are required', code: 'INVALID_INSTANCE_SOURCE' })
  }
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(INSTANCES_FILE, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return json(404, { ok: false, error: 'no instance descriptor', code: 'NO_INSTANCE_DESCRIPTOR' })
    return json(500, { ok: false, error: 'invalid instance descriptor', code: 'INVALID_INSTANCE_DESCRIPTOR' })
  }
  if (!parsed || parsed.version !== INSTANCE_DESCRIPTOR_VERSION || !Array.isArray(parsed.errors)) {
    return json(500, { ok: false, error: 'invalid instance descriptor', code: 'INVALID_INSTANCE_DESCRIPTOR' })
  }
  if (parsed.errors.length > 0) return json(422, { ok: false, error: 'instance registry is invalid', code: 'INVALID_INSTANCE_REGISTRY' })
  const instance = Array.isArray(parsed.instances) ? parsed.instances.find((item) => item?.instanceId === instanceId) : null
  if (!instance || instance.pluginType !== 'docs') return json(404, { ok: false, error: 'unknown docs instance', code: 'UNKNOWN_INSTANCE' })
  const document = Array.isArray(instance.docs) ? instance.docs.find((item) => item?.docId === docId && item?.sourcePath === source) : null
  if (!document) return json(404, { ok: false, error: 'unknown instance document', code: 'UNKNOWN_INSTANCE_DOCUMENT' })
  const roots = [
    ...(Array.isArray(instance.versions) ? instance.versions.flatMap((version) => version?.sourceRoots ?? []) : []),
    ...(Array.isArray(instance.sourceRoots) ? instance.sourceRoots : []),
  ].filter(safeInstanceRoot)
  const root = roots
    .filter((candidate) => candidate === '' || source === candidate || source.startsWith(`${candidate}/`))
    .sort((a, b) => b.length - a.length)[0]
  if (root === undefined) return json(404, { ok: false, error: 'source is outside instance root', code: 'UNKNOWN_INSTANCE_DOCUMENT' })
  try {
    const realSite = await fs.realpath(SITE.root)
    const rootAbs = path.resolve(SITE.root, root)
    await assertNoSymlinkComponents(SITE.root, rootAbs)
    const realRoot = await fs.realpath(rootAbs)
    if (!inside(realSite, realRoot)) return json(403, { ok: false, error: 'instance root escapes site', code: 'INSTANCE_SOURCE_DENIED' })
    const target = path.resolve(SITE.root, source)
    if (!inside(rootAbs, target)) return json(403, { ok: false, error: 'source escapes instance root', code: 'INSTANCE_SOURCE_DENIED' })
    await assertNoSymlinkComponents(rootAbs, target)
    let handle
    try {
      handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
    } catch (error) {
      if (error?.code === 'ENOENT') return json(404, { ok: false, error: 'source not found', code: 'UNKNOWN_INSTANCE_DOCUMENT' })
      if (error?.code === 'ELOOP') return json(403, { ok: false, error: 'source symlink rejected', code: 'INSTANCE_SOURCE_DENIED' })
      throw error
    }
    try {
      // Bind validation to the object that was opened: re-resolve the path and
      // compare device/inode after open, then read only a bounded amount from
      // the descriptor itself.
      const fdStat = await handle.stat()
      if (!fdStat.isFile()) return json(403, { ok: false, error: 'source is not a regular file', code: 'INSTANCE_SOURCE_DENIED' })
      if (fdStat.size > INSTANCE_SOURCE_MAX_BYTES) return json(413, { ok: false, error: 'source too large', code: 'INSTANCE_SOURCE_TOO_LARGE' })
      const realTarget = await fs.realpath(target)
      if (!inside(realRoot, realTarget) || !inside(realSite, realTarget)) {
        return json(403, { ok: false, error: 'source escapes instance root', code: 'INSTANCE_SOURCE_DENIED' })
      }
      const pathStat = await fs.stat(target)
      if (pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) {
        return json(403, { ok: false, error: 'source changed while opening', code: 'INSTANCE_SOURCE_DENIED' })
      }
      const chunks = []
      let total = 0
      while (total <= INSTANCE_SOURCE_MAX_BYTES) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, INSTANCE_SOURCE_MAX_BYTES + 1 - total))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > INSTANCE_SOURCE_MAX_BYTES) {
          return json(413, { ok: false, error: 'source too large', code: 'INSTANCE_SOURCE_TOO_LARGE' })
        }
        chunks.push(buffer.subarray(0, bytesRead))
      }
      const text = Buffer.concat(chunks, total).toString('utf8')
      return json(200, { ok: true, instanceId, docId, source, size: total, text })
    } finally {
      await handle.close().catch(() => {})
    }
  } catch (error) {
    return json(error?.status ?? 500, { ok: false, error: String(error?.message ?? error) })
  }
}

async function handleIndex(ctx, request) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'origin rejected' })
  const url = new URL(request.url, 'http://dsh.local')
  const refresh = url.searchParams.get('refresh') === '1'
  const now = Date.now()
  try {
    if (!refresh && indexCache !== null && now - indexCache.at < INDEX_TTL_MS) {
      return json(200, { ok: true, site: { ...siteInfo(), previewReady: await previewReady() }, cached: true, ...indexCache.data })
    }
    const descriptor = await loadInstanceDescriptor()
    if (!descriptor.ok) return json(descriptor.status, descriptor.body)
    const docsInstances = descriptor.instances.filter((entry) => entry.pluginType === 'docs' && entry.instanceId === 'default')
    const merged = {
      ok: true,
      generatedAt: new Date().toISOString(),
      counts: { dirs: 0, docs: 0, other: 0, skipped: 0 },
      entries: [],
      warnings: [],
      truncated: false,
      limits: { maxEntries: 2000, maxFileBytes: 4 * 1024 * 1024 },
    }
    const realSiteRoot = await fs.realpath(SITE.root)
    for (const instance of docsInstances) {
      const version = instance.versions[0] ?? (instance.routePath === null ? null : { versionName: 'current', routePath: instance.routePath, sourceRoots: instance.sourceRoots })
      const sourceRoot = version?.sourceRoots?.[0]
      if (typeof sourceRoot !== 'string' || sourceRoot.length === 0) continue
      const root = path.resolve(SITE.root, sourceRoot)
      if (!inside(SITE.root, root)) continue
      let realRoot
      try { realRoot = await fs.realpath(root) } catch (error) {
        if (error?.code === 'ENOENT') {
          merged.warnings.push(`${instance.instanceId}: source root is unavailable`)
          continue
        }
        throw error
      }
      if (!inside(realSiteRoot, realRoot)) {
        merged.warnings.push(`${instance.instanceId}: source root escapes the site`)
        continue
      }
      try {
        const indexed = await buildIndex({
          docsRoot: root,
          routeBasePath: version.routePath ?? SITE.routeBasePath,
          baseUrl: SITE.baseUrl,
          trailingSlash: SITE.trailingSlash,
          sourceRoot,
          instanceId: instance.instanceId,
          versionName: version.versionName,
          editable: instance.instanceId === 'default' && sourceRoot === 'docs' && version.versionName === 'current',
        })
        merged.entries.push(...indexed.entries)
        for (const key of Object.keys(merged.counts)) merged.counts[key] += indexed.counts[key] ?? 0
        merged.warnings.push(...indexed.warnings.map((warning) => `${instance.instanceId}: ${warning}`))
        merged.truncated = merged.truncated || indexed.truncated
      } catch (error) {
        if (error?.code === 'ENOENT') {
          merged.warnings.push(`${instance.instanceId}: source root is unavailable`)
          continue
        }
        throw error
      }
    }
    const data = { ...merged, instances: descriptor.instances }
    data.entries = data.entries.map((entry) => (entry.kind === 'doc'
      ? {
        ...entry,
        previewPermalink: computePreviewPermalink(entry.source, { baseUrl: SITE.baseUrl, trailingSlash: SITE.trailingSlash }),
        previewRouteBasePath: PREVIEW_ROUTE_BASE,
      }
      : entry))
    indexCache = { at: now, data }
    return json(200, { ok: true, site: { ...siteInfo(), previewReady: await previewReady() }, cached: false, ...data })

  } catch (error) {
    return json(error?.status ?? 500, { ok: false, error: String(error?.message ?? error) })
  }
}

async function handleSource(ctx, request) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'origin rejected' })
  const url = new URL(request.url, 'http://dsh.local')
  const rel = url.searchParams.get('path') ?? ''
  try {
    const source = await readSource(ctx, rel)
    return json(200, { ok: true, path: rel, version: source.version, hash: source.hash, size: source.size, text: source.text })
  } catch (error) {
    return json(error?.status ?? 500, { ok: false, error: String(error?.message ?? error) })
  }
}

async function publishStructureReload ({ requestId = null, rel = null } = {}) {
  try {
    await fs.mkdir(path.dirname(STRUCTURE_SENTINEL), { recursive: true })
    const temp = `${STRUCTURE_SENTINEL}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(temp, JSON.stringify({
      version: 1,
      at: new Date().toISOString(),
      requestId,
      path: rel,
    }, null, 2), { mode: 0o600 })
    await fs.rename(temp, STRUCTURE_SENTINEL)
  } catch (error) {
    // The save itself already succeeded; a preview reload is best-effort.
    console.warn('[live-editor-phase2] structure sentinel write failed', error?.message ?? error)
  }
}

async function writeGuarded(ctx, rel, expectedHash, content, meta = null) {
  if (SITE.writable !== true) throw Object.assign(new Error('site is read-only'), { status: 403 })
  const source = await readSource(ctx, rel)
  if (source.target === null || source.version === null) {
    throw Object.assign(new Error('文件系统写入句柄不可用；源码可读但保存暂不可用，请重启 DSH 后再试'), { status: 503 })
  }
  const baseAudit = {
    event: 'save',
    path: rel,
    requestId: meta?.requestId ?? null,
    host: meta?.host ?? null,
    client: meta ?? null,
    expectedHash,
  }
  if (source.hash !== expectedHash) {
    await appendDiag({
      ...baseAudit, status: 409, code: 'STALE', currentHash: source.hash,
      textFnv: fnv1a(content), textLen: Buffer.byteLength(content),
    })
    return { status: 409, body: { ok: false, error: 'content changed since read', code: 'STALE', expectedHash, currentHash: source.hash } }
  }
  const structural = hasStructuralPreviewChange(source.text, content)
  let backupInfo
  try {
    backupInfo = await backupBeforeWrite(ctx, rel, source.text)
  } catch (error) {
    // The formal write must not run without a durable pre-write backup. This
    // is an explicit stop, never a "git has it" fallback.
    await appendDiag({
      ...baseAudit, status: 503, code: 'BACKUP_FAILED', currentHash: source.hash,
      textFnv: fnv1a(content), textLen: Buffer.byteLength(content),
      error: String(error?.message ?? error).slice(0, 200),
    })
    return { status: 503, body: { ok: false, error: '备份失败；已停止正式写入，磁盘未修改', code: 'BACKUP_FAILED' } }
  }
  try {
    const outcome = await ctx.fs.writeText(
      source.target,
      content,
      { kind: 'replaceIfVersion', version: source.version },
      undefined,
      { mode: 'workspace-write', workspaceRoot: SITE.root },
    )
    indexCache = null
    // The adapter reports the content it committed with CRLF normalized to
    // LF (FsWriteOutcome.after). Compare on that contract, not raw bytes; the
    // Node readback below still verifies the actual file content.
    const adapterAfter = typeof outcome?.after === 'string' ? outcome.after : null
    const expectedAdapterAfter = content.replaceAll('\r\n', '\n')
    if (adapterAfter === null || adapterAfter !== expectedAdapterAfter) {
      await appendDiag({
        ...baseAudit, status: 500, code: 'WRITE_VERIFY_FAILED', currentHash: source.hash,
        textFnv: fnv1a(content), textLen: Buffer.byteLength(content),
        backup: backupInfo.file,
        adapterAfterLen: adapterAfter === null ? null : Buffer.byteLength(adapterAfter),
        version: outcome?.version ?? null,
      })
      return { status: 500, body: { ok: false, error: '写入结果与提交内容不一致；未确认保存成功，请重载核对磁盘', code: 'WRITE_VERIFY_FAILED' } }
    }
    let after = null
    let readbackError = null
    try {
      // source.target is a DSH fs handle, not a Node path; read the real file.
      const afterBuffer = await fs.readFile(path.resolve(SITE.root, rel))
      const diskText = afterBuffer.toString('utf8')
      after = { len: afterBuffer.length, fnv: fnv1a(diskText) }
      // The adapter's `after` is generated from the submitted content, so it
      // is only a contract check. This disk read is the separate verification.
      if (diskText !== content) {
        readbackError = 'readback-mismatch'
      }
    } catch (error) {
      after = null
      readbackError = String(error?.code ?? error?.message ?? error).slice(0, 160)
    }
    if (readbackError === 'readback-mismatch') {
      // Our write committed, but another writer replaced the file before the
      // readback. This is a post-write conflict: keep the draft and let the
      // client resolve it explicitly; never report a clean success.
      let currentHash = null
      try { currentHash = (await readSource(ctx, rel)).hash } catch { /* keep null */ }
      await appendDiag({
        ...baseAudit, status: 409, code: 'POST_WRITE_CHANGED', currentHash,
        textFnv: fnv1a(content), textLen: Buffer.byteLength(content),
        beforeFnv: fnv1a(source.text), beforeLen: Buffer.byteLength(source.text),
        backup: backupInfo.file, version: outcome.version ?? null, after, readbackError,
      })
      return {
        status: 409,
        body: {
          ok: false,
          error: '写入已提交，但磁盘随后被其他写者修改；未确认保存成功，草稿已保留',
          code: 'POST_WRITE_CHANGED',
          expectedHash,
          currentHash,
        },
      }
    }
    if (readbackError !== null) {
      // The write may or may not have reached the disk. Never report a clean
      // success and never silently advance the client baseline; keep the draft.
      await appendDiag({
        ...baseAudit, status: 500, code: 'WRITE_UNCONFIRMED',
        currentHash: source.hash,
        textFnv: fnv1a(content), textLen: Buffer.byteLength(content),
        beforeFnv: fnv1a(source.text), beforeLen: Buffer.byteLength(source.text),
        backup: backupInfo.file, version: outcome.version ?? null,
        readbackError, after,
      })
      return {
        status: 500,
        body: {
          ok: false,
          error: '写入结果未确认（读回失败）；草稿已保留，请以磁盘为准核对，或明确覆盖',
          code: 'WRITE_UNCONFIRMED',
          expectedHash,
        },
      }
    }
    await appendDiag({
      ...baseAudit, status: 200,
      currentHash: source.hash,
      textFnv: fnv1a(content), textLen: Buffer.byteLength(content),
      beforeFnv: fnv1a(source.text), beforeLen: Buffer.byteLength(source.text),
      backup: backupInfo.file, backupBytes: backupInfo.bytes,
      backupDirSync: backupInfo.dirSync, backupPruned: backupInfo.pruned, backupPruneError: backupInfo.pruneError,
      version: outcome.version ?? null, after, verified: true,
      adapterVerified: true, structural,
    })
    if (structural) await publishStructureReload({ requestId: meta?.requestId ?? null, rel })
    return {
      status: 200,
      body: {
        ok: true,
        version: outcome.version,
        hash: createHash('sha1').update(content).digest('hex'),
        size: Buffer.byteLength(content),
        backup: backupInfo.file,
        structural,
        verified: true,
      },
    }
  } catch (error) {
    if (error?.code === 'FS_STALE_VERSION') {
      let currentHash = null
      try { currentHash = (await readSource(ctx, rel)).hash } catch { /* keep null */ }
      await appendDiag({
        ...baseAudit, status: 409, code: 'FS_STALE_VERSION', currentHash,
        textFnv: fnv1a(content), textLen: Buffer.byteLength(content),
      })
      return { status: 409, body: { ok: false, error: 'stale version during atomic write', code: 'STALE', expectedHash, currentHash } }
    }
    // Any other adapter failure after the backup may have happened before or
    // after publication. Treat it as unconfirmed, keep the draft and offer the
    // explicit disk/overwrite reconciliation path; never claim a clean save.
    await appendDiag({
      ...baseAudit, status: 500, code: 'WRITE_UNCONFIRMED', currentHash: source.hash,
      textFnv: fnv1a(content), textLen: Buffer.byteLength(content),
      beforeFnv: fnv1a(source.text), beforeLen: Buffer.byteLength(source.text),
      backup: backupInfo.file,
      adapterError: String(error?.message ?? error).slice(0, 200),
      adapterCode: String(error?.code ?? '').slice(0, 80),
    })
    return {
      status: 500,
      body: {
        ok: false,
        error: '写入结果未确认（适配器异常）；草稿已保留，请以磁盘为准核对，或明确覆盖',
        code: 'WRITE_UNCONFIRMED',
        expectedHash,
      },
    }
  }
}

async function handleSave(ctx, request) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'origin rejected' })
  const requestId = randomUUID()
  const origin = request.headers.get('origin')
  const host = { pid: HOST_PID, bootAt: HOST_BOOT_AT }
  let body
  try {
    body = await request.json()
  } catch {
    await appendDiag({ event: 'save-rejected', requestId, origin, host, reason: 'invalid-json' })
    return json(400, { ok: false, error: 'invalid json' })
  }
  const rel = body?.path
  const expectedHash = body?.expectedHash
  const content = body?.content
  if (typeof rel !== 'string' || typeof expectedHash !== 'string' || typeof content !== 'string') {
    await appendDiag({
      event: 'save-rejected', requestId, origin, host, reason: 'missing-fields',
      pathType: typeof rel, expectedHashType: typeof expectedHash,
      contentType: typeof content,
      textLen: typeof content === 'string' ? Buffer.byteLength(content) : null,
    })
    return json(400, { ok: false, error: 'path, expectedHash, content are required' })
  }
  if (Buffer.byteLength(content) > MAX_BYTES) {
    await appendDiag({ event: 'save-rejected', requestId, origin, host, reason: 'too-large', path: rel, textLen: Buffer.byteLength(content) })
    return json(413, { ok: false, error: 'content too large' })
  }
  const meta = {
    bodyId: typeof body?.diagBodyId === 'string' ? body.diagBodyId.slice(0, 64) : null,
    source: typeof body?.diagSource === 'string' ? body.diagSource.slice(0, 64) : null,
    viewerOpen: body?.diagViewerOpen === true,
    handshakeVersion: typeof body?.handshakeVersion === 'string' ? body.handshakeVersion.slice(0, 64) : null,
    requestId,
    host,
  }
  await appendDiag({
    event: 'save-entry',
    path: rel,
    requestId,
    host,
    expectedHash,
    textLen: Buffer.byteLength(content),
    textFnv: fnv1a(content),
    hasClientDiag: typeof body?.diagBodyId === 'string',
    client: {
      bodyId: meta.bodyId,
      source: meta.source,
      viewerOpen: meta.viewerOpen,
    },
  })
  try {
    const result = await writeGuarded(ctx, rel, expectedHash, content, meta)
    if (result.status === 200) {
      await refreshPreviewManifestSourceDigest()
      result.body.previewReady = await previewReady()
    }
    return json(result.status, result.body)
  } catch (error) {
    await appendDiag({ event: 'save-rejected', requestId, origin, host, reason: 'write-error', path: rel, error: String(error?.message ?? error).slice(0, 160) })
    return json(error?.status ?? 500, { ok: false, error: String(error?.message ?? error) })
  }
}

function backupDirFor(rel) {
  return path.join(BACKUP_ROOT, backupDirName(rel))
}

async function handleBackups(ctx, request) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'origin rejected' })
  const url = new URL(request.url, 'http://dsh.local')
  const rel = url.searchParams.get('path') ?? ''
  try {
    await resolveDoc(rel)
    const files = new Set()
    for (const dir of backupDirsFor(rel, BACKUP_ROOT)) {
      try {
        for (const file of await fs.readdir(dir)) {
          if (file.endsWith('.mdx')) files.add(file)
        }
      } catch { /* no backups in this location */ }
    }
    return json(200, { ok: true, path: rel, backups: [...files].sort() })
  } catch (error) {
    return json(error?.status ?? 500, { ok: false, error: String(error?.message ?? error) })
  }
}

async function handleRestore(ctx, request) {
  if (!originAllowed(request)) return json(403, { ok: false, error: 'origin rejected' })
  const requestId = randomUUID()
  const origin = request.headers.get('origin')
  const host = { pid: HOST_PID, bootAt: HOST_BOOT_AT }
  let body
  try { body = await request.json() } catch { return json(400, { ok: false, error: 'invalid json' }) }
  const rel = body?.path
  const backupFile = body?.backupFile
  const expectedHash = body?.expectedHash
  if (typeof rel !== 'string' || typeof backupFile !== 'string' || typeof expectedHash !== 'string') {
    return json(400, { ok: false, error: 'path, backupFile, expectedHash are required' })
  }
  if (!/^[A-Za-z0-9._-]+\.mdx$/.test(backupFile)) return json(400, { ok: false, error: 'invalid backup file' })
  await appendDiag({ event: 'restore-entry', requestId, path: rel, backupFile, expectedHash })
  try {
    await resolveDoc(rel)
    let backup
    for (const dir of backupDirsFor(rel, BACKUP_ROOT)) {
      try {
        backup = await fs.readFile(path.join(dir, backupFile), 'utf8')
        break
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    if (backup === undefined) throw new Error('backup not found')
    const result = await writeGuarded(ctx, rel, expectedHash, backup, {
      bodyId: null, source: 'restore', viewerOpen: false, requestId,
    })
    await appendDiag({
      event: 'restore-result', requestId, path: rel, backupFile,
      status: result.status, code: result.body?.code ?? null,
    })
    if (result.status === 200) {
      await refreshPreviewManifestSourceDigest()
      result.body.previewReady = await previewReady()
    }
    return json(result.status, result.body)
  } catch (error) {
    await appendDiag({
      event: 'restore-error', requestId, path: rel, backupFile,
      error: String(error?.message ?? error).slice(0, 200),
    })
    return json(error?.status ?? 500, { ok: false, error: String(error?.message ?? error) })
  }
}

export { ensurePreviewMirror, handleInstanceDocuments, handleInstanceSource, handleInstances, handlePreview, handlePreviewAck, handlePreviewRecover, handleSave, handleRestore, handleSite, PREVIEW_ROOT, PREVIEW_MANIFEST, PREVIEW_STATES, previewReady }

export function apply(ctx) {
  ctx.logger.info(`[live-editor-phase2] read/write routes registered (site: ${SITE_ID}, writable: ${SITE.writable}, root: ${SITE.root})`)
  registerImportRoutes(ctx, {
    auditFile: path.join(SITE.root, '.dsh-live-editor', 'import-audit.jsonl'),
  })
  ctx.effect(() => {
    if (!PREVIEW_ENABLED) {
      ctx.logger.info('[live-editor-phase2] preview disabled; staging mirror not initialized')
      return () => {}
    }
    let cancelled = false
    let mirrorStarted = true
    void ensurePreviewMirror().then(() => {
      if (!cancelled) ctx.logger.info('[live-editor-phase2] staging preview mirror ready', PREVIEW_ROOT)
    }).catch((error) => {
      ctx.logger.error('[live-editor-phase2] staging preview mirror failed', error)
    })
    return () => {
      cancelled = true
      if (!mirrorStarted) return
      mirrorStarted = false
      void fs.rm(PREVIEW_ROOT, { recursive: true, force: true }).catch(() => {})
    }
  }, 'live-editor-phase2: preview mirror')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/live-editor/index',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleIndex(ctx, request),
  }), 'live-editor-phase2: index route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/live-editor/instances',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleInstances(ctx, request),
  }), 'live-editor-phase2: instances route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/live-editor/instances/docs',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleInstanceDocuments(ctx, request),
  }), 'live-editor-phase2: instance docs route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/live-editor/instances/source',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleInstanceSource(ctx, request),
  }), 'live-editor-phase2: instance source route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/live-editor/source',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleSource(ctx, request),
  }), 'live-editor-phase2: source route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/live-editor/save',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleSave(ctx, request),
  }), 'live-editor-phase2: save route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/live-editor/backups',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleBackups(ctx, request),
  }), 'live-editor-phase2: backups route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/live-editor/restore',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleRestore(ctx, request),
  }), 'live-editor-phase2: restore route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/live-editor/preview',
    methods: ['POST'],
    requestBody: 'buffered',
    // A2-only reject audit: a failed first preview write previously left no
    // trace because the success audit is inside handlePreview. This wrapper
    // records the actual status/code without changing the response.
    fetch: async (request) => {
      const response = await handlePreview(ctx, request)
      if (PREVIEW_CHANNEL_ENABLED && response.status >= 400) {
        try {
          const data = await response.clone().json()
          await appendDiag({
            event: 'preview-experiment-reject',
            status: response.status,
            code: data?.code ?? null,
            error: data?.error ?? null,
          })
        } catch { /* diagnostics must never break the preview */ }
      }
      return response
    },
  }), 'live-editor-phase2: preview route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/live-editor/preview/ack',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handlePreviewAck(ctx, request),
  }), 'live-editor-phase2: preview ack route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/live-editor/preview/recover',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handlePreviewRecover(ctx, request),
  }), 'live-editor-phase2: preview recover route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/live-editor/site',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleSite(request),
  }), 'live-editor-phase2: site route')
}
