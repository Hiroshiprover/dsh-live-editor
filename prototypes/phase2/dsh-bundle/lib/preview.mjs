/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Step 3.3-B — pure staging preview helpers.
 *
 * These helpers are shared by the Host staging writer and tests. They never
 * touch the real docs tree; callers pass/consume staging-only text.
 */
import path from 'node:path'
import { computePermalink, normalizeDocSource } from './docindex.js'

export const PREVIEW_ROUTE_BASE = '/__live-preview'
export const PREVIEW_SESSION_FIELD = 'dsh_preview_session'
export const PREVIEW_REVISION_FIELD = 'dsh_preview_revision'
export const MAX_PREVIEW_BYTES = 4 * 1024 * 1024
const DOC_SOURCE = /^docs\/[A-Za-z0-9._\-\/]+\.mdx?$/
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function normalizePreviewSource(source) {
  const normalized = normalizeDocSource(source)
  if (normalized === null || normalized.kind !== 'docs') return null
  if (!DOC_SOURCE.test(normalized.source)) return null
  if (normalized.source.includes('..') || normalized.source.includes('\\')) return null
  return normalized.source
}

export function previewRelPath(source) {
  const normalized = normalizePreviewSource(source)
  return normalized === null ? null : normalized.slice('docs/'.length)
}

export function computePreviewPermalink(source, { baseUrl = '/', trailingSlash = true } = {}) {
  const rel = previewRelPath(source)
  if (rel === null) return null
  return computePermalink({
    relPosix: rel,
    frontMatter: {},
    routeBasePath: PREVIEW_ROUTE_BASE,
    baseUrl,
    trailingSlash,
  })
}

export function previewTarget(root, source) {
  const rel = previewRelPath(source)
  if (rel === null) return null
  const abs = path.resolve(root, rel)
  const rootAbs = path.resolve(root)
  if (abs !== rootAbs && !abs.startsWith(`${rootAbs}${path.sep}`)) return null
  return abs
}

/** Remove the real slug only from the staging mirror, so preview routes are source-based and unique. */
export function stripStagingSlug(text) {
  if (typeof text !== 'string') return text
  const match = FRONTMATTER.exec(text)
  if (match === null) return text
  const body = match[1]
    .replace(/^slug\s*:\s*.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
  const block = body.length > 0 ? `---\n${body}\n---\n` : '---\n---\n'
  return block + text.slice(match[0].length)
}

/** Inject the preview session/revision into staging frontmatter. Never used for real docs. */
export function injectPreviewMeta(text, { session, revision }) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  if (typeof session !== 'string' || session.length === 0 || session.length > 128) {
    throw new TypeError('invalid preview session')
  }
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('invalid preview revision')
  const meta = `${PREVIEW_SESSION_FIELD}: ${JSON.stringify(session)}\n${PREVIEW_REVISION_FIELD}: ${revision}`
  const match = FRONTMATTER.exec(text)
  if (match !== null) {
    const body = match[1]
      .replace(new RegExp(`^${PREVIEW_SESSION_FIELD}\\s*:\\s*.*$`, 'gm'), '')
      .replace(new RegExp(`^${PREVIEW_REVISION_FIELD}\\s*:\\s*.*$`, 'gm'), '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+|\n+$/g, '')
    const block = `---\n${body.length > 0 ? `${body}\n` : ''}${meta}\n---\n`
    return block + text.slice(match[0].length)
  }
  return `---\n${meta}\n---\n\n${text}`
}

export function readPreviewMeta(text) {
  if (typeof text !== 'string') return { session: null, revision: null }
  const match = FRONTMATTER.exec(text)
  if (match === null) return { session: null, revision: null }
  const sessionMatch = new RegExp(`^${PREVIEW_SESSION_FIELD}\\s*:\\s*(.+)$`, 'm').exec(match[1])
  const revisionMatch = new RegExp(`^${PREVIEW_REVISION_FIELD}\\s*:\\s*(\\d+)\\s*$`, 'm').exec(match[1])
  let session = null
  if (sessionMatch !== null) {
    const value = sessionMatch[1].trim().replace(/^["']|["']$/g, '')
    if (value.length > 0 && value.length <= 128) session = value
  }
  const revision = revisionMatch === null ? null : Number(revisionMatch[1])
  return { session, revision: Number.isSafeInteger(revision) ? revision : null }
}

export const R2_WRITE_ID_MARKER = 'dsh-r2-write-id'
export const R2_REVISION_MARKER = 'dsh-r2-revision'
const R2_MARKERS = /\n?<span id="dsh-r2-(?:write-id|revision)"[^>]*>[\s\S]*?<\/span>\s*/g

/**
 * Add hidden, DOM-visible identity markers to staging preview text only.
 * The formal R2 child channel reads them after a real commit; an old DOM keeps
 * the old values and cannot acknowledge a newer command.
 */
export function injectR2Markers(text, { writeId, revision }) {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  if (typeof writeId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(writeId)) {
    throw new TypeError('invalid preview writeId')
  }
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('invalid preview revision')
  const clean = text.replace(R2_MARKERS, '').replace(/\s+$/, '')
  return `${clean}\n\n<span id="${R2_WRITE_ID_MARKER}" hidden>${writeId}</span>\n<span id="${R2_REVISION_MARKER}" hidden>${revision}</span>\n`
}


const PREVIEW_META_FIELDS = new Set([PREVIEW_SESSION_FIELD, PREVIEW_REVISION_FIELD])

/** Extract the frontmatter block, excluding preview-only metadata. */
export function structuralFrontMatter(text) {
  if (typeof text !== 'string') return ''
  const match = FRONTMATTER.exec(text)
  if (match === null) return ''
  return match[1]
    .split(/\r?\n/)
    .filter((line) => !PREVIEW_META_FIELDS.has((/^\s*([^:]+):/.exec(line)?.[1] ?? '').trim()))
    .join('\n')
    .trim()
}

/**
 * Structural change means frontmatter that can affect routing/sidebar/render
 * options changed. Body-only edits return false. The first write is not a
 * change; callers pass the previous staged/raw text explicitly.
 */
const FIRST_H1 = /^#\s+(.+)$/m
// Docusaurus also treats a paragraph immediately followed by a line of '='
// as an H1 (setext heading). Ignore obvious block starts so a '=' line under
// a list/quote is not misread as a title.
const SETEXT_H1 = /^(?!\s{0,3}(?:#|>|[-*+]\s|\d+\.\s))(.+?)\r?\n\s*=+\s*$/m
const TITLE_FIELD = /^\s*title\s*:/m

function fallbackTitle(text) {
  const frontMatter = structuralFrontMatter(text)
  if (TITLE_FIELD.test(frontMatter)) return null
  const atx = FIRST_H1.exec(text)?.[1]?.trim()
  if (atx) return atx
  return SETEXT_H1.exec(text)?.[1]?.trim() ?? ''
}

export function hasStructuralPreviewChange(previousText, nextText) {
  if (typeof previousText !== 'string') return false
  if (typeof nextText !== 'string') return true
  if (structuralFrontMatter(previousText) !== structuralFrontMatter(nextText)) return true
  // Docusaurus can use a body H1 as the document title when frontmatter has no
  // title. Only compare that fallback in the no-title case; ordinary body edits
  // must stay reload-free.
  return fallbackTitle(previousText) !== fallbackTitle(nextText)
}

export const R2_SENTINEL_REL = '.dsh-r2-sentinel.json'

export function r2SentinelTarget(root) {
  return path.join(root, '..', R2_SENTINEL_REL)
}

export function renderR2Sentinel({ source, session, revision, writeId, structural = true }) {
  if (typeof source !== 'string' || typeof session !== 'string'
    || !Number.isSafeInteger(revision) || revision < 1
    || typeof writeId !== 'string' || writeId.length === 0) {
    throw new TypeError('invalid R2 sentinel payload')
  }
  return JSON.stringify({
    version: 1, source, session, revision, writeId, structural: structural === true,
  }) + '\n'
}
