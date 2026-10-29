/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const diag = require('../diag.cjs')
const h = React.createElement

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Official DSH modal layer (modal stack + focus trap + Escape + shortcut-service
 * modal detection). Loaded lazily so Node/SSR tests never need the browser
 * module table. If it is unavailable the viewer fails closed (see
 * ReadOnlyViewer) instead of silently falling back to a non-modal shell.
 */
let loadFailureReason = null
function loadModalLayer () {
  try {
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const reactDom = require('react-dom')
    if (primitives && typeof primitives.useModalLayer === 'function'
      && reactDom && typeof reactDom.createPortal === 'function') {
      return { useModalLayer: primitives.useModalLayer, createPortal: reactDom.createPortal }
    }
    loadFailureReason = 'modal-layer-unavailable'
  } catch (error) {
    loadFailureReason = String(error?.message ?? error).slice(0, 160)
  }
  return null
}

const MODAL_ID = 'live-editor-readonly'

function logViewerKey (event) {
  if (event.key === 'Escape' || event.key === 'Tab'
    || ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 's')) {
    diag.log('viewer-key', {
      key: event.key,
      meta: event.metaKey === true,
      ctrl: event.ctrlKey === true,
      shift: event.shiftKey === true,
      target: diag.describeElement(event.target),
      activeElement: diag.activeElementInfo(),
    })
  }
}

function blockSaveShortcut (event) {
  if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 's') {
    event.preventDefault()
    event.stopPropagation()
    return true
  }
  return false
}

function ViewerBody (props) {
  const { view, query, setQuery, copied, copy, onClose, normalizedQuery, matches, mode } = props
  const text = typeof view?.text === 'string' ? view.text : ''
  return h(React.Fragment, null,
    h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
        borderBottom: `1px solid ${T.border}`, flex: '0 0 auto',
      },
    },
      h('strong', { style: { flex: '1 1 220px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        `只读：${view.doc?.title ?? view.doc?.source ?? '实例文档'}`),
      h('input', {
        value: query,
        onChange: (event) => setQuery(event.target.value),
        placeholder: '查找…',
        'aria-label': '在只读源码中查找',
        'data-modal-autofocus': mode === 'official' ? true : undefined,
        style: {
          width: 160, border: `1px solid ${T.border}`, borderRadius: T.radius,
          background: T.bgMuted, color: T.text, padding: '3px 6px',
          font: `${T.uiSmallSize}/1.4 ${T.font}`,
        },
      }),
      normalizedQuery !== '' && h('span', { style: { color: T.textTertiary, fontSize: T.uiSmallSize } }, `${matches} 处`),
      h('button', {
        type: 'button', onClick: copy, disabled: text.length === 0,
        style: { border: `1px solid ${T.border}`, background: T.bg, color: T.textSecondary, borderRadius: T.radius, padding: '2px 8px', cursor: 'pointer' },
      }, copied ? '已复制' : '复制'),
      h('button', {
        type: 'button', onClick: onClose,
        title: '关闭只读查看器，返回编辑器',
        style: { border: 0, background: 'transparent', color: T.textSecondary, cursor: 'pointer', fontSize: 16 },
      }, '×'),
    ),
    view.phase === 'loading' && h('div', { style: { padding: 20, color: T.textSecondary } }, '正在读取只读源码…'),
    view.phase === 'error' && h('div', { role: 'alert', style: { padding: 20, color: T.error } }, view.error ?? '读取失败'),
    view.phase === 'ready' && h('pre', {
      style: {
        flex: '1 1 auto', minHeight: 0, margin: 0, overflow: 'auto', padding: '12px 16px',
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        font: `13px/1.55 ${T.mono ?? T.font}`, background: T.bg, color: T.text,
      },
    }, normalizedQuery === ''
      ? text
      : text.split(new RegExp(`(${escapeRegExp(normalizedQuery)})`, 'gi')).map((part, index) => (
        index % 2 === 1
          ? h('mark', { key: `match:${index}`, style: { background: T.warning, color: T.text } }, part)
          : part
      ))),
  )
}

function useViewerState () {
  const [query, setQuery] = React.useState('')
  const [copied, setCopied] = React.useState(false)
  return { query, setQuery, copied, setCopied }
}

function OfficialViewer ({ modalLayer, view, onClose }) {
  const { useModalLayer, createPortal } = modalLayer
  const { query, setQuery, copied, setCopied } = useViewerState()
  const panelRef = React.useRef(null)
  useModalLayer(panelRef, true, onClose)
  React.useEffect(() => {
    diag.log('viewer-focus', {
      mode: 'official',
      focused: panelRef.current?.contains(document.activeElement) === true,
      activeElement: diag.activeElementInfo(),
    })
  }, [])
  const text = typeof view?.text === 'string' ? view.text : ''
  const normalizedQuery = query.trim()
  const matches = React.useMemo(() => {
    if (normalizedQuery === '' || text === '') return 0
    try { return (text.match(new RegExp(escapeRegExp(normalizedQuery), 'gi')) ?? []).length } catch { return 0 }
  }, [text, normalizedQuery])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch { /* clipboard unavailable */ }
  }
  return createPortal(
    h('div', {
      ref: panelRef,
      role: 'dialog',
      'aria-modal': 'true',
      'data-shortcut-modal': MODAL_ID,
      tabIndex: -1,
      'aria-label': '只读源码查看器',
      onKeyDown: (event) => {
        logViewerKey(event)
        blockSaveShortcut(event)
      },
      style: {
        position: 'fixed', inset: 0, zIndex: 100, display: 'flex', flexDirection: 'column',
        background: T.bg, color: T.text, minHeight: 0,
      },
    },
      h(ViewerBody, {
        view, query, setQuery, copied, copy, onClose, normalizedQuery, matches, mode: 'official',
      }),
    ),
    document.body,
  )
}

function UnavailableViewer ({ reason, onClose }) {
  const closeRef = React.useRef(null)
  React.useEffect(() => {
    closeRef.current?.focus()
    diag.log('viewer-focus', { mode: 'unavailable', reason })
  }, [reason])
  return h('div', {
    role: 'alert',
    'aria-label': '只读源码查看器不可用',
    style: {
      position: 'fixed', inset: 0, zIndex: 100, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24,
      background: T.bg, color: T.text,
    },
  },
    h('strong', null, '只读查看器不可用'),
    h('div', { style: { color: T.textSecondary, maxWidth: 520, textAlign: 'center' } },
      'DSH 官方模态层未能加载，已安全停止打开只读源码。请刷新页面或重启 DSH 后重试。'),
    h('div', { style: { color: T.textTertiary, fontSize: T.uiSmallSize } }, `原因：${reason}`),
    h('button', {
      ref: closeRef,
      type: 'button',
      onClick: onClose,
      style: { border: `1px solid ${T.border}`, background: T.bgMuted, color: T.text, borderRadius: T.radius, padding: '4px 12px', cursor: 'pointer' },
    }, '关闭'),
  )
}

function ReadOnlyViewer (props) {
  const { view, onClose } = props
  const modalLayer = React.useMemo(loadModalLayer, [])
  if (view === null) return null
  // Fail closed: without the official modal layer the viewer must not render
  // source or pretend to be an application-level modal.
  if (modalLayer === null) return h(UnavailableViewer, { reason: loadFailureReason ?? 'unknown', onClose })
  return h(OfficialViewer, { modalLayer, view, onClose })
}

module.exports = { ReadOnlyViewer }
