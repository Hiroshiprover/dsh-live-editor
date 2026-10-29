/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

function QuickOpen ({ open, docs, onClose, onSelect }) {
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)
  const inputRef = React.useRef(null)

  React.useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    const id = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [open])

  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q === ''
      ? docs
      : docs.filter((doc) => `${doc.title ?? ''} ${doc.path} ${doc.docId ?? ''}`.toLowerCase().includes(q))
    return list.slice(0, 40)
  }, [docs, query])

  React.useEffect(() => {
    if (active >= results.length) setActive(0)
  }, [results.length, active])

  if (!open) return null

  const choose = (index) => {
    const doc = results[index]
    if (doc) onSelect(doc.path)
  }

  return h('div', {
    role: 'presentation',
    onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
    style: {
      position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.32)',
      display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh',
    },
  },
  h('div', {
    role: 'dialog', 'aria-label': '快速打开',
    style: {
      width: 'min(560px, 90vw)', maxHeight: '60vh', display: 'flex', flexDirection: 'column',
      background: T.bg, color: T.text, border: `1px solid ${T.border}`,
      borderRadius: 8, boxShadow: '0 18px 48px rgba(0,0,0,0.35)', overflow: 'hidden',
    },
  },
    h('input', {
      ref: inputRef,
      value: query,
      onChange: (event) => { setQuery(event.target.value); setActive(0) },
      onKeyDown: (event) => {
        if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(results.length - 1, value + 1)); return }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); return }
        if (event.key === 'Enter') { event.preventDefault(); choose(active) }
      },
      placeholder: '打开文件…（标题 / 路径 / docId）',
      'aria-label': '快速打开文件',
      style: {
        border: 0, borderBottom: `1px solid ${T.border}`, background: T.bg, color: T.text,
        padding: '10px 12px', font: `${T.uiSize}/1.5 ${T.font}`, outline: 'none',
      },
    }),
    h('div', { style: { overflow: 'auto', padding: '4px 0' } },
      results.length === 0 && h('div', { style: { padding: '10px 12px', color: T.textTertiary, fontSize: T.uiSmallSize } }, '没有匹配的文件'),
      results.map((doc, index) => h('button', {
        key: doc.path,
        type: 'button',
        onMouseEnter: () => setActive(index),
        onClick: () => choose(index),
        style: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          border: 0, cursor: 'pointer',
          background: index === active ? T.bgMuted : 'transparent',
          color: T.text, padding: '5px 12px', font: `${T.uiSmallSize}/1.5 ${T.font}`,
        },
      },
        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, doc.title ?? doc.name),
        h('span', { style: { color: T.textTertiary, fontFamily: T.mono, fontSize: T.uiSmallSize, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, doc.path),
      ))
    ),
  ))
}

module.exports = { QuickOpen }
