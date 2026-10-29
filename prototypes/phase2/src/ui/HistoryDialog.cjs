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
const formatSize = (text) => {
  const bytes = new TextEncoder().encode(text ?? '').length
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

const buttonStyle = {
  border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.bg,
  color: T.text, padding: '3px 10px', cursor: 'pointer', font: `${T.uiSmallSize}/1.4 ${T.font}`,
}

function HistoryDialog ({ open, title, records, onRestore, onClose }) {
  const [selected, setSelected] = React.useState(null)
  React.useEffect(() => {
    if (open) setSelected(records?.[0]?.id ?? null)
  }, [open, records])
  if (!open) return null
  const record = (records ?? []).find((item) => item.id === selected) ?? records?.[0] ?? null

  const row = (item) => h('button', {
    key: item.id,
    type: 'button',
    onClick: () => setSelected(item.id),
    style: {
      display: 'flex', flexDirection: 'column', gap: 2, width: '100%', textAlign: 'left',
      border: 0, cursor: 'pointer',
      background: item.id === selected ? T.bgMuted : 'transparent',
      color: T.text, padding: '5px 10px', font: `${T.uiSmallSize}/1.45 ${T.font}`,
    },
  },
  h('span', { style: { fontWeight: item.id === selected ? 600 : 400 } }, formatTime(item.createdAt)),
  h('span', { style: { color: T.textTertiary, fontSize: T.uiSmallSize } },
    `${formatSize(item.text)} · ${item.reason}${item.saved ? ' · 已保存' : ''}`))

  return h('div', {
    role: 'presentation',
    onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
    style: {
      position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.32)',
      display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '8vh',
    },
  },
  h('div', {
    role: 'dialog', 'aria-label': '草稿历史',
    style: {
      width: 'min(780px, 92vw)', maxHeight: '78vh', display: 'flex', flexDirection: 'column',
      background: T.bg, color: T.text, border: `1px solid ${T.border}`,
      borderRadius: 8, boxShadow: '0 18px 48px rgba(0,0,0,0.35)', overflow: 'hidden',
    },
  },
  h('div', {
    style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${T.border}` },
  },
  h('div', { style: { fontWeight: 600, flex: 1 } }, title ?? '草稿历史'),
  h('button', {
    type: 'button', onClick: onClose,
    style: { border: 0, background: 'transparent', color: T.textSecondary, cursor: 'pointer', fontSize: 16 },
  }, '×')),
  h('div', { style: { display: 'flex', minHeight: 0, flex: '1 1 auto' } },
    h('div', {
      style: { width: 300, maxWidth: '45%', overflow: 'auto', borderRight: `1px solid ${T.border}`, padding: '4px 0' },
    },
    (records ?? []).length === 0
      ? h('div', { style: { padding: '10px 12px', color: T.textTertiary, fontSize: T.uiSmallSize } }, '暂无历史快照')
      : (records ?? []).map(row)),
    h('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' } },
      h('pre', {
        style: {
          flex: '1 1 auto', minHeight: 0, overflow: 'auto', margin: 0, padding: '10px 12px',
          background: T.bgMuted, color: T.text, font: `${T.codeSize}/1.5 ${T.mono}`,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        },
      }, record?.text ?? '选择左侧快照预览'),
      h('div', {
        style: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '8px 12px', borderTop: `1px solid ${T.border}` },
      },
      h('button', { type: 'button', onClick: onClose, style: buttonStyle }, '取消'),
      h('button', {
        type: 'button',
        disabled: record === null,
        onClick: () => { if (record !== null) onRestore(record.id) },
        style: {
          ...buttonStyle, background: T.accent, color: '#fff', borderColor: T.accent,
          opacity: record === null ? 0.5 : 1,
        },
      }, '恢复此版本'))))))
}

module.exports = { HistoryDialog }
