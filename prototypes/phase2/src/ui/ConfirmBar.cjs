/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

/**
 * Model B: a switch is blocked only when the current text is not safely
 * staged locally. This bar retries the draft write; "仍然切换" is the explicit
 * risk path and does NOT write or discard the editor's in-memory text.
 */
function ConfirmBar ({ pending, busy, onRetry, onSwitchAnyway, onCancel }) {
  if (!pending) return null
  const button = (label, onClick, extra) => h('button', {
    type: 'button',
    onClick,
    disabled: busy === true,
    style: {
      border: `1px solid ${T.border}`, borderRadius: T.radius,
      background: T.bg, color: T.text, padding: '2px 8px',
      font: `${T.uiSmallSize}/1.4 ${T.font}`,
      cursor: busy === true ? 'not-allowed' : 'pointer',
      opacity: busy === true ? 0.6 : 1,
      ...extra,
    },
  }, label)
  return h('div', {
    role: 'alert',
    style: {
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '4px 10px', borderBottom: `1px solid ${T.border}`,
      background: T.bgMuted, color: T.text, font: `${T.uiSmallSize}/1.4 ${T.font}`,
      flex: '0 0 auto',
    },
  },
    h('span', { style: { flex: '1 1 240px', minWidth: 0 } },
      `「${pending.title}」的草稿尚未安全暂存；切换可能丢失最后修改。`),
    button(busy ? '重试中…' : '重试暂存', onRetry),
    button('仍然切换（可能丢失）', onSwitchAnyway, { color: T.error, borderColor: T.error }),
    button('取消', onCancel),
  )
}

module.exports = { ConfirmBar }
