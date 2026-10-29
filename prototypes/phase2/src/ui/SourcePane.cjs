/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

function SourcePane ({ sourceHostRef, visible, borderRight, sourceText, sourceError, unrecognized, pageReturn, editorError, paneStyle }) {
  return h('div', {
    style: {
      flex: '1 1 50%', minWidth: 0, position: 'relative',
      display: visible ? 'flex' : 'none', background: T.bg,
      borderRight: borderRight ? `1px solid ${T.border}` : 0,
      ...paneStyle,
    },
  },
    h('div', { ref: sourceHostRef, style: { flex: 1, minWidth: 0, overflow: 'hidden' } }),
    (sourceText === null || unrecognized !== null || editorError !== null) && h('div', {
      style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, background: T.bg, color: T.textSecondary, textAlign: 'center', padding: 16 },
    },
      unrecognized !== null
        ? h('div', null,
          h('div', { style: { fontWeight: 600, color: T.text } }, '当前页面不是可编辑的 MDX 文档'),
          h('div', { style: { fontFamily: T.mono, fontSize: T.uiSmallSize } }, unrecognized.permalink || unrecognized.title),
          pageReturn && h('div', {
            style: { marginTop: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 },
          },
            h('div', { style: { color: T.textSecondary, fontSize: T.uiSmallSize } },
              `上一个文档：${pageReturn.label}${pageReturn.dirty ? '（有未保存草稿）' : ''}`),
            h('button', {
              type: 'button', onClick: pageReturn.onClick,
              style: {
                border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.bg,
                color: T.text, padding: '3px 10px', cursor: 'pointer',
                font: `${T.uiSmallSize}/1.4 ${T.font}`,
              },
            }, '返回该文档'),
          ))
        : h('div', null, editorError !== null ? `编辑器初始化失败：${editorError}` : sourceError ? `源码读取失败：${sourceError}` : '读取源码中…'),
    ),
  )
}

module.exports = { SourcePane }
