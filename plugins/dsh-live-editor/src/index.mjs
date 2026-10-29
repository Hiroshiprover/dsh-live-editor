/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * DSH Live Editor — dev-only Docusaurus plugin.
 *
 * Responsibilities (Phase 2, Step 1 keeps the v1 bridge protocol):
 *   - theme: shadow @theme/DocItem with a wrapper that publishes doc identity;
 *   - client: load the iframe bridge on every dev page (no-op outside the editor);
 *   - global data: build the docMap from the docs plugin content.
 *
 * Compatibility notes (verified against Docusaurus 3.10.1):
 *   - Docusaurus loads plugins through jiti in a CJS wrapper. `import.meta.url`
 *     is supported; `import.meta.dirname` is a hard SyntaxError.
 *   - allContent is keyed [pluginName][pluginId]; docs content is
 *     { loadedVersions: LoadedVersion[] }.
 *   - allContentLoaded is not in the public lifecycle docs; pin the dependency.
 *   - A plugin theme's `@theme-original/X` resolves to the plugin's own file,
 *     so the wrapper imports `@theme-init/DocItem` (previous theme) instead.
 */
import path from 'node:path'
import { promises as fs, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readR2ShadowConfig } from './r2-shadow/flag.mjs'
import { previewContentSignature } from './preview-signature.mjs'
import { collectInstances } from './instances/registry.mjs'

const DEFAULT_DEV_ORIGIN = 'http://localhost:3000'
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']
const HEALTH_PATH = '/__dsh-live-editor/health'

/**
 * Only a loopback http(s) origin may receive the preview's CORS allowance.
 * Anything else falls back to the default rather than silently opening CORS
 * to an attacker-supplied origin.
 */
export function resolveDevOrigin (value) {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_DEV_ORIGIN
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_DEV_ORIGIN
    if (!LOOPBACK_HOSTS.includes(url.hostname)) return DEFAULT_DEV_ORIGIN
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return DEFAULT_DEV_ORIGIN
    return url.origin
  } catch {
    return DEFAULT_DEV_ORIGIN
  }
}

/**
 * Docusaurus merges a plugin's `configureWebpack().devServer` into the dev
 * server config. Keep Host/Origin server-side strict: allowedHosts blocks DNS
 * rebinding, the explicit ACAO replaces Docusaurus's `*`, and CORP prevents
 * cross-origin script embedding even where CORS is not consulted.
 */
export function previewOriginAllowed (origin, devOrigin = DEFAULT_DEV_ORIGIN) {
  if (typeof origin !== 'string' || origin.length === 0) return true
  if (origin === devOrigin) return true
  // The preview can be opened as either localhost or 127.0.0.1; allow only
  // the same scheme/port counterpart, never a different site.
  try {
    const base = new URL(devOrigin)
    for (const hostname of LOOPBACK_HOSTS.map((entry) => entry.replaceAll('[', '').replaceAll(']', ''))) {
      if (hostname === base.hostname) continue
      const peer = new URL(devOrigin)
      peer.hostname = hostname
      if (peer.origin === origin) return true
    }
  } catch { /* malformed values are rejected below */ }
  return false
}

/**
 * The Live Editor status probe runs from the DSH GUI (a different loopback
 * origin) and only asks whether the dev server is alive. That probe must not
 * be confused with content access: the health endpoint returns no data, while
 * every content/source path keeps the strict preview-Origin check.
 */
export function healthOriginAllowed (origin) {
  if (typeof origin !== 'string' || origin.length === 0) return true
  if (origin === 'dsh-app://app') return true
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return LOOPBACK_HOSTS.includes(url.hostname)
  } catch {
    return false
  }
}

export function devServerSecurity (devOrigin = resolveDevOrigin(process.env.DSH_LIVE_EDITOR_DEV_ORIGIN)) {
  return {
    allowedHosts: [...LOOPBACK_HOSTS],
    headers: {
      'access-control-allow-origin': devOrigin,
      'cross-origin-resource-policy': 'same-origin',
    },
    // Keep the HTTP Origin boundary server-side as well; a browser CORS rule
    // alone is not an access control. Navigation requests without Origin are
    // allowed (the preview iframe loads this way), and same-origin assets pass.
    setupMiddlewares (middlewares) {
      middlewares.unshift((req, res, next) => {
        const url = typeof req.url === 'string' ? req.url : ''
        if (url === HEALTH_PATH || url.startsWith(`${HEALTH_PATH}?`)) {
          const origin = req.headers?.origin
          if (!healthOriginAllowed(origin)) {
            res.statusCode = 403
            res.setHeader('content-type', 'text/plain; charset=utf-8')
            res.end('forbidden origin')
            return
          }
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.setHeader('cross-origin-resource-policy', 'cross-origin')
          if (typeof origin === 'string' && origin.length > 0) {
            res.setHeader('access-control-allow-origin', origin)
            res.setHeader('vary', 'origin')
          }
          res.end('{"ok":true}')
          return
        }
        if (previewOriginAllowed(req.headers?.origin, devOrigin)) return next()
        res.statusCode = 403
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end('forbidden origin')
      })
      return middlewares
    },
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const themeDir = path.join(here, 'theme')
const A2_HANDSHAKE_VERSION = 'A2-HANDSHAKE-V2'
const clientModule = path.join(here, 'client', 'index.js')

const PLUGIN_NAME = 'dsh-live-editor'
const DEFAULT_PLUGIN_ID = 'default'
const MAX_SIDEBAR_DEPTH = 20
const MAX_SIDEBAR_ITEMS = 2000
const MAX_LABEL_LENGTH = 200

function labelOf(value, fallback = null) {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (text.length === 0) return fallback
  return text.slice(0, MAX_LABEL_LENGTH)
}

function sanitizeSidebarLink(link) {
  if (!link || typeof link !== 'object') return null
  if (link.type === 'doc' && typeof link.id === 'string' && link.id.length > 0) {
    return { type: 'doc', id: link.id, label: labelOf(link.label) }
  }
  if (link.type === 'generated-index') {
    return {
      type: 'generated-index',
      slug: typeof link.slug === 'string' ? link.slug : null,
      permalink: typeof link.permalink === 'string' ? link.permalink : null,
      title: labelOf(link.title),
    }
  }
  return null
}

function sanitizeSidebars(rawSidebars) {
  if (!rawSidebars || typeof rawSidebars !== 'object') return {}
  const entries = Array.isArray(rawSidebars)
    ? [['defaultSidebar', rawSidebars]]
    : Object.entries(rawSidebars)
  const budget = { count: 0 }
  const sanitizeItem = (item, depth) => {
    if (budget.count >= MAX_SIDEBAR_ITEMS) return null
    if (!item || typeof item !== 'object' || depth > MAX_SIDEBAR_DEPTH) return null
    if (item.type === 'doc' || item.type === 'ref') {
      if (typeof item.id !== 'string' || item.id.length === 0) return null
      budget.count += 1
      return { type: 'doc', id: item.id, label: labelOf(item.label) }
    }
    if (item.type === 'link') {
      if (typeof item.href !== 'string' || item.href.length === 0) return null
      budget.count += 1
      return { type: 'link', href: item.href.slice(0, 2048), label: labelOf(item.label) }
    }
    if (item.type === 'category') {
      budget.count += 1
      const items = Array.isArray(item.items) ? item.items : []
      return {
        type: 'category',
        label: labelOf(item.label, ''),
        collapsed: item.collapsed === true,
        collapsible: item.collapsible !== false,
        link: sanitizeSidebarLink(item.link),
        items: items.map((child) => sanitizeItem(child, depth + 1)).filter(Boolean),
      }
    }
    // `html`/`autogenerated`/unknown processed item kinds are deliberately
    // dropped: the tree only exposes docs and non-editable labels/links.
    return null
  }
  const trees = {}
  for (const [name, items] of entries) {
    if (typeof name !== 'string' || !Array.isArray(items)) continue
    trees[name] = items.map((item) => sanitizeItem(item, 0)).filter(Boolean)
  }
  return trees
}

function normalizeDocSource(source, pluginId = null) {
  if (typeof source !== 'string') return source
  let text = source.replaceAll('\\', '/')
  if (text.startsWith('@site/')) text = text.slice('@site/'.length)
  // Only the legacy staging instance is projected back to the docs/ source
  // contract. Other instances keep their full site-relative path so a nested
  // proj/docs/... cannot be mistaken for the default instance.
  if (pluginId === 'live-preview') {
    const docs = text.indexOf('docs/')
    return docs >= 0 ? text.slice(docs) : text
  }
  return text
}

function countSidebarItems(trees) {
  let count = 0
  const walk = (items) => {
    for (const item of items) {
      count += 1
      if (item.type === 'category') walk(item.items)
    }
  }
  for (const items of Object.values(trees)) walk(items)
  return count
}


// Default draft-preview confirmation channel. The formal R2 shadow/sentinel
// gates stay off; only the DOM-confirmed ACK channel is enabled for the
// preview page.
function readR2ShadowConfigForPreview() {
  const base = readR2ShadowConfig()
  const enabled = process.env.DSH_LIVE_EDITOR_PREVIEW_CHANNEL !== 'off'
  return {
    ...base,
    channel: enabled,
    watcherFilter: enabled,
    sentinel: false,
    experiment: false,
    mode: enabled ? 'preview-channel' : 'disabled',
  }
}

export default function dshLiveEditor(context = {}) {
  const locale = context?.i18n?.currentLocale ?? null

  return {
    name: PLUGIN_NAME,

    getThemePath() {
      return themeDir
    },

    getClientModules() {
      return [clientModule]
    },

    configureWebpack() {
      return { devServer: devServerSecurity() }
    },

    async allContentLoaded({ allContent, actions }) {
      const docsPlugin = allContent?.['docusaurus-plugin-content-docs'] ?? {}
      const generatedAt = new Date().toISOString()
      const baseUrl = context?.siteConfig?.baseUrl ?? '/'
      const siteId = context?.siteConfig?.url ?? 'site'
      const registry = collectInstances(allContent, {
        siteId,
        siteDir: context?.siteDir ?? '/',
        locale,
        defaultLocale: context?.i18n?.defaultLocale ?? locale,
        defaultInstanceId: DEFAULT_PLUGIN_ID,
        previewInstanceIds: Object.keys(docsPlugin).filter((id) => id === 'live-preview'),
      })
      const identityBySource = new Map(registry.documents.map((doc) => [`${doc.instanceId}|${doc.sourcePath}`, doc]))
      const collect = (pluginId, content) => {
        const versions = Array.isArray(content?.loadedVersions) ? content.loadedVersions : []
        const docs = []
        for (const version of versions) {
          for (const doc of version?.docs ?? []) {
            const canonicalSource = normalizeDocSource(doc.source, pluginId)
            const identity = identityBySource.get(`${pluginId}|${canonicalSource}`)
            docs.push({
              source: canonicalSource,
              docId: doc.id,
              permalink: doc.permalink,
              title: doc.title,
              locale: doc.frontMatter?.locale ?? locale,
              version: version?.versionName ?? version?.label ?? null,
              versionName: version?.versionName ?? version?.label ?? null,
              sidebarPosition: doc.sidebarPosition ?? null,
              sidebarLabel: doc.frontMatter?.sidebar_label ?? null,
              routeBasePath: version?.path ?? (pluginId === 'live-preview' ? '/__live-preview' : '/docs'),
              instanceId: pluginId,
              sourceRoot: identity?.sourceRoot ?? null,
              preview: pluginId === 'live-preview',
            })
          }
        }
        const primary = versions.find((version) => version?.versionName === 'current') ?? versions[0]
        return { docs, primary }
      }
      const entries = Object.entries(docsPlugin).map(([pluginId, content]) => [pluginId, collect(pluginId, content)])
      const primaryEntry = entries.find(([pluginId]) => pluginId === DEFAULT_PLUGIN_ID) ?? entries[0] ?? null
      const previewEntry = entries.find(([pluginId]) => pluginId === 'live-preview') ?? null
      const docs = entries.flatMap(([, value]) => value.docs)
      const primaryVersion = primaryEntry?.[1]?.primary
      const previewVersion = previewEntry?.[1]?.primary
      const sidebars = sanitizeSidebars(primaryVersion?.sidebars)
      const previewSidebars = sanitizeSidebars(previewVersion?.sidebars)
      const routeBasePath = primaryVersion?.path ?? '/docs'
      const previewRouteBasePath = previewVersion?.path ?? '/__live-preview'
      if (process.env.DSH_LIVE_EDITOR_INSTANCES_FILE) {
        const target = process.env.DSH_LIVE_EDITOR_INSTANCES_FILE
        const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
        try {
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(temp, JSON.stringify({
            version: 1, generatedAt, instances: registry.instances, errors: registry.errors,
          }, null, 2))
          await fs.rename(temp, target)
        } catch (error) {
          await fs.rm(temp, { force: true }).catch(() => {})
          console.warn('[dsh-live-editor] instance descriptor write failed', error)
        }
      }
      const sidebarsPayload = {
        version: primaryVersion?.versionName ?? primaryVersion?.label ?? null,
        locale,
        routeBasePath,
        baseUrl,
        generatedAt,
        trees: sidebars,
      }
      const previewTrees = Object.keys(previewSidebars).length > 0 ? previewSidebars : sidebars
      const previewSidebarsPayload = {
        version: previewVersion?.versionName ?? previewVersion?.label ?? null,
        locale,
        routeBasePath: previewRouteBasePath,
        baseUrl,
        generatedAt,
        // Content hash, not the wall clock: only a staged docs reload that
        // actually changes title/slug/sidebar may clear the structural warning.
        previewSignature: previewContentSignature({
          docs: previewVersion?.docs,
          sidebars: previewVersion?.sidebars,
        }),
        trees: previewTrees,
      }
      if (primaryVersion?.sidebars) {
        console.info('[dsh-live-editor] sidebars published', {
          version: sidebarsPayload.version,
          names: Object.keys(sidebars),
          items: countSidebarItems(sidebars),
          generatedAt,
        })
      } else {
        console.warn('[dsh-live-editor] primary docs version has no sidebars; falling back to the Host file tree')
      }
      if (Object.keys(previewTrees).length > 0) {
        console.info('[dsh-live-editor] preview sidebars published', {
          version: previewSidebarsPayload.version,
          names: Object.keys(previewSidebars),
          items: countSidebarItems(previewSidebars),
          generatedAt,
        })
      } else {
        console.warn('[dsh-live-editor] preview docs version has no sidebars and no primary fallback')
      }

      console.info('[dsh-live-editor][diag] allContentLoaded', {
        t: new Date().toISOString(),
        docsPluginKeys: Object.keys(docsPlugin ?? {}),
        primaryPluginId: primaryEntry?.[0] ?? null,
        previewPluginId: previewEntry?.[0] ?? null,
        primaryDocs: primaryEntry?.[1]?.docs?.length ?? null,
        previewDocs: previewEntry?.[1]?.docs?.length ?? null,
        primaryVersion: primaryVersion?.versionName ?? null,
        previewVersion: previewVersion?.versionName ?? null,
        previewVersionHasSidebars: Boolean(previewVersion?.sidebars),
        primarySidebars: Object.keys(sidebars ?? {}).length,
        previewSidebars: Object.keys(previewSidebars ?? {}).length,
        previewInstanceReady: previewEntry !== null,
        routeBasePath,
        previewRouteBasePath,
        a2HandshakeVersion: A2_HANDSHAKE_VERSION,
      })

      actions.setGlobalData({
        version: 2,
        generatedAt,
        locale,
        routeBasePath,
        previewRouteBasePath,
        previewInstanceReady: previewEntry !== null,
        baseUrl,
        a2HandshakeVersion: A2_HANDSHAKE_VERSION,
        docs,
        sidebars: sidebarsPayload,
        previewSidebars: previewSidebarsPayload,
        instances: registry.instances,
        instanceErrors: registry.errors,
        r2Shadow: readR2ShadowConfigForPreview(),
      })
    }
  }
}
