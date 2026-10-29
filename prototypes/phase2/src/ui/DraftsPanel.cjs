/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

const formatTime = (value) => {
  if (!Number.isFinite(value)) return '未知'
  try { return new Date(value).toLocaleString() } catch { return '未知' }
}

function DraftsPanel ({ open, groups, onOpen, onHistory, onClose, onRefresh }) {
  if (!open) return null
  return h('div', {
    role: 'presentation',
    onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
    style: {
      position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.28)',
      display: 'flex', justifyContent: 'flex-end',
    },
  },
  h('div', {
    role: 'dialog', 'aria-label': '草稿',
    style: {
      width: 'min(460px, 92vw)', height: '100%', display: 'flex', flexDirection: 'column',
      background: T.bg, color: T.text, borderLeft: `1px solid ${T.border}`,
      boxShadow: '-8px 0 24px rgba(0,0,0,0.25)',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${T.border}` } },
      h('div', { style: { fontWeight: 600, flex: 1 } }, `草稿 (${groups.length})`),
      h('button', { type: 'button', onClick: onRefresh, style: buttonStyle }, '刷新'),
      h('button', { type: 'button', onClick: onClose, style: { ...buttonStyle, border: 0, fontSize: 16 } }, '×')),
    h('div', { style: { flex: '1 1 auto', overflow: 'auto', padding: '4px 0' } },
      groups.length === 0 && h('div', { style: { padding: '12px', color: T.textTertiary, fontSize: T.uiSmallSize } }, '没有未恢复的草稿'),
      groups.map((group) => h('div', {
        key: group.path,
        style: { padding: '8px 12px', borderBottom: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 4 },
      },
        h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group.title),
        h('div', { style: { color: T.textTertiary, fontSize: T.uiSmallSize, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group.path),
        h('div', { style: { color: T.textSecondary, fontSize: T.uiSmallSize } },
          `${group.latest?.[0] ? `最新 ${formatTime(group.latest[0].updatedAt)}` : '无最新草稿（仅历史快照）'} · 历史 ${group.history?.length ?? 0} 条`,
          group.conflict ? ' · 与磁盘版本不一致' : ''),
        h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
          h('button', { type: 'button', onClick: () => onOpen(group.path), style: buttonStyle }, '打开'),
          h('button', { type: 'button', onClick: () => onHistory(group.path), style: buttonStyle }, '历史')))))))
}

const buttonStyle = {
  border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.bg,
  color: T.text, padding: '2px 8px', cursor: 'pointer', font: `${T.uiSmallSize}/1.4 ${T.font}`,
}

module.exports = { DraftsPanel }
