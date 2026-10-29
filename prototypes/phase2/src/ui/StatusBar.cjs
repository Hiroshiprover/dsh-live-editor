/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

function StatusBar ({ cursor, dirty, saving, saveError, savePhase, draft, status, serverOnline, lastText, previewStatus, siteLabel, siteId, readOnly }) {
  const offline = serverOnline === false
  const connection = status === 'hidden'
    ? '预览已隐藏'
    : offline ? 'dev server 断开' : status === 'timeout' ? '握手超时' : status === 'connected' ? '已连接' : '连接中'
  const color = status === 'hidden'
    ? T.textTertiary
    : offline || status === 'timeout' ? T.error : status === 'connected' ? T.success : T.warning
  const draftTime = Number.isFinite(draft?.persistedAt)
    ? new Date(draft.persistedAt).toLocaleTimeString()
    : ''
  const draftLabel = draft?.status === 'persisted'
    ? `草稿已保存 ${draftTime}`
    : draft?.status === 'pending' || draft?.status === 'writing'
      ? '草稿暂存中…'
      : draft?.status === 'error'
        ? '草稿未保存'
        : draft?.status === 'conflict'
          ? '草稿冲突'
          : draft?.status === 'restored'
            ? '草稿已恢复（未写盘）'
            : null
  const draftColor = draft?.status === 'error'
    ? T.error
    : draft?.status === 'persisted' || draft?.status === 'restored'
      ? T.accent
    : T.textSecondary
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 12, minHeight: 24,
      padding: '3px 10px', borderTop: `1px solid ${T.border}`,
      background: T.bg, color: T.textSecondary,
      fontFamily: T.mono, fontSize: T.uiSmallSize, flex: '0 0 auto',
    },
  },
    h('span', null, `Ln ${cursor.line}, Col ${cursor.column}`),
    siteLabel && h('span', {
      title: `${siteLabel}${siteId ? ` · ${siteId}` : ''}`,
      style: {
        color: readOnly ? T.warning : T.textTertiary,
        maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
    }, `${readOnly ? '只读 · ' : ''}${siteLabel}`),
    h('span', { style: { color: saveError ? T.error : saving ? T.warning : dirty ? T.warning : T.success } },
      saveError ? '冲突' : saving ? '保存中…' : dirty ? '● 未保存到文件' : savePhase === 'saved' ? '文件已保存' : '已同步'),
    draftLabel && h('span', { style: { color: draftColor } }, draftLabel),
    previewStatus && h('span', { style: { color: previewStatus.error ? T.error : T.textTertiary } }, previewStatus.label),
    lastText && h('span', { style: { color: T.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, lastText),
    h('span', { style: { marginLeft: 'auto', display: 'inline-flex', gap: 5, alignItems: 'center', color, whiteSpace: 'nowrap' } },
      h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block' } }),
      connection,
    ),
  )
}

module.exports = { StatusBar }
