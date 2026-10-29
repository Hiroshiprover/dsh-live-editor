/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

const buttonBase = {
  border: `1px solid ${T.border}`,
  background: T.bg,
  color: T.text,
  borderRadius: T.radius,
  padding: '3px 8px',
  font: `${T.uiSize}/1.4 ${T.font}`,
  cursor: 'pointer',
}
const segmentBase = {
  border: 0,
  background: 'transparent',
  color: T.textSecondary,
  borderRadius: 4,
  padding: '3px 8px',
  font: `${T.uiSize}/1.4 ${T.font}`,
  cursor: 'pointer',
}

function Toolbar (props) {
  const {
    layout, pageMode, fontSize, dirty, saving, sourceHash, narrowSplit,
    onLayoutChange, onFontSizeChange, onSave, onReload, onImport, canImport, readOnly,
    filesOpen, onToggleFiles, onQuickOpen, docTitle,
    draftCount, onOpenDrafts, previewStatus, a2Capability, a2Client, a2State, a2HandshakeVersion,
  } = props
  return h('div', {
    style: {
      padding: '4px 8px', borderBottom: `1px solid ${T.border}`,
      display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flex: '0 0 auto',
      background: T.bg, color: T.text, font: `${T.uiSize}/1.4 ${T.font}`,
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
      h('button', {
        type: 'button', onClick: onToggleFiles, 'aria-pressed': filesOpen === true, title: '文件树',
        style: { ...buttonBase, ...(filesOpen === true ? { background: T.bgMuted } : {}) },
      }, '文件'),
      h('button', { type: 'button', onClick: onQuickOpen, title: '快速打开', style: buttonBase }, '快速打开'),
      h('button', {
        type: 'button', onClick: onOpenDrafts, title: '未恢复的本地草稿',
        style: { ...buttonBase, ...(draftCount > 0 ? { borderColor: T.accent, color: T.accent } : {}) },
      }, draftCount > 0 ? `草稿 (${draftCount})` : '草稿'),
      docTitle && h('span', {
        title: docTitle,
        style: {
          color: T.textSecondary, fontSize: T.uiSmallSize,
          maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
      }, docTitle),
      previewStatus && h('span', {
        title: previewStatus.title ?? previewStatus.label,
        style: {
          color: previewStatus.error ? T.error : previewStatus.warning ? T.accent : T.textTertiary, fontSize: T.uiSmallSize,
          border: `1px solid ${previewStatus.error ? T.error : previewStatus.warning ? T.accent : T.border}`, borderRadius: T.radius,
          padding: '0 5px', whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis',
        },
      }, previewStatus.label),
      pageMode && h('span', {
        title: '当前页面不是可编辑文档；默认仅显示预览。手动源码/分栏是临时视图，不写回长期布局。',
        style: {
          color: T.textTertiary, fontSize: T.uiSmallSize,
          border: `1px solid ${T.border}`, borderRadius: T.radius,
          padding: '0 5px', whiteSpace: 'nowrap',
        },
      }, '页面模式'),
    ),
    h('label', {
      title: '编辑器字号',
      style: { display: 'inline-flex', gap: 4, alignItems: 'center', color: T.textTertiary, fontSize: T.uiSmallSize },
    },
      '字号',
      h('select', {
        value: String(fontSize),
        onChange: (event) => onFontSizeChange(Number(event.target.value)),
        style: {
          border: `1px solid ${T.border}`, borderRadius: T.radius,
          background: T.bg, color: T.textSecondary, padding: '2px 4px',
          font: `${T.uiSmallSize}/1.4 ${T.font}`, cursor: 'pointer',
        },
      }, [12, 13, 14, 15, 16].map((size) => h('option', { key: size, value: String(size) }, `${size}px`))),
    ),
    h('span', {
      style: { display: 'inline-flex', gap: 2, marginLeft: 'auto', padding: 2, borderRadius: 6, background: T.bgMuted, border: `1px solid ${T.border}` },
    },
      ['split', 'source', 'preview'].map((mode) => h('button', {
        key: mode, type: 'button', onClick: () => onLayoutChange(mode),
        'aria-pressed': layout === mode,
        style: layout === mode
          ? { ...segmentBase, background: T.bg, color: T.text, boxShadow: '0 0 0 1px ' + T.border }
          : segmentBase,
      }, mode === 'split' ? '分栏' : mode === 'source' ? '源码' : '预览')),
    ),
    narrowSplit && h('span', {
      title: '可用宽度不足 906px，双栏会低于最小宽度；已临时显示源码',
      style: { color: T.textTertiary, fontSize: T.uiSmallSize, whiteSpace: 'nowrap' },
    }, '窗口过窄，临时单栏'),
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
      h('button', {
        type: 'button', onClick: onImport, disabled: canImport !== true,
        title: '导入一张图片为可审阅的 MDX 草稿',
        style: { ...buttonBase, opacity: canImport !== true ? 0.55 : 1 },
      }, '导入'),
      h('button', {
        type: 'button', onClick: onSave, disabled: readOnly === true || !dirty || saving || sourceHash === null,
        title: readOnly === true ? '只读站点，保存已停用' : '保存（⌘S）',
        style: { ...buttonBase, opacity: (readOnly === true || !dirty || saving || sourceHash === null) ? 0.55 : 1 },
      }, saving ? '保存中…' : '保存'),
      h('button', { type: 'button', onClick: onReload, title: '重新加载当前文档', style: buttonBase }, '重载'),
    ),
  )
}

module.exports = { Toolbar }
