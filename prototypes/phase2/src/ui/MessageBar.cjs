/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

const FADE_MS = 600

function toneColor (tone) {
  if (tone === 'success') return T.success
  if (tone === 'warning') return T.warning
  if (tone === 'info') return T.text
  return T.error
}

function reduceMotion () {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}

/**
 * One row above the editor. Real errors (save conflict, load failure) stay
 * until resolved and keep the reload action. Transient notices may carry a
 * lifetime: they fade out, then dismiss themselves; every notice also has an
 * explicit close button. Notice identity is noticeId so re-setting the same
 * text restarts the timer.
 */
function MessageBar ({
  error, notice, tone = 'error', noticeId = null, ttlMs = null,
  onDismissNotice, onReloadDisk,
}) {
  const [fading, setFading] = React.useState(false)
  const dismissRef = React.useRef(onDismissNotice)
  dismissRef.current = onDismissNotice

  React.useEffect(() => { if (error) setFading(false) }, [error])
  React.useEffect(() => { setFading(false) }, [notice, noticeId])

  React.useEffect(() => {
    // A real error takes the row over and must stay fully visible. Cancel the
    // notice timers instead of letting a pending fade hide the reload action.
    if (error || !notice || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      setFading(false)
      return undefined
    }
    const fadeMs = reduceMotion() ? 0 : FADE_MS
    const fadeTimer = setTimeout(() => setFading(true), ttlMs)
    const clearTimer = setTimeout(() => {
      if (typeof dismissRef.current === 'function') dismissRef.current()
    }, ttlMs + fadeMs)
    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(clearTimer)
    }
  }, [error, notice, noticeId, ttlMs])

  if (!error && !notice) return null
  const showingNotice = !error && typeof notice === 'string' && notice.length > 0
  const text = error || notice
  const color = error ? T.error : toneColor(tone)
  return h('div', {
    role: 'status',
    style: {
      padding: '5px 10px', fontSize: T.uiSize, color,
      borderBottom: `1px solid ${T.border}`,
      background: error ? 'color-mix(in srgb, ' + T.error + ' 7%, ' + T.bg + ')' : T.bg,
      flex: '0 0 auto', display: 'flex', gap: 8, alignItems: 'center',
      opacity: error ? 1 : (fading ? 0 : 1),
      transition: `opacity ${FADE_MS}ms ease`,
    },
  },
    h('span', { style: { flex: '1 1 auto' } }, text),
    showingNotice && typeof onDismissNotice === 'function' && h('button', {
      type: 'button', onClick: onDismissNotice, 'aria-label': '关闭提示', title: '关闭提示',
      style: {
        border: 0, background: 'transparent', color: T.textTertiary, cursor: 'pointer',
        fontSize: 14, lineHeight: 1, padding: '0 2px',
      },
    }, '×'),
    error && onReloadDisk && h('button', {
      type: 'button', onClick: onReloadDisk,
      style: { border: `1px solid ${T.border}`, background: T.bg, color: T.text, borderRadius: T.radius, padding: '2px 6px', cursor: 'pointer' },
    }, '重新加载磁盘版本'),
  )
}

module.exports = { MessageBar }
