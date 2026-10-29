/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Notice bar behavior: success notices fade out on their lifetime, every
 * notice can be dismissed, and real errors stay with their reload action.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '../..')
const phaseRequire = createRequire(path.join(ROOT, 'prototypes/phase2/src/client.cjs'))
const React = phaseRequire('react')
const TestRenderer = phaseRequire('react-test-renderer')
const { MessageBar } = phaseRequire('./ui/MessageBar.cjs')
const { T } = phaseRequire('./ui/tokens.cjs')
const { act } = TestRenderer
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const text = (children) => Array.isArray(children)
  ? children.map(text).join('')
  : (typeof children === 'string' ? children : '')

const findButton = (root, label) => root.root.findAllByType('button')
  .find((button) => text(button.props.children).includes(label))

const render = async (props) => {
  let root
  await act(async () => { root = TestRenderer.create(React.createElement(MessageBar, props)) })
  return root
}

test('a notice uses its tone, exposes a close button, and dismisses', async () => {
  let dismissed = 0
  const root = await render({
    error: null, notice: '导入草稿已追加', tone: 'success', noticeId: 1, ttlMs: null,
    onDismissNotice: () => { dismissed += 1 }, onReloadDisk: () => {},
  })
  try {
    const json = root.toJSON()
    assert.equal(json.props.style.color, T.success)
    assert.equal(json.props.style.transition, 'opacity 600ms ease')
    const close = findButton(root, '×')
    assert.ok(close, 'notice must have a close button')
    assert.equal(close.props['aria-label'], '关闭提示')
    await act(async () => { close.props.onClick() })
    assert.equal(dismissed, 1)
    assert.equal(findButton(root, '重新加载磁盘版本'), undefined)
  } finally {
    await act(async () => { root.unmount() })
  }
})

test('a notice with a lifetime fades out and dismisses itself', async () => {
  let dismissed = 0
  const root = await render({
    error: null, notice: '短提示', tone: 'info', noticeId: 2, ttlMs: 50,
    onDismissNotice: () => { dismissed += 1 },
  })
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)) })
    assert.equal(dismissed, 0, 'not dismissed before the fade completes')
    assert.equal(root.toJSON().props.style.opacity, 0, 'fading stage must be applied')

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)) })
    assert.equal(dismissed, 1)
  } finally {
    await act(async () => { root.unmount() })
  }
})

test('a real error stays persistent, keeps reload, and has no close button', async () => {
  let reloads = 0
  const root = await render({
    error: '保存冲突：磁盘文件已变化', notice: null, noticeId: null, ttlMs: null,
    onDismissNotice: () => {}, onReloadDisk: () => { reloads += 1 },
  })
  try {
    const json = root.toJSON()
    assert.equal(json.props.style.color, T.error)
    assert.equal(findButton(root, '×'), undefined)
    const reload = findButton(root, '重新加载磁盘版本')
    assert.ok(reload)
    await act(async () => { reload.props.onClick() })
    assert.equal(reloads, 1)
  } finally {
    await act(async () => { root.unmount() })
  }
})

test('replacing the notice cancels the previous dismiss timer', async () => {
  let dismissed = 0
  const root = await render({
    error: null, notice: '第一条', tone: 'info', noticeId: 3, ttlMs: 40,
    onDismissNotice: () => { dismissed += 1 },
  })
  try {
    await act(async () => {
      root.update(React.createElement(MessageBar, {
        error: null, notice: '第二条', tone: 'info', noticeId: 4, ttlMs: null,
        onDismissNotice: () => { dismissed += 1 },
      }))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
    assert.equal(dismissed, 0, 'the older timer must not dismiss the new notice')
    assert.match(JSON.stringify(root.toJSON()), /第二条/)
  } finally {
    await act(async () => { root.unmount() })
  }
})

test('a real error interrupts a notice fade and stays fully visible', async () => {
  let dismissed = 0
  const baseProps = {
    notice: '短提示', tone: 'info', noticeId: 21, ttlMs: 60,
    onDismissNotice: () => { dismissed += 1 },
  }
  const root = await render({ error: null, ...baseProps })
  try {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)) })
    assert.equal(root.toJSON().props.style.opacity, 0)

    await act(async () => {
      root.update(React.createElement(MessageBar, {
        error: '保存冲突：磁盘文件已变化', notice: null, noticeId: null, ttlMs: null,
        onDismissNotice: () => { dismissed += 1 }, onReloadDisk: () => {},
      }))
    })
    const json = root.toJSON()
    assert.equal(json.props.style.opacity, 1)
    assert.equal(json.props.style.color, T.error)
    assert.ok(findButton(root, '重新加载磁盘版本'))

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
    assert.equal(dismissed, 0, 'the notice timer must be cancelled when an error takes over')
  } finally {
    await act(async () => { root.unmount() })
  }
})
