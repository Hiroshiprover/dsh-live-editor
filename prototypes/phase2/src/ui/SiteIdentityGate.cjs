/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

const buttonStyle = {
  border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.bg,
  color: T.text, padding: '4px 10px', cursor: 'pointer',
  font: `${T.uiSmallSize}/1.4 ${T.font}`,
}

/**
 * Gate the editor body on a confirmed site identity. Drafts, history and
 * import results are namespaced by that identity, so creating a store before
 * it is known would risk reading another site's data under a fallback id.
 * A failed identity check must offer retry and must never fall back to a
 * hard-coded site id.
 */
function SiteIdentityGate ({ loadSite, renderBody }) {
  const [state, setState] = React.useState({ status: 'loading', site: null, error: null })

  const load = React.useCallback(() => {
    setState({ status: 'loading', site: null, error: null })
    Promise.resolve()
      .then(() => loadSite())
      .then((site) => {
        if (!site || typeof site.siteId !== 'string' || site.siteId.length === 0) {
          throw new Error('站点身份无效')
        }
        setState({ status: 'ready', site, error: null })
      })
      .catch((error) => {
        setState({ status: 'error', site: null, error: String(error?.message ?? error) })
      })
  }, [loadSite])

  React.useEffect(() => { load() }, [load])

  if (state.status === 'ready') return renderBody(state.site)

  const shellStyle = {
    display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start',
    padding: 20, font: `${T.uiSize}/1.5 ${T.font}`, color: T.text, background: T.bg,
    borderBottom: `1px solid ${T.border}`,
  }
  if (state.status === 'error') {
    return h('div', { style: shellStyle },
      h('strong', null, '无法确认当前站点身份'),
      h('span', { style: { color: T.error, fontSize: T.uiSmallSize } }, state.error ?? '未知错误'),
      h('span', { style: { color: T.textTertiary, fontSize: T.uiSmallSize } },
        '草稿尚未加载；修复连接后重试。不会以固定站点身份回退。'),
      h('button', { type: 'button', onClick: load, style: buttonStyle }, '重试'),
    )
  }
  return h('div', { style: shellStyle },
    h('span', { style: { color: T.textTertiary } }, '正在确认站点身份…'),
  )
}

module.exports = { SiteIdentityGate }
