/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { EditorState } = require('@codemirror/state')
const { EditorView, lineNumbers, keymap } = require('@codemirror/view')
const { history, historyKeymap, isolateHistory } = require('@codemirror/commands')
const { markdown } = require('@codemirror/lang-markdown')
const { HighlightStyle, syntaxHighlighting, ensureSyntaxTree } = require('@codemirror/language')
const { tags } = require('@lezer/highlight')
const { mdxBlockDecorations } = require('./editor-decorations.cjs')
const { Toolbar } = require('./ui/Toolbar.cjs')
const { MessageBar } = require('./ui/MessageBar.cjs')
const { SourcePane } = require('./ui/SourcePane.cjs')
const { PreviewPane } = require('./ui/PreviewPane.cjs')
const { StatusBar } = require('./ui/StatusBar.cjs')
const { SplitHandle } = require('./ui/SplitHandle.cjs')
const { FilePanel } = require('./ui/FilePanel.cjs')
const { ReadOnlyViewer } = require('./ui/ReadOnlyViewer.cjs')
const { QuickOpen } = require('./ui/QuickOpen.cjs')
const { ConfirmBar } = require('./ui/ConfirmBar.cjs')
const { RecoveryBar } = require('./ui/RecoveryBar.cjs')
const { ConflictBar } = require('./ui/ConflictBar.cjs')
const { HistoryDialog } = require('./ui/HistoryDialog.cjs')
const { DraftsPanel } = require('./ui/DraftsPanel.cjs')
const { ImportPanel } = require('./ui/ImportPanel.cjs')
const { SiteIdentityGate } = require('./ui/SiteIdentityGate.cjs')
const { importTaskKey } = require('./state/site-identity.cjs')
const { createDraftStore } = require('./state/draft-store.mjs')
const { T } = require('./ui/tokens.cjs')
const { createDocStore, normalizePath, normalizeSource } = require('./state/doc-store.mjs')
const { buildImportInsertion, endsInOpenFence } = require('./state/import-insert.mjs')
const { createR2ParentController, A2_HANDSHAKE_VERSION, R2_SOURCE: R2_PARENT_SOURCE, R2_VERSION: R2_PARENT_VERSION } = require('./state/r2-parent.mjs')
const { createPreviewScheduler, createPreviewWriter, isPreviewSchedulerEnabled } = require('./state/preview-scheduler.mjs')
const { decidePreviewWrite } = require('./state/preview-gate.mjs')
const { decideStructuralSync } = require('./state/structural-sync.mjs')
const { buildSidebarTree } = require('./state/sidebar-tree.mjs')
const { findLinkAt, resolveLinkTarget } = require('./state/link-resolver.cjs')
const { acquireViewer, releaseViewer, isViewerActive, currentViewerOwner } = require('./state/viewer-owner.mjs')
const diag = require('./diag.cjs')

const h = React.createElement
const ID = 'dsh-live-editor-phase2'
const KIND = 'live-editor-phase2'
const SOURCE = 'dsh-live-editor-bridge'
const VERSION = 2
const CHILD_ORIGIN = 'http://localhost:3000'
const PREVIEW_API = '/api/live-editor/preview'
const PREVIEW_ACK_API = '/api/live-editor/preview/ack'
const PREVIEW_RECOVER_API = '/api/live-editor/preview/recover'
const PREVIEW_DEBOUNCE_MS = 250
const PREVIEW_ACK_TIMEOUT_MS = 1800
// The first write after a document switch races the new iframe's channel
// install; allow extra time for the hello reissue before declaring failure.
const PREVIEW_ACK_TIMEOUT_MS_NAV = 4000
const R2_ENABLED = () => typeof window !== 'undefined' && window.__DSH_LIVE_EDITOR_R2__?.active === true
const SCHEDULER_ENABLED = () => isPreviewSchedulerEnabled(window)
const SENTINEL_ENABLED = () => R2_ENABLED() && window.__DSH_LIVE_EDITOR_R2__?.sentinel === true
// Dev-only A2 experiment switch: open the DSH GUI with ?a2=1. It enables the
// DOM-confirmed preview ack; the formal R2 gate stays false and 250ms remains.
if (typeof window !== 'undefined' && typeof window.location !== 'undefined'
  && new URLSearchParams(window.location.search).get('a2') === '1') {
  window.__DSH_LIVE_EDITOR_R2__ = { active: true, sentinel: false, experiment: true }
}
const LAST_PATH_KEY = 'live-editor:last-path'
const FILES_PINNED_KEY = 'live-editor:files-pinned'
const SIDEBAR_PAYLOAD_KEY = 'live-editor:sidebar-payload:v1'
const TAB_ID_KEY = 'live-editor:tab-id'
const HISTORY_INTERVAL_KEY = 'live-editor:history-interval'
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'table', 'blockquote', 'li', 'div'])
const quickOpenByRoot = new WeakMap()
const quickOpenByTab = new Map()

// DSH in-app tabs share one window (verified 2026-10-25), and only the active
// tab body is mounted. Open-tab identity therefore comes from DSH's own
// `sidebarRight.openTabs` inventory, not from mount state: an inactive but
// still-open tab must keep its draft out of another tab's recovery bar.
// Tab ids are per Session (`tab3`, `tab5`, ...), so key by session as well.
const openTabIds = new Map()
const isTabLiveInSession = (sessionId, id) => {
  if (typeof sessionId !== 'string' || typeof id !== 'string') return false
  const ids = openTabIds.get(sessionId)
  return ids instanceof Set && ids.has(id)
}

const newNonce = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
const isString = (v) => typeof v === 'string'
const isPermalink = (v) => isString(v) && /^\/(en\/)?(docs|__live-preview)\//.test(v)

function validateBase (data, nonce) {
  return data && typeof data === 'object'
    && data.source === SOURCE
    && data.v === VERSION
    && data.nonce === nonce
}

const editorHighlight = HighlightStyle.define([
  { tag: [tags.heading1, tags.heading2], fontWeight: '700', color: T.heading },
  { tag: [tags.heading3, tags.heading4], fontWeight: '600', color: T.heading },
  { tag: tags.quote, color: T.textSecondary, fontStyle: 'italic' },
  { tag: tags.meta, color: T.textTertiary },
  { tag: tags.list, color: T.textSecondary },
  { tag: tags.contentSeparator, color: T.textTertiary },
])

const editorTheme = EditorView.theme({
  '&': {
    height: '100%', fontSize: T.codeSize, fontFamily: T.mono,
    color: T.text, backgroundColor: T.bg,
  },
  '.cm-scroller': { overflow: 'auto', lineHeight: T.codeLineHeight, fontFamily: 'inherit' },
  '.cm-content': { padding: '12px 0', caretColor: T.accent },
  '.cm-line': { padding: '0 10px' },
  '.cm-gutters': {
    backgroundColor: T.bg, color: T.textTertiary, border: 'none',
    paddingLeft: '4px', minWidth: '34px',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 4px' },
  '.cm-activeLine': { backgroundColor: T.bgMuted },
  '.cm-activeLineGutter': { backgroundColor: T.bgMuted, color: T.textSecondary },
  '.cm-selectionBackground, ::selection': { backgroundColor: T.selection },
  '.cm-cursor': { borderLeftColor: T.accent },
  '.cm-le-frontmatter': { color: T.textTertiary },
  '.cm-le-codeblock': { backgroundColor: T.bgMuted },
  '.cm-le-mathblock': { color: T.text, backgroundColor: T.mathBg, paddingLeft: '1.6em', textIndent: '-1.6em' },
  '.cm-le-math-inline, .cm-le-math-source': { color: T.text },
  '.cm-le-math-inline *, .cm-le-math-source *': { color: 'inherit !important', fontStyle: 'normal !important', textDecoration: 'none !important' },
  '.cm-le-math-inline .cm-le-latex-structure, .cm-le-math-source .cm-le-latex-structure': { color: T.math + ' !important', fontWeight: '600' },
  '.cm-le-math-inline .cm-le-latex-env, .cm-le-math-source .cm-le-latex-env': { color: T.heading + ' !important' },
  '.cm-le-math-inline .cm-le-latex-operator, .cm-le-math-source .cm-le-latex-operator': { color: T.text + ' !important' },
  '.cm-le-math-inline .cm-le-latex-symbol, .cm-le-math-source .cm-le-latex-symbol': { color: T.text + ' !important' },
  '.cm-le-math-inline .cm-le-latex-special, .cm-le-math-source .cm-le-latex-special': { color: T.special + ' !important', fontWeight: '600' },
  '.cm-le-math-inline .cm-le-latex-function, .cm-le-math-source .cm-le-latex-function': { color: T.fn + ' !important', fontWeight: '600' },
  '.cm-le-math-inline .cm-le-latex-delimiter, .cm-le-math-source .cm-le-latex-delimiter, .cm-le-math-inline .cm-le-math-delimiter, .cm-le-math-source .cm-le-math-delimiter': { color: T.textTertiary + ' !important' },
  '.cm-le-md-code': { fontFamily: T.mono, color: T.textSecondary, background: T.bgMuted },
  '.cm-le-md-link': { color: T.accent, textDecoration: 'underline' },
  '.cm-le-md-strong': { fontWeight: '650' },
  '.cm-le-md-emphasis': { fontStyle: 'italic' },
  '.cm-le-comment': { color: T.textTertiary, fontStyle: 'italic' },
  '.cm-le-admonition': { backgroundColor: 'color-mix(in srgb, ' + T.accent + ' 6%, transparent)' },
  '.cm-le-latex': { color: T.latex, fontWeight: '550' },
})

const MIN_SOURCE = 420
const MIN_PREVIEW = 480
const DIVIDER = 6
const SPLIT_MIN = MIN_SOURCE + MIN_PREVIEW + DIVIDER

function readStoredLayout () {
  try {
    const value = localStorage.getItem('live-editor:layout')
    if (value === 'split' || value === 'source' || value === 'preview') return value
  } catch { /* storage unavailable */ }
  return 'split'
}

function readStoredRatio () {
  try {
    const value = Number(localStorage.getItem('live-editor:split-ratio'))
    if (Number.isFinite(value) && value > 0 && value < 1) return value
  } catch { /* storage unavailable */ }
  return 0.55
}

function readStoredFontSize () {
  try {
    const value = Number(localStorage.getItem('live-editor:font-size'))
    if (Number.isFinite(value) && value >= 12 && value <= 16) return value
  } catch { /* storage unavailable */ }
  return 13
}

function readStoredLastPath () {
  try {
    const value = localStorage.getItem(LAST_PATH_KEY)
    if (isString(value) && value.length > 0 && !value.startsWith('/')
      && !value.includes('..') && /\.mdx?$/i.test(value)) return value
  } catch { /* storage unavailable */ }
  return null
}

function readStoredFilesPinned () {
  try { return localStorage.getItem(FILES_PINNED_KEY) === '1' } catch { return false }
}

function readStoredSidebarPayload () {
  try {
    const raw = localStorage.getItem(SIDEBAR_PAYLOAD_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    if (!Array.isArray(parsed) && (parsed.trees === null || typeof parsed.trees !== 'object')) return null
    return parsed
  } catch { return null }
}

function writeStoredSidebarPayload (payload) {
  try { localStorage.setItem(SIDEBAR_PAYLOAD_KEY, JSON.stringify(payload)) } catch { /* quota/unavailable */ }
}

function getTabId () {
  try {
    const existing = sessionStorage.getItem(TAB_ID_KEY)
    if (isString(existing) && existing.length > 0) return existing
    const next = newNonce()
    sessionStorage.setItem(TAB_ID_KEY, next)
    return next
  } catch {
    return newNonce()
  }
}

function readStoredHistoryInterval () {
  try {
    const raw = localStorage.getItem(HISTORY_INTERVAL_KEY)
    if (raw === '30000' || raw === '60000' || raw === '300000') return Number(raw)
  } catch { /* storage unavailable */ }
  return 60000
}

function clampSplitRatio (ratio, usableWidth) {
  if (!Number.isFinite(usableWidth) || usableWidth <= 0) return 0.55
  const min = MIN_SOURCE / usableWidth
  const max = 1 - MIN_PREVIEW / usableWidth
  if (min >= max) return 0.55
  return Math.min(max, Math.max(min, ratio))
}

function useStoreSnapshot (store) {
  // Avoid depending on React 18's useSyncExternalStore: DSH's bundled React
  // version is an external contract we do not control. A plain subscription
  // is sufficient for this single-threaded tab UI.
  const [snapshot, setSnapshot] = React.useState(store.getSnapshot())
  React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store])
  return snapshot
}

function LiveEditorBody (props) {
  const siteId = props?.siteIdentity?.siteId
  const siteWritable = props?.siteIdentity?.writable !== false
  const tabInfo = typeof props?.useTabInfo === 'function' ? props.useTabInfo() : null
  const tabId = tabInfo?.tab?.id ?? null
  const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
  const storeRef = React.useRef(null)
  const draftRef = React.useRef(null)
  // Each DSH tab has its own stable record id (tab3, tab5, ...) even though all
  // in-app tabs share one window and one sessionStorage. Using the shared
  // sessionStorage id here made two Live Editor tabs read and write the same
  // draft; switching tabs then looked like the other tab had "taken over" the
  // document and the first tab's text was gone. Scope the draft to the tab.
  const tabDraftId = typeof tabInfo?.tab?.id === 'string' && tabInfo.tab.id.length > 0
    ? tabInfo.tab.id
    : getTabId()
  if (draftRef.current === null) {
    draftRef.current = createDraftStore({ siteId, tabId: tabDraftId, sessionId })
  }
  if (storeRef.current === null) {
    storeRef.current = createDocStore({
      draftSiteId: siteId,
      draftTabId: draftRef.current.tabId,
      draftSessionId: sessionId,
      isTabLive: (id) => isTabLiveInSession(sessionId, id),
      historyIntervalMs: readStoredHistoryInterval(),
    })
  }
  const store = storeRef.current
  const snap = useStoreSnapshot(store)
  React.useEffect(() => {
    if (siteWritable) return
    store.setNotice('当前站点为只读镜像；保存已停用', { tone: 'warning' })
  }, [siteWritable, store])

  const [layout, setLayout] = React.useState(readStoredLayout)
  const [pageModeView, setPageModeView] = React.useState(null)
  const [sitePreviewReady, setSitePreviewReady] = React.useState(null)
  const [splitRatio, setSplitRatio] = React.useState(readStoredRatio)
  const [workspaceWidth, setWorkspaceWidth] = React.useState(0)
  const [dragging, setDragging] = React.useState(false)
  const [cursor, setCursor] = React.useState({ line: 1, column: 1 })
  const [fontSize, setFontSize] = React.useState(readStoredFontSize)
  const [darkTheme, setDarkTheme] = React.useState(() => document.body.hasAttribute('data-ds-dark-theme'))
  const [nonce, setNonce] = React.useState(newNonce)
  const [attempt, setAttempt] = React.useState(0)
  const [iframeUrl, setIframeUrl] = React.useState(null)
  const [previewState, setPreviewState] = React.useState({ phase: 'idle', session: null, source: null, revision: 0, error: null })
  const [structuralPending, setStructuralPending] = React.useState(false)
  const structuralPendingRef = React.useRef(false)
  structuralPendingRef.current = structuralPending
  const previewStateRef = React.useRef(previewState)
  previewStateRef.current = previewState
  const [status, setStatus] = React.useState('handshaking')
  const [serverOnline, setServerOnline] = React.useState(null)
  const [filesOpen, setFilesOpen] = React.useState(false)
  const [filesPinned, setFilesPinned] = React.useState(readStoredFilesPinned)
  const [quickOpen, setQuickOpen] = React.useState(false)
  const [sidebarPayload, setSidebarPayload] = React.useState(readStoredSidebarPayload)
  const rememberSidebarPayload = React.useCallback((payload) => {
    if (payload === null || typeof payload !== 'object') return
    setSidebarPayload(payload)
    writeStoredSidebarPayload(payload)
  }, [])
  const [discoveredInstances, setDiscoveredInstances] = React.useState([])
  const [discoveredDocs, setDiscoveredDocs] = React.useState([])
  const [readOnlyView, setReadOnlyView] = React.useState(null)
  const readOnlySeqRef = React.useRef(0)
  const readOnlyMountedRef = React.useRef(true)
  const readOnlyViewRef = React.useRef(null)
  readOnlyViewRef.current = readOnlyView
  const bodyIdRef = React.useRef(null)
  if (bodyIdRef.current === null) bodyIdRef.current = diag.newBodyId()
  const viewerOwnerIdRef = React.useRef(null)
  if (viewerOwnerIdRef.current === null) viewerOwnerIdRef.current = `${bodyIdRef.current}:viewer`
  // Cross-body isolation: a viewer opened in another Live Editor body blocks
  // this body's save/navigation/drafts/QuickOpen too (the local ref alone only
  // knows about this body).
  const viewerIsBlocked = React.useCallback(() => Boolean(readOnlyViewRef.current) || isViewerActive(), [])
  const viewerOpen = readOnlyView !== null
  React.useEffect(() => {
    diag.log('body-mount', {
      bodyId: bodyIdRef.current,
      liveEditorRoots: document.querySelectorAll('[data-dsh-live-editor="phase2"]').length,
      tabs: typeof tabId === 'string' ? tabId : null,
      fullscreen: tabInfo?.sidebar?.fullscreen ?? null,
      expanded: tabInfo?.sidebar?.expanded ?? null,
      activeElement: diag.activeElementInfo(),
    })
    return () => {
      diag.log('body-unmount', { bodyId: bodyIdRef.current })
    }
  }, [])
  React.useEffect(() => {
    if (!viewerOpen) return undefined
    const view = readOnlyViewRef.current
    const viewerRoot = document.querySelector('[aria-label="只读源码查看器"]')
    const viewerId = `${viewerOwnerIdRef.current}#${readOnlySeqRef.current}`
    diag.log('viewer-open', {
      bodyId: bodyIdRef.current,
      viewerId,
      owner: currentViewerOwner(),
      doc: { instanceId: view?.doc?.instanceId ?? null, docId: view?.doc?.docId ?? null, source: view?.doc?.source ?? null },
      fullscreen: tabInfo?.sidebar?.fullscreen ?? null,
      expanded: tabInfo?.sidebar?.expanded ?? null,
      activeElement: diag.activeElementInfo(),
      viewerPresent: viewerRoot !== null,
    })
    const onFocusIn = (event) => {
      if (viewerRoot === null) return
      if (event.target instanceof Node && viewerRoot.contains(event.target)) return
      diag.log('focus-escape', {
        bodyId: bodyIdRef.current,
        viewerId,
        target: diag.describeElement(event.target),
        activeElement: diag.activeElementInfo(),
      })
    }
    const onKeyDown = (event) => {
      const key = String(event.key)
      const combo = event.metaKey || event.ctrlKey
      if (key !== 'Tab' && !(combo && ['s', 'p'].includes(key.toLowerCase()))) return
      diag.log('doc-key', {
        bodyId: bodyIdRef.current,
        viewerId,
        key,
        meta: event.metaKey === true,
        ctrl: event.ctrlKey === true,
        shift: event.shiftKey === true,
        insideViewer: viewerRoot !== null && event.target instanceof Node && viewerRoot.contains(event.target),
        target: diag.describeElement(event.target),
      })
    }
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('keydown', onKeyDown, true)
      diag.log('viewer-close', { bodyId: bodyIdRef.current, viewerId, activeElement: diag.activeElementInfo() })
    }
  }, [viewerOpen])
  React.useEffect(() => {
    if (readOnlyView === null) return
    diag.log('viewer-phase', {
      bodyId: bodyIdRef.current,
      viewerId: `${viewerOwnerIdRef.current}#${readOnlySeqRef.current}`,
      phase: readOnlyView.phase,
    })
  }, [readOnlyView?.phase])
  const [a2Ready, setA2Ready] = React.useState(() => R2_ENABLED())
  const [a2Capability, setA2Capability] = React.useState(null)
  const a2CapabilityRef = React.useRef(a2Capability)
  a2CapabilityRef.current = a2Capability
  const [a2State, setA2State] = React.useState('idle')
  const enableA2 = React.useCallback(() => {
    if (typeof window === 'undefined') return
    window.__DSH_LIVE_EDITOR_R2__ = { active: true, sentinel: false, experiment: false }
    window.__DSH_A2_HANDSHAKE__ = { version: A2_HANDSHAKE_VERSION, at: Date.now() }
    try { document.documentElement.dataset.dshA2 = '1' } catch { /* ignore */ }
    try { store.setNotice('草稿预览已启用') } catch { /* ignore */ }
    setA2State('enabled')
    setA2Ready(true)
  }, [])
  const discoverySeqRef = React.useRef(0)
  const discoveryMountedRef = React.useRef(false)
  const [pendingNav, setPendingNav] = React.useState(null)
  const [pendingBusy, setPendingBusy] = React.useState(false)
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [historyRecords, setHistoryRecords] = React.useState([])
  const [historyTitle, setHistoryTitle] = React.useState('')
  const [draftsOpen, setDraftsOpen] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)
  const [draftGroups, setDraftGroups] = React.useState([])
  const [pendingHistoryPath, setPendingHistoryPath] = React.useState(null)
  const [sourceHostNode, setSourceHostNode] = React.useState(null)
  const [editorMountError, setEditorMountError] = React.useState(null)

  const activeDoc = snap.activeDoc
  const pinnedFiles = filesOpen && filesPinned && workspaceWidth >= SPLIT_MIN
  const paneWidth = Math.max(0, workspaceWidth - (pinnedFiles ? 268 : 0))
  const toolbarLayout = snap.page !== null ? (pageModeView ?? 'preview') : layout
  const pageEffectiveLayout = toolbarLayout === 'split'
    ? (paneWidth >= SPLIT_MIN ? 'split' : 'source')
    : toolbarLayout
  const preferredEffectiveLayout = layout === 'split'
    ? (paneWidth >= SPLIT_MIN ? 'split' : 'source')
    : layout
  const effectiveLayout = snap.page !== null ? pageEffectiveLayout : preferredEffectiveLayout
  const narrowSplit = toolbarLayout === 'split' && paneWidth > 0 && paneWidth < SPLIT_MIN
  const usableWidth = Math.max(0, paneWidth - DIVIDER)
  const sourcePx = usableWidth > 0 ? clampSplitRatio(splitRatio, usableWidth) * usableWidth : 0
  const sourcePaneStyle = effectiveLayout === 'split' ? { flex: `0 0 ${sourcePx}px`, minWidth: MIN_SOURCE } : undefined
  const previewPaneStyle = effectiveLayout === 'split' ? { flex: '1 1 auto', minWidth: MIN_PREVIEW } : undefined
  const iframe = React.useRef(null)
  const rootRef = React.useRef(null)
  const sourceHost = React.useRef(null)
  const sourceHostRef = React.useCallback((node) => {
    sourceHost.current = node
    setSourceHostNode(node)
  }, [])
  const workspace = React.useRef(null)
  const editor = React.useRef(null)
  const timer = React.useRef(null)
  const routeTimer = React.useRef(null)
  const connected = React.useRef(false)
  const bridgeDocsRef = React.useRef(new Map())
  const bridgeMetaRef = React.useRef({ bootId: null, locale: null, routeBasePath: '/docs' })
  // The preview page republishes `previewSignature`, a hash of the staged
  // docs title/slug/frontmatter/sidebar. A wall-clock generatedAt changes even
  // for a real-docs reload that leaves the staged content old, so the
  // structural sync waits for this content hash to change instead.
  const previewSignatureRef = React.useRef(null)
  const structuralSyncRef = React.useRef(null)
  const restartPreviewRef = React.useRef(null)
  const pendingSpaRef = React.useRef(null)
  const spaTimerRef = React.useRef(null)
  const previewRef = React.useRef({ path: null, session: null, source: null, docId: null, epoch: 0, revision: 0, text: null, writeSeq: 0, renderedRevision: null })
  const previewHadErrorRef = React.useRef(false)
  const previewEpochRef = React.useRef(0)
  const previewTimerRef = React.useRef(null)
  const previewAckTimerRef = React.useRef(null)
  const previewVisibleRef = React.useRef(true)
  const previewHiddenPendingRef = React.useRef(null)
  const previewSchedulerRef = React.useRef(null)
  const previewWriterRef = React.useRef(null)
  const r2ParentRef = React.useRef(null)

  React.useEffect(() => {
    // Default off. The dev-only A2 experiment enables this after /instances
    // reports the host flag; the normal preview path never sets it.
    if (!R2_ENABLED()) return
    const controller = createR2ParentController({
      send: (message) => {
        const win = iframe.current?.contentWindow
        if (win) win.postMessage(message, CHILD_ORIGIN)
      },
      onTimeout: () => {
        window.__DSH_R2_LAST_TIMEOUT__ = Date.now()
      },
    })
    r2ParentRef.current = controller
    return () => { controller.dispose(); r2ParentRef.current = null }
  }, [a2Ready])

  React.useEffect(() => () => { disposePreviewScheduler() }, [])
  const lastNavIntentRef = React.useRef({ href: '', at: 0 })
  const sendRevealRef = React.useRef(null)
  const requestOpenRef = React.useRef(null)
  const sendThemeRef = React.useRef(null)
  const suppressSync = React.useRef(false)
  const lastReveal = React.useRef({ line: 0, at: 0 })
  const activePathRef = React.useRef(null)
  const pageModeRef = React.useRef(false)
  const viewStates = React.useRef(new Map())
  const editorStates = React.useRef(new Map())
  const historyResetPaths = React.useRef(new Set())
  const extensionsRef = React.useRef(null)

  const clearTimer = () => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
  }
  const armTimer = (ms, nextStatus) => {
    clearTimer()
    timer.current = setTimeout(() => {
      if (!connected.current) setStatus(nextStatus)
    }, ms)
  }
  const clearRouteTimer = () => {
    if (routeTimer.current !== null) { clearTimeout(routeTimer.current); routeTimer.current = null }
  }
  const clearSpaTimer = () => {
    if (spaTimerRef.current !== null) { clearTimeout(spaTimerRef.current); spaTimerRef.current = null }
  }
  const replaceBridgeDocs = (docs) => {
    if (!Array.isArray(docs)) return
    const next = new Map()
    for (const doc of docs) {
      if (!doc || !isString(doc.source) || !isString(doc.permalink)) continue
      next.set(doc.source, { ...doc })
    }
    bridgeDocsRef.current = next
  }
  const mergeBridgeDoc = (doc) => {
    if (!doc || !isString(doc.source) || !isString(doc.permalink)) return
    bridgeDocsRef.current.set(doc.source, { ...doc })
  }
  const hostPreviewReady = snap.index.site?.previewReady === true
  const previewReady = hostPreviewReady && sitePreviewReady === true
  const previewHrefFor = (entry, anchor = null) => {
    if (!entry) return null
    if (!previewReady || a2Capability === false) return isString(entry.permalink) ? (anchor ? `${entry.permalink}#${anchor}` : entry.permalink) : null
    const override = bridgeDocsRef.current.get(entry.source)
    const permalink = isString(entry.previewPermalink)
      ? entry.previewPermalink
      : (override?.preview === true && isString(override.permalink) ? override.permalink : entry.permalink)
    if (!isString(permalink)) return null
    return anchor ? `${permalink}#${anchor}` : permalink
  }

  const clearPreviewAckTimer = () => {
    if (previewAckTimerRef.current !== null) {
      clearTimeout(previewAckTimerRef.current)
      previewAckTimerRef.current = null
    }
    previewHiddenPendingRef.current = null
  }
  const startPreviewAckTimeout = (current, revision) => {
    clearPreviewAckTimer()
    if (previewVisibleRef.current !== true) {
      // Hidden iframes may have their requestAnimationFrame confirmation
      // paused; do not turn that into a visible render failure. Keep the
      // current write pending and arm the deadline when the pane is shown.
      previewHiddenPendingRef.current = { current, revision }
      return
    }
    previewAckTimerRef.current = setTimeout(() => {
      previewAckTimerRef.current = null
      if (previewRef.current !== current || current.revision !== revision || current.renderedRevision === revision) return
      previewHadErrorRef.current = true
      setPreviewState({ phase: 'error', session: current.session, source: current.source, revision, error: '预览编译或渲染超时' })
      void recoverPreview(current, current.source)
    }, revision === 1 ? PREVIEW_ACK_TIMEOUT_MS_NAV : PREVIEW_ACK_TIMEOUT_MS)
  }
  const clearPreviewTimer = () => {
    if (previewTimerRef.current !== null) {
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
  }
  const disposePreviewScheduler = () => {
    if (previewSchedulerRef.current !== null) {
      previewSchedulerRef.current.dispose()
      previewSchedulerRef.current = null
    }
  }
  const ensurePreviewSession = (doc, source) => {
    const current = previewRef.current
    if (current.path === doc.path && current.source === source && current.session !== null) return current
    clearPreviewTimer()
    clearPreviewAckTimer()
    disposePreviewScheduler()
    const previewHref = previewHrefFor(doc.entry)
    let route = null
    try { route = previewHref ? new URL(previewHref, window.location.origin).pathname : null } catch { route = null }
    const next = {
      path: doc.path, session: newNonce(), source, docId: doc.entry?.docId ?? null,
      route,
      // Timestamp-based epoch: a DSH page reload must still be newer than
      // the in-memory Host state from the previous client session.
      epoch: Math.max(Date.now(), previewEpochRef.current + 1), revision: 0,
      text: null, writeSeq: 0, renderedRevision: null,
    }
    previewEpochRef.current = next.epoch
    previewRef.current = next
    setStructuralPending(false)
    setPreviewState({ phase: 'waiting', session: next.session, source, revision: 0, error: null })
    return next
  }
  React.useEffect(() => {
    const win = iframe.current?.contentWindow ?? null
    // Do not establish the frame from the iframe element before its new
    // channel hello: a command posted to an iframe that has not installed its
    // listener is lost. The hello's event.source is the only frame authority.
    r2ParentRef.current?.invalidate('route-or-frame-change')
    // A controller created after the iframe missed the child's install-time
    // hello; ask for a fresh hello so queued commands can be reissued.
    if (R2_ENABLED() && win && typeof win.postMessage === 'function') {
      try {
        win.postMessage({ source: R2_PARENT_SOURCE, v: R2_PARENT_VERSION, type: 'r2-hello-request' }, CHILD_ORIGIN)
      } catch { /* ignore */ }
    }
  }, [activeDoc?.path, iframeUrl, a2Ready])

  const postPreviewAck = (current, source) => {
    const ackSession = current.session
    const ackRevision = current.revision
    const ackSource = source
    void fetch(PREVIEW_ACK_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source, docId: current.docId, session: ackSession,
        revision: ackRevision, epoch: current.epoch,
        writeId: current.lastWriteId ?? null,
      }),
    }).then(async (response) => {
      const data = await response.json().catch(() => null)
      // Logged after the Host ACK request settles: status 200 is the evidence
      // that Host lastGood was updated while the viewer was open.
      diag.log('preview-ack', {
        bodyId: bodyIdRef.current,
        session: ackSession,
        revision: ackRevision,
        source: ackSource,
        status: response.status,
        ok: data?.ok === true,
        viewerOpen: viewerIsBlocked(),
        owner: currentViewerOwner(),
      })
    }).catch((error) => {
      diag.log('preview-ack', {
        bodyId: bodyIdRef.current,
        session: ackSession,
        revision: ackRevision,
        source: ackSource,
        status: 0,
        error: String(error?.message ?? error),
        viewerOpen: viewerIsBlocked(),
      })
    })
  }
  const commitPreviewRendered = (current, source) => {
    if (current.renderedRevision === current.revision) return
    current.renderedRevision = current.revision
    clearPreviewAckTimer()
    setPreviewState({ phase: 'rendered', session: current.session, source, revision: current.revision, error: null })
    if (previewHadErrorRef.current) {
      previewHadErrorRef.current = false
      // Docusaurus keeps its compile-error overlay after the staging file is
      // fixed. Force one iframe reload so the current revision is rendered.
      setTimeout(() => { try { restartPreview() } catch { /* not mounted yet */ } }, 30)
    }
    postPreviewAck(current, source)
  }
  const notePreviewDoc = (doc) => {
    // Under the A2 experiment the DOM-confirmed R2 ack is the only authority;
    // the docs metadata ack is stale by design (watcher reload suppressed).
    if (R2_ENABLED()) return
    if (!doc || doc.preview !== true) return
    const current = previewRef.current
    if (!current.session || doc.source !== current.source) return
    if (doc.previewSession !== current.session || doc.previewRevision !== current.revision) return
    if (current.renderedRevision === current.revision) return
    commitPreviewRendered(current, doc.source)
  }
  const recoverPreview = async (current, source) => {
    try {
      const response = await fetch(PREVIEW_RECOVER_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, docId: current.docId, session: current.session, epoch: current.epoch }),
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.ok === true && previewRef.current === current) {
        previewHadErrorRef.current = true
        setPreviewState({
          phase: 'error', session: current.session, source,
          revision: Number.isSafeInteger(data.revision) ? data.revision : current.revision,
          error: '编译失败，已恢复上一帧预览', recovered: true,
        })
      }
    } catch { /* keep the error state */ }
  }
  const writePreview = async (doc, source, text, expected) => {
    if (a2CapabilityRef.current === false) return
    const current = previewRef.current
    if (current !== expected || current.path !== doc.path || current.source !== source) return
    const revision = current.revision + 1
    diag.log('preview-write-start', {
      bodyId: bodyIdRef.current,
      session: current.session,
      revision,
      epoch: current.epoch,
      source,
      textLen: text.length,
      textFnv: diag.fnv1a(text),
      viewerOpen: viewerIsBlocked(),
    })
    const r2 = R2_ENABLED() ? r2ParentRef.current : null
    const writeId = r2 ? newNonce() : undefined
    current.lastWriteId = writeId
    current.revision = revision
    current.text = text
    current.renderedRevision = null
    current.writeSeq += 1
    startPreviewAckTimeout(current, revision)
    console.info('[dsh-live-editor] timing preview-write', { phase: 'start', revision, t: performance.now() })
    setPreviewState({ phase: 'writing', session: current.session, source, revision, error: null })
    try {
      const response = await fetch(PREVIEW_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source, docId: current.docId, text, session: current.session, revision, epoch: current.epoch,
          handshakeVersion: A2_HANDSHAKE_VERSION,
          ...(writeId === undefined ? {} : { writeId }),
        }),
      })
      const data = await response.json().catch(() => ({}))
      setA2State(`resp:${response.status}${data?.ok === true ? '' : ':' + String(data?.code ?? data?.error ?? '')}`)
      console.info('[dsh-live-editor] timing preview-response', { status: response.status, revision, t: performance.now() })
      diag.log('preview-write-response', {
        bodyId: bodyIdRef.current,
        session: current.session,
        revision,
        status: response.status,
        ok: data?.ok === true,
        code: typeof data?.code === 'string' ? data.code : null,
        error: typeof data?.error === 'string' ? data.error.slice(0, 160) : null,
      })
      if (previewRef.current !== current || current.revision !== revision) return
      // The body can render via HMR, but frontmatter metadata (title/slug/
      // sidebar) is not reloaded while the watcher filter is active. Compare
      // against the real saved docs (not the previous write) so reverting the
      // frontmatter edit clears the warning again.
      setStructuralPending(data?.structuralPending === true)
      if (response.ok && data.ok === true && data.structural === true && SENTINEL_ENABLED()) {
        // Structural frontmatter changes require a fresh docs/route commit.
        // Dormant unless both R2 active and sentinel gates are explicitly set.
        restartPreview()
      }
      if (response.ok && data.ok === true && r2) {
        const commandId = r2.begin({
          session: current.session, docId: current.docId, route: current.route,
          revision, writeId,
        })
        window.__DSH_R2_LAST_BEGIN__ = { at: Date.now(), commandId, revision, writeId }
        setA2State(commandId ? 'cmd' : 'queued')
      }
      if (!response.ok || data.ok !== true) {
        clearPreviewAckTimer()
        if (response.status === 409) {
          // The Host retained an older session/revision for this source (for
          // example after a DSH page reload). Start a fresh timestamp epoch and
          // retry once; never leave every subsequent write permanently rejected.
          current.session = null
          const next = ensurePreviewSession(doc, source)
          setPreviewState({ phase: 'waiting', session: next.session, source, revision: 0, error: null })
          schedulePreviewWrite(doc, source, text, next)
          return
        }
        previewHadErrorRef.current = true
        setPreviewState({ phase: 'error', session: current.session, source, revision, error: data.error ?? `预览写入失败 (${response.status})` })
      }
    } catch {
      if (previewRef.current !== current || current.revision !== revision) return
      clearPreviewAckTimer()
      previewHadErrorRef.current = true
      setPreviewState({ phase: 'error', session: current.session, source, revision, error: '预览写入失败' })
    }
  }
  const serializedPreviewWrite = (doc, source, text, current) => {
    if (previewWriterRef.current === null) {
      previewWriterRef.current = createPreviewWriter(writePreview)
    }
    return previewWriterRef.current(doc, source, text, current)
  }
  const schedulePreviewWrite = (doc, source, text, current) => {
    if (SCHEDULER_ENABLED()) {
      if (previewSchedulerRef.current === null) {
        previewSchedulerRef.current = createPreviewScheduler({
          write: async (snapshot) => {
            await serializedPreviewWrite(snapshot.doc, snapshot.source, snapshot.text, snapshot.current)
          },
          onError: (error) => {
            previewHadErrorRef.current = true
            setPreviewState((old) => ({ ...old, phase: 'error', error: String(error?.message ?? error) }))
          },
        })
      }
      previewSchedulerRef.current.submit({ doc, source, text, current })
      return
    }
    clearPreviewTimer()
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = null
      void serializedPreviewWrite(doc, source, text, current)
    }, PREVIEW_DEBOUNCE_MS)
  }

  pageModeRef.current = snap.page !== null

  React.useEffect(() => {
    const doc = activeDoc
    if (!doc) return
    const source = normalizeSource(doc.entry?.source)
    const current = previewRef.current
    const sameSource = current !== null && current.source === source
    const decision = decidePreviewWrite({
      previewReady,
      schedulerEnabled: SCHEDULER_ENABLED(),
      loadPhase: doc.loadPhase,
      text: doc.text,
      currentSession: sameSource ? current.session : null,
      currentText: sameSource ? current.text : null,
      capability: a2Capability,
    })
    if (decision === 'disabled') {
      clearPreviewTimer()
      if (previewSchedulerRef.current !== null) {
        previewSchedulerRef.current.dispose()
        previewSchedulerRef.current = null
      }
      return
    }
    if (decision === 'wait' && doc.loadPhase === 'ready' && typeof doc.text === 'string') {
      // TEMPORARY diagnostic: keep the old "doc ready before the handshake"
      // trace; the effect now re-runs when previewReady flips and writes then.
      diag.log('preview-skip', {
        bodyId: bodyIdRef.current,
        activeDoc: doc.path,
        hostPreviewReady,
        sitePreviewReady,
      })
    }
    if (decision !== 'write') return
    if (source === null) return
    const session = ensurePreviewSession(doc, source)
    // In scheduler mode the last submitted text may equal the current write's
    // starting text after A→B→A; always submit so the final A can replace B.
    schedulePreviewWrite(doc, source, doc.text, session)
  }, [activeDoc?.path, activeDoc?.text, activeDoc?.loadPhase, activeDoc?.entry?.source, previewReady, a2Capability])
  React.useEffect(() => {
    console.info('[dsh-live-editor][diag] sitePreviewReady state', {
      sitePreviewReady,
      hostPreviewReady,
      previewReady,
      activeDoc: activeDoc?.path ?? null,
      t: performance.now(),
    })
    diag.log('preview-ready', {
      bodyId: bodyIdRef.current,
      sitePreviewReady,
      hostPreviewReady,
      previewReady,
      activeDoc: activeDoc?.path ?? null,
      fullscreen: tabInfo?.sidebar?.fullscreen ?? null,
      expanded: tabInfo?.sidebar?.expanded ?? null,
    })
  }, [sitePreviewReady, hostPreviewReady, previewReady, activeDoc?.path])
  React.useEffect(() => {
    if (activeDoc?.reconcile?.required === true) {
      diag.log('reconcile-visible', {
        bodyId: bodyIdRef.current,
        activeDoc: activeDoc.path,
        reconcile: {
          required: activeDoc.reconcile.required,
          restoredFrom: activeDoc.reconcile.restoredFrom ?? null,
        },
      })
    }
  }, [activeDoc?.reconcile?.required, activeDoc?.path])
  const sidebarGeneratedAt = sidebarPayload?.generatedAt ?? null

  const sidebarRefreshRef = React.useRef(null)

  // Page mode is a transient preview-only view. A manual source/split choice
  // while a page is active is an override, never the persisted layout.
  React.useEffect(() => {
    if (snap.page === null) setPageModeView(null)
  }, [snap.page])

  // The shortcut resolver finds the owning Live Editor root in the DOM and
  // opens that tab's QuickOpen; no module-level "active tab" is needed.
  React.useEffect(() => {
    const root = rootRef.current
    if (root === null) return undefined
    const open = () => {
      const blocked = viewerIsBlocked()
      diag.log('quickopen-open', { bodyId: bodyIdRef.current, via: 'root', blocked, activeElement: diag.activeElementInfo() })
      if (!blocked) setQuickOpen(true)
    }
    quickOpenByRoot.set(root, open)
    return () => {
      if (quickOpenByRoot.get(root) === open) quickOpenByRoot.delete(root)
    }
  }, [])

  React.useEffect(() => {
    if (tabId === null) return undefined
    const open = () => {
      const blocked = viewerIsBlocked()
      diag.log('quickopen-open', { bodyId: bodyIdRef.current, via: 'tab', blocked, activeElement: diag.activeElementInfo() })
      if (!blocked) setQuickOpen(true)
    }
    quickOpenByTab.set(tabId, open)
    return () => {
      if (quickOpenByTab.get(tabId) === open) quickOpenByTab.delete(tabId)
    }
  }, [tabId])

  // A new sidebar payload means the docs plugin may have added/removed docs
  // (HMR/category edit). Refresh the Host index once per generatedAt so the
  // tree can map every sidebar doc id to a real source path.
  React.useEffect(() => {
    if (sidebarGeneratedAt === null) return
    if (sidebarRefreshRef.current === sidebarGeneratedAt) return
    sidebarRefreshRef.current = sidebarGeneratedAt
    void store.loadIndex({ refresh: true, preferredPath: store.getSnapshot().activePath })
  }, [sidebarGeneratedAt, store])

  // Read-only discovery surface. These entries are deliberately not merged
  // into DocStore; non-default instances remain view-only until identity,
  // drafts, sidebar and save authorization are all wired together.
  const refreshDiscovery = React.useCallback(() => {
    const seq = (discoverySeqRef.current += 1)
    fetch('/api/live-editor/instances', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then(async (data) => {
        if (!discoveryMountedRef.current || seq !== discoverySeqRef.current) return
        if (!data?.ok || !Array.isArray(data.instances)) return
        setA2Capability(data.a2Experiment === true)
        if (data.a2Experiment === true) enableA2()
        const visible = data.instances.filter((entry) => entry && entry.instanceId !== 'default')
        setDiscoveredInstances(visible)
        const docsInstances = visible.filter((entry) => entry.pluginType === 'docs')
        const lists = await Promise.all(docsInstances.map(async (entry) => {
          try {
            const response = await fetch(`/api/live-editor/instances/docs?instance=${encodeURIComponent(entry.instanceId)}`, { cache: 'no-store' })
            if (!response.ok) return []
            const body = await response.json()
            return body?.ok && Array.isArray(body.documents) ? body.documents : []
          } catch {
            return []
          }
        }))
        if (!discoveryMountedRef.current || seq !== discoverySeqRef.current) return
        setDiscoveredDocs(lists.flat())
      })
      .catch(() => {})
  }, [])
  React.useEffect(() => {
    discoveryMountedRef.current = true
    refreshDiscovery()
    return () => {
      discoveryMountedRef.current = false
      discoverySeqRef.current += 1
    }
  }, [refreshDiscovery])

  const openReadOnly = React.useCallback((doc) => {
    if (!doc || typeof doc.instanceId !== 'string' || typeof doc.docId !== 'string'
      || typeof doc.source !== 'string') return
    // The owner token is document-wide: only one Live Editor body may hold the
    // read-only viewer at a time, and every body's guards observe it.
    if (readOnlyViewRef.current === null) {
      const acquired = acquireViewer(viewerOwnerIdRef.current)
      if (acquired === null) {
        store.setNotice('另一个 Live Editor 标签正在使用只读查看器')
        return
      }
    } else if (currentViewerOwner() !== viewerOwnerIdRef.current) {
      return
    }
    const seq = (readOnlySeqRef.current += 1)
    setReadOnlyView({ phase: 'loading', doc, text: '', error: null })
    const query = new URLSearchParams({ instance: doc.instanceId, docId: doc.docId, source: doc.source })
    fetch(`/api/live-editor/instances/source?${query.toString()}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!readOnlyMountedRef.current || seq !== readOnlySeqRef.current) return
        if (!response.ok || !body?.ok || typeof body.text !== 'string') {
          setReadOnlyView({ phase: 'error', doc, text: '', error: body?.error ?? `HTTP ${response.status}` })
          return
        }
        setReadOnlyView({ phase: 'ready', doc, text: body.text, error: null })
      })
      .catch((error) => {
        if (!readOnlyMountedRef.current || seq !== readOnlySeqRef.current) return
        setReadOnlyView({ phase: 'error', doc, text: '', error: String(error?.message ?? error) })
      })
  }, [])
  const closeReadOnly = React.useCallback(() => {
    readOnlySeqRef.current += 1
    releaseViewer(viewerOwnerIdRef.current)
    setReadOnlyView(null)
  }, [])
  React.useEffect(() => {
    readOnlyMountedRef.current = true
    return () => {
      readOnlyMountedRef.current = false
      readOnlySeqRef.current += 1
      releaseViewer(viewerOwnerIdRef.current)
    }
  }, [])

  const refreshDraftGroups = React.useCallback(async () => {
    try {
      const groups = await store.listDrafts()
      setDraftGroups(groups)
    } catch {
      setDraftGroups([])
    }
  }, [store])

  // Open IndexedDB once, attach it to the store, and keep the sync emergency
  // copy on unload/visibility-hidden.
  React.useEffect(() => {
    let cancelled = false
    void draftRef.current.open().then((ok) => {
      if (cancelled) return
      if (ok) {
        store.attachDraftStore(draftRef.current)
        void refreshDraftGroups()
      } else {
        store.setDraftStorageError('IndexedDB 草稿存储不可用；将只使用应急存储。')
      }
    })
    const onHide = () => { void store.flushEmergencyAll({ sync: true }) }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide()
    }
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      onHide()
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onVisibility)
      const draft = draftRef.current
      // Stop timers and flush the last draft before closing IndexedDB. Without
      // this ordering a closed connection can still receive scheduled writes.
      void store.dispose().finally(() => { void draft?.close() })
    }
  }, [store, refreshDraftGroups])

  // Draft panel -> open doc -> history dialog once the recovery data is ready.
  React.useEffect(() => {
    if (pendingHistoryPath === null) return
    const active = store.getSnapshot().activeDoc
    if (active === null || active.path !== pendingHistoryPath) return
    if (active.recovery.status !== 'available' || (active.recovery.history?.length ?? 0) === 0) return
    setHistoryRecords(active.recovery.history)
    setHistoryTitle(active.entry?.title ?? active.path)
    setHistoryOpen(true)
    setPendingHistoryPath(null)
  }, [pendingHistoryPath, store, snap])

  // Load the read-only Host index once; prefer the last open document.
  React.useEffect(() => {
    void store.loadIndex({ preferredPath: readStoredLastPath() })
  }, [store])

  // First active document decides the initial preview URL.
  React.useEffect(() => {
    if (iframeUrl === null && activeDoc?.entry) setIframeUrl(previewHrefFor(activeDoc.entry))
  }, [activeDoc?.entry, activeDoc?.entry?.permalink, iframeUrl, activeDoc?.entry?.previewPermalink, previewReady, a2Capability])

  React.useEffect(() => {
    if (a2Capability === false) return
    if (!previewReady || activeDoc?.entry === undefined || iframeUrl === null) return
    if (iframeUrl.startsWith('/__live-preview')) return
    loadPreviewUrl(previewHrefFor(activeDoc.entry))
  }, [previewReady, activeDoc?.path, a2Capability])

  // Rollback off: the preview must show the real docs page, never staging.
  // This also covers an iframe that was already on the staging route when the
  // capability response arrived.
  React.useEffect(() => {
    if (a2Capability !== false) return
    const real = activeDoc?.entry?.permalink
    if (!isString(real) || iframeUrl === real) return
    setIframeUrl(real)
    setNonce(newNonce())
    setAttempt((value) => value + 1)
  }, [a2Capability, activeDoc?.entry?.permalink, iframeUrl])

  // Remember the current document for the next tab mount.
  React.useEffect(() => {
    if (snap.activePath === null) return
    try { localStorage.setItem(LAST_PATH_KEY, snap.activePath) } catch { /* storage unavailable */ }
  }, [snap.activePath])

  const saveViewState = (path) => {
    const view = editor.current
    if (!view || !path) return
    const selection = view.state.selection.main
    viewStates.current.set(path, {
      scrollTop: view.scrollDOM.scrollTop,
      anchor: selection.anchor,
      head: selection.head,
      state: view.state,
    })
  }

  const restoreViewState = (path) => {
    const view = editor.current
    if (!view || !path) return
    const saved = viewStates.current.get(path)
    if (!saved) return
    const max = view.state.doc.length
    const anchor = Math.max(0, Math.min(max, saved.anchor))
    const head = Math.max(0, Math.min(max, saved.head))
    view.dispatch({ selection: { anchor, head } })
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = saved.scrollTop
      view.requestMeasure()
    })
  }

  const makeExtensions = () => {
    if (extensionsRef.current !== null) return extensionsRef.current
    extensionsRef.current = [
      markdown(),
      history(),
      syntaxHighlighting(editorHighlight),
      mdxBlockDecorations,
      lineNumbers(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (viewerIsBlocked()) return
        const path = activePathRef.current
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head
          const info = update.state.doc.lineAt(head)
          setCursor({ line: info.number, column: head - info.from + 1 })
        }
        if (update.docChanged && path !== null) {
          editorStates.current.set(path, update.state)
          store.setEditorText(path, update.state.doc.toString())
        }
        if (!update.selectionSet && !update.viewportChanged) return
        if (suppressSync.current || pageModeRef.current) return
        const state = update.state
        const head = state.selection.main.head
        const scroller = update.view.scrollDOM
        const center = scroller.scrollTop + scroller.clientHeight / 2
        const block = update.view.lineBlockAtHeight(center)
        const line = state.doc.lineAt(update.selectionSet ? head : block.from).number
        const now = Date.now()
        if (line === lastReveal.current.line && now - lastReveal.current.at < 120) return
        lastReveal.current = { line, at: now }
        sendRevealRef.current?.(line)
      }),
      keymap.of([
        ...historyKeymap,
        { key: 'Mod-s', run: () => { saveRef.current?.('keymap'); return true } },
      ]),
      EditorView.domEventHandlers({
        mousedown(event, view) {
          if (event.button !== 0 || event.defaultPrevented) return false
          const isMac = /Mac|iPhone|iPad/i.test(navigator.platform)
            || /Mac/i.test(navigator.userAgent)
          const modified = isMac ? event.metaKey : event.ctrlKey
          if (!modified || event.altKey || event.shiftKey) return false
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos === null) return false
          const link = findLinkAt(view.state, pos)
          if (link === null) return false
          const snapshotNow = store.getSnapshot()
          const resolved = resolveLinkTarget(link.target, activePathRef.current, snapshotNow.index)
          if (resolved.kind === 'doc') {
            event.preventDefault()
            requestOpenRef.current?.(resolved.path, { anchor: resolved.anchor })
            return true
          }
          if (resolved.kind === 'ambiguous') {
            event.preventDefault()
            store.setNotice(`链接目标有歧义：${resolved.paths.join(' / ')}`)
            return true
          }
          return false
        },
      }),
      editorTheme,
    ]
    return extensionsRef.current
  }

  // Swap editor content only for the active document; stale loads never reach here.
  React.useEffect(() => {
    const doc = activeDoc
    // Keep a cached editor visible even if a reload failed; the error is shown
    // separately. A fresh load with no text waits for ready/error.
    if (!doc || !isString(doc.text)) return
    const host = sourceHost.current
    if (!host) return
    const view = editor.current
    const previousPath = activePathRef.current
    if (view === null) {
      try {
        activePathRef.current = doc.path
        const state = EditorState.create({ doc: doc.text, extensions: makeExtensions() })
        editorStates.current.set(doc.path, state)
        editor.current = new EditorView({ state, parent: host })
        setEditorMountError(null)
      } catch (error) {
        setEditorMountError(String(error?.message ?? error))
      }
      return
    }
    // The SourcePane host can be replaced (e.g. switching a pinned side rail);
    // move the existing editor DOM instead of leaving a blank pane behind.
    try {
      if (view.dom.parentNode !== host) {
        host.appendChild(view.dom)
        view.requestMeasure()
      }
      const pathChanged = previousPath !== null && previousPath !== doc.path
      if (pathChanged) saveViewState(previousPath)
      // Attribute any update fired by setState to the new document.
      activePathRef.current = doc.path
      const cached = editorStates.current.get(doc.path)
      const textChanged = view.state.doc.toString() !== doc.text
      const forceReset = historyResetPaths.current.has(doc.path)
      if (!forceReset && cached !== undefined && cached.doc.toString() === doc.text) {
        // Restoring a cached EditorState keeps this document's own undo history.
        if (view.state !== cached) view.setState(cached)
      } else if (textChanged || pathChanged || forceReset) {
        const next = EditorState.create({ doc: doc.text, extensions: makeExtensions() })
        editorStates.current.set(doc.path, next)
        view.setState(next)
      }
      historyResetPaths.current.delete(doc.path)
      restoreViewState(doc.path)
    } catch (error) {
      setEditorMountError(String(error?.message ?? error))
    }
  }, [activeDoc?.path, activeDoc?.loadEpoch, activeDoc?.loadPhase, activeDoc?.contentVersion, store, sourceHostNode])

  // Re-measure when the source pane becomes visible again (hidden panes can
  // otherwise keep a stale zero-height layout).
  React.useEffect(() => {
    if (effectiveLayout === 'preview') return undefined
    const id = setTimeout(() => editor.current?.requestMeasure(), 0)
    return () => clearTimeout(id)
  }, [effectiveLayout, sourceHostNode])

  React.useEffect(() => () => {
    editor.current?.destroy()
    editor.current = null
    editorStates.current.clear()
    viewStates.current.clear()
    if (routeTimer.current !== null) clearTimeout(routeTimer.current)
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  React.useEffect(() => {
    const element = workspace.current
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width
      if (Number.isFinite(width)) setWorkspaceWidth(width)
    })
    observer.observe(element)
    setWorkspaceWidth(element.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    const update = () => setDarkTheme(document.body.hasAttribute('data-ds-dark-theme'))
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    sendThemeRef.current?.()
  }, [darkTheme])

  React.useEffect(() => {
    try {
      localStorage.setItem('live-editor:layout', layout)
      localStorage.setItem('live-editor:split-ratio', String(splitRatio))
      localStorage.setItem('live-editor:font-size', String(fontSize))
    } catch { /* storage unavailable */ }
  }, [layout, splitRatio, fontSize])

  React.useEffect(() => {
    const id = setTimeout(() => editor.current?.requestMeasure(), 0)
    return () => clearTimeout(id)
  }, [layout])

  const startSplitDrag = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const element = workspace.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    const usable = Math.max(1, rect.width - DIVIDER)
    let frame = null
    let pendingX = null
    const applyMove = () => {
      frame = null
      if (pendingX === null) return
      const ratio = (pendingX - rect.left) / usable
      setSplitRatio(clampSplitRatio(ratio, usable))
      pendingX = null
    }
    const move = (moveEvent) => {
      pendingX = moveEvent.clientX
      if (frame === null) frame = requestAnimationFrame(applyMove)
    }
    const up = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      if (pendingX !== null) applyMove()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setDragging(false)
    }
    setDragging(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const revealLine = (line, endLine) => {
    const view = editor.current
    if (view === null) return
    const total = view.state.doc.lines
    const start = Math.min(Math.max(1, line), total)
    const end = Math.min(Math.max(start, endLine || start), total)
    const from = view.state.doc.line(start).from
    const to = view.state.doc.line(end).to
    suppressSync.current = true
    const margin = Math.round(view.scrollDOM.clientHeight * 0.25)
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: margin }) })
    view.focus()
    setTimeout(() => { suppressSync.current = false }, 80)
  }

  const save = async (source = 'unknown') => {
    if (!siteWritable) {
      store.setNotice('当前站点为只读镜像；保存已停用', { tone: 'warning' })
      return
    }
    const doc = store.getSnapshot().activeDoc
    const view = editor.current
    const text = view === null ? '' : view.state.doc.toString()
    const viewerOpen = viewerIsBlocked()
    diag.log('save-intent', {
      bodyId: bodyIdRef.current,
      source,
      path: doc?.path ?? null,
      viewerOpen,
      activeElement: diag.activeElementInfo(),
      textLen: text.length,
      textFnv: diag.fnv1a(text),
      docTextLen: typeof doc?.text === 'string' ? doc.text.length : null,
      docTextFnv: typeof doc?.text === 'string' ? diag.fnv1a(doc.text) : null,
      baseHash: doc?.baseHash ?? null,
      dirty: doc?.dirty ?? null,
      savePhase: doc?.savePhase ?? null,
    })
    if (viewerOpen) {
      diag.log('save-blocked-viewer', { bodyId: bodyIdRef.current, source })
      return
    }
    if (!doc || view === null || doc.savePhase === 'saving') {
      diag.log('save-skipped', { bodyId: bodyIdRef.current, source, reason: !doc ? 'no-doc' : view === null ? 'no-view' : 'saving' })
      return
    }
    const signatureBeforeSave = structuralPendingRef.current && typeof previewSignatureRef.current === 'string'
      ? previewSignatureRef.current
      : null
    const ok = await store.save(doc.path, text, {
      diag: { bodyId: bodyIdRef.current, source, viewerOpen },
    })
    diag.log('save-result', {
      bodyId: bodyIdRef.current,
      source,
      ok,
      path: doc.path,
      savePhase: doc.savePhase,
      baseHash: doc.baseHash,
      docTextLen: typeof doc.text === 'string' ? doc.text.length : null,
      docTextFnv: typeof doc.text === 'string' ? diag.fnv1a(doc.text) : null,
    })
    if (ok) {
      // Do not clear the structural warning until the preview page carries a
      // new staged-content signature. The save itself only reloads the real
      // docs plugin; the sentinel-triggered staging reload is what makes the
      // new title/sidebar visible. Retry the preview restart until the
      // signature changes, then clear the warning.
      setPreviewState((old) => old.phase === 'rendered' ? { ...old, saved: true } : old)
      if (signatureBeforeSave !== null) {
        const previous = structuralSyncRef.current
        if (previous !== null && previous.timer !== null) clearTimeout(previous.timer)
        structuralSyncRef.current = {
          signature: signatureBeforeSave,
          attempts: 0,
          timer: null,
        }
      }
      restartPreview()
      void refreshDraftGroups()
    }
  }
  const saveRef = React.useRef(save)
  saveRef.current = save

  const restartPreview = () => {
    const doc = store.getSnapshot().activeDoc
    clearSpaTimer()
    pendingSpaRef.current = null
    connected.current = false
    clearTimer()
    clearRouteTimer()
    setStatus('handshaking')
    setIframeUrl(previewHrefFor(doc?.entry) ?? iframeUrl)
    setNonce(newNonce())
    setAttempt((value) => value + 1)
  }
  restartPreviewRef.current = restartPreview

  const notePreviewSignature = React.useCallback((sidebars) => {
    const signature = typeof sidebars?.previewSignature === 'string' && sidebars.previewSignature.length > 0
      ? sidebars.previewSignature
      : null
    if (signature !== null) previewSignatureRef.current = signature
    const pending = structuralSyncRef.current
    if (pending === null) return
    const decision = decideStructuralSync({
      pendingSignature: pending.signature,
      observedSignature: signature,
      attempts: pending.attempts,
      maxAttempts: 3,
    })
    if (decision === 'synced') {
      if (pending.timer !== null) clearTimeout(pending.timer)
      structuralSyncRef.current = null
      setStructuralPending(false)
      return
    }
    if (decision !== 'retry') {
      if (pending.timer !== null) clearTimeout(pending.timer)
      structuralSyncRef.current = null
      return
    }
    pending.attempts += 1
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      if (structuralSyncRef.current !== pending) return
      restartPreviewRef.current?.()
    }, 400)
  }, [])
  React.useEffect(() => () => {
    const pending = structuralSyncRef.current
    if (pending !== null && pending.timer !== null) clearTimeout(pending.timer)
    structuralSyncRef.current = null
  }, [])

  const reloadFromDisk = () => {
    if (viewerIsBlocked()) return
    const doc = store.getSnapshot().activeDoc
    if (!doc) return
    if (doc.dirty && !window.confirm('重新加载会丢失编辑器里的未保存修改。确定继续？')) return
    const result = store.reload(doc.path)
    if (result?.ok === false) {
      if (result.reason === 'saving') store.setNotice('保存中，暂不能重载；请等待保存完成。')
      if (result.reason === 'reconcile') store.setNotice('请先处理保存冲突：以磁盘为准，或明确覆盖。')
      return
    }
    viewStates.current.delete(doc.path)
    editorStates.current.delete(doc.path)
    historyResetPaths.current.add(doc.path)
    restartPreview()
  }

  const loadPreviewUrl = (url) => {
    if (!isString(url)) return
    clearSpaTimer()
    pendingSpaRef.current = null
    setIframeUrl(url)
    setNonce(newNonce())
    setAttempt((value) => value + 1)
    connected.current = false
    clearTimer()
    clearRouteTimer()
    setStatus('handshaking')
  }

  const sendNavigate = (href) => {
    if (!isString(href) || iframe.current?.contentWindow == null) return false
    const navId = newNonce()
    console.info('[dsh-live-editor] navigate sent', { href, navId, t: performance.now() })
    pendingSpaRef.current = { href, navId, at: Date.now() }
    iframe.current.contentWindow.postMessage(
      {
        source: SOURCE, v: VERSION, type: 'navigate', nonce,
        bootId: bridgeMetaRef.current.bootId ?? undefined, href, navId,
      },
      CHILD_ORIGIN,
    )
    clearSpaTimer()
    spaTimerRef.current = setTimeout(() => {
      spaTimerRef.current = null
      const pending = pendingSpaRef.current
      if (pending === null || pending.navId !== navId) return
      pendingSpaRef.current = null
      loadPreviewUrl(pending.href)
    }, 3000)
    return true
  }

  const openFromTree = (path, options = {}) => {
    if (viewerIsBlocked()) return
    const snapshotNow = store.getSnapshot()
    const entry = snapshotNow.index.docByPath.get(path)
    if (entry === undefined) {
      store.setNotice(`文件不在索引中：${path}`)
      return
    }
    const anchor = isString(options.anchor) && options.anchor.length > 0 ? options.anchor : null
    setPendingNav(null)
    if (snapshotNow.activePath === path) {
      if (anchor) {
        const href = previewHrefFor(entry, anchor)
        if (href !== null && connected.current) sendNavigate(href)
        else loadPreviewUrl(href)
      }
      if (filesPinned !== true) setFilesOpen(false)
      return
    }
    store.openDoc(path)
    const href = previewHrefFor(entry, anchor)
    if (href !== null && connected.current) {
      sendNavigate(href)
    } else {
      loadPreviewUrl(href)
    }
    if (filesPinned !== true) setFilesOpen(false)
  }

  const requestOpen = async (path, options = {}) => {
    if (viewerIsBlocked()) return
    const snapshotNow = store.getSnapshot()
    const active = snapshotNow.activeDoc
    if (active !== null && active.path !== path && active.dirty) {
      const safe = await store.ensureDraftSafe(active.path)
      if (viewerIsBlocked()) return
      if (!safe.ok) {
        const entry = snapshotNow.index.docByPath.get(path)
        setPendingNav({
          path,
          title: entry?.title ?? path,
          reason: safe.reason,
          anchor: isString(options.anchor) && options.anchor.length > 0 ? options.anchor : null,
        })
        return
      }
    }
    openFromTree(path, options)
  }
  requestOpenRef.current = requestOpen

  const retryDraftAndGo = async () => {
    if (viewerIsBlocked()) return
    const target = pendingNav
    const active = store.getSnapshot().activeDoc
    if (target === null || active === null) return
    setPendingBusy(true)
    const safe = await store.ensureDraftSafe(active.path)
    setPendingBusy(false)
    if (viewerIsBlocked()) return
    if (safe.ok) openFromTree(target.path, { anchor: target.anchor ?? null })
    else setPendingNav({ ...target, reason: safe.reason })
  }

  const switchAnyway = () => {
    if (viewerIsBlocked()) return
    const target = pendingNav
    setPendingNav(null)
    if (target !== null) openFromTree(target.path, { anchor: target.anchor ?? null })
  }

  const recoverActiveDraft = async () => {
    diag.log('recovery-action', { bodyId: bodyIdRef.current, action: 'recover-latest', activeDoc: store.getSnapshot().activeDoc?.path ?? null, viewerOpen: viewerIsBlocked() })
    if (viewerIsBlocked()) return
    const doc = store.getSnapshot().activeDoc
    if (!doc) return
    const result = await store.recoverLatest(doc.path)
    if (!result.ok) store.setNotice(result.error ?? '恢复草稿失败')
    else void refreshDraftGroups()
  }

  const openActiveHistory = () => {
    if (viewerIsBlocked()) return
    const doc = store.getSnapshot().activeDoc
    if (!doc) return
    setHistoryRecords(doc.recovery.history ?? [])
    setHistoryTitle(doc.entry?.title ?? doc.path)
    setHistoryOpen(true)
  }

  const discardActiveDraft = (tabId = null) => {
    diag.log('recovery-action', { bodyId: bodyIdRef.current, action: 'discard-draft', activeDoc: store.getSnapshot().activeDoc?.path ?? null, viewerOpen: viewerIsBlocked() })
    if (viewerIsBlocked()) return
    const doc = store.getSnapshot().activeDoc
    if (!doc) return
    if (!window.confirm('丢弃当前草稿并回到磁盘版本？历史快照会保留。')) return
    store.discardDraft(doc.path, tabId)
    void refreshDraftGroups()
  }

  const restoreHistory = async (id) => {
    diag.log('recovery-action', { bodyId: bodyIdRef.current, action: 'restore-history', historyId: typeof id === 'string' ? id.slice(0, 64) : null, activeDoc: store.getSnapshot().activeDoc?.path ?? null, viewerOpen: viewerIsBlocked() })
    if (viewerIsBlocked()) return
    const doc = store.getSnapshot().activeDoc
    if (!doc) return
    const result = await store.recoverHistory(doc.path, id)
    if (!result.ok) store.setNotice(result.error ?? '恢复历史版本失败')
    else {
      setHistoryOpen(false)
      void refreshDraftGroups()
    }
  }

  const resolveWithDisk = async () => {
    diag.log('reconcile-action', { bodyId: bodyIdRef.current, action: 'with-disk', activeDoc: store.getSnapshot().activeDoc?.path ?? null, reconcile: store.getSnapshot().activeDoc?.reconcile ?? null, viewerOpen: viewerIsBlocked() })
    if (viewerIsBlocked()) return
    const doc = store.getSnapshot().activeDoc
    if (!doc) return
    if (doc.reconcile?.busy === true) return
    if (doc.dirty && !window.confirm('以磁盘为准会用磁盘内容替换编辑器；当前草稿会先保存为独立可恢复快照。继续？')) return
    const result = await store.resolveReconcile(doc.path, 'disk')
    if (!result.ok) store.setNotice(result.reason === 'busy' ? '冲突处理中，请稍候' : (result.error ?? '重载磁盘失败'))
    else void refreshDraftGroups()
  }

  const resolveOverwrite = async () => {
    diag.log('reconcile-action', { bodyId: bodyIdRef.current, action: 'overwrite-disk', activeDoc: store.getSnapshot().activeDoc?.path ?? null, reconcile: store.getSnapshot().activeDoc?.reconcile ?? null, viewerOpen: viewerIsBlocked() })
    if (viewerIsBlocked()) return
    const doc = store.getSnapshot().activeDoc
    if (!doc) return
    if (doc.reconcile?.busy === true) return
    if (!window.confirm('用当前编辑器内容覆盖磁盘？\n\n会先重新读取磁盘最新版本，再用新的 expectedHash 做 CAS；覆盖前的磁盘内容会进入备份；如果磁盘又被修改，仍会停下并保留草稿。')) return
    const result = await store.resolveReconcile(doc.path, 'overwrite', {
      bodyId: bodyIdRef.current,
      source: 'reconcile-overwrite',
      viewerOpen: viewerIsBlocked(),
    })
    if (!result.ok) store.setNotice(result.reason === 'busy' ? '冲突处理中，请稍候' : (result.error ?? '冲突处理失败'))
    else {
      restartPreview()
      void refreshDraftGroups()
    }
  }

  const insertImportDraft = (text) => {
    if (viewerIsBlocked()) return false
    const view = editor.current
    if (!view) {
      store.setNotice('当前没有可编辑的文档；导入草稿未插入')
      return false
    }
    const insertion = buildImportInsertion(view.state.doc.toString(), text)
    if (insertion === null) {
      store.setNotice('导入草稿为空，未插入')
      return false
    }
    // Appending into an unclosed fenced code block can let a harmless-looking
    // code-block draft close the user's fence and become executable MDX. Force
    // a parse to EOF; if the tree is unavailable/incomplete, fail closed.
    const tree = ensureSyntaxTree(view.state, view.state.doc.length, 50)
    if (endsInOpenFence(tree, view.state.doc.length)) {
      store.setNotice('当前文档末尾的代码围栏尚未闭合；为避免改变 Markdown 结构，导入草稿未插入。请先补全围栏后重试')
      return false
    }
    view.dispatch({
      changes: { from: insertion.at, insert: insertion.insertion },
      selection: { anchor: insertion.anchor },
      // One image/AI insertion is one undo step; do not merge it with typing.
      annotations: isolateHistory.of('full'),
    })
    view.focus()
    setImportOpen(false)
    store.setNotice(
      '导入草稿已追加到文档末尾；请核对公式与符号，再按 Cmd+S 保存',
      { tone: 'success', ttlMs: 10_000 },
    )
    return true
  }

  React.useEffect(() => {
    try { localStorage.setItem(FILES_PINNED_KEY, filesPinned ? '1' : '0') } catch { /* storage unavailable */ }
  }, [filesPinned])

  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setQuickOpen(false)
        if (pendingNav !== null) setPendingNav(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingNav])

  sendThemeRef.current = () => {
    if (!connected.current) return
    iframe.current?.contentWindow?.postMessage(
      { source: SOURCE, v: VERSION, type: 'theme', nonce, theme: darkTheme ? 'dark' : 'light' },
      CHILD_ORIGIN,
    )
  }

  sendRevealRef.current = (line) => {
    if (!connected.current || pageModeRef.current) return
    iframe.current?.contentWindow?.postMessage(
      { source: SOURCE, v: VERSION, type: 'reveal-line', nonce, line },
      CHILD_ORIGIN,
    )
  }

  React.useEffect(() => {
    if (!connected.current) return
    iframe.current?.contentWindow?.postMessage(
      { source: SOURCE, v: VERSION, type: 'guard', nonce, dirty: activeDoc?.dirty === true },
      CHILD_ORIGIN,
    )
  }, [activeDoc?.dirty, nonce])

  React.useEffect(() => {
    const post = (payload) => {
      iframe.current?.contentWindow?.postMessage(
        { source: SOURCE, v: VERSION, nonce, ...payload },
        CHILD_ORIGIN,
      )
    }
    const onMessage = (event) => {
      if (event.origin !== CHILD_ORIGIN) return
      if (event.source !== iframe.current?.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.source === R2_PARENT_SOURCE) {
        if (data.v !== R2_PARENT_VERSION) return
        const controller = r2ParentRef.current
        if (!controller) return
        // The message source is the authoritative child window. A transient
        // null iframe ref must not clear the frame identity (which would queue
        // every command and leave the ack path stalled).
        const sourceWindow = event.source && typeof event.source === 'object' ? event.source : null
        if (sourceWindow) controller.setFrame(sourceWindow)
        if (data.type === 'r2-hello') {
          if (data.handshake !== A2_HANDSHAKE_VERSION) {
            // Fail closed: revoke the current connection identity and pending
            // confirmation; old ACKs become unsolicited. A later valid hello
            // can recover, reissuing the preserved latest write.
            controller.resetHandshake('handshake-version-mismatch')
            setA2State('hello-version-mismatch')
            return
          }
          if (controller.acceptHello(data)) setA2State('hello')
        } else if (data.type === 'r2-ack') {
          const result = controller.handleAck(data)
          window.__DSH_R2_LAST_ACK__ = { at: Date.now(), ...result }
          setA2State(result.ok ? 'ack' : `reject:${result.reason ?? 'unknown'}`)
          if (result.ok && result.ack) {
            const current = previewRef.current
            if (current !== null
              && result.ack.revision === current.revision
              && result.ack.writeId === current.lastWriteId
              && result.ack.session === current.session
              && result.ack.docId === current.docId
              && result.ack.route === current.route) {
              commitPreviewRendered(current, current.source)
            }
          }
        }
        return
      }
      if (data.source !== SOURCE || data.nonce !== nonce) return
      if (data.v !== VERSION) {
        store.setNotice(`桥版本不匹配（插件 v${String(data.v)} / 编辑器 v${VERSION}）`)
        return
      }

      if (data.type === 'sidebars') {
        if (data.sidebars && typeof data.sidebars === 'object') {
          rememberSidebarPayload(data.sidebars)
          notePreviewSignature(data.sidebars)
          console.info('[dsh-live-editor] sidebars update', {
            generatedAt: data.sidebars.generatedAt ?? data.generatedAt ?? null,
            timeOrigin: data.timeOrigin ?? null,
          })
        }
        return
      }
      if (data.type === 'doc-map') {
        if (viewerIsBlocked()) return
        replaceBridgeDocs(data.docMap)
        if (isString(data.locale)) bridgeMetaRef.current.locale = data.locale
        if (isString(data.routeBasePath)) bridgeMetaRef.current.routeBasePath = data.routeBasePath
        return
      }
      if (data.type === 'doc') {
        // A valid preview acknowledgement is data, not navigation: it must
        // still settle the pending draft render while the viewer is open.
        notePreviewDoc(data.doc)
        if (viewerIsBlocked()) return
        mergeBridgeDoc(data.doc)
        // Route-state (50ms) is normally enough, but a late DocItem effect can
        // arrive after a page route-state. If the pending page is this doc,
        // refine it only after the draft is safe; route-state remains
        // authoritative for the next navigation.
        const current = store.getSnapshot()
        const doc = data.doc
        const pathname = data.pathname
        if (current.page !== null && doc && isString(doc.source) && isString(pathname)
          && normalizePath(current.page.permalink) === normalizePath(pathname)) {
          void (async () => {
            const snapshot = store.getSnapshot()
            if (snapshot.activeDoc?.dirty) {
              const safe = await store.ensureDraftSafe(snapshot.activeDoc.path)
              if (!safe.ok || viewerIsBlocked()) return
            }
            if (viewerIsBlocked()) return
            const source = normalizeSource(doc.source)
            if (source !== null) store.previewRoute({ source, permalink: doc.permalink, title: doc.title })
          })()
        }
        return
      }

      const snapshotNow = store.getSnapshot()
      if (data.type === 'hello') {
        console.info('[dsh-live-editor] bridge hello', {
          href: data.href ?? null,
          timeOrigin: data.timeOrigin ?? null,
          pathname: data.pathname ?? null,
          docSource: data.doc?.source ?? null,
        })
        if (!isString(data.href) || !isString(data.pathname)) return
        clearSpaTimer()
        pendingSpaRef.current = null
        if (isString(data.bootId)) bridgeMetaRef.current.bootId = data.bootId
        if (isString(data.locale)) bridgeMetaRef.current.locale = data.locale
        if (isString(data.routeBasePath)) bridgeMetaRef.current.routeBasePath = data.routeBasePath
        connected.current = false
        setStatus('handshaking')
        clearTimer()
        armTimer(5000, 'timeout')
        post({ type: 'ready' })
        return
      }
      if (data.type === 'ready-ack') {
        connected.current = true
        clearTimer()
        setStatus('connected')
        if (isString(data.bootId)) bridgeMetaRef.current.bootId = data.bootId
        if (isString(data.locale)) bridgeMetaRef.current.locale = data.locale
        if (isString(data.routeBasePath)) bridgeMetaRef.current.routeBasePath = data.routeBasePath
        replaceBridgeDocs(data.docMap)
        mergeBridgeDoc(data.doc)
        notePreviewDoc(data.doc)
        if (data.sidebars && typeof data.sidebars === 'object') {
          rememberSidebarPayload(data.sidebars)
          notePreviewSignature(data.sidebars)
        }
        console.info('[dsh-live-editor] bridge ready-ack', {
          timeOrigin: data.timeOrigin ?? null,
          hasSidebars: Boolean(data.sidebars),
          hasDocMap: Array.isArray(data.docMap),
          bootId: data.bootId ?? null,
        })
        sendThemeRef.current?.()
        const active = store.getSnapshot().activeDoc
        post({ type: 'guard', dirty: active?.dirty === true })
        return
      }
      if (!connected.current) return

      if (data.type === 'route-state') {
        notePreviewDoc(data.doc)
        if (viewerIsBlocked()) return
        console.info('[dsh-live-editor] timing route-state', { pathname: data.pathname ?? null, navId: data.navId ?? null, t: performance.now() })
        console.info('[dsh-live-editor] route-state', {
          pathname: data.pathname ?? null,
          source: data.doc?.source ?? null,
          navId: data.navId ?? null,
          bootId: data.bootId ?? null,
        })
        clearSpaTimer()
        pendingSpaRef.current = null
        if (isString(data.bootId) && bridgeMetaRef.current.bootId !== null
          && data.bootId !== bridgeMetaRef.current.bootId) return
        if (data.doc && typeof data.doc === 'object') {
          mergeBridgeDoc(data.doc)
          notePreviewDoc(data.doc)
        }
        void (async () => {
          const current = store.getSnapshot()
          if (current.activeDoc?.dirty) {
            const safe = await store.ensureDraftSafe(current.activeDoc.path)
            if (!safe.ok) {
              store.setNotice('预览已跳转；草稿尚未安全暂存，未自动切换。')
              return
            }
          }
          if (viewerIsBlocked()) return
          const doc = data.doc && typeof data.doc === 'object' ? data.doc : null
        const instanceReady = doc === null ? null : doc.previewInstanceReady === true
        console.info('[dsh-live-editor][diag] route previewInstanceReady', {
          pathname: data.pathname ?? null,
          source: doc?.source ?? null,
          previewInstanceReady: instanceReady,
          raw: doc?.previewInstanceReady,
          bootId: data.bootId ?? null,
          t: performance.now(),
        })
        // A route update with doc:null means "not known yet", not "no preview
        // instance"; keep the previous known value instead of showing restart.
        if (doc !== null) setSitePreviewReady(instanceReady)
          const source = doc === null ? null : normalizeSource(doc.source)
          if (doc !== null && source !== null) {
            const routed = store.previewRoute({ source, permalink: doc.permalink, title: doc.title })
            if (!routed.ok && routed.reason === 'dirty') {
              store.setNotice('预览已跳转到另一篇文档；草稿尚未安全暂存。')
            }
          } else {
            const permalink = isString(data.pathname) ? data.pathname : '/'
            const mapped = store.getSnapshot().index.docByPermalink.get(normalizePath(permalink))
            if (mapped) {
              // The child can emit a transient doc:null before the DocItem
              // effect publishes; the Host index already knows this permalink.
              store.previewRoute({ permalink, title: mapped.title, source: mapped.source })
            } else {
              store.setPage({ permalink, title: isString(data.title) ? data.title : permalink, reason: 'unmapped' })
            }
          }
        })()
        return
      }

      if (data.type === 'nav-intent') {
        if (viewerIsBlocked()) return
        console.info('[dsh-live-editor] timing nav-intent', { href: data.href ?? null, pathname: data.pathname ?? null, t: performance.now() })
        if (data.kind !== 'link' || !isString(data.href) || !isString(data.pathname)) return
        let url
        try { url = new URL(data.href, CHILD_ORIGIN) } catch { return }
        if (url.origin !== CHILD_ORIGIN) return
        const last = lastNavIntentRef.current
        if (last.href === url.href && Date.now() - last.at < 100) return
        lastNavIntentRef.current = { href: url.href, at: Date.now() }
        void (async () => {
          const current = store.getSnapshot()
          if (current.activeDoc?.dirty) {
            const safe = await store.ensureDraftSafe(current.activeDoc.path)
            if (!safe.ok) {
              store.setNotice('预览跳转已阻止：草稿尚未安全暂存。')
              return
            }
          }
          if (viewerIsBlocked()) return
          const mapped = current.index.docByPermalink.get(normalizePath(url.pathname))
          const rewritten = mapped?.previewPermalink
            ? `${CHILD_ORIGIN}${mapped.previewPermalink}${url.search}${url.hash}`
            : url.href
          console.info('[dsh-live-editor] timing nav-rewrite', {
            from: url.pathname, to: rewritten, t: performance.now(),
          })
          sendNavigate(rewritten)
        })()
        return
      }

      if (data.type === 'block-click') {
        if (viewerIsBlocked()) return
        const active = store.getSnapshot().activeDoc
        if (!active || active.loadPhase !== 'ready') return
        const clickedSource = normalizeSource(data.docSource)
          ?? store.getSnapshot().index.docByPermalink.get(normalizePath(data.permalink))?.source
          ?? null
        const activePermalink = previewHrefFor(active.entry)
        const bridgePermalink = bridgeDocsRef.current.get(active.entry.source)?.permalink ?? null
        const permalinkMatches = isPermalink(data.permalink) && [activePermalink, active.entry.previewPermalink, bridgePermalink]
          .filter((value) => isString(value))
          .some((value) => normalizePath(value) === normalizePath(data.permalink))
        console.info('[dsh-live-editor] block-click', {
          line: data.line, source: clickedSource, activeSource: active.entry.source,
          permalink: data.permalink, activePermalink, bridgePermalink, permalinkMatches,
        })
        const exact = data.exact === true
        if (!Number.isInteger(data.line) || data.line < 1 || data.line > 1000000
          || !Number.isInteger(data.endLine) || data.endLine < data.line || data.endLine > 1000000
          || !BLOCK_TAGS.has(data.tag)
          || clickedSource !== active.entry.source
          || !permalinkMatches
          || !isString(data.text) || data.text.length > 200) {
          return
        }
        revealLine(data.line, data.endLine)
        window.__dshLiveEditorLastClick = {
          docSource: clickedSource, line: data.line, endLine: data.endLine, tag: data.tag, text: data.text, exact,
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [nonce, store, notePreviewSignature, rememberSidebarPayload])

  React.useEffect(() => {
    let cancelled = false
    let interval = null
    const probe = async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)
      try {
        const response = await fetch(`${CHILD_ORIGIN}/__dsh-live-editor/health`, {
          mode: 'cors', cache: 'no-store', signal: controller.signal,
        })
        if (!cancelled) setServerOnline(response.ok)
      } catch {
        if (!cancelled) setServerOnline(false)
      } finally {
        clearTimeout(timeout)
      }
    }
    void probe()
    interval = setInterval(probe, 2000)
    return () => { cancelled = true; if (interval !== null) clearInterval(interval) }
  }, [])

  const onIframeLoad = () => {
    // A load is a connection rebuild, not a document change: keep the newest
    // successful write so the new hello can reissue its confirmation. Only a
    // document/route change clears it (the setFrame effect below).
    r2ParentRef.current?.resetHandshake('iframe-load')
    // A load event is a full document navigation (initial, restart, or the v2
    // child's location.assign fallback). A SPA route change does not fire it.
    // If the bridge is already connected, the reloading child will send a new
    // hello (window.name carries its nonce); that hello owns the reset.
    if (connected.current) return
    clearTimer()
    clearRouteTimer()
    clearSpaTimer()
    pendingSpaRef.current = null
    setStatus('handshaking')
    armTimer(20000, 'timeout')
  }

  const bridgeSrc = (() => {
    if (iframeUrl === null) return 'about:blank'
    const hashIndex = iframeUrl.indexOf('#')
    const base = hashIndex >= 0 ? iframeUrl.slice(0, hashIndex) : iframeUrl
    const hash = hashIndex >= 0 ? iframeUrl.slice(hashIndex) : ''
    const separator = base.includes('?') ? '&' : '?'
    return `${CHILD_ORIGIN}${base}${separator}dshBridge=1&nonce=${encodeURIComponent(nonce)}${hash}`
  })()
  const offline = serverOnline === false
  const showSource = effectiveLayout !== 'preview'
  const showPreview = effectiveLayout !== 'source'
  const dirty = activeDoc?.dirty === true
  const saving = activeDoc?.savePhase === 'saving'
  const saveError = activeDoc?.saveError ?? null
  // Route notices are informational (with a reload action) and must not make
  // the status bar claim a save conflict.
  const messageError = saveError
    ?? activeDoc?.loadError
    ?? (snap.phase === 'index-error' ? snap.index.error : null)
    ?? snap.draftStorageError
  const saveNotice = activeDoc?.saveNotice
  // Informational notices are transient UI, not save conflicts. They can carry
  // a lifetime and a close button; real errors stay in the persistent slot.
  const noticeText = snap.notice ?? saveNotice
  const noticeMeta = snap.notice !== null ? snap.noticeMeta : null
  const noticeTone = snap.notice !== null ? (snap.noticeMeta?.tone ?? 'error') : 'success'
  const dismissNotice = () => {
    if (snap.notice !== null) store.clearNotice()
    else store.clearSaveNotice(activeDoc?.path)
  }
  const sourceText = activeDoc?.text ?? null
  const sourceError = activeDoc?.loadError ?? (snap.phase === 'index-error' ? snap.index.error : null)
  const statusValue = !showPreview ? 'hidden' : offline ? 'offline' : status
  const lastDoc = snap.lastActivePath !== null ? store.getDoc(snap.lastActivePath) : null
  const pageReturn = snap.page !== null && lastDoc !== null
    ? {
        label: lastDoc.entry?.title ?? lastDoc.path,
        dirty: lastDoc.dirty === true,
        onClick: () => openFromTree(lastDoc.path),
      }
    : null
  const docTitle = activeDoc?.entry?.title ?? activeDoc?.path ?? ''
  const sidebarTree = React.useMemo(
    () => buildSidebarTree(sidebarPayload, snap.index.docs, { instanceId: activeDoc?.entry?.instanceId ?? 'default' }),
    [sidebarPayload, snap.index.docs, activeDoc?.entry?.instanceId],
  )
  const previewStatus = (() => {
    if (activeDoc === null || snap.page !== null) return null
    if (a2Capability === false) return { phase: 'disabled', error: false, label: '草稿预览：实时预览已停用（回滚安全模式）', title: '预览通道已关闭；编辑与草稿恢复仍可用，实时预览不可用' }
    if (!showPreview) return { phase: 'hidden', error: false, warning: structuralPending, label: `草稿预览：预览已隐藏，显示后确认${structuralPending ? ' · 结构变化未同步' : ''}`, title: structuralPending ? '正文已实时；title/slug/sidebar 等结构变化需要保存后才同步' : '预览页面已加载；显示预览面板后确认最新草稿' }
    if (hostPreviewReady && sitePreviewReady === false) return { phase: 'restart-required', error: false, label: 'staging 已初始化，但 site 启动时未加载 → 请有序重启', title: 'Host staging 已就绪，但当前 Docusaurus dev server 启动时没有 second docs；请重启 phase2 dev server' }
    if (!hostPreviewReady) return { phase: 'not-ready', error: false, label: 'staging 未就绪 · 当前为真实页面', title: 'Host staging manifest 未就绪；预览回退到真实 /docs 页面' }
    const phase = previewState.phase
    const dirtyText = activeDoc.dirty ? ' · 未写盘' : (previewState.saved ? ' · 已保存' : '')
    const structuralText = structuralPending ? ' · 结构变化未同步' : ''
    const structuralTitle = structuralPending
      ? '正文已实时渲染；title/slug/sidebar 等结构变化需要保存后才同步，当前预览的页面标题/侧栏/路由可能仍是旧值'
      : null
    if (phase === 'error') {
      const connectionError = offline === true || serverOnline === false
      return {
        phase,
        error: true,
        warning: structuralPending,
        label: `草稿预览：${connectionError ? '预览站点未就绪/连接断开' : '编译错误 · 上一帧'}${structuralText}${dirtyText}`,
        title: connectionError ? '预览站点未就绪；草稿仍在，站点恢复后点预览框内“重载”' : (previewState.error ?? '编译错误'),
      }
    }
    if (phase === 'rendered') return { phase, error: false, warning: structuralPending, label: `草稿预览：已渲染${structuralText}${dirtyText}`, title: structuralTitle ?? '预览来自 staging 草稿，尚未写盘' }
    if (phase === 'writing') return { phase, error: false, warning: structuralPending, label: `草稿预览：更新中…${structuralText}${dirtyText}`, title: structuralTitle ?? '正在写入 staging 并等待 HMR 渲染' }
    if (phase === 'waiting') return { phase, error: false, warning: structuralPending, label: `草稿预览：准备中…${structuralText}${dirtyText}`, title: structuralTitle ?? '等待草稿加载后写入 staging' }
    return { phase, error: false, warning: structuralPending, label: `草稿预览${structuralText}${dirtyText}`, title: structuralTitle ?? '预览来自 staging，不写真实 docs' }
  })()

  React.useEffect(() => {
    previewVisibleRef.current = showPreview
    if (!showPreview) {
      if (previewAckTimerRef.current !== null) {
        clearTimeout(previewAckTimerRef.current)
        previewAckTimerRef.current = null
      }
      const current = previewRef.current
      if (current !== null && current.renderedRevision !== current.revision) {
        previewHiddenPendingRef.current = { current, revision: current.revision }
      }
      return
    }
    const pending = previewHiddenPendingRef.current
    previewHiddenPendingRef.current = null
    if (pending !== null && previewRef.current === pending.current && pending.current.renderedRevision !== pending.revision) {
      startPreviewAckTimeout(pending.current, pending.revision)
    }
  }, [showPreview])

  const changeLayout = (mode) => {
    if (snap.page !== null) {
      setPageModeView(mode)
      return
    }
    setLayout(mode)
  }
  const filePanelProps = {
    entries: snap.index.entries,
    sidebarTree,
    activePath: snap.activePath,
    draftPaths: snap.draftPaths,
    onOpen: requestOpen,
    onClose: () => setFilesOpen(false),
    onTogglePin: () => setFilesPinned((value) => !value),
    onRefresh: () => {
      void store.loadIndex({ refresh: true, preferredPath: snap.activePath })
      refreshDiscovery()
    },
    discoveredInstances,
    discoveredDocs,
    onOpenReadOnly: openReadOnly,
  }

  return h('div', {
    'data-dsh-live-editor': 'phase2',
    ref: rootRef,
    style: {
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      font: `${T.uiSize}/1.4 ${T.font}`, color: T.text, background: T.bg,
      '--live-editor-code-size': `${fontSize}px`,
      '--live-editor-heading': darkTheme ? '#9ec7e0' : '#2f5d7a',
      '--live-editor-math': darkTheme ? '#8fb8d4' : '#2f5d7a',
      '--live-editor-special': darkTheme ? '#d6a083' : '#9a5a3a',
      '--live-editor-function': darkTheme ? '#b9a7d9' : '#6b5b95',
      '--live-editor-success': darkTheme ? '#7fae8c' : '#2e7d4f',
      '--live-editor-error': darkTheme ? '#d08a84' : '#a8322a',
      '--live-editor-warning': darkTheme ? '#c7a45c' : '#8a5a12',
      '--live-editor-math-bg': darkTheme ? 'color-mix(in srgb, #8fb8d4 4%, transparent)' : 'color-mix(in srgb, #2f5d7a 6%, transparent)',
      '--live-editor-selection': darkTheme ? 'color-mix(in srgb, #8fb8d4 16%, transparent)' : 'color-mix(in srgb, #2f5d7a 13%, transparent)',
    },
  },
  h(Toolbar, {
    layout: toolbarLayout,
    pageMode: snap.page !== null,
    fontSize,
    narrowSplit,
    dirty,
    saving,
    sourceHash: activeDoc?.baseHash ?? null,
    onLayoutChange: changeLayout,
    onFontSizeChange: setFontSize,
    onSave: () => save('toolbar'),
    readOnly: !siteWritable,
    onReload: activeDoc?.reconcile?.required === true ? resolveWithDisk : reloadFromDisk,
    onImport: () => {
      if (viewerIsBlocked() || activeDoc === null) return
      setImportOpen(true)
    },
    canImport: activeDoc !== null,
    filesOpen,
    onToggleFiles: () => setFilesOpen((value) => !value),
    onQuickOpen: () => {
      const blocked = viewerIsBlocked()
      diag.log('quickopen-toolbar', { bodyId: bodyIdRef.current, blocked })
      if (!blocked) setQuickOpen(true)
    },
    docTitle,
    draftCount: Math.max(draftGroups.length, snap.recoveryPaths.length, dirty ? 1 : 0),
    a2Capability,
    a2Client: R2_ENABLED(),
    a2State,
    a2HandshakeVersion: A2_HANDSHAKE_VERSION,
    onOpenDrafts: () => {
      setDraftsOpen(true)
      void refreshDraftGroups()
    },
    previewStatus,
  }),
  h(MessageBar, {
    error: messageError,
    notice: noticeText,
    tone: noticeTone,
    noticeId: noticeMeta?.id ?? null,
    ttlMs: noticeMeta?.ttlMs ?? null,
    onDismissNotice: dismissNotice,
    // A conflict is resolved from the conflict bar (which keeps a draft
    // snapshot); do not offer a second, differently-behaving reload button.
    onReloadDisk: activeDoc?.reconcile?.required === true ? null : reloadFromDisk,
  }),
  h(ConfirmBar, {
    pending: pendingNav,
    busy: pendingBusy,
    onRetry: retryDraftAndGo,
    onSwitchAnyway: switchAnyway,
    onCancel: () => setPendingNav(null),
  }),
  activeDoc?.recovery?.dismissed !== true && h(RecoveryBar, {
    doc: activeDoc,
    onRecover: recoverActiveDraft,
    onHistory: openActiveHistory,
    onDiscard: discardActiveDraft,
    onDismiss: () => {
      if (viewerIsBlocked()) return
      const doc = store.getSnapshot().activeDoc
      if (doc) store.dismissRecovery(doc.path)
    },
  }),
  activeDoc?.reconcile?.required === true && h(ConflictBar, {
    mode: activeDoc.reconcile.restoredFrom === 'external-change'
      ? 'external-change'
      : activeDoc.reconcile.restoredFrom === 'write-unconfirmed'
        ? 'write-unconfirmed'
        : 'restored-draft',
    error: null,
    busy: activeDoc.reconcile.busy === true,
    onUseDisk: resolveWithDisk,
    onOverwrite: resolveOverwrite,
  }),
  h('div', { ref: workspace, style: { display: 'flex', flex: '1 1 auto', minHeight: 0, position: 'relative' } },
    h('div', {
      style: { display: 'contents' },
      inert: readOnlyView !== null ? '' : undefined,
    },
    h(SourcePane, {
      key: 'source-pane',
      sourceHostRef,
      visible: showSource,
      borderRight: false,
      sourceText,
      sourceError,
      unrecognized: snap.page,
      pageReturn,
      editorError: editorMountError,
      paneStyle: sourcePaneStyle,
    }),
    effectiveLayout === 'split' && h(SplitHandle, {
      key: 'split-handle',
      onPointerDown: startSplitDrag,
      onDoubleClick: () => setSplitRatio(0.55),
    }),
    h(PreviewPane, {
      key: 'preview-pane',
      iframeRef: iframe,
      src: bridgeSrc,
      attempt,
      visible: showPreview,
      timeout: status === 'timeout',
      loading: iframeUrl === null && snap.phase !== 'index-error',
      onLoad: onIframeLoad,
      onReload: restartPreview,
      paneStyle: previewPaneStyle,
      previewStatus,
    }),
    // Keep the source pane first in the flex DOM so toggling the pinned rail
    // never remounts it; order:-1 still places the rail visually on the left.
    pinnedFiles && h('div', {
      key: 'files-rail',
      style: { order: -1, flex: '0 0 268px', width: 268, minWidth: 0, display: 'flex', minHeight: 0 },
    }, h(FilePanel, { ...filePanelProps, pinned: true })),
    filesOpen && !pinnedFiles && h(React.Fragment, { key: 'files-overlay' },
      h('div', {
        onClick: () => setFilesOpen(false),
        style: { position: 'absolute', inset: 0, zIndex: 25, background: 'rgba(0,0,0,0.22)' },
      }),
      h(FilePanel, { ...filePanelProps, pinned: false }),
    ),
    ),
    readOnlyView !== null && h(ReadOnlyViewer, { key: 'read-only-viewer', view: readOnlyView, onClose: closeReadOnly }),
  ),
  h(QuickOpen, {
    open: quickOpen,
    docs: snap.index.docs,
    onClose: () => setQuickOpen(false),
    onSelect: (path) => {
      setQuickOpen(false)
      requestOpen(path)
    },
  }),
  h(HistoryDialog, {
    open: historyOpen,
    title: historyTitle,
    records: historyRecords,
    onRestore: restoreHistory,
    onClose: () => setHistoryOpen(false),
  }),
  h(ImportPanel, {
    open: importOpen,
    activePath: activeDoc?.path ?? null,
    taskKey: activeDoc?.path
      ? importTaskKey({ siteId, sessionId, tabId: tabDraftId, path: activeDoc.path })
      : null,
    onClose: () => setImportOpen(false),
    onInsert: insertImportDraft,
  }),
  h(DraftsPanel, {
    open: draftsOpen,
    groups: draftGroups,
    onOpen: (path) => {
      setDraftsOpen(false)
      void requestOpen(path)
    },
    onHistory: (path) => {
      setDraftsOpen(false)
      setPendingHistoryPath(path)
      void requestOpen(path)
    },
    onClose: () => setDraftsOpen(false),
    onRefresh: () => { void refreshDraftGroups() },
  }),
  h(StatusBar, {
    cursor,
    dirty,
    saving,
    saveError,
    savePhase: activeDoc?.savePhase,
    draft: activeDoc?.draft,
    status: statusValue,
    serverOnline,
    previewStatus,
    siteLabel: props.siteIdentity?.label ?? null,
    siteId,
    readOnly: !siteWritable,
  }),
  dragging && h('div', {
    'aria-hidden': 'true',
    onPointerUp: () => setDragging(false),
    style: {
      position: 'fixed', inset: 0, zIndex: 9999,
      cursor: 'col-resize', background: 'transparent', userSelect: 'none',
    },
  }),
  )
}

let siteIdentityPromise = null

function loadSiteIdentity () {
  if (siteIdentityPromise !== null) return siteIdentityPromise
  siteIdentityPromise = fetch('/api/live-editor/site', { cache: 'no-store' })
    .then(async (response) => {
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || data.ok !== true
        || typeof data.siteId !== 'string' || data.siteId.length === 0) {
        throw new Error(data?.error ?? `站点身份检查失败 (${response.status})`)
      }
      return {
        siteId: data.siteId,
        label: typeof data.label === 'string' ? data.label : null,
        writable: data.writable === true,
      }
    })
    .catch((error) => {
      // A failed identity check must not be cached as a usable identity; the
      // gate offers retry and never falls back to a hard-coded site id.
      siteIdentityPromise = null
      throw error
    })
  return siteIdentityPromise
}

function Body (props) {
  return h(SiteIdentityGate, {
    loadSite: loadSiteIdentity,
    renderBody: (siteIdentity) => h(LiveEditorBody, { ...props, siteIdentity }),
  })
}

function apply (ctx) {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID,
    kind: KIND,
    multiple: true,
    title: () => 'Live Editor',
    // Keep a distinct position: the built-in Workspace Files entry also uses
    // order 10, and ties are resolved by plugin registration order (unstable
    // across loads). 5 pins Live Editor first without touching DSH.
    guide: [{ id: 'open', order: 5, title: () => 'Live Editor', description: () => 'MDX 编辑与预览' }],
  }), 'live-editor-phase2: type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID,
  }, Body)), 'live-editor-phase2: body')

  // Live Editor tabs that are open but currently inactive have no mounted
  // body, so their drafts are not "closed". DSH's open-tab inventory is the
  // public source of truth; subscribe to it for the recovery scoping.
  ctx.inject(['sidebarRight'], (ctx) => {
    ctx.effect(() => {
      const source = ctx.sidebarRight.openTabs
      if (source === null || source === undefined || typeof source.getSnapshot !== 'function') return () => {}
      const sync = () => {
        const next = new Map()
        for (const tab of source.getSnapshot() ?? []) {
          if (tab?.kind !== KIND || typeof tab.tabId !== 'string' || typeof tab.sessionId !== 'string') continue
          if (!next.has(tab.sessionId)) next.set(tab.sessionId, new Set())
          next.get(tab.sessionId).add(tab.tabId)
        }
        openTabIds.clear()
        for (const [session, ids] of next) openTabIds.set(session, ids)
      }
      sync()
      const unsubscribe = typeof source.subscribe === 'function' ? source.subscribe(sync) : () => {}
      return () => {
        unsubscribe()
        openTabIds.clear()
      }
    }, 'live-editor-phase2: open tab inventory')
  })

  // QuickOpen used to live on a bare window.keydown for Mod+P. DSH's desktop
  // native keyboard bridge owns Mod+P (workspace.files) and consumes it before
  // the DOM, so the only correct owner is the application shortcut service.
  // Mod+Alt+P is free on desktop; Web uses Mod+Shift+P because workspace.files
  // owns Mod+Alt+P there. Every candidate is checked against the live catalog.
  ctx.inject(['shortcuts', 'sidebarRight'], (ctx) => {
    ctx.effect(() => {
      const candidates = {
        'desktop:macos': [
          { code: 'KeyP', modifiers: ['primary', 'shift'] },
          { code: 'KeyP', modifiers: ['primary', 'alt'] },
          { code: 'KeyP', modifiers: ['primary', 'alt', 'shift'] },
        ],
        'desktop:windows': [
          { code: 'KeyP', modifiers: ['primary', 'shift'] },
          { code: 'KeyP', modifiers: ['primary', 'alt'] },
          { code: 'KeyP', modifiers: ['primary', 'alt', 'shift'] },
        ],
        'desktop:linux': [
          { code: 'KeyP', modifiers: ['primary', 'shift'] },
          { code: 'KeyP', modifiers: ['primary', 'alt'] },
          { code: 'KeyP', modifiers: ['primary', 'alt', 'shift'] },
        ],
        'web:macos': [
          { code: 'KeyP', modifiers: ['primary', 'shift'] },
          { code: 'KeyP', modifiers: ['primary', 'alt', 'shift'] },
        ],
        'web:windows': [
          { code: 'KeyP', modifiers: ['primary', 'shift'] },
          { code: 'KeyP', modifiers: ['primary', 'alt', 'shift'] },
        ],
      }
      const defaults = {}
      for (const [profile, bindings] of Object.entries(candidates)) {
        for (const binding of bindings) {
          try {
            const info = ctx.shortcuts.describeBinding(binding)
            if (info.issue == null && (info.conflicts ?? []).length === 0) {
              defaults[profile] = binding
              break
            }
          } catch { /* invalid/unsupported profile: try the next candidate */ }
        }
      }
      if (Object.keys(defaults).length === 0) {
        console.warn('[dsh-live-editor] no free QuickOpen shortcut candidate')
        return () => {}
      }
      const command = {
        id: 'liveEditor.quickOpen',
        label: () => '快速打开',
        aliases: ['quick open', 'live editor quick open'],
        defaults,
        regions: ['page', 'editable', 'terminal'],
        modals: [],
        resolve: ({ target, modal = null }) => {
          // The official shortcut service reports the top modal from
          // [role=dialog][aria-modal=true]. On macOS/Windows Desktop its native
          // dispatch treats bindings as priority and skips the `modals`
          // allowlist, so the command must refuse here as well.
          if (modal !== null) {
            diag.log('quickopen-resolve', {
              modal,
              blockedByModal: true,
              target: diag.describeElement(target instanceof Element ? target : null),
              activeElement: diag.activeElementInfo(),
            })
            return { status: 'blocked', reason: 'modal' }
          }
          // Native keyboard input can carry no DOM target (or a target outside
          // the editor, e.g. the sidebar tab strip). Prefer the target's root,
          // then the focused/visible Live Editor root. A visible root is a
          // strong enough ownership signal for this editor-only command.
          const element = target instanceof Element ? target : null
          const directRoot = element?.closest('[data-dsh-live-editor="phase2"]') ?? null
          const focused = document.activeElement instanceof Element
            ? document.activeElement.closest('[data-dsh-live-editor="phase2"]')
            : null
          const roots = [...document.querySelectorAll('[data-dsh-live-editor="phase2"]')]
          const visible = roots.find((candidate) => (
            candidate.isConnected
            && candidate.getClientRects().length > 0
            && candidate.closest('[hidden], [aria-hidden="true"]') === null
          ))
          const root = directRoot ?? focused ?? visible ?? null
          const rootOpen = root === null ? undefined : quickOpenByRoot.get(root)
          const active = ctx.sidebarRight?.commandTarget?.(element)
          const tabOpen = active?.tabId === undefined ? undefined : quickOpenByTab.get(active.tabId)
          diag.log('quickopen-resolve', {
            modal,
            target: diag.describeElement(element),
            roots: roots.length,
            directRoot: directRoot !== null,
            focusedRoot: focused !== null && focused !== undefined,
            visibleRoot: visible !== undefined && visible !== null,
            picked: rootOpen !== undefined ? 'root' : tabOpen !== undefined ? 'tab' : 'none',
            tabId: active?.tabId ?? null,
            activeElement: diag.activeElementInfo(),
          })
          if (rootOpen !== undefined) return { status: 'handled', run: rootOpen }
          if (tabOpen !== undefined) return { status: 'handled', run: tabOpen }
          return { status: 'pass' }
        },
      }
      const disposers = []
      try {
        disposers.push(ctx.shortcuts.register(command))
        console.info('[dsh-live-editor] QuickOpen shortcut registered', { defaults })
      } catch (error) {
        console.warn('[dsh-live-editor] QuickOpen shortcut registration failed', error)
      }

      // Fallback binding for environments where the browser/DevTools owns
      // Cmd+Shift+P (e.g. the DevTools command menu while its console has
      // focus). Period/Comma are the only KeyP-free Web combinations admitted
      // on every Web platform by DSH; both are also ordinary desktop chords.
      const altDefaults = {}
      const altCandidates = {}
      for (const profile of [...Object.keys(candidates), 'web:linux']) {
        altCandidates[profile] = [
          { code: 'Period', modifiers: ['primary', 'shift'] },
          { code: 'Comma', modifiers: ['primary', 'shift'] },
        ]
      }
      for (const [profile, bindings] of Object.entries(altCandidates)) {
        for (const binding of bindings) {
          try {
            const info = ctx.shortcuts.describeBinding(binding)
            if (info.issue == null && (info.conflicts ?? []).length === 0) {
              altDefaults[profile] = binding
              break
            }
          } catch { /* try next */ }
        }
      }
      if (Object.keys(altDefaults).length > 0) {
        try {
          disposers.push(ctx.shortcuts.register({
            id: 'liveEditor.quickOpenAlternate',
            label: () => '快速打开（备用）',
            aliases: ['quick open alternate', 'live editor quick open alternate'],
            defaults: altDefaults,
            regions: ['page', 'editable', 'terminal'],
            modals: [],
            resolve: command.resolve,
          }))
          console.info('[dsh-live-editor] QuickOpen alternate shortcut registered', { defaults: altDefaults })
        } catch (error) {
          console.warn('[dsh-live-editor] QuickOpen alternate shortcut registration failed', error)
        }
      }
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'live-editor-phase2: QuickOpen shortcut')
  })
}

exports.apply = apply
exports.inject = ['slots', 'sidebarRightTabs', 'shortcuts', 'sidebarRight']
// Test-only export: lets node --test render the tab body without DSH.
exports.__Body = Body
exports.__LiveEditorBody = LiveEditorBody
// Test-only: expose the dom-root -> QuickOpen controller registry.
exports.__quickOpenByRoot = quickOpenByRoot
