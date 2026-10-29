/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

const formatTime = (value) => {
  if (!Number.isFinite(value)) return '未知时间'
  try { return new Date(value).toLocaleTimeString() } catch { return '未知时间' }
}

function RecoveryBar ({ doc, onRecover, onHistory, onDiscard, onDismiss }) {
  const recovery = doc?.recovery
  if (recovery === undefined || recovery.status !== 'available') return null
  const latest = recovery.latest?.[0]
  const conflict = recovery.conflict === true
  return h('div', {
    role: 'status',
    style: {
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '4px 10px', borderBottom: `1px solid ${T.border}`,
      background: T.bgMuted, color: T.text, font: `${T.uiSmallSize}/1.4 ${T.font}`,
      flex: '0 0 auto',
    },
  },
    h('span', { style: { flex: '1 1 260px', minWidth: 0 } },
      `上次离开时有未保存草稿（${formatTime(latest?.updatedAt)}${latest?.tabId ? `，来自 ${latest.tabId}` : ''}）`,
      conflict ? '；草稿基于旧磁盘版本，恢复后保存会触发冲突。' : '。'),
    h('button', { type: 'button', onClick: onRecover, style: buttonStyle }, '恢复最新'),
    h('button', { type: 'button', onClick: onHistory, style: buttonStyle }, `查看历史 (${recovery.history?.length ?? 0})`),
    h('button', { type: 'button', onClick: () => onDiscard(latest?.tabId), style: { ...buttonStyle, color: T.error } }, '丢弃'),
    h('button', { type: 'button', onClick: onDismiss, style: { ...buttonStyle, border: 0, background: 'transparent', color: T.textSecondary } }, '稍后'),
  )
}

const buttonStyle = {
  border: `1px solid ${T.border}`, borderRadius: T.radius,
  background: T.bg, color: T.text, padding: '2px 8px',
  cursor: 'pointer', font: `${T.uiSmallSize}/1.4 ${T.font}`,
}

module.exports = { RecoveryBar }
