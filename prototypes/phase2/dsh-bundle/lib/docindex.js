/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Phase 2 — read-only DocIndex for the Live Editor Host.
 *
 * Derives a filesystem <-> Docusaurus route index for a docs root without
 * importing Docusaurus. Rules mirror @docusaurus/plugin-content-docs 3.10.1:
 *   - number prefixes: /^(?<n>\d+)\s*[-_.]+\s*(?<suffix>[^-_.\s].*)$/ and
 *     date-like prefixes (^\d+[-_.]\d+) are not stripped;
 *   - category index docs: index / readme / <folder> use the directory slug;
 *   - frontMatter.slug starting with "/" is used as-is;
 *   - permalink = baseUrl + routeBasePath + slug (+ trailing slash).
 *
 * The bridge-reported docMap stays authoritative for permalinks at runtime;
 * this index is the always-available fallback and the file tree source.
 *
 * Security: only relative posix paths are returned; symlinks and dotfiles are
 * skipped; the root itself is never returned.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 2000,
  maxFileBytes: 4 * 1024 * 1024,
  maxWarnings: 20,
})

const NUMBER_PREFIX = /^(?<numberPrefix>\d+)\s*[-_.]+\s*(?<suffix>[^-_.\s].*)$/
const DATE_LIKE_PREFIX = /^\d+[-_.]\d+/
const MARKDOWN = /\.(mdx?|md)$/i

export function stripNumberPrefix(name) {
  const value = String(name ?? '')
  if (DATE_LIKE_PREFIX.test(value)) return value
  const match = NUMBER_PREFIX.exec(value)
  return match?.groups?.suffix ?? value
}

export function numberPrefixOf(name) {
  const value = String(name ?? '')
  if (DATE_LIKE_PREFIX.test(value)) return null
  const match = NUMBER_PREFIX.exec(value)
  return match?.groups?.numberPrefix ? Number(match.groups.numberPrefix) : null
}

export function isCategoryIndex(fileName, dirNames = []) {
  const lower = String(fileName ?? '').toLowerCase()
  if (lower === 'index' || lower === 'readme') return true
  const parent = dirNames[dirNames.length - 1]
  return typeof parent === 'string' && lower === parent.toLowerCase()
}

export function computeDocId(relPosix) {
  const noExt = String(relPosix).replace(MARKDOWN, '')
  return noExt.split('/').map(stripNumberPrefix).join('/')
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl ?? '/').trim()
  return value.startsWith('/') ? value : `/${value}`
}

function joinUrl(...parts) {
  const joined = parts
    .map((part) => String(part ?? '').trim())
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0)
    .join('/')
  return `/${joined}`
}

/**
 * Compute the Docusaurus slug for a docs-relative file.
 * `dirNames` are the raw (possibly number-prefixed) directory segments.
 */
export function computeSlug(relPosix, frontMatter = {}) {
  const segments = String(relPosix).split('/')
  const file = segments.pop() ?? ''
  const baseName = file.replace(MARKDOWN, '')
  const dirNames = segments
  const dirSlug = dirNames.length === 0
    ? '/'
    : `/${dirNames.map(stripNumberPrefix).join('/')}/`

  const frontMatterSlug = typeof frontMatter.slug === 'string' && frontMatter.slug.trim().length > 0
    ? frontMatter.slug.trim()
    : undefined

  if (frontMatterSlug?.startsWith('/')) return frontMatterSlug
  if (!frontMatterSlug && isCategoryIndex(baseName, dirNames)) return dirSlug
  const baseSlug = frontMatterSlug ?? stripNumberPrefix(baseName)
  const resolved = path.posix.resolve(dirSlug, baseSlug)
  return resolved.startsWith('/') ? resolved : `/${resolved}`
}

export function computePermalink({
  relPosix,
  frontMatter = {},
  routeBasePath = '/docs',
  baseUrl = '/',
  trailingSlash = true,
}) {
  const slug = computeSlug(relPosix, frontMatter)
  const base = normalizeBaseUrl(baseUrl)
  const route = String(routeBasePath ?? '').trim()
  const url = joinUrl(base, route, slug)
  return trailingSlash && !url.endsWith('/') ? `${url}/` : url
}

/**
 * Normalize a Docusaurus `metadata.source` into a docs-relative identity.
 * Returns null for absolute paths, traversal or unknown prefixes.
 */
export function normalizeDocSource(input, { docsPrefix = 'docs/' } = {}) {
  if (typeof input !== 'string') return null
  let text = input.replaceAll('\\', '/').trim()
  if (text.startsWith('@site/')) text = text.slice('@site/'.length)
  if (text.length === 0 || text.startsWith('/')) return null
  if (text.split('/').some((part) => part === '..' || part === '.')) return null
  if (text.startsWith(docsPrefix)) {
    const relPath = text.slice(docsPrefix.length)
    if (relPath.length === 0 || relPath.endsWith('/')) return null
    return { kind: 'docs', source: `${docsPrefix}${relPath}`, relPath, locale: null }
  }
  const i18n = /^i18n\/([^/]+)\/docusaurus-plugin-content-docs\/current\/(.+)$/.exec(text)
  if (i18n) {
    return { kind: 'i18n', source: text, relPath: i18n[2], locale: i18n[1] }
  }
  return null
}

function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const result = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!m) continue
    const value = m[2].trim().replace(/^['"]|['"]$/g, '')
    if (value.length === 0) continue
    result[m[1]] = value
  }
  return result
}

function firstHeading(text) {
  const match = /^#\s+(.+)$/m.exec(text)
  return match ? match[1].trim() : null
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value
  return value === 'true'
}

async function readCategory(dirAbs) {
  const file = path.join(dirAbs, '_category_.json')
  try {
    const text = await fs.readFile(file, 'utf8')
    const data = JSON.parse(text)
    return {
      label: typeof data.label === 'string' ? data.label : null,
      position: toNumber(data.position),
      collapsible: data.collapsible === undefined ? null : toBoolean(data.collapsible),
      link: data.link && typeof data.link === 'object' ? data.link : null,
    }
  } catch {
    return null
  }
}

/**
 * Build the read-only index.
 * @returns {Promise<{ok:boolean, generatedAt:string, counts:object, entries:object[], warnings:string[], truncated:boolean}>}
 */
export async function buildIndex({
  docsRoot,
  routeBasePath = '/docs',
  baseUrl = '/',
  trailingSlash = true,
  sourceRoot = 'docs',
  instanceId = 'default',
  versionName = 'current',
  editable = true,
  limits = {},
}) {
  const cap = { ...DEFAULT_LIMITS, ...limits }
  const rootReal = await fs.realpath(path.resolve(docsRoot))
  const entries = []
  const warnings = []
  const counts = { dirs: 0, docs: 0, other: 0, skipped: 0 }
  let truncated = false

  const note = (message) => {
    if (warnings.length < cap.maxWarnings) warnings.push(message)
  }

  const walk = async (relDir) => {
    const absDir = path.join(rootReal, relDir)
    let dirents
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true })
    } catch (error) {
      note(`cannot read dir ${relDir || '.'}: ${String(error?.code ?? error)}`)
      return
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name))
    for (const dirent of dirents) {
      if (entries.length >= cap.maxEntries) {
        truncated = true
        return
      }
      if (dirent.name.startsWith('.')) {
        counts.skipped += 1
        continue
      }
      const rel = relDir === '' ? dirent.name : `${relDir}/${dirent.name}`
      if (dirent.isSymbolicLink()) {
        counts.skipped += 1
        note(`skipped symlink ${rel}`)
        continue
      }
      if (dirent.isDirectory()) {
        counts.dirs += 1
        const category = await readCategory(path.join(rootReal, rel))
        entries.push({
          kind: 'dir',
          path: rel,
          name: dirent.name,
          label: category?.label ?? stripNumberPrefix(dirent.name),
          position: category?.position ?? numberPrefixOf(dirent.name),
          collapsible: category?.collapsible ?? null,
          link: category?.link ?? null,
        })
        await walk(rel)
        continue
      }
      if (!dirent.isFile()) {
        counts.skipped += 1
        continue
      }
      if (dirent.name === '_category_.json') {
        counts.other += 1
        entries.push({ kind: 'other', path: rel, name: dirent.name, editable: false })
        continue
      }
      if (!MARKDOWN.test(dirent.name)) {
        counts.other += 1
        entries.push({ kind: 'other', path: rel, name: dirent.name, editable: false })
        continue
      }
      const abs = path.join(rootReal, rel)
      const info = await fs.stat(abs)
      if (info.size > cap.maxFileBytes) {
        counts.skipped += 1
        note(`skipped large file ${rel} (${info.size} bytes)`)
        continue
      }
      const text = await fs.readFile(abs, 'utf8')
      const frontMatter = parseFrontMatter(text)
      const fileBase = dirent.name.replace(MARKDOWN, '')
      const dirNames = rel.split('/').slice(0, -1)
      const docId = computeDocId(rel)
      entries.push({
        kind: 'doc',
        path: rel,
        name: dirent.name,
        docId,
        source: `${sourceRoot}/${rel}`,
        instanceId,
        versionName,
        sourceRoot,
        slug: computeSlug(rel, frontMatter),
        permalink: computePermalink({ relPosix: rel, frontMatter, routeBasePath, baseUrl, trailingSlash }),
        title: frontMatter.title ?? firstHeading(text) ?? fileBase,
        sidebarLabel: frontMatter.sidebar_label ?? null,
        position: toNumber(frontMatter.sidebar_position) ?? numberPrefixOf(dirent.name),
        draft: toBoolean(frontMatter.draft),
        unlisted: toBoolean(frontMatter.unlisted),
        size: info.size,
        editable,
      })
      counts.docs += 1
    }
  }

  await walk('')
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    counts,
    entries,
    warnings,
    truncated,
    limits: { maxEntries: cap.maxEntries, maxFileBytes: cap.maxFileBytes },
  }
}

/** Index a return by source ("docs/...") for merge with the bridge docMap. */
export function bySource(index) {
  const map = new Map()
  for (const entry of index?.entries ?? []) {
    if (entry.kind === 'doc') map.set(entry.source, entry)
  }
  return map
}
