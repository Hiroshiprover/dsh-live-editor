/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Pure builder for the Docusaurus-sidebar file tree.
 *
 * Input is the additive v1 bridge payload published by the dev-only
 * Docusaurus plugin:
 *   { version, locale, generatedAt, trees: { defaultSidebar: [...] } }
 * Items are already sanitized to doc/category/link; this module maps the
 * sidebar's doc ids to the read-only Host index entries. It never guesses a
 * path from an id (docId !== file name), and it drops a category's index doc
 * from the leaf list so the category link and a leaf cannot duplicate.
 */

const MAX_DEPTH = 24
const MAX_NODES = 4000
const MAX_LABEL = 200

function text(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length === 0 ? fallback : trimmed.slice(0, MAX_LABEL)
}

/**
 * Pick the sidebar tree to render. Docusaurus sites may expose several named
 * sidebars; Live Editor uses the default one when present, otherwise the first
 * non-empty array. A raw array payload is accepted for tests and older bridges.
 */
export function selectSidebarTree(payload) {
  if (payload === null || payload === undefined) return null
  if (Array.isArray(payload)) {
    return { name: 'sidebar', items: payload, version: null, locale: null, generatedAt: null }
  }
  if (typeof payload !== 'object') return null
  const trees = payload.trees && typeof payload.trees === 'object' ? payload.trees : payload
  let name = null
  let items = null
  if (Array.isArray(trees.defaultSidebar)) {
    name = 'defaultSidebar'
    items = trees.defaultSidebar
  } else {
    for (const [key, value] of Object.entries(trees)) {
      if (Array.isArray(value)) {
        name = key
        items = value
        break
      }
    }
  }
  if (items === null) return null
  return {
    name,
    items,
    version: typeof payload.version === 'string' ? payload.version : null,
    locale: typeof payload.locale === 'string' ? payload.locale : null,
    generatedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : null,
  }
}

function compareDoc(left, right) {
  const byPath = left.path.localeCompare(right.path)
  if (byPath !== 0) return byPath
  return String(left.title ?? '').localeCompare(String(right.title ?? ''))
}

/**
 * Build a FilePanel tree from a bridge sidebar payload and Host index docs.
 * @returns root node `{kind:'root', children: [...]}` or null when no sidebar
 * payload/tree is available (parent falls back to the filesystem tree).
 */
export function buildSidebarTree(payload, docs, options = {}) {
  const payloadInstanceId = typeof payload?.instanceId === 'string' && payload.instanceId.length > 0
    ? payload.instanceId
    : null
  // An unqualified sidebar belongs to the known legacy default; the active
  // document must not be able to relabel it as another instance.
  const instanceId = payloadInstanceId ?? 'default'
  if (payloadInstanceId !== null && typeof options?.instanceId === 'string'
    && options.instanceId.length > 0 && options.instanceId !== payloadInstanceId) return null
  const selected = selectSidebarTree(payload)
  if (selected === null || !Array.isArray(docs)) return null

  const docKey = (entry) => `${entry?.instanceId ?? 'default'}|${entry?.versionName ?? 'current'}|${entry?.docId ?? ''}`
  const byDocId = new Map()
  for (const entry of docs) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue
    if ((entry.instanceId ?? 'default') !== instanceId) continue
    if (typeof entry.docId === 'string' && entry.docId.length > 0 && !byDocId.has(docKey(entry))) {
      byDocId.set(docKey(entry), entry)
    }
  }

  const used = new Set()
  const budget = { count: 0 }
  const usedKey = (entry) => `${entry?.instanceId ?? 'default'}|${entry?.path ?? ''}`
  const versionName = typeof options?.versionName === 'string' && options.versionName.length > 0
    ? options.versionName
    : (typeof payload?.version === 'string' ? payload.version : 'current')
  const docFor = (id) => typeof id === 'string' ? byDocId.get(`${instanceId}|${versionName}|${id}`) : undefined

  const makeDoc = (entry, labelOverride) => {
    if (!entry || typeof entry.path !== 'string' || used.has(usedKey(entry)) || budget.count >= MAX_NODES) return null
    used.add(usedKey(entry))
    budget.count += 1
    return {
      kind: 'doc',
      path: entry.path,
      title: entry.title ?? entry.path,
      label: text(labelOverride, text(entry.title, entry.path)),
      docId: entry.docId ?? null,
      instanceId: entry.instanceId ?? instanceId,
      versionName: entry.versionName ?? null,
      source: entry.source ?? null,
    }
  }

  const convert = (item, depth, index) => {
    if (!item || typeof item !== 'object' || depth > MAX_DEPTH || budget.count >= MAX_NODES) return null
    if (item.type === 'doc' || item.type === 'ref') return makeDoc(docFor(item.id), item.label)
    if (item.type === 'link') {
      return {
        kind: 'link',
        key: `link:${depth}:${index}`,
        label: text(item.label, text(item.href, '链接')),
        href: typeof item.href === 'string' ? item.href : '',
        disabled: true,
      }
    }
    if (item.type !== 'category') return null

    // Claim the category's linked index doc before descending: if the same doc
    // also appears as a leaf in `items`, the leaf is skipped, not duplicated.
    let indexEntry = null
    let indexPath = null
    let indexDisabled = false
    if (item.link && item.link.type === 'doc') {
      indexEntry = docFor(item.link.id)
      if (indexEntry && !used.has(usedKey(indexEntry))) {
        used.add(usedKey(indexEntry))
        budget.count += 1
        indexPath = indexEntry.path
      }
    } else if (item.link && item.link.type === 'generated-index') {
      indexDisabled = true
    }

    const children = []
    const items = Array.isArray(item.items) ? item.items : []
    for (let childIndex = 0; childIndex < items.length; childIndex += 1) {
      const child = convert(items[childIndex], depth + 1, childIndex)
      if (child !== null) children.push(child)
    }
    budget.count += 1
    return {
      kind: 'dir',
      path: `cat:${depth}:${index}:${text(item.label, '')}`,
      label: text(item.label, '未命名分类'),
      defaultCollapsed: item.collapsed === true,
      children,
      indexPath,
      indexDisabled,
      indexTitle: indexEntry?.title ?? null,
    }
  }

  const roots = []
  for (let index = 0; index < selected.items.length; index += 1) {
    const node = convert(selected.items[index], 0, index)
    if (node !== null) roots.push(node)
  }

  const other = docs
    .filter((entry) => entry && typeof entry.path === 'string' && (entry.instanceId ?? 'default') === instanceId && !used.has(usedKey(entry)))
    .sort(compareDoc)
  if (other.length > 0) {
    const children = []
    for (const entry of other) {
      const node = makeDoc(entry)
      if (node !== null) children.push(node)
    }
    if (children.length > 0) {
      roots.push({
        kind: 'dir',
        path: '__other__',
        label: '其他文件',
        defaultCollapsed: false,
        children,
        indexPath: null,
        indexDisabled: false,
        indexTitle: null,
      })
    }
  }

  return {
    kind: 'root',
    path: '',
    source: 'sidebar',
    name: selected.name,
    version: selected.version,
    locale: selected.locale,
    generatedAt: selected.generatedAt,
    children: roots,
  }
}

/** Collect every directory/category path in a FilePanel tree. */
export function collectDirPaths(node, out = []) {
  if (!node || !Array.isArray(node.children)) return out
  for (const child of node.children) {
    if (child.kind === 'dir') {
      out.push(child.path)
      collectDirPaths(child, out)
    }
  }
  return out
}

/** Directory/category paths that must be open for `targetPath` to be visible. */
export function ancestorPaths(node, targetPath, trail = [], out = []) {
  if (!node || !Array.isArray(node.children)) return out
  for (const child of node.children) {
    if (child.kind === 'doc' && child.path === targetPath) {
      out.push(...trail)
      return out
    }
    if (child.kind === 'dir') {
      const nextTrail = [...trail, child.path]
      if (child.indexPath === targetPath) {
        out.push(...trail)
        return out
      }
      ancestorPaths(child, targetPath, nextTrail, out)
      if (out.length > 0) return out
    }
  }
  return out
}
