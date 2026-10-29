/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSidebarTree, selectSidebarTree, ancestorPaths } from '../../prototypes/phase2/src/state/sidebar-tree.mjs'

const docs = [
  { docId: 'QFT/index', path: 'QFT/index.mdx', title: 'QFT 首页', source: 'docs/QFT/index.mdx' },
  { docId: 'QFT/01', path: 'QFT/01-field.mdx', title: '场', source: 'docs/QFT/01-field.mdx' },
  { docId: 'QFT/appendix/01', path: 'QFT/appendix/01-math.mdx', title: '数学工具', source: 'docs/QFT/appendix/01-math.mdx' },
  { docId: 'ASM/index', path: 'ASM/index.mdx', title: '统计物理', source: 'docs/ASM/index.mdx' },
  { docId: 'intro', path: '01-intro.mdx', title: '关于', source: 'docs/01-intro.mdx' },
  { docId: 'loose', path: 'loose.md', title: '未收录', source: 'docs/loose.md' },
]

const payload = {
  version: 'current',
  locale: 'zh',
  generatedAt: '2026-10-22T00:00:00.000Z',
  trees: {
    defaultSidebar: [
      {
        type: 'category',
        label: '宝宝用量子场论',
        collapsed: false,
        link: { type: 'doc', id: 'QFT/index' },
        items: [
          // Same doc as the category link: must not become a duplicate leaf.
          { type: 'doc', id: 'QFT/index', label: 'QFT 首页（重复）' },
          { type: 'doc', id: 'QFT/01', label: '场论' },
          {
            type: 'category',
            label: '数学工具与补充推导',
            collapsed: true,
            link: { type: 'generated-index', slug: '/qft/math' },
            items: [{ type: 'doc', id: 'QFT/appendix/01' }],
          },
        ],
      },
      { type: 'doc', id: 'ASM/index', label: '统计物理' },
      { type: 'link', label: 'GitHub', href: 'https://example.com/repo' },
      { type: 'doc', id: 'does/not/exist' },
    ],
  },
}

test('selectSidebarTree prefers defaultSidebar and accepts a raw array', () => {
  const selected = selectSidebarTree(payload)
  assert.equal(selected.name, 'defaultSidebar')
  assert.equal(selected.items.length, 4)
  assert.equal(selected.generatedAt, payload.generatedAt)
  const raw = selectSidebarTree([{ type: 'doc', id: 'intro' }])
  assert.equal(raw.name, 'sidebar')
  assert.equal(buildSidebarTree(null, docs), null)
})

test('sidebar tree maps ids to Host paths, keeps order, and never duplicates a category index doc', () => {
  const tree = buildSidebarTree(payload, docs)
  assert.ok(tree)
  assert.equal(tree.kind, 'root')
  assert.equal(tree.source, 'sidebar')
  assert.deepEqual(tree.children.map((node) => node.kind), ['dir', 'doc', 'link', 'dir'])

  const qft = tree.children[0]
  assert.equal(qft.label, '宝宝用量子场论')
  assert.equal(qft.indexPath, 'QFT/index.mdx')
  assert.equal(qft.children[0].kind, 'doc')
  assert.equal(qft.children[0].path, 'QFT/01-field.mdx')
  assert.equal(qft.children[0].label, '场论')
  assert.equal(qft.children[1].kind, 'dir')
  assert.equal(qft.children[1].label, '数学工具与补充推导')
  assert.equal(qft.children[1].defaultCollapsed, true)
  assert.equal(qft.children[1].indexDisabled, true)

  const allDocPaths = []
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.kind === 'doc') allDocPaths.push(child.path)
      walk(child)
    }
  }
  walk(tree)
  assert.equal(allDocPaths.filter((path) => path === 'QFT/index.mdx').length, 0, 'category index is not a leaf')
  assert.equal(allDocPaths.filter((path) => path === 'QFT/01-field.mdx').length, 1)
  assert.equal(allDocPaths.filter((path) => path === 'QFT/appendix/01-math.mdx').length, 1)

  const asm = tree.children[1]
  assert.equal(asm.path, 'ASM/index.mdx')
  assert.equal(asm.label, '统计物理')
  const link = tree.children[2]
  assert.equal(link.kind, 'link')
  assert.equal(link.disabled, true)
  assert.equal(link.href, 'https://example.com/repo')
})

test('sidebar tree puts non-sidebar docs in 其他文件 and excludes used docs', () => {
  const tree = buildSidebarTree(payload, docs)
  const other = tree.children[3]
  assert.equal(other.kind, 'dir')
  assert.equal(other.label, '其他文件')
  assert.deepEqual(other.children.map((node) => node.path), ['01-intro.mdx', 'loose.md'])
  assert.ok(!other.children.some((node) => node.path.startsWith('QFT/')))
  assert.ok(!other.children.some((node) => node.path === 'ASM/index.mdx'))
})

test('ancestorPaths opens only the categories needed for a target', () => {
  const tree = buildSidebarTree(payload, docs)
  const chain = ancestorPaths(tree, 'QFT/appendix/01-math.mdx')
  assert.equal(chain.length, 2)
  assert.equal(chain[0], tree.children[0].path)
  assert.equal(chain[1], tree.children[0].children[1].path)
  assert.deepEqual(ancestorPaths(tree, '01-intro.mdx'), ['__other__'])
  assert.deepEqual(ancestorPaths(tree, 'missing.mdx'), [])
})


test('sidebar identity resolves the same docId in the requested instance', () => {
  const payload = {
    version: 'current', instanceId: 'proj',
    trees: { projSidebar: [{ type: 'doc', id: 'intro' }] },
  }
  const docs = [
    { docId: 'intro', path: '01-intro.mdx', title: 'Default intro', source: 'docs/01-intro.mdx', instanceId: 'default' },
    { docId: 'intro', path: 'index.mdx', title: 'Project intro', source: 'proj/index.mdx', instanceId: 'proj' },
  ]
  const tree = buildSidebarTree(payload, docs, { instanceId: 'proj' })
  assert.ok(tree)
  assert.equal(tree.children[0].path, 'index.mdx')
  assert.equal(tree.children[0].instanceId, 'proj')
  assert.equal(tree.children[0].title, 'Project intro')
})


test('sidebar instance isolation applies to the whole tree, not only docId lookup', () => {
  const payload = {
    version: 'current', instanceId: 'proj',
    trees: { projSidebar: [{ type: 'doc', id: 'intro' }] },
  }
  const docs = [
    { docId: 'intro', path: '01-intro.mdx', title: 'Default intro', source: 'docs/01-intro.mdx', instanceId: 'default' },
    { docId: 'intro', path: 'index.mdx', title: 'Project intro', source: 'proj/index.mdx', instanceId: 'proj' },
    { docId: 'only-default', path: 'default-only.mdx', title: 'Default only', source: 'docs/default-only.mdx', instanceId: 'default' },
  ]
  const tree = buildSidebarTree(payload, docs, { instanceId: 'proj' })
  assert.ok(tree)
  const all = []
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.kind === 'doc') all.push(child)
      if (child.kind === 'dir') walk(child)
    }
  }
  walk(tree)
  assert.deepEqual(all.map((node) => node.path), ['index.mdx'])
  assert.ok(!all.some((node) => node.path === 'default-only.mdx'))
})

test('an unqualified sidebar cannot be relabelled by the active document instance', () => {
  const payload = { version: 'current', trees: { defaultSidebar: [{ type: 'doc', id: 'intro' }] } }
  const docs = [
    { docId: 'intro', path: '01-intro.mdx', title: 'Default intro', source: 'docs/01-intro.mdx', instanceId: 'default' },
    { docId: 'intro', path: 'index.mdx', title: 'Project intro', source: 'proj/index.mdx', instanceId: 'proj' },
  ]
  const unqualified = buildSidebarTree(payload, docs, { instanceId: 'proj' })
  assert.equal(unqualified.children[0].path, '01-intro.mdx')
  assert.equal(unqualified.children[0].instanceId, 'default')
  const fallback = buildSidebarTree(payload, docs, { instanceId: 'default' })
  assert.equal(fallback.children[0].path, '01-intro.mdx')
})
