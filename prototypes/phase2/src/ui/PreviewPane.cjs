/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

function PreviewPane ({ iframeRef, src, attempt, visible, timeout, loading, onLoad, onReload, paneStyle, previewStatus }) {
  return h('div', {
    style: {
      flex: '1 1 50%', minWidth: 0, position: 'relative',
      display: visible ? 'flex' : 'none', background: T.bg,
      ...paneStyle,
    },
  },
    h('iframe', {
      key: attempt,
      ref: iframeRef,
      // Do not load the Docusaurus preview document into a hidden iframe. A
      // saved source-only layout used to load the page behind display:none,
      // and that hidden page could crash on first open. Load the real preview
      // page only when the pane becomes visible; the draft write is already in
      // staging, and the first visible load reconnects/reissues the ACK.
      src: visible ? src : 'about:blank',
      title: 'Docusaurus preview',
      onLoad,
      style: { flex: 1, width: '100%', border: 0, background: T.bg },
    }),
    previewStatus && visible && h('div', {
      'data-preview-status': previewStatus.phase,
      style: {
        position: 'absolute', top: 8, left: 8, zIndex: 2, pointerEvents: 'none',
        maxWidth: 'calc(100% - 16px)', padding: '2px 7px', borderRadius: T.radius,
        border: `1px solid ${previewStatus.error ? T.error : previewStatus.warning ? T.accent : T.border}`,
        background: T.bg, color: previewStatus.error ? T.error : previewStatus.warning ? T.accent : T.textSecondary,
        font: `${T.uiSmallSize}/1.5 ${T.font}`,
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
      },
    }, previewStatus.label),
    loading && h('div', {
      style: {
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 6, padding: 24,
        background: T.bg, color: T.textSecondary, textAlign: 'center',
      },
    },
      h('div', { style: { fontWeight: 600, color: T.text } }, '读取文件索引…'),
      h('div', null, '正在获取 docs/ 的只读索引'),
    ),
    timeout && h('div', {
      style: {
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24,
        background: T.bg, color: T.text, textAlign: 'center',
      },
    },
      h('div', { style: { fontWeight: 600 } }, 'dev server 未就绪 / 握手超时'),
      h('div', { style: { color: T.textSecondary } }, '请确认 http://localhost:3000 已启动，然后点“重载”。'),
      h('button', {
        type: 'button', onClick: onReload,
        style: { border: `1px solid ${T.border}`, background: T.bg, color: T.text, borderRadius: T.radius, padding: '3px 8px', cursor: 'pointer' },
      }, '重载'),
    ),
  )
}

module.exports = { PreviewPane }
