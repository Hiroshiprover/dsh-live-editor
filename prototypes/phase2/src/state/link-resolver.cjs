/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Source Cmd+click link resolution.
 *
 * Two independent guards sit in front of the Lezer Markdown tree:
 *   1. math ranges (`$$…$$`, `$…$`, `\(…\)`, `\[…\]`) — Lezer happily parses
 *      `[X'(f)](p)` inside display math as a Link; those are not links;
 *   2. no-target nodes (`[^1]`, bare `[text]`, images) — only a URL child or a
 *      resolvable reference definition is a target.
 *
 * Target parsing never falls back to a regex over Markdown source. Link
 * extraction comes from the Lezer tree; path resolution is plain string /
 * posix-path work against the read-only Host doc index.
 */
const { ensureSyntaxTree, syntaxTree } = require('@codemirror/language')

const LINK_NAMES = new Set(['Link', 'Autolink'])
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
const ASSET_TARGET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|pdf|mp4|webm|mp3|zip|json|csv|ipynb|txt|ya?ml)$/i
const MARKDOWN_TARGET = /\.(?:md|mdx)$/i

function inRanges(ranges, position) {
  for (const [from, to] of ranges) {
    if (position >= from && position < to) return true
  }
  return false
}

function isEscaped(text, index) {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1
  return slashes % 2 === 1
}

function lineStartAt(text, index) {
  const previous = text.lastIndexOf('\n', index - 1)
  return previous < 0 ? 0 : previous + 1
}

/** Ranges that are code/frontmatter/comments and therefore cannot contain links. */
function findOpaqueRanges(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const ranges = []
  const lineStarts = [0]
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1)
  const lineText = (line) => {
    const from = lineStarts[line]
    const to = line < lineStarts.length - 1 ? lineStarts[line + 1] - 1 : text.length
    return { from, to, text: text.slice(from, to) }
  }
  const add = (from, to) => {
    if (to > from) ranges.push([from, to])
  }

  // Frontmatter (only at the first line) and fenced code blocks.
  let line = 0
  if (lineText(0).text.trim() === '---') {
    add(0, lineText(0).to + 1)
    for (line = 1; line < lineStarts.length; line += 1) {
      const info = lineText(line)
      add(info.from, info.to + 1)
      if (info.text.trim() === '---') break
    }
    line += 1
  }
  let fence = null
  for (; line < lineStarts.length; line += 1) {
    const info = lineText(line)
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(info.text)
    if (fence === null) {
      if (match) {
        fence = { marker: match[1][0], length: match[1].length }
        add(info.from, info.to + 1)
      }
    } else {
      add(info.from, info.to + 1)
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length) fence = null
    }
  }

  // Inline code spans and MDX comments, line by line (comments may span lines).
  let commentStart = -1
  for (let current = 0; current < lineStarts.length; current += 1) {
    const info = lineText(current)
    if (commentStart >= 0) {
      const end = text.indexOf('*/}', commentStart)
      if (end >= 0) {
        add(commentStart, end + 3)
        commentStart = -1
        current = lineStarts.findIndex((start) => start > end) - 1
      }
      continue
    }
    let i = info.from
    while (i <= info.to) {
      if (text.startsWith('{/*', i)) {
        const end = text.indexOf('*/}', i + 3)
        if (end >= 0) {
          add(i, end + 3)
          i = end + 3
          if (i > info.to) {
            commentStart = -1
            const lineAt = lineStarts.findIndex((start) => start > end)
            if (lineAt >= 0) current = lineAt - 1
          }
          continue
        }
        commentStart = i
        add(i, info.to + 1)
        break
      }
      if (text[i] === '`') {
        let run = 0
        while (text[i + run] === '`') run += 1
        const close = text.indexOf('`'.repeat(run), i + run)
        if (close >= 0 && close + run <= info.to + 1) {
          add(i, close + run)
          i = close + run
          continue
        }
        i += run
        continue
      }
      i += 1
    }
  }
  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1])
  return ranges
}

/**
 * Math intervals used to reject Lezer's false-positive links inside formulas.
 * The scan follows the site's remark-math syntax (single/double dollars and
 * LaTeX bracket delimiters); code, frontmatter and MDX comments are skipped.
 */
function findMathRanges(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const opaque = findOpaqueRanges(text)
  const ranges = []
  const findDelimiter = (from, delimiter) => {
    let i = from
    while (i <= text.length - delimiter.length) {
      if (inRanges(opaque, i)) {
        const covering = opaque.find(([start, end]) => i >= start && i < end)
        i = covering ? covering[1] : i + 1
        continue
      }
      if (isEscaped(text, i)) {
        i += 1
        continue
      }
      if (text.startsWith(delimiter, i)) return i
      i += 1
    }
    return -1
  }
  const addRange = (from, close, width) => {
    if (close < 0) return false
    ranges.push([from, close + width])
    return true
  }

  let i = 0
  while (i < text.length) {
    if (inRanges(opaque, i)) {
      const covering = opaque.find(([start, end]) => i >= start && i < end)
      i = covering ? covering[1] : i + 1
      continue
    }
    if (text[i] === '\\') {
      if (i + 1 < text.length && text[i + 1] === '[') {
        const close = findDelimiter(i + 2, '\\]')
        if (addRange(i, close, 2)) { i = close + 2; continue }
      } else if (i + 1 < text.length && text[i + 1] === '(') {
        const close = findDelimiter(i + 2, '\\)')
        if (addRange(i, close, 2)) { i = close + 2; continue }
      }
      i += 2
      continue
    }
    if (text.startsWith('$$', i)) {
      const close = findDelimiter(i + 2, '$$')
      if (close >= 0) { ranges.push([i, close + 2]); i = close + 2; continue }
      i += 2
      continue
    }
    if (text[i] === '$') {
      let close = findDelimiter(i + 1, '$')
      while (close >= 0 && text[close + 1] === '$') close = findDelimiter(close + 1, '$')
      if (close >= 0 && !text.slice(i + 1, close).includes('\n\n')) {
        ranges.push([i, close + 1])
        i = close + 1
        continue
      }
    }
    i += 1
  }
  return ranges
}

function stripAngle(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed
}

function normalizeLabel(value) {
  return stripAngle(value).replace(/^\[|\]$/g, '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function collectReferenceDefinitions(tree, text) {
  const definitions = new Map()
  const cursor = tree.cursor()
  do {
    if (cursor.name !== 'LinkReference') continue
    let label = null
    let url = null
    const sub = cursor.node.cursor()
    if (sub.firstChild()) {
      do {
        if (sub.name === 'LinkLabel') label = text.slice(sub.from, sub.to)
        else if (sub.name === 'URL') url = text.slice(sub.from, sub.to)
      } while (sub.nextSibling())
    }
    if (label !== null && url !== null) definitions.set(normalizeLabel(label), stripAngle(url))
  } while (cursor.next())
  return definitions
}

/**
 * Find the link at a source position. Returns null for images, no-target
 * brackets/footnotes, code, comments and math. Only a Lezer `Link`/`Autolink`
 * with a URL (or a resolved reference definition) can produce a result.
 */
function findLinkAt(state, position) {
  if (!state || typeof position !== 'number' || position < 0) return null
  const text = state.doc.toString()
  const math = findMathRanges(text)
  if (inRanges(math, position)) return null
  const opaque = findOpaqueRanges(text)
  if (inRanges(opaque, position)) return null

  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, position + 1), 100) ?? syntaxTree(state)
  let node = tree.resolveInner(position, -1)
  while (node !== null && !LINK_NAMES.has(node.name) && node.name !== 'Image') node = node.parent
  if (node === null || node.name === 'Image') return null
  if (inRanges(math, node.from) || inRanges(opaque, node.from)) return null

  let url = null
  let label = null
  let child = node.firstChild
  while (child !== null) {
    if (child.name === 'URL') url = text.slice(child.from, child.to)
    else if (child.name === 'LinkLabel') label = text.slice(child.from, child.to)
    child = child.nextSibling
  }
  if (url === null && label !== null) {
    let key = normalizeLabel(label)
    if (key === '') {
      const raw = text.slice(node.from, node.to)
      const first = /^\[([^\]]*)\]/.exec(raw)
      if (first) key = normalizeLabel(first[1])
    }
    if (key === '') return null
    url = collectReferenceDefinitions(tree, text).get(key) ?? null
  }
  if (url === null || url.length === 0) return null

  const target = stripAngle(url)
  if (target.length === 0) return null
  return { target, node: node.name, from: node.from, to: node.to }
}

function decodePath(value) {
  try { return decodeURIComponent(value) } catch { return value }
}

function splitTarget(raw) {
  let value = stripAngle(raw)
  if (value.length === 0) return { path: '', anchor: '' }
  let anchor = ''
  const hash = value.indexOf('#')
  if (hash >= 0) {
    anchor = value.slice(hash + 1)
    value = value.slice(0, hash)
  }
  const query = value.indexOf('?')
  if (query >= 0) value = value.slice(0, query)
  if (value.length === 0 && anchor.length === 0) return { path: '', anchor: '' }
  return { path: decodePath(value), anchor }
}

function normalizePermalink(value) {
  const trimmed = value.replace(/\/+$/, '')
  return trimmed === '' ? '/' : `${trimmed}/`
}

function posixDirname(value) {
  const index = value.lastIndexOf('/')
  if (index < 0) return '.'
  return index === 0 ? '/' : value.slice(0, index)
}

function posixNormalize(value) {
  const absolute = value.startsWith('/')
  const parts = []
  for (const part of value.split('/')) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
    } else {
      parts.push(part)
    }
  }
  const body = parts.join('/')
  if (absolute) return `/${body}` || '/'
  return body.length > 0 ? body : '.'
}

function posixJoin(left, right) {
  return posixNormalize(`${left}/${right}`)
}

function mapFrom(value) {
  if (value instanceof Map) return value
  if (value && typeof value === 'object') return new Map(Object.entries(value))
  return new Map()
}

/**
 * Resolve one source link target against the Host doc index.
 *
 * @returns `{kind:'doc', path, anchor}`, `{kind:'ambiguous', paths, anchor}`,
 *          `{kind:'unmapped', target, anchor}` or `{kind:'skip'}`.
 */
function resolveLinkTarget(raw, currentPath, index) {
  const { path: targetPath, anchor } = splitTarget(raw)
  if (targetPath.length === 0) {
    return anchor.length > 0 && typeof currentPath === 'string'
      ? { kind: 'doc', path: currentPath, anchor }
      : { kind: 'skip' }
  }
  if (EXTERNAL_TARGET.test(targetPath) || ASSET_TARGET.test(targetPath)) return { kind: 'skip' }
  if (targetPath.startsWith('/blog/')) return { kind: 'skip' }

  const byPath = mapFrom(index?.docByPath)
  const byPermalink = mapFrom(index?.docByPermalink)

  if (targetPath.startsWith('/')) {
    const entry = byPermalink.get(normalizePermalink(targetPath))
    if (entry) return { kind: 'doc', path: entry.path, anchor }
    return { kind: 'unmapped', target: targetPath, anchor }
  }

  if (typeof currentPath !== 'string' || currentPath.length === 0) {
    return { kind: 'unmapped', target: targetPath, anchor }
  }
  const base = posixDirname(currentPath)
  const resolved = posixNormalize(posixJoin(base, targetPath))
  if (resolved.startsWith('..')) return { kind: 'unmapped', target: targetPath, anchor }

  const candidates = []
  const add = (candidate) => {
    const entry = byPath.get(candidate)
    if (entry && !candidates.some((value) => value.path === entry.path)) candidates.push(entry)
  }
  add(resolved)
  if (!MARKDOWN_TARGET.test(resolved)) {
    add(`${resolved}.mdx`)
    add(`${resolved}.md`)
    add(posixJoin(resolved, 'index.mdx'))
    add(posixJoin(resolved, 'index.md'))
  }
  if (candidates.length === 1) return { kind: 'doc', path: candidates[0].path, anchor }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', paths: candidates.map((entry) => entry.path), anchor }
  }
  return { kind: 'unmapped', target: targetPath, anchor }
}

module.exports = { findOpaqueRanges, findMathRanges, findLinkAt, resolveLinkTarget }
