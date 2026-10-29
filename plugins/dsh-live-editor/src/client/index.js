/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Docusaurus client module for the DSH Live Editor bridge.
 *
 * Loaded on every page in dev, but the bridge only activates when the page is
 * embedded with `?dshBridge=1&nonce=...`. After an SPA navigation the query is
 * gone; the child keeps the nonce in `window.name` so a full reload at the new
 * route can still re-handshake. In a normal browser tab this module has zero
 * visible side effects.
 */
import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment'
import { createBridge } from './bridge.js'

const PARENT_ORIGIN = 'dsh-app://app'
const NAME_PREFIX = 'dsh-live-editor-nonce:'
const state = { bridge: null }

function readNameNonce() {
  try {
    const value = typeof window.name === 'string' ? window.name : ''
    if (!value.startsWith(NAME_PREFIX)) return null
    const nonce = value.slice(NAME_PREFIX.length)
    return nonce.length > 0 && nonce.length <= 256 ? nonce : null
  } catch {
    return null
  }
}

function writeNameNonce(nonce) {
  try { window.name = `${NAME_PREFIX}${nonce}` } catch { /* storage unavailable */ }
}

function ensureBridge() {
  if (!ExecutionEnvironment.canUseDOM) return null
  if (state.bridge !== null) return state.bridge

  const params = new URLSearchParams(window.location.search)
  const queryNonce = params.get('nonce')
  const storedNonce = readNameNonce()
  const embedded = window.parent !== window
  const queryBridge = params.get('dshBridge') === '1'
  const nonce = typeof queryNonce === 'string' && queryNonce.length > 0
    ? queryNonce
    : (embedded ? storedNonce : null)
  const active = embedded
    && typeof nonce === 'string'
    && nonce.length > 0
    && (queryBridge || (queryNonce === null && storedNonce !== null))

  if (!active) {
    state.bridge = { active: false, api: null }
    return state.bridge
  }

  // The first embedded load has the query; persist it before Docusaurus can
  // replace the URL during SPA navigation.
  if (typeof queryNonce === 'string' && queryNonce.length > 0) writeNameNonce(queryNonce)

  const api = createBridge({ nonce, parentOrigin: PARENT_ORIGIN })
  window.__DSH_LIVE_EDITOR__ = api
  api.start()
  state.bridge = { active: true, api }
  return state.bridge
}

ensureBridge()

export function onRouteUpdate({ location }) {
  const bridge = ensureBridge()
  if (!bridge?.active) return
  bridge.api.onRouteUpdate(location)
}

export function onRouteDidUpdate({ location }) {
  const bridge = ensureBridge()
  if (!bridge?.active) return
  bridge.api.onRouteDidUpdate(location)
}
