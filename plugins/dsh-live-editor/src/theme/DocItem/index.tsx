/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Dev-only DocItem wrapper for the DSH Live Editor.
 *
 * Publishes the current doc identity to the iframe bridge. The site has two
 * docs instances in dev: the real `/docs` instance and the isolated staging
 * `/__live-preview` instance. The pluginData.docs array contains both; the
 * current instance is matched by permalink (and source as a fallback) so a
 * staging page publishes `preview: true`, `/__live-preview` identity and the
 * staging session/revision from frontmatter.
 *
 * IMPORTANT: a plugin theme's `@theme-original/DocItem` resolves to this very
 * file (self-reference). The previous implementation is exposed as
 * `@theme-init/DocItem`.
 *
 * Do NOT use `useDoc()` here: the original DocItem creates DocProvider below
 * this wrapper. Read the same identity from `props.content.metadata`.
 */
import React from 'react'
import OriginalDocItem from '@theme-init/DocItem'
import { usePluginData } from '@docusaurus/useGlobalData'
import { useHistory } from '@docusaurus/router'
import { installR2Channel } from '../../r2-shadow/channel.js'

type DocMetadata = {
  source?: string | null
  permalink?: string
  id?: string
  title?: string
  locale?: string
  frontMatter?: Record<string, unknown>
}

type DocItemProps = {
  content?: { metadata?: DocMetadata } & Record<string, unknown>
} & Record<string, unknown>

type PluginDoc = {
  source?: string | null
  permalink?: string
  routeBasePath?: string
  instanceId?: string
  versionName?: string
  sourceRoot?: string
  preview?: boolean
}

type PluginData = {
  version?: number
  locale?: string | null
  routeBasePath?: string
  previewRouteBasePath?: string
  previewInstanceReady?: boolean
  baseUrl?: string
  docs?: PluginDoc[]
  sidebars?: unknown
  previewSidebars?: unknown
  r2Shadow?: { channel?: boolean; active?: boolean; activationReady?: boolean }
} | undefined

declare global {
  interface Window {
    __DSH_LIVE_EDITOR__?: {
      publishDoc(doc: {
        source: string | null
        docId: string | null
        permalink: string
        title: string
        locale: string | null
        routeBasePath?: string
        baseUrl?: string
        instanceId?: string | null
        versionName?: string | null
        sourceRoot?: string | null
        preview?: boolean
        previewSession?: string | null
        previewRevision?: number | null
        previewInstanceReady?: boolean
        docs: unknown[]
        sidebars?: unknown
        navigate: (href: string) => void
      }): void
    }
  }
}

function normalizeSource(source: string | null | undefined): string | null {
  if (typeof source !== 'string') return null
  let text = source.replaceAll('\\', '/').trim()
  if (text.startsWith('@site/')) text = text.slice('@site/'.length)
  if (text.length === 0 || text.startsWith('/') || text.split('/').some((part) => part === '..' || part === '.')) return null
  return text
}

export default function DocItem(props: DocItemProps): React.ReactNode {
  const metadata = props.content?.metadata
  const pluginData = usePluginData('dsh-live-editor') as PluginData
  const history = useHistory()

  const docs = Array.isArray(pluginData?.docs) ? pluginData.docs : []
  const rawSource = normalizeSource(metadata?.source)
  const pathname = typeof window !== 'undefined' ? window.location.pathname : ''
  const currentDoc = docs.find((doc) => doc?.permalink === metadata?.permalink)
    ?? docs.find((doc) => doc?.source === rawSource)
    ?? (pathname.startsWith('/__live-preview')
      ? docs.find((doc) => doc?.preview === true && typeof doc?.source === 'string' && typeof rawSource === 'string' && rawSource.endsWith(`/${doc.source}`))
      : undefined)
  const source = currentDoc?.source ?? rawSource
  const preview = currentDoc?.preview === true
  const frontMatter = metadata?.frontMatter ?? {}
  const rawRevision = frontMatter['dsh_preview_revision']
  const previewRevision = typeof rawRevision === 'number' && Number.isSafeInteger(rawRevision)
    ? rawRevision
    : (typeof rawRevision === 'string' && /^\d+$/.test(rawRevision) ? Number(rawRevision) : null)
  const rawSession = frontMatter['dsh_preview_session']
  const previewSession = typeof rawSession === 'string' && rawSession.length > 0 && rawSession.length <= 128 ? rawSession : null
  const routeBasePath = currentDoc?.routeBasePath
    ?? (preview ? pluginData?.previewRouteBasePath : pluginData?.routeBasePath)

  React.useEffect(() => {
    // Formal R2 child channel is gated by the same shadow flag that also gates
    // watcher/sentinel. The cleanup is intentionally bound only to the gate /
    // preview lifecycle; metadata revisions are applied by the second effect.
    if (preview && pluginData?.r2Shadow?.channel === true) {
      return installR2Channel({
        metadata: {
          source,
          docId: typeof metadata?.id === 'string' ? metadata.id : null,
          permalink: metadata?.permalink ?? window.location.pathname,
          previewSession,
          previewRevision,
        },
      })
    }
  }, [preview, pluginData?.r2Shadow?.channel])

  React.useEffect(() => {
    if (preview && pluginData?.r2Shadow?.channel === true) {
      installR2Channel({
        metadata: {
          source,
          docId: typeof metadata?.id === 'string' ? metadata.id : null,
          permalink: metadata?.permalink ?? window.location.pathname,
          previewSession,
          previewRevision,
        },
      })
    }
  }, [preview, pluginData?.r2Shadow?.channel, source, metadata?.id, metadata?.permalink, previewSession, previewRevision])

  React.useEffect(() => {
    const api = window.__DSH_LIVE_EDITOR__
    if (!api || !metadata) return
    api.publishDoc({
      source,
      docId: typeof metadata.id === 'string' ? metadata.id : null,
      permalink: metadata.permalink ?? window.location.pathname,
      title: metadata.title ?? document.title,
      locale: metadata.locale ?? pluginData?.locale ?? null,
      routeBasePath,
      instanceId: currentDoc?.instanceId ?? null,
      versionName: currentDoc?.versionName ?? null,
      sourceRoot: currentDoc?.sourceRoot ?? null,
      previewInstanceReady: pluginData?.previewInstanceReady === true,
      baseUrl: pluginData?.baseUrl,
      preview,
      previewSession,
      previewRevision,
      docs,
      sidebars: preview ? (pluginData?.previewSidebars ?? pluginData?.sidebars) : pluginData?.sidebars,
      navigate: (href: string) => history.push(href),
    })
  }, [
    metadata?.source,
    metadata?.permalink,
    metadata?.id,
    metadata?.title,
    metadata?.locale,
    source,
    currentDoc,
    routeBasePath,
    preview,
    previewSession,
    previewRevision,
    docs,
    pluginData,
    history,
  ])

  return <OriginalDocItem {...props} />
}
