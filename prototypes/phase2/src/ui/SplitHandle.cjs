/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

function SplitHandle ({ onPointerDown, onDoubleClick }) {
  return h('div', {
    role: 'separator',
    'aria-orientation': 'vertical',
    title: '拖动调整分栏比例；双击恢复 55/45',
    onPointerDown,
    onDoubleClick,
    style: {
      flex: '0 0 6px', width: 6, cursor: 'col-resize',
      background: 'transparent', position: 'relative', zIndex: 2,
      touchAction: 'none',
    },
  },
    h('div', {
      style: {
        position: 'absolute', top: 0, bottom: 0, left: '50%',
        width: 1, background: T.border, transform: 'translateX(-0.5px)',
        pointerEvents: 'none',
      },
    }),
  )
}

module.exports = { SplitHandle }
