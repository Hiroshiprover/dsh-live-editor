/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * v2 iframe bridge for the DSH Live Editor.
 *
 * v2 adds a navigation protocol on top of the v1 security invariants:
 *   - hello/ready/ready-ack carry bootId; ready-ack also carries docMap,
 *     locale, routeBasePath and sidebars;
 *   - route-state is authoritative after a committed client route;
 *   - doc is an early DocItem-published identity update;
 *   - nav-intent lets the parent veto a preview link before it navigates;
 *   - navigate asks the child to perform an SPA push (or a full-load fallback).
 *
 * Security invariants (kept from Phase 0B/1A):
 *   - only messages from `parentOrigin` and `event.source === window.parent`;
 *   - every message carries { source, v=2, nonce } and is validated;
 *   - payload fields are type/length checked by the parent as well.
 *
 * Activation: only when embedded (`window.parent !== window`) and the iframe
 * has a `?dshBridge=1&nonce=...` query, or a nonce persisted in `window.name`
 * by a previous bridge activation (SPA reload after losing the query).
 */

const SOURCE = 'dsh-live-editor-bridge'
const VERSION = 2
const HELLO_INTERVAL_MS = 1000
const HELLO_FIRST_DELAY_MS = 150
const HELLO_MAX_TRIES = 60
const ASSET_TARGET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|pdf|mp4|webm|mp3|zip|json|csv|ipynb|txt|ya?ml)$/i

const normalizePath = (value) => {
  if (typeof value !== 'string') return ''
  const trimmed = value.replace(/\/+$/, '')
  return trimmed === '' ? '/' : `${trimmed}/`
}

const newId = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

const isString = (value) => typeof value === 'string'
const now = () => Date.now()

function normalizeDocSource(value, preview = false) {
  if (typeof value !== 'string') return value
  let text = value.replaceAll('\\', '/').trim()
  if (text.startsWith('@site/')) text = text.slice('@site/'.length)
  if (text.length === 0 || text.startsWith('/') || text.split('/').some((part) => part === '..' || part === '.')) return ''
  // Keep the explicit legacy staging projection; never trim a nested
  // proj/docs/... path into the default docs identity.
  if (preview === true) {
    const docs = text.indexOf('docs/')
    if (docs >= 0) return text.slice(docs)
  }
  return text
}

function docFields(doc) {
  if (!doc || typeof doc !== 'object') return null
  const source = normalizeDocSource(doc.source, doc.preview === true)
  if (!isString(source) || source.length === 0) return null
  if (!isString(doc.permalink) || doc.permalink.length === 0) return null
  return {
    source,
    docId: isString(doc.docId) ? doc.docId : null,
    permalink: doc.permalink,
    title: isString(doc.title) ? doc.title : null,
    locale: isString(doc.locale) ? doc.locale : null,
    sidebarPosition: typeof doc.sidebarPosition === 'number' ? doc.sidebarPosition : null,
    sidebarLabel: isString(doc.sidebarLabel) ? doc.sidebarLabel : null,
    routeBasePath: isString(doc.routeBasePath) ? doc.routeBasePath : null,
    instanceId: isString(doc.instanceId) ? doc.instanceId : null,
    versionName: isString(doc.versionName) ? doc.versionName : null,
    sourceRoot: isString(doc.sourceRoot) ? doc.sourceRoot : null,
    preview: doc.preview === true,
    previewInstanceReady: doc.previewInstanceReady === true,
    previewSession: isString(doc.previewSession) ? doc.previewSession : null,
    previewRevision: Number.isSafeInteger(doc.previewRevision) ? doc.previewRevision : null,
  }
}

function sameDoc(left, right) {
  return left !== null && right !== null
    && left.source === right.source
    && normalizePath(left.permalink) === normalizePath(right.permalink)
}

export function createBridge({ nonce, parentOrigin }) {
  const bootId = newId()
  const state = {
    nonce,
    parentOrigin,
    bootId,
    ready: false,
    started: false,
    current: null,
    map: [],
    mapSerialized: '',
    sidebars: null,
    sidebarsSerialized: '',
    navigate: null,
    locale: null,
    routeBasePath: '/docs',
    baseUrl: '/',
    guardDirty: false,
    pendingNavId: null,
    helloTimer: null,
    helloTries: 0,
    routeTimer: null,
    lastRouteKey: '',
    startAt: now(),
  }

  const send = (payload) => {
    try {
      window.parent.postMessage({ source: SOURCE, v: VERSION, nonce, bootId, ...payload }, parentOrigin)
    } catch (error) {
      console.warn('[dsh-live-editor] postMessage failed', error)
    }
  }

  const stopHello = () => {
    if (state.helloTimer !== null) {
      clearInterval(state.helloTimer)
      state.helloTimer = null
    }
  }

  const hello = () => {
    if (state.ready) return
    state.helloTries += 1
    send({
      type: 'hello',
      permalink: window.location.pathname,
      pathname: window.location.pathname,
      href: window.location.href,
      title: document.title,
      doc: docFields(state.current),
      locale: state.locale,
      routeBasePath: state.routeBasePath,
      timeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : null,
    })
    if (state.helloTries >= HELLO_MAX_TRIES) stopHello()
  }

  const startHello = () => {
    if (state.ready || state.helloTimer !== null) return
    setTimeout(() => {
      hello()
      if (state.ready || state.helloTimer !== null) return
      state.helloTimer = setInterval(hello, HELLO_INTERVAL_MS)
    }, HELLO_FIRST_DELAY_MS)
  }

  const sendDoc = () => {
    const doc = docFields(state.current)
    if (doc === null) return
    send({ type: 'doc', doc, pathname: window.location.pathname, timeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : null })
  }

  const sendDocMap = () => {
    send({
      type: 'doc-map',
      docMap: state.map,
      locale: state.locale,
      routeBasePath: state.routeBasePath,
      baseUrl: state.baseUrl,
      timeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : null,
    })
  }

  const findMappedDoc = (pathname) => {
    const normalized = normalizePath(pathname)
    return state.map.find((doc) => isString(doc.permalink) && normalizePath(doc.permalink) === normalized) ?? null
  }

  const sendRouteState = (location) => {
    if (!state.ready) return
    const pathname = isString(location?.pathname) ? location.pathname : window.location.pathname
    const href = isString(location?.href) ? location.href : window.location.href
    const currentMatches = state.current !== null
      && normalizePath(state.current.permalink) === normalizePath(pathname)
    const current = currentMatches ? state.current : null
    const mapped = current === null ? findMappedDoc(pathname) : null
    const doc = docFields(current ?? mapped)
    const navId = state.pendingNavId
    state.pendingNavId = null
    const key = `${pathname}|${doc?.source ?? ''}|${navId ?? ''}`
    if (key === state.lastRouteKey) return
    state.lastRouteKey = key
    send({
      type: 'route-state',
      href,
      pathname,
      doc,
      bootId,
      navId,
      ts: now(),
      title: document.title,
      timeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : null,
    })
  }

  const scheduleRouteState = (location) => {
    if (!state.ready) return
    if (state.routeTimer !== null) clearTimeout(state.routeTimer)
    state.routeTimer = setTimeout(() => {
      state.routeTimer = null
      sendRouteState(location)
    }, 50)
  }

  const publishDoc = (doc) => {
    if (!doc || typeof doc !== 'object') return
    let mapChanged = false
    if (Array.isArray(doc.docs)) {
      const docs = doc.docs.map((entry) => (
        entry && typeof entry === 'object' && isString(entry.source)
          ? { ...entry, source: normalizeDocSource(entry.source) }
          : entry
      ))
      const serialized = JSON.stringify(docs)
      if (serialized !== state.mapSerialized) {
        state.map = docs
        state.mapSerialized = serialized
        mapChanged = true
      }
    }
    if (isString(doc.locale)) state.locale = doc.locale
    if (isString(doc.routeBasePath)) state.routeBasePath = doc.routeBasePath
    if (isString(doc.baseUrl)) state.baseUrl = doc.baseUrl
    if (typeof doc.navigate === 'function') state.navigate = doc.navigate
    if (state.ready && mapChanged) sendDocMap()

    let sidebarsChanged = false
    if (doc.sidebars && typeof doc.sidebars === 'object') {
      const serialized = JSON.stringify(doc.sidebars)
      sidebarsChanged = serialized !== state.sidebarsSerialized
      if (sidebarsChanged) {
        state.sidebars = doc.sidebars
        state.sidebarsSerialized = serialized
      }
    }

    const next = docFields(doc)
    if (next !== null) {
      const changed = !sameDoc(state.current, next)
        || state.current?.previewSession !== next.previewSession
        || state.current?.previewRevision !== next.previewRevision
        || state.current?.preview !== next.preview
        || state.current?.routeBasePath !== next.routeBasePath
        || state.current?.previewInstanceReady !== next.previewInstanceReady
      state.current = next
      if (state.ready && changed) sendDoc()
    }
    if (state.ready && sidebarsChanged) {
      send({
        type: 'sidebars',
        sidebars: state.sidebars,
        generatedAt: state.sidebars?.generatedAt ?? null,
        timeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : null,
      })
    }
  }

  const revealLine = (line) => {
    const target = Number(line)
    if (!Number.isInteger(target) || target < 1) return
    const blocks = [...document.querySelectorAll('[data-dsh-src-line]')]
      .map((el) => ({
        el,
        start: Number(el.getAttribute('data-dsh-src-line')),
        end: Number(el.getAttribute('data-dsh-src-end')) || Number(el.getAttribute('data-dsh-src-line')),
      }))
      .filter((item) => Number.isFinite(item.start))
      .sort((a, b) => a.start - b.start)
    if (blocks.length === 0) return
    const hit = blocks.filter((item) => item.start <= target).pop() ?? blocks[0]
    const rect = hit.el.getBoundingClientRect()
    const scroller = document.scrollingElement ?? document.documentElement
    const top = Math.max(0, scroller.scrollTop + rect.top - window.innerHeight * 0.25)
    window.scrollTo({ top, behavior: 'auto' })
  }

  const applyTheme = (theme) => {
    const next = theme === 'dark' ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', next)
  }

  const linkFromEvent = (event) => {
    if (event.defaultPrevented || event.button !== 0) return null
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null
    const target = event.target
    const anchor = target instanceof Element ? target.closest('a[href]') : null
    if (anchor === null) return null
    if (anchor.target && anchor.target !== '_self') return null
    if (anchor.hasAttribute('download')) return null
    let url
    try { url = new URL(anchor.href, window.location.href) } catch { return null }
    if (url.origin !== window.location.origin) return null
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return null
    if (ASSET_TARGET.test(url.pathname)) return null
    return { anchor, url }
  }

  const onMessage = (event) => {
    if (event.origin !== state.parentOrigin) return
    if (event.source !== window.parent) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.source !== SOURCE || data.v !== VERSION || data.nonce !== state.nonce) return

    if (data.type === 'ready') {
      if (state.ready) return
      state.ready = true
      stopHello()
      send({
        type: 'ready-ack',
        doc: docFields(state.current),
        docMap: state.map,
        sidebars: state.sidebars,
        locale: state.locale,
        routeBasePath: state.routeBasePath,
        baseUrl: state.baseUrl,
        bootId,
        timeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : null,
      })
      if (state.current !== null) sendDoc()
      scheduleRouteState()
      return
    }
    if (!state.ready) return
    if (data.type === 'theme') applyTheme(data.theme)
    else if (data.type === 'reveal-line') revealLine(data.line)
    else if (data.type === 'guard') state.guardDirty = data.dirty === true
    else if (data.type === 'navigate') {
      if (!isString(data.href) || data.href.length === 0 || data.href.length > 4096) return
      let url
      try { url = new URL(data.href, window.location.href) } catch { return }
      if (url.origin !== window.location.origin) return
      state.pendingNavId = isString(data.navId) ? data.navId : null
      const target = `${url.pathname}${url.search}${url.hash}`
      if (typeof state.navigate === 'function') {
        try {
          state.navigate(target)
          return
        } catch (error) {
          console.warn('[dsh-live-editor] SPA navigate failed; falling back to a full load', error)
        }
      }
      window.location.assign(target)
    }
  }

  const onClickCapture = (event) => {
    if (!state.ready) return
    const link = linkFromEvent(event)
    if (link !== null) {
      event.preventDefault()
      event.stopPropagation()
      send({
        type: 'nav-intent',
        kind: 'link',
        href: link.url.href,
        pathname: link.url.pathname,
        timeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : null,
      })
      return
    }

    const target = event.target
    const el = target instanceof Element ? target.closest('[data-dsh-src-line]') : null
    if (el === null) return
    const line = Number(el.getAttribute('data-dsh-src-line'))
    const endLine = Number(el.getAttribute('data-dsh-src-end')) || line
    if (!Number.isFinite(line) || line < 1) return
    if (!state.current?.source) return
    send({
      type: 'block-click',
      line,
      endLine,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      permalink: window.location.pathname,
      docSource: state.current.source,
      exact: target === el,
    })
  }

  const start = () => {
    if (state.started) return
    state.started = true
    console.info('[dsh-live-editor] bridge active', {
      href: window.location.href,
      bootId,
      timeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : null,
    })
    window.addEventListener('pageshow', (event) => {
      console.info('[dsh-live-editor][diag] iframe pageshow', {
        href: window.location.href, bootId, persisted: event.persisted === true,
        t: performance.now(),
      })
    })
    window.addEventListener('pagehide', (event) => {
      console.info('[dsh-live-editor][diag] iframe pagehide', {
        href: window.location.href, bootId, persisted: event.persisted === true,
        t: performance.now(),
      })
    })
    window.addEventListener('beforeunload', () => {
      console.info('[dsh-live-editor][diag] iframe beforeunload', {
        href: window.location.href, bootId, t: performance.now(),
      })
    })
    window.addEventListener('message', onMessage)

    document.addEventListener('click', onClickCapture, true)
    startHello()
  }

  const onRouteUpdate = (location) => {
    void location
  }

  const onRouteDidUpdate = (location) => {
    scheduleRouteState(location)
  }

  const api = {
    get ready() { return state.ready },
    get bootId() { return bootId },
    get current() { return state.current },
    get map() { return state.map },
    publishDoc,
    start,
    onRouteUpdate,
    onRouteDidUpdate,
  }

  api.snapshot = () => ({
    ready: state.ready,
    current: state.current,
    map: state.map,
    locale: state.locale,
    routeBasePath: state.routeBasePath,
    preview: state.current?.preview === true,
  })

  return api
}
