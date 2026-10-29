/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Phase 2 / Step 2A — DocIndex unit tests.
 *
 * Covers the Docusaurus-compatible derivation rules and the security/
 * robustness behavior of the Host index (symlinks, dotfiles, size limits).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MODULE = path.resolve(import.meta.dirname, '../../prototypes/phase2/dsh-bundle/lib/docindex.js')
const {
  stripNumberPrefix,
  computeDocId,
  computeSlug,
  computePermalink,
  normalizeDocSource,
  buildIndex,
  bySource,
} = await import(pathToFileURL(MODULE).href)

test('stripNumberPrefix follows Docusaurus 3.10 rules', () => {
  assert.equal(stripNumberPrefix('03-classical-field-theory'), 'classical-field-theory')
  assert.equal(stripNumberPrefix('003 - myDoc'), 'myDoc')
  assert.equal(stripNumberPrefix('2021-11-foo'), '2021-11-foo') // date-like, not stripped
  assert.equal(stripNumberPrefix('7.0-foo'), '7.0-foo')
  assert.equal(stripNumberPrefix('index'), 'index')
})

test('docId keeps index and strips directory prefixes', () => {
  assert.equal(computeDocId('ASM/Chapter6/index.mdx'), 'ASM/Chapter6/index')
  assert.equal(computeDocId('QFT/03-classical-field-theory.mdx'), 'QFT/classical-field-theory')
  assert.equal(computeDocId('01-intro.mdx'), 'intro')
  assert.equal(computeDocId('03-free-field-theory.mdx'), 'free-field-theory')
})

test('slug/permalink: plain doc, index doc, slug override, root', () => {
  assert.equal(computePermalink({ relPosix: 'QFT/03-classical-field-theory.mdx' }), '/docs/QFT/classical-field-theory/')
  assert.equal(computePermalink({ relPosix: 'QFT/index.mdx' }), '/docs/QFT/')
  assert.equal(computePermalink({ relPosix: 'QFT/index.mdx', frontMatter: { slug: '/QFT' } }), '/docs/QFT/')
  assert.equal(computePermalink({ relPosix: 'ASM/index.mdx', frontMatter: { slug: '/05-ASM' } }), '/docs/05-ASM/')
  assert.equal(computePermalink({ relPosix: '01-intro.mdx' }), '/docs/intro/')
  assert.equal(computePermalink({ relPosix: 'index.mdx' }), '/docs/')
  assert.equal(computePermalink({ relPosix: 'QFT/01-why-qft.mdx', trailingSlash: false }), '/docs/QFT/why-qft')
  assert.equal(computeSlug('QFT/index.mdx'), '/QFT/')
})

test('normalizeDocSource accepts @site/docs and i18n, rejects absolute/traversal', () => {
  assert.deepEqual(normalizeDocSource('@site/docs/QFT/01-why-qft.mdx'), {
    kind: 'docs', source: 'docs/QFT/01-why-qft.mdx', relPath: 'QFT/01-why-qft.mdx', locale: null,
  })
  assert.deepEqual(normalizeDocSource('docs/01-intro.mdx'), {
    kind: 'docs', source: 'docs/01-intro.mdx', relPath: '01-intro.mdx', locale: null,
  })
  assert.deepEqual(normalizeDocSource('@site/i18n/en/docusaurus-plugin-content-docs/current/01-intro.mdx'), {
    kind: 'i18n', source: 'i18n/en/docusaurus-plugin-content-docs/current/01-intro.mdx', relPath: '01-intro.mdx', locale: 'en',
  })
  assert.equal(normalizeDocSource('/Users/x/site/docs/a.mdx'), null)
  assert.equal(normalizeDocSource('docs/../secret.mdx'), null)
  assert.equal(normalizeDocSource('docusaurus.config.ts'), null)
  assert.equal(normalizeDocSource(null), null)
})

test('buildIndex skips symlinks/dotfiles/large files and keeps paths relative', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-docindex-'))
  try {
    const docs = path.join(tmp, 'docs')
    await mkdir(path.join(docs, 'Guide'), { recursive: true })
    await writeFile(path.join(docs, '01-intro.mdx'), '---\ntitle: 介绍\n---\n# 介绍\n')
    await writeFile(path.join(docs, 'Guide', '_category_.json'), JSON.stringify({ label: '指南', position: 2 }))
    await writeFile(path.join(docs, 'Guide', 'index.mdx'), '# 指南\n')
    await writeFile(path.join(docs, 'Guide', '02-topic.mdx'), '---\nsidebar_position: 4\n---\n# 主题\n')
    await writeFile(path.join(docs, '.hidden.mdx'), '# hidden\n')
    await writeFile(path.join(docs, 'big.mdx'), '# big\n' + 'x'.repeat(2000))
    await symlink(path.join(docs, '01-intro.mdx'), path.join(docs, 'link.mdx'))

    const index = await buildIndex({ docsRoot: docs, limits: { maxFileBytes: 1000 } })
    const paths = index.entries.map((entry) => entry.path)
    assert.equal(index.counts.dirs, 1)
    assert.equal(index.counts.docs, 3)
    assert.equal(index.counts.other, 1)
    assert.equal(index.counts.skipped, 3) // dotfile + symlink + large
    assert.ok(!paths.includes('link.mdx'))
    assert.ok(!paths.includes('.hidden.mdx'))
    assert.ok(!paths.includes('big.mdx'))
    assert.ok(index.entries.every((entry) => !entry.path.startsWith('/') && !entry.path.includes('..')))
    assert.ok(index.warnings.some((warning) => warning.includes('symlink')))
    assert.equal(bySource(index).get('docs/Guide/02-topic.mdx').position, 4)
    assert.equal(index.entries.find((entry) => entry.kind === 'dir').label, '指南')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
