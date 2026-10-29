/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const MODULE = path.resolve(import.meta.dirname, '../../plugins/dsh-live-editor/src/instances/registry.mjs')
const { collectInstances } = await import(pathToFileURL(MODULE).href)

const SITE = '/site'
const doc = (source, id, permalink, extra = {}) => ({
  source, id, permalink, title: id, frontMatter: {}, ...extra,
})
const version = (contentPath, path, docs, extra = {}) => ({
  versionName: 'current', contentPath, path, docs, sidebars: {}, ...extra,
})
const docsContent = (versions) => ({ loadedVersions: versions })

function baseContent() {
  return {
    'docusaurus-plugin-content-docs': {
      default: docsContent([version('/site/docs', '/docs', [
        doc('@site/docs/intro.mdx', 'intro', '/docs/intro/'),
      ])]),
      proj: docsContent([version('/site/proj', '/proj', [
        doc('@site/proj/index.mdx', 'index', '/proj/'),
        doc('@site/proj/si29/01-effective-mass.mdx', 'si29/01-effective-mass', '/proj/si29/effective-mass/'),
      ])]),
    },
    'docusaurus-plugin-content-blog': {
      default: { blogPosts: [{ metadata: { source: '@site/blog/a.md', permalink: '/blog/a/', title: 'A' } }] },
    },
    'docusaurus-plugin-content-pages': { default: null },
    'docusaurus-plugin-unknown': { default: {} },
  }
}

test('collects arbitrary docs/blog/pages/unknown instances without default/proj special cases', () => {
  const result = collectInstances(baseContent(), { siteId: 'test-site', siteDir: SITE, locale: 'zh', defaultLocale: 'zh', defaultInstanceId: 'default' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.instances.map((i) => `${i.pluginType}:${i.instanceId}`), [
    'blog:default', 'docs:default', 'docs:proj', 'pages:default', 'unknown:default',
  ])
  assert.equal(result.documents.length, 3)
  assert.equal(result.documents.find((d) => d.instanceId === 'proj').sourceRoot, 'proj')
  assert.equal(result.documents.find((d) => d.instanceId === 'proj').editableKey, 'test-site|docusaurus-plugin-content-docs|proj|proj/index.mdx')
  assert.equal(result.legacy.instanceId, 'default')
  assert.deepEqual(result.legacy.docs.map((d) => d.source).sort(), ['docs/intro.mdx', 'proj/index.mdx', 'proj/si29/01-effective-mass.mdx'])
  assert.deepEqual(result.legacy.selectedDocs.map((d) => d.source), ['docs/intro.mdx'])
  assert.equal(result.legacy.routeBasePath, '/docs')
  assert.equal(result.instances.find((i) => i.pluginType === 'blog').capability, 'unsupported')
  assert.equal(result.instances.find((i) => i.pluginType === 'pages').capability, 'unsupported')
  assert.equal(result.instances.find((i) => i.pluginType === 'unknown').capability, 'unsupported')
})

test('duplicate edit targets and duplicate routes fail closed', () => {
  const content = baseContent()
  content['docusaurus-plugin-content-docs'].proj.loadedVersions[0].docs.push(
    doc('@site/proj/index.mdx', 'index-copy', '/proj-copy/'),
  )
  const duplicateSource = collectInstances(content, { siteDir: SITE, siteId: 's', defaultInstanceId: 'default' })
  assert.equal(duplicateSource.ok, false)
  assert.ok(duplicateSource.errors.some((e) => e.error === 'duplicate-editable-identity'))

  const routeContent = baseContent()
  routeContent['docusaurus-plugin-content-docs'].proj.loadedVersions[0].docs.push(
    doc('@site/proj/collision.mdx', 'collision', '/docs/intro/'),
  )
  const duplicateRoute = collectInstances(routeContent, { siteDir: SITE, siteId: 's', defaultInstanceId: 'default' })
  assert.equal(duplicateRoute.ok, false)
  assert.ok(duplicateRoute.errors.some((e) => e.error === 'duplicate-route'))
})

test('locale fallback records route and content locales separately', () => {
  const content = {
    'docusaurus-plugin-content-docs': {
      proj: docsContent([version('/site/proj', '/en/proj', [
        doc('@site/proj/fallback.mdx', 'fallback', '/en/proj/fallback/'),
      ], {
        contentPathLocalized: '/site/i18n/en/docusaurus-plugin-content-docs-proj',
      })]),
    },
  }
  const result = collectInstances(content, { siteDir: SITE, siteId: 's', locale: 'en', defaultLocale: 'zh' })
  const fallback = result.documents[0]
  assert.equal(fallback.routeLocale, 'en')
  assert.equal(fallback.contentLocale, 'zh')
  assert.equal(fallback.localized, false)
  assert.equal(fallback.sourceRoot, 'proj')
  assert.equal(fallback.rendered.permalink, '/en/proj/fallback/')
})

test('absolute or escaping sources are rejected rather than treated as identities', () => {
  const content = {
    'docusaurus-plugin-content-docs': {
      bad: docsContent([version('/site/docs', '/docs', [
        doc('/etc/passwd', 'bad', '/docs/bad/'),
      ])]),
    },
  }
  const result = collectInstances(content, { siteDir: SITE, siteId: 's' })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.error === 'invalid-doc-source'))
  assert.equal(result.documents.length, 0)
})

test('missing default leaves legacy projection null without inventing one', () => {
  const content = {
    'docusaurus-plugin-content-docs': {
      other: docsContent([version('/site/other', '/other', [
        doc('@site/other/index.mdx', 'index', '/other/'),
      ])]),
    },
  }
  const result = collectInstances(content, { siteDir: SITE, defaultInstanceId: 'default' })
  assert.equal(result.legacy, null)
  assert.equal(result.documents[0].instanceId, 'other')
})


test('duplicate doc IDs and physical ownership fail closed; versioned IDs are allowed', () => {
  const duplicateId = baseContent()
  duplicateId['docusaurus-plugin-content-docs'].proj.loadedVersions[0].docs.push(
    doc('@site/proj/other.mdx', 'index', '/proj/other/'),
  )
  const byId = collectInstances(duplicateId, { siteDir: SITE, siteId: 's' })
  assert.equal(byId.ok, false)
  assert.ok(byId.errors.some((e) => e.error === 'duplicate-doc-id'))

  const sharedSource = baseContent()
  sharedSource['docusaurus-plugin-content-docs'].other = docsContent([version('/site', '/other', [
    doc('@site/docs/intro.mdx', 'other-intro', '/other/intro/'),
  ])])
  const bySource = collectInstances(sharedSource, { siteDir: SITE, siteId: 's' })
  assert.equal(bySource.ok, false)
  assert.ok(bySource.errors.some((e) => e.error === 'duplicate-physical-ownership'))

  const versioned = {
    'docusaurus-plugin-content-docs': {
      default: docsContent([
        version('/site/docs', '/docs', [doc('@site/docs/intro.mdx', 'intro', '/docs/intro/')]),
        version('/site/versioned_docs/version-1', '/docs/1', [doc('@site/versioned_docs/version-1/intro.mdx', 'intro', '/docs/1/intro/')], { versionName: '1' }),
      ]),
    },
  }
  const versions = collectInstances(versioned, { siteDir: SITE, siteId: 's' })
  assert.equal(versions.ok, true)
  assert.equal(versions.documents.length, 2)
  assert.equal(new Set(versions.documents.map((d) => d.versionName)).size, 2)
})

test('one or three docs instances use the same collector', () => {
  const one = {
    'docusaurus-plugin-content-docs': {
      default: docsContent([version('/site/docs', '/docs', [doc('@site/docs/index.mdx', 'index', '/docs/')])]),
    },
  }
  assert.equal(collectInstances(one, { siteDir: SITE }).documents.length, 1)

  const three = baseContent()
  three['docusaurus-plugin-content-docs'].third = docsContent([version('/site/third', '/third', [
    doc('@site/third/index.mdx', 'index', '/third/'),
  ])])
  const result = collectInstances(three, { siteDir: SITE })
  assert.equal(result.documents.length, 4)
  assert.deepEqual(result.instances.filter((i) => i.pluginType === 'docs').map((i) => i.instanceId).sort(), ['default', 'proj', 'third'])
})

test('blog null content and pages null content are classified without editing capability', () => {
  const content = {
    'docusaurus-plugin-content-blog': { default: null },
    'docusaurus-plugin-content-pages': { default: null },
  }
  const result = collectInstances(content, { siteDir: SITE })
  assert.equal(result.instances.find((i) => i.pluginType === 'blog').posts.length, 0)
  assert.equal(result.instances.find((i) => i.pluginType === 'pages').capability, 'unsupported')
  assert.equal(result.documents.length, 0)
})


test('a real localized source keeps its physical identity and content locale', () => {
  const content = {
    'docusaurus-plugin-content-docs': {
      proj: docsContent([version('/site/proj', '/en/proj', [
        doc('@site/i18n/en/docusaurus-plugin-content-docs-proj/current/translated.mdx', 'translated', '/en/proj/translated/'),
      ], {
        contentPathLocalized: '/site/i18n/en/docusaurus-plugin-content-docs-proj/current',
      })]),
    },
  }
  const result = collectInstances(content, { siteDir: SITE, siteId: 's', locale: 'en', defaultLocale: 'zh' })
  const translated = result.documents[0]
  assert.equal(translated.localized, true)
  assert.equal(translated.contentLocale, 'en')
  assert.equal(translated.sourceRoot, 'i18n/en/docusaurus-plugin-content-docs-proj/current')
  assert.equal(translated.editableKey, 's|docusaurus-plugin-content-docs|proj|i18n/en/docusaurus-plugin-content-docs-proj/current/translated.mdx')
  assert.equal(translated.rendered.permalink, '/en/proj/translated/')
})


test('site-root content roots are explicit and foreign/outside sources fail', () => {
  const siteRoot = {
    'docusaurus-plugin-content-docs': {
      root: docsContent([version('/site', '/', [doc('@site/intro.mdx', 'intro', '/')])]),
    },
  }
  const rootResult = collectInstances(siteRoot, { siteDir: SITE, siteId: 's' })
  assert.equal(rootResult.ok, true)
  assert.equal(rootResult.documents[0].sourceRoot, '')
  assert.equal(rootResult.documents[0].editableKey, 's|docusaurus-plugin-content-docs|root|intro.mdx')

  const outside = {
    'docusaurus-plugin-content-docs': {
      docs: docsContent([version('/site/docs', '/docs', [doc('@site/private/a.mdx', 'a', '/docs/a/')])]),
    },
  }
  const outsideResult = collectInstances(outside, { siteDir: SITE })
  assert.equal(outsideResult.ok, false)
  assert.ok(outsideResult.errors.some((e) => e.error === 'source-outside-version-root'))

  const windows = {
    'docusaurus-plugin-content-docs': {
      bad: docsContent([version('/site/docs', '/docs', [doc('C:/outside/a.mdx', 'a', '/docs/a/')])]),
    },
  }
  const windowsResult = collectInstances(windows, { siteDir: SITE })
  assert.equal(windowsResult.ok, false)
  assert.ok(windowsResult.errors.some((e) => e.error === 'invalid-doc-source'))
})

test('repeated separators normalize to one lexical identity', () => {
  const content = {
    'docusaurus-plugin-content-docs': {
      default: docsContent([version('/site/docs', '/docs', [
        doc('@site/docs/a.mdx', 'a', '/docs/a/'),
        doc('@site/docs//a.mdx', 'a-copy', '/docs/a-copy/'),
      ])]),
    },
  }
  const result = collectInstances(content, { siteDir: SITE })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.error === 'duplicate-physical-ownership' || e.error === 'duplicate-editable-identity'))
})

test('legacy projection prefers current version and keeps flat-doc fields', () => {
  const content = {
    'docusaurus-plugin-content-docs': {
      default: docsContent([
        version('/site/versioned_docs/version-1', '/docs/1', [doc('@site/versioned_docs/version-1/intro.mdx', 'intro', '/docs/1/intro/')], {
          versionName: '1', sidebars: { oldSidebar: [] },
        }),
        version('/site/docs', '/docs', [doc('@site/docs/intro.mdx', 'intro', '/docs/intro/', { sidebarPosition: 2, frontMatter: { sidebar_label: 'Intro' } })], {
          versionName: 'current', sidebars: { currentSidebar: [] },
        }),
      ]),
    },
  }
  const result = collectInstances(content, { siteDir: SITE, locale: 'zh', defaultInstanceId: 'default' })
  assert.equal(result.legacy.routeBasePath, '/docs')
  assert.deepEqual(result.legacy.sidebars, { currentSidebar: [] })
  assert.equal(result.legacy.docs.length, 2)
  const current = result.legacy.docs.find((d) => d.version === 'current')
  assert.equal(current.locale, 'zh')
  assert.equal(current.routeBasePath, '/docs')
  assert.equal(current.sidebarPosition, 2)
  assert.equal(current.sidebarLabel, 'Intro')
  assert.equal(result.legacy.selectedDocs[0].version, 'current')
})


test('meaningful filename whitespace is rejected, not silently trimmed', () => {
  const leading = {
    'docusaurus-plugin-content-docs': {
      default: docsContent([version('/site', '/', [doc('@site/ intro.mdx', 'intro', '/')])]),
    },
  }
  const result = collectInstances(leading, { siteDir: SITE })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.error === 'invalid-doc-source'))
})

test('trailing separators on a declared root are normalized', () => {
  const content = {
    'docusaurus-plugin-content-docs': {
      default: docsContent([version('/site/docs/', '/docs', [doc('@site/docs/a.mdx', 'a', '/docs/a/')])]),
    },
  }
  const result = collectInstances(content, { siteDir: SITE })
  assert.equal(result.ok, true)
  assert.equal(result.documents[0].sourceRoot, 'docs')
})

test('legacy locale keeps the old frontmatter-locale precedence', () => {
  const content = {
    'docusaurus-plugin-content-docs': {
      default: docsContent([version('/site/docs', '/docs', [
        doc('@site/docs/a.mdx', 'a', '/docs/a/', { frontMatter: { locale: 'fr' } }),
      ])]),
    },
  }
  const result = collectInstances(content, { siteDir: SITE, locale: 'en', defaultLocale: 'zh', defaultInstanceId: 'default' })
  assert.equal(result.documents[0].routeLocale, 'en')
  assert.equal(result.legacy.docs[0].locale, 'fr')
  assert.equal(result.legacy.selectedDocs[0].locale, 'fr')
})


test('route collision uses normalized permalinks and includes unsupported blog routes', () => {
  const trailing = baseContent()
  trailing['docusaurus-plugin-content-docs'].proj.loadedVersions[0].docs.push(
    doc('@site/proj/same.mdx', 'same', '/docs/intro'),
  )
  const byTrailing = collectInstances(trailing, { siteDir: SITE, siteId: 's' })
  assert.equal(byTrailing.ok, false)
  assert.ok(byTrailing.errors.some((e) => e.error === 'duplicate-route'))

  const withBlog = baseContent()
  withBlog['docusaurus-plugin-content-blog'].default.blogPosts.push({
    metadata: { source: '@site/blog/collision.md', permalink: '/docs/intro/', title: 'collision' },
  })
  const byBlog = collectInstances(withBlog, { siteDir: SITE, siteId: 's' })
  assert.equal(byBlog.ok, false)
  assert.ok(byBlog.errors.some((e) => e.error === 'duplicate-route'))
})

test('missing docId or permalink is not editable', () => {
  const content = {
    'docusaurus-plugin-content-docs': {
      default: docsContent([version('/site/docs', '/docs', [
        { source: '@site/docs/a.mdx', id: '', permalink: '/docs/a/', title: 'A', frontMatter: {} },
      ])]),
    },
  }
  const result = collectInstances(content, { siteDir: SITE })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.error === 'missing-doc-identity'))
})

test('invalid registry marks docs instances non-editable', () => {
  const content = baseContent()
  content['docusaurus-plugin-content-docs'].proj.loadedVersions[0].docs.push(
    doc('@site/proj/index.mdx', 'index-copy', '/proj-copy/'),
  )
  const result = collectInstances(content, { siteDir: SITE })
  assert.equal(result.ok, false)
  for (const instance of result.instances.filter((i) => i.pluginType === 'docs')) {
    assert.equal(instance.editable, false)
    assert.equal(instance.capability, 'invalid-registry')
  }
})
