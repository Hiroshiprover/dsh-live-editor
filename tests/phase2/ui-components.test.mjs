/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Phase 2 / Step 3 — file tree + quick open + confirm bar render smoke.
 *
 * SSR-renders the new UI components without a browser to catch hook/JSX
 * errors before the tab reload.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import Module from 'node:module'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../..')
const UI = path.join(REPO, 'prototypes/phase2/src/ui')

process.env.NODE_PATH = [
  path.join(REPO, 'prototypes/phase2/site/node_modules'),
  path.join(REPO, 'prototypes/phase1a/node_modules'),
  process.env.NODE_PATH ?? '',
].filter(Boolean).join(path.delimiter)
Module._initPaths()

globalThis.localStorage = { getItem: () => null, setItem: () => {} }
globalThis.document = {
  body: { hasAttribute: () => false, appendChild: () => {}, style: {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  documentElement: { setAttribute: () => {}, style: {} },
  createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
}
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  confirm: () => true,
}

const req = createRequire(path.join(UI, 'FilePanel.cjs'))
const React = req('react')
const { renderToString } = req('react-dom/server')

test('FilePanel renders the tree header, filter and top-level docs', () => {
  const { FilePanel } = req(path.join(UI, 'FilePanel.cjs'))
  const html = renderToString(React.createElement(FilePanel, {
    entries: [
      { kind: 'dir', path: 'QFT', label: '量子场论', position: 1 },
      { kind: 'doc', path: 'QFT/a.mdx', title: 'A 文档', position: 2 },
      { kind: 'doc', path: '01-intro.mdx', title: 'Intro', position: 1 },
    ],
    activePath: '01-intro.mdx',
    draftPaths: [],
    pinned: false,
    onOpen() {}, onClose() {}, onTogglePin() {}, onRefresh() {},
  }))
  assert.match(html, /过滤文件/)
  assert.match(html, /量子场论/)
  assert.match(html, /Intro/)
})

test('QuickOpen renders the query box and results', () => {
  const { QuickOpen } = req(path.join(UI, 'QuickOpen.cjs'))
  const html = renderToString(React.createElement(QuickOpen, {
    open: true,
    docs: [{ path: '01-intro.mdx', title: 'Intro' }, { path: 'QFT/a.mdx', title: 'A 文档' }],
    onClose() {}, onSelect() {},
  }))
  assert.match(html, /快速打开/)
  assert.match(html, /Intro/)
  assert.match(html, /01-intro\.mdx/)
})

test('ConfirmBar renders retry/still-switch/cancel for an unsafe draft', () => {
  const { ConfirmBar } = req(path.join(UI, 'ConfirmBar.cjs'))
  const html = renderToString(React.createElement(ConfirmBar, {
    pending: { path: 'QFT/a.mdx', title: 'A 文档' },
    busy: false,
    onRetry() {}, onSwitchAnyway() {}, onCancel() {},
  }))
  assert.match(html, /重试暂存/)
  assert.match(html, /仍然切换/)
  assert.match(html, /取消/)
})

test('RecoveryBar renders recover/history/discard', () => {
  const { RecoveryBar } = req(path.join(UI, 'RecoveryBar.cjs'))
  const html = renderToString(React.createElement(RecoveryBar, {
    doc: {
      recovery: {
        status: 'available',
        conflict: false,
        latest: [{ tabId: 'tab1', updatedAt: 1761000000000 }],
        history: [{ id: 1, text: 'x', createdAt: 1 }],
      },
    },
    onRecover() {}, onHistory() {}, onDiscard() {}, onDismiss() {},
  }))
  assert.match(html, /恢复最新/)
  assert.match(html, /查看历史/)
  assert.match(html, /丢弃/)
})

test('HistoryDialog and DraftsPanel render the recovery entries', () => {
  const { HistoryDialog } = req(path.join(UI, 'HistoryDialog.cjs'))
  const { DraftsPanel } = req(path.join(UI, 'DraftsPanel.cjs'))
  const history = renderToString(React.createElement(HistoryDialog, {
    open: true,
    title: 'A 文档',
    records: [{ id: 1, text: 'old text', createdAt: 1761000000000, reason: 'interval', saved: false }],
    onRestore() {}, onClose() {},
  }))
  assert.match(history, /old text/)
  assert.match(history, /恢复此版本/)
  const panel = renderToString(React.createElement(DraftsPanel, {
    open: true,
    groups: [{ path: 'QFT/a.mdx', title: 'A 文档', latest: [{ updatedAt: 1761000000000 }], history: [{ id: 1 }], conflict: false }],
    onOpen() {}, onHistory() {}, onClose() {}, onRefresh() {},
  }))
  assert.match(panel, /A 文档/)
  assert.match(panel, /历史/)
})
test('FilePanel renders a sidebar tree with a category index link and 其他文件', () => {
  const { FilePanel } = req(path.join(UI, 'FilePanel.cjs'))
  const sidebarTree = {
    kind: 'root',
    path: '',
    source: 'sidebar',
    children: [
      {
        kind: 'dir',
        path: 'cat:0:0:QFT',
        label: '宝宝用量子场论',
        indexPath: 'QFT/index.mdx',
        indexTitle: 'QFT 首页',
        indexDisabled: false,
        children: [{ kind: 'doc', path: 'QFT/01.mdx', label: '场论', title: '场论' }],
      },
      {
        kind: 'dir',
        path: '__other__',
        label: '其他文件',
        indexPath: null,
        indexDisabled: false,
        children: [{ kind: 'doc', path: '01-intro.mdx', label: '关于', title: '关于' }],
      },
    ],
  }
  const html = renderToString(React.createElement(FilePanel, {
    entries: [],
    sidebarTree,
    activePath: 'QFT/index.mdx',
    draftPaths: [],
    pinned: false,
    onOpen() {}, onClose() {}, onTogglePin() {}, onRefresh() {},
  }))
  assert.match(html, /侧边栏/)
  assert.match(html, /宝宝用量子场论/)
  assert.match(html, /分类首页/)
  assert.match(html, /其他文件/)
  assert.match(html, /关于/)
})

test('FilePanel shows non-doc files as locked rows under 其他文件', () => {
  const { FilePanel } = req(path.join(UI, 'FilePanel.cjs'))
  const sidebarTree = {
    kind: 'root',
    path: '',
    source: 'sidebar',
    children: [
      {
        kind: 'dir',
        path: '__other__',
        label: '其他文件',
        indexPath: null,
        indexDisabled: false,
        children: [{ kind: 'doc', path: '01-intro.mdx', label: '关于', title: '关于' }],
      },
    ],
  }
  const html = renderToString(React.createElement(FilePanel, {
    entries: [{ kind: 'other', path: 'ASM/Chapter7/_category_.json', name: '_category_.json', editable: false }],
    sidebarTree,
    activePath: null,
    draftPaths: [],
    pinned: false,
    onOpen() {}, onClose() {}, onTogglePin() {}, onRefresh() {},
  }))
  assert.match(html, /其他文件/)
  assert.match(html, /ASM\/Chapter7\/_category_.json/)
  assert.match(html, /🔒/)
})

test('ImportPanel renders the single-image review surface without saving', () => {
  const { ImportPanel } = req(path.join(UI, 'ImportPanel.cjs'))
  const html = renderToString(React.createElement(ImportPanel, {
    open: true,
    activePath: 'QFT/01-why-qft.mdx',
    onClose () {}, onInsert () {},
  }))
  assert.match(html, /导入一张图片/)
  assert.match(html, /只生成可审阅草稿/)
  assert.match(html, /开始转写/)
})

test('StatusBar distinguishes a hidden preview from an in-flight handshake', () => {
  const { StatusBar } = req(path.join(UI, 'StatusBar.cjs'))
  const hidden = renderToString(React.createElement(StatusBar, {
    cursor: { line: 1, column: 1 },
    status: 'hidden',
    serverOnline: true,
    previewStatus: { label: '草稿预览：预览已隐藏，显示后确认', error: false },
  }))
  assert.match(hidden, /预览已隐藏/)
  assert.doesNotMatch(hidden, /连接中/)
  const handshake = renderToString(React.createElement(StatusBar, {
    cursor: { line: 1, column: 1 },
    status: 'handshaking',
    serverOnline: true,
  }))
  assert.match(handshake, /连接中/)
})

test('ConflictBar exposes explicit disk/overwrite recovery for both conflict sources', () => {
  const { ConflictBar } = req(path.join(UI, 'ConflictBar.cjs'))
  const external = renderToString(React.createElement(ConflictBar, {
    mode: 'external-change',
    error: '文件已被外部修改；保存已取消，未覆盖磁盘内容；草稿已保留。',
    onUseDisk () {}, onOverwrite () {},
  }))
  assert.match(external, /保存冲突/)
  assert.match(external, /草稿仍保留/)
  assert.match(external, /以磁盘为准/)
  assert.match(external, /用我的内容覆盖/)
  assert.match(external, /data-conflict-bar="external-change"/)

  const restored = renderToString(React.createElement(ConflictBar, {
    mode: 'restored-draft', error: null, onUseDisk () {}, onOverwrite () {},
  }))
  assert.match(restored, /草稿来源是旧版本/)
  assert.match(restored, /data-conflict-bar="restored-draft"/)
})

test('ConflictBar distinguishes an unconfirmed write and disables actions while busy', () => {
  const { ConflictBar } = req(path.join(UI, 'ConflictBar.cjs'))
  const unconfirmed = renderToString(React.createElement(ConflictBar, {
    mode: 'write-unconfirmed', busy: false, onUseDisk () {}, onOverwrite () {},
  }))
  assert.match(unconfirmed, /保存结果未确认/)
  assert.match(unconfirmed, /写入可能已经提交/)
  assert.match(unconfirmed, /data-conflict-bar="write-unconfirmed"/)

  const busy = renderToString(React.createElement(ConflictBar, {
    mode: 'external-change', busy: true, onUseDisk () {}, onOverwrite () {},
  }))
  assert.match(busy, /处理中/)
  assert.match(busy, /disabled=""/)
})
