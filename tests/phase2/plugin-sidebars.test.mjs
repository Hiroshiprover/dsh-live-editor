/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * The dev-only Docusaurus plugin must publish a JSON-safe, bounded sidebar
 * payload alongside the existing docs map. HMR re-runs allContentLoaded, so
 * this payload is the source for the parent tree update.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'

const PLUGIN = path.resolve(import.meta.dirname, '../../plugins/dsh-live-editor/src/index.mjs')
const { default: dshLiveEditor } = await import(pathToFileURL(PLUGIN).href)

test('allContentLoaded publishes docs + sanitized sidebars', async () => {
  const globalData = []
  const plugin = dshLiveEditor({ i18n: { currentLocale: 'zh' } })
  const allContent = {
    'docusaurus-plugin-content-docs': {
      default: {
        loadedVersions: [{
          versionName: 'current',
          docs: [
            { id: 'QFT/index', source: 'docs/QFT/index.mdx', permalink: '/docs/QFT/', title: 'QFT 首页', frontMatter: {} },
            { id: 'QFT/01', source: 'docs/QFT/01.mdx', permalink: '/docs/QFT/01/', title: '场论', frontMatter: {} },
          ],
          sidebars: {
            defaultSidebar: [
              {
                type: 'category',
                label: '宝宝用量子场论',
                collapsed: true,
                link: { type: 'doc', id: 'QFT/index' },
                items: [
                  { type: 'doc', id: 'QFT/01', label: '场论' },
                  { type: 'html', value: '<b>not JSON UI</b>' },
                  { type: 'link', label: 'GitHub', href: 'https://example.com' },
                ],
              },
            ],
          },
        }],
      },
    },
  }
  await plugin.allContentLoaded({
    allContent,
    actions: { setGlobalData: (value) => globalData.push(value) },
  })
  assert.equal(globalData.length, 1)
  const data = globalData[0]
  assert.equal(data.version, 2)
  assert.equal(data.routeBasePath, '/docs')
  assert.equal(data.locale, 'zh')
  assert.equal(data.docs.length, 2)
  assert.equal(data.sidebars.version, 'current')
  assert.equal(data.sidebars.locale, 'zh')
  assert.equal(typeof data.sidebars.generatedAt, 'string')
  const category = data.sidebars.trees.defaultSidebar[0]
  assert.equal(category.type, 'category')
  assert.equal(category.collapsed, true)
  assert.equal(category.link.type, 'doc')
  assert.equal(category.items.length, 2, 'html item is dropped')
  assert.equal(category.items[0].type, 'doc')
  assert.equal(category.items[1].type, 'link')
  assert.equal(JSON.stringify(data.sidebars).includes('not JSON UI'), false)
})

test('allContentLoaded tolerates missing sidebars without throwing', async () => {
  const globalData = []
  const plugin = dshLiveEditor({ i18n: { currentLocale: 'zh' } })
  await plugin.allContentLoaded({
    allContent: {
      'docusaurus-plugin-content-docs': {
        default: { loadedVersions: [{ versionName: 'current', docs: [] }] },
      },
    },
    actions: { setGlobalData: (value) => globalData.push(value) },
  })
  assert.deepEqual(globalData[0].sidebars.trees, {})
})


test('publishes additive instances while keeping legacy docs/sidebars', async () => {
  const globalData = []
  const plugin = dshLiveEditor({
    i18n: { currentLocale: 'zh', defaultLocale: 'zh' },
    siteDir: '/site',
    siteConfig: { url: 'https://example.test', baseUrl: '/' },
  })
  const allContent = {
    'docusaurus-plugin-content-docs': {
      default: {
        loadedVersions: [{
          versionName: 'current', path: '/docs', contentPath: '/site/docs', sidebars: { defaultSidebar: [] },
          docs: [{ id: 'intro', source: '@site/docs/intro.mdx', permalink: '/docs/intro/', title: 'Intro', frontMatter: {} }],
        }],
      },
      proj: {
        loadedVersions: [{
          versionName: 'current', path: '/proj', contentPath: '/site/proj', sidebars: { projSidebar: [] },
          docs: [
            { id: 'index', source: '@site/proj/index.mdx', permalink: '/proj/', title: 'Project', frontMatter: {} },
            { id: 'docs/nested', source: '@site/proj/docs/nested.mdx', permalink: '/proj/nested/', title: 'Nested', frontMatter: {} },
          ],
        }],
      },
    },
  }
  await plugin.allContentLoaded({
    allContent,
    actions: { setGlobalData: (value) => globalData.push(value) },
  })
  const data = globalData[0]
  assert.equal(data.version, 2)
  assert.equal(data.docs.length, 3, 'legacy flat docs retained')
  assert.equal(data.docs.find((d) => d.instanceId === 'proj').sourceRoot, 'proj')
  assert.equal(data.docs.find((d) => d.source === 'proj/docs/nested.mdx').instanceId, 'proj')
  assert.equal(data.docs.find((d) => d.instanceId === 'proj').versionName, 'current')
  assert.equal(data.sidebars.trees.defaultSidebar.length, 0)
  assert.equal(data.instances.filter((i) => i.pluginType === 'docs').length, 2)
  assert.deepEqual(data.instances.filter((i) => i.pluginType === 'docs').map((i) => i.instanceId).sort(), ['default', 'proj'])
  assert.equal(data.instanceErrors.length, 0)
  assert.deepEqual(data.instances.find((i) => i.instanceId === 'proj').sourceRoots, ['proj'])
})


test('optional descriptor export is written when the environment requests it', async () => {
  const out = path.join(os.tmpdir(), `dsh-instances-${process.pid}-${Date.now()}.json`)
  const previous = process.env.DSH_LIVE_EDITOR_INSTANCES_FILE
  process.env.DSH_LIVE_EDITOR_INSTANCES_FILE = out
  try {
    const plugin = dshLiveEditor({
      i18n: { currentLocale: 'zh', defaultLocale: 'zh' }, siteDir: '/site',
      siteConfig: { url: 'https://example.test', baseUrl: '/' },
    })
    await plugin.allContentLoaded({
      allContent: {
        'docusaurus-plugin-content-docs': {
          default: { loadedVersions: [{
            versionName: 'current', path: '/docs', contentPath: '/site/docs', sidebars: {},
            docs: [{ id: 'intro', source: '@site/docs/intro.mdx', permalink: '/docs/intro/', title: 'Intro', frontMatter: {} }],
          }] },
        },
      },
      actions: { setGlobalData: () => {} },
    })
    const data = JSON.parse(await fs.readFile(out, 'utf8'))
    assert.equal(data.version, 1)
    assert.equal(data.instances[0].instanceId, 'default')
  } finally {
    if (previous === undefined) delete process.env.DSH_LIVE_EDITOR_INSTANCES_FILE
    else process.env.DSH_LIVE_EDITOR_INSTANCES_FILE = previous
    await fs.rm(out, { force: true })
  }
})
