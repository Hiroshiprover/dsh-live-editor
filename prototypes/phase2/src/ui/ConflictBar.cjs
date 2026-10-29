/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

/**
 * Phase 5-P0 conflict bar.
 *
 * Three situations reuse the same safe actions:
 * - `external-change`: a save just received 409 because another writer changed
 *   the file (another tab or an external editor).
 * - `write-unconfirmed`: the write may or may not have committed; the draft
 *   and baseline must not be advanced as a clean success.
 * - `restored-draft`: a recovered draft was based on an older disk version.
 *
 * Neither action may silently discard the editor text. "Use disk" first keeps
 * an independent recoverable draft snapshot; "overwrite" re-reads the disk and
 * then uses a fresh CAS, so a second external change still stops.
 */
function ConflictBar ({ mode, error, busy, onUseDisk, onOverwrite }) {
  const external = mode === 'external-change'
  const unconfirmed = mode === 'write-unconfirmed'
  const label = mode === 'restored-draft' ? 'restored-draft' : mode
  const button = (text, onClick, extra) => h('button', {
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
  }, busy === true ? '处理中…' : text)
  return h('div', {
    role: 'alert',
    'data-conflict-bar': label,
    style: {
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '4px 10px', borderBottom: `1px solid ${T.border}`,
      background: T.bgMuted, color: T.text, font: `${T.uiSmallSize}/1.4 ${T.font}`,
      flex: '0 0 auto',
    },
  },
    h('span', { style: { flex: '1 1 280px', minWidth: 0 } },
      unconfirmed
        ? '保存结果未确认：写入可能已经提交，也可能没有。你的草稿仍保留；普通保存不会推进基线。'
        : external
          ? '保存冲突：磁盘已被外部修改（可能是另一个标签或外部编辑器）。你的草稿仍保留；普通保存不会覆盖磁盘。'
          : '磁盘版本已变化；草稿来源是旧版本，普通保存已被阻止。'),
    error ? h('span', { style: { color: T.error, flex: '1 1 200px' } }, error) : null,
    button('以磁盘为准…', onUseDisk, { title: '先保存独立草稿快照，再用磁盘内容替换编辑器' }),
    button('用我的内容覆盖…', onOverwrite, {
      color: T.error,
      borderColor: T.error,
      title: '重新读取磁盘最新版本，再用新的 expectedHash 做 CAS；再次冲突会继续停下',
    }),
  )
}

module.exports = { ConflictBar }
