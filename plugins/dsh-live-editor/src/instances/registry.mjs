/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import path from 'node:path'

/**
 * Pure content-instance registry for Docusaurus 3.10.1.
 *
 * This module has no filesystem side effects and is not consumed by the running
 * editor yet. It turns `allContent` into stable descriptors, editable source
 * identities, rendered identities and a legacy-default projection.
 */
const DOCS_PLUGIN = 'docusaurus-plugin-content-docs'
const BLOG_PLUGIN = 'docusaurus-plugin-content-blog'
const PAGES_PLUGIN = 'docusaurus-plugin-content-pages'

const posix = (value) => String(value).replaceAll('\\', '/')
const trimSlashes = (value) => posix(value).replace(/^\/+|\/+$/g, '')
const normalizePermalink = (value) => {
  if (typeof value !== 'string' || value.length === 0) return null
  const text = posix(value)
  return text === '/' ? '/' : text.replace(/\/+$/, '') || '/'
}
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//

function normalizeRelative(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return null
  const text = posix(value)
  // Preserve whitespace significance; rejecting is safer than silently
  // retargeting a filename that differs only at its leading/trailing edge.
  if (text.length !== text.trim().length) return null
  if (text.length === 0) return allowEmpty ? '' : null
  if (text.startsWith('/') || WINDOWS_ABSOLUTE.test(text)) return null
  const normalized = path.posix.normalize(text).replace(/\/+$/, '')
  if (normalized === '.') return allowEmpty ? '' : null
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return null
  return normalized
}

function siteRelative(siteDir, value) {
  if (typeof value !== 'string') return null
  let text = posix(value)
  if (text.length !== text.trim().length) return null
  if (text.startsWith('@site/')) text = text.slice('@site/'.length)
  const root = posix(siteDir).replace(/\/+$/, '')
  if (text === root) return ''
  if (text.startsWith(`${root}/`)) text = text.slice(root.length + 1)
  else if (text.startsWith('/') || WINDOWS_ABSOLUTE.test(text)) return null
  return normalizeRelative(text, { allowEmpty: true })
}

function sourceOfDoc(doc, siteDir) {
  return normalizeRelative(siteRelative(siteDir, doc?.source))
}

function versionRoot(siteDir, version, sourcePath) {
  const localized = siteRelative(siteDir, version?.contentPathLocalized)
  const base = siteRelative(siteDir, version?.contentPath)
  const under = (root) => root !== null && (root === '' || sourcePath === root || sourcePath.startsWith(`${root}/`))
  if (localized !== null && localized !== '' && under(localized)) return { root: localized, localized: true }
  if (base !== null && under(base)) return { root: base, localized: false }
  return null
}

function makeDocIdentity({ siteId, pluginName, instanceId, version, doc, siteDir, locale, defaultLocale }) {
  if (typeof doc?.id !== 'string' || doc.id.length === 0 || typeof doc?.permalink !== 'string' || doc.permalink.length === 0) {
    return { error: 'missing-doc-identity' }
  }
  const sourcePath = sourceOfDoc(doc, siteDir)
  if (sourcePath === null) return { error: 'invalid-doc-source' }
  const rootInfo = versionRoot(siteDir, version, sourcePath)
  if (rootInfo === null) return { error: 'source-outside-version-root' }
  const { root, localized } = rootInfo
  const versionName = version?.versionName ?? 'current'
  const editable = { siteId, pluginName, instanceId, sourcePath }
  const rendered = {
    siteId, pluginName, instanceId, versionName,
    routeLocale: locale ?? null, contentLocale: localized ? (locale ?? null) : (defaultLocale ?? null),
    permalink: doc?.permalink ?? null,
  }
  return {
    pluginType: 'docs',
    pluginName, instanceId, versionName,
    sourcePath, sourceRoot: root, localized,
    contentLocale: rendered.contentLocale,
    routeLocale: rendered.routeLocale,
    source: doc?.source ?? null,
    docId: doc?.id ?? null,
    permalink: doc?.permalink ?? null,
    routePath: version?.path ?? null,
    title: doc?.title ?? null,
    sidebarPosition: doc?.sidebarPosition ?? null,
    sidebarLabel: doc?.frontMatter?.sidebar_label ?? null,
    frontMatterLocale: typeof doc?.frontMatter?.locale === 'string' ? doc.frontMatter.locale : null,
    editableKey: `${siteId}|${pluginName}|${instanceId}|${sourcePath}`,
    renderedKey: `${siteId}|${pluginName}|${instanceId}|${versionName}|${rendered.routeLocale ?? ''}|${doc?.permalink ?? sourcePath}`,
    editable,
    rendered,
    capability: 'docs-editable',
  }
}

function makeVersionDescriptor(siteDir, siteId, pluginName, instanceId, version, locale, defaultLocale) {
  const docs = []
  for (const doc of version?.docs ?? []) {
    const identity = makeDocIdentity({ siteId, pluginName, instanceId, version, doc, siteDir, locale, defaultLocale })
    if (identity.error) return { error: identity.error, docs: [] }
    docs.push(identity)
  }
  const roots = new Set(docs.map((doc) => doc.sourceRoot))
  return {
    pluginName, pluginType: 'docs', instanceId,
    versionName: version?.versionName ?? 'current',
    routePath: version?.path ?? null,
    locale: locale ?? null,
    contentPath: siteRelative(siteDir, version?.contentPath),
    contentPathLocalized: siteRelative(siteDir, version?.contentPathLocalized),
    sidebars: version?.sidebars && typeof version.sidebars === 'object' ? version.sidebars : {},
    sourceRoots: [...roots].sort(),
    docs,
  }
}

function collectDocs(siteDir, siteId, instanceId, content, locale, defaultLocale) {
  const versions = Array.isArray(content?.loadedVersions) ? content.loadedVersions : []
  const descriptors = versions.map((version) => makeVersionDescriptor(siteDir, siteId, DOCS_PLUGIN, instanceId, version, locale, defaultLocale))
  const error = descriptors.find((entry) => entry.error)
  if (error) return { error: error.error }
  const docs = descriptors.flatMap((entry) => entry.docs)
  const sourceRoots = [...new Set(descriptors.flatMap((entry) => entry.sourceRoots))].sort()
  return { pluginType: 'docs', pluginName: DOCS_PLUGIN, instanceId, locale, versions: descriptors, docs, sourceRoots }
}

function collectBlog(siteDir, instanceId, content, locale) {
  const posts = Array.isArray(content?.blogPosts) ? content.blogPosts : []
  return {
    pluginType: 'blog', pluginName: BLOG_PLUGIN, instanceId, locale,
    editable: false, capability: 'unsupported', unsupportedReason: 'blog-editing-not-implemented',
    sourceRoots: [],
    posts: posts.map((post) => ({
      sourcePath: sourceOfDoc({ source: post?.metadata?.source }, siteDir),
      permalink: post?.metadata?.permalink ?? null,
      routeLocale: locale,
      title: post?.metadata?.title ?? null,
    })),
  }
}

export function collectInstances(allContent, {
  siteId = 'site',
  siteDir = '/',
  locale = null,
  defaultLocale = null,
  defaultInstanceId = null,
  previewInstanceIds = [],
} = {}) {
  const instances = []
  const documents = []
  const errors = []

  for (const [pluginName, byId] of Object.entries(allContent ?? {})) {
    if (!byId || typeof byId !== 'object') continue
    for (const [instanceId, content] of Object.entries(byId)) {
      if (pluginName === DOCS_PLUGIN) {
        const collected = collectDocs(siteDir, siteId, instanceId, content, locale, defaultLocale)
        if (collected.error) { errors.push({ pluginName, instanceId, error: collected.error }); continue }
        instances.push(collected)
        documents.push(...collected.docs)
      } else if (pluginName === BLOG_PLUGIN) {
        instances.push(collectBlog(siteDir, instanceId, content, locale))
      } else if (pluginName === PAGES_PLUGIN) {
        instances.push({ pluginType: 'pages', pluginName, instanceId, locale, sourceRoots: [], capability: 'unsupported', unsupportedReason: 'pages-editing-not-implemented' })
      } else {
        instances.push({ pluginType: 'unknown', pluginName, instanceId, locale, sourceRoots: [], capability: 'unsupported', unsupportedReason: 'unknown-plugin' })
      }
    }
  }

  for (const doc of documents) {
    doc.preview = previewInstanceIds.includes(doc.instanceId)
  }

  const editableKeys = new Map()
  const physicalOwners = new Map()
  const docIdKeys = new Map()
  for (const doc of documents) {
    if (editableKeys.has(doc.editableKey)) {
      errors.push({ error: 'duplicate-editable-identity', key: doc.editableKey })
    } else editableKeys.set(doc.editableKey, doc)

    const physicalOwner = physicalOwners.get(doc.sourcePath)
    if (physicalOwner && physicalOwner.editableKey !== doc.editableKey) {
      errors.push({ error: 'duplicate-physical-ownership', key: doc.sourcePath })
    } else physicalOwners.set(doc.sourcePath, doc)

    const docKey = `${doc.pluginName}:${doc.instanceId}:${doc.versionName}:${doc.docId}`
    if (docIdKeys.has(docKey)) errors.push({ error: 'duplicate-doc-id', key: docKey })
    else docIdKeys.set(docKey, doc)
  }
  const renderedKeys = new Map()
  const routeKeys = new Map()
  const routeCandidates = documents.map((doc) => ({
    routeLocale: doc.routeLocale, permalink: doc.permalink, owner: doc.editableKey,
  }))
  for (const instance of instances) {
    if (instance.pluginType === 'blog') {
      for (const post of instance.posts) routeCandidates.push({
        routeLocale: post.routeLocale, permalink: post.permalink, owner: `blog|${instance.instanceId}|${post.sourcePath}`,
      })
    }
  }
  for (const doc of documents) {
    if (renderedKeys.has(doc.renderedKey)) errors.push({ error: 'duplicate-rendered-identity', key: doc.renderedKey })
    else renderedKeys.set(doc.renderedKey, doc)
  }
  for (const candidate of routeCandidates) {
    const permalink = normalizePermalink(candidate.permalink)
    if (permalink === null) continue
    const routeKey = `${candidate.routeLocale ?? ''}|${permalink}`
    const owner = routeKeys.get(routeKey)
    if (owner && owner !== candidate.owner) errors.push({ error: 'duplicate-route', key: routeKey })
    else routeKeys.set(routeKey, candidate.owner)
  }

  instances.sort((a, b) => `${a.pluginName}:${a.instanceId}`.localeCompare(`${b.pluginName}:${b.instanceId}`))
  const valid = errors.length === 0
  for (const instance of instances) {
    if (instance.pluginType === 'docs') {
      instance.preview = previewInstanceIds.includes(instance.instanceId)
      instance.editable = valid && instance.preview !== true
      instance.capability = valid ? 'docs-editable' : 'invalid-registry'
    }
  }

  const defaultInstance = defaultInstanceId === null ? null : instances.find((entry) => entry.instanceId === defaultInstanceId && entry.pluginType === 'docs') ?? null
  const selectedVersion = defaultInstance === null
    ? null
    : (defaultInstance.versions.find((version) => version.versionName === 'current') ?? defaultInstance.versions[0] ?? null)
  const legacy = defaultInstance === null ? null : {
    instanceId: defaultInstance.instanceId,
    // Existing global data is flat and includes every Docs instance.
    docs: documents.map((doc) => ({
      source: doc.sourcePath, docId: doc.docId, permalink: doc.permalink,
      title: doc.title, locale: doc.frontMatterLocale ?? doc.routeLocale, version: doc.versionName,
      sidebarPosition: doc.sidebarPosition, sidebarLabel: doc.sidebarLabel,
      routeBasePath: doc.routePath, instanceId: doc.instanceId, preview: doc.preview === true,
    })),
    selectedDocs: (selectedVersion?.docs ?? []).map((doc) => ({
      source: doc.sourcePath, docId: doc.docId, permalink: doc.permalink,
      title: doc.title, locale: doc.frontMatterLocale ?? doc.routeLocale, version: doc.versionName,
      sidebarPosition: doc.sidebarPosition, sidebarLabel: doc.sidebarLabel,
      routeBasePath: doc.routePath, instanceId: doc.instanceId, preview: doc.preview === true,
    })),
    sidebars: selectedVersion?.sidebars ?? {},
    routeBasePath: selectedVersion?.routePath ?? null,
  }

  return {
    version: 1,
    ok: errors.length === 0,
    instances,
    documents,
    errors,
    legacy,

}
}
