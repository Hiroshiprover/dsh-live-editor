/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

function LocationBar ({ text }) {
  if (text === null) return null
  return h('div', {
    style: {
      padding: '5px 10px', borderTop: `1px solid ${T.border}`,
      fontFamily: T.mono, fontSize: T.uiSmallSize, color: T.textSecondary,
      background: T.bg, flex: '0 0 auto',
    },
  }, text)
}

module.exports = { LocationBar }
