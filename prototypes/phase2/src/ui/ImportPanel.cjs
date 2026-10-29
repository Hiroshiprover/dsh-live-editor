/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const h = React.createElement

const MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const buttonStyle = {
  border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.bg,
  color: T.text, padding: '4px 10px', cursor: 'pointer',
  font: `${T.uiSmallSize}/1.4 ${T.font}`,
}
const muted = { color: T.textTertiary, fontSize: T.uiSmallSize }

async function requestCancel (requestId) {
  if (typeof requestId !== 'string' || requestId.length === 0) return null
  const response = await fetch('/api/live-editor/import/cancel', {
    method: 'POST', keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId }),
  })
  const data = await response.json().catch(() => null)
  return { response, data }
}

function dropStoredTask (key) {
  if (typeof key !== 'string' || key.length === 0) return
  try { sessionStorage.removeItem(key) } catch { /* unavailable */ }
}

function saveStoredTask (key, result, draft) {
  if (typeof key !== 'string' || key.length === 0) return false
  if (typeof draft !== 'string' || draft.length === 0) return false
  try {
    sessionStorage.setItem(key, JSON.stringify({ result, draft }))
    return true
  } catch {
    return false
  }
}

// A document slot must never be overwritten by a task the user has already
// superseded. `seq` increases per started import; only the latest task for a
// key may publish. `taskFallback` keeps a completed review when sessionStorage
// rejects it, and `taskWatchers` lets a mounted panel receive a result that
// arrives after the panel was remounted for the same document.
let taskSeq = 0
const latestTaskSeq = new Map()
const taskWatchers = new Map()
const taskFallback = new Map()
const STORAGE_WARNING = '草稿已生成，但浏览器暂存写入失败；请立即插入或手动保存，关闭页面后可能无法恢复。'

function beginTaskSequence (key) {
  const seq = ++taskSeq
  latestTaskSeq.set(key, seq)
  taskFallback.delete(key)
  return seq
}

function publishDetachedResult (task, result, draft) {
  if (latestTaskSeq.get(task.taskKey) !== task.seq) return false
  const saved = saveStoredTask(task.taskKey, result, draft)
  if (!saved) taskFallback.set(task.taskKey, { seq: task.seq, result, draft })
  const watchers = taskWatchers.get(task.taskKey)
  if (watchers !== undefined) {
    for (const watcher of [...watchers]) {
      try { watcher({ result, draft, saved }) } catch { /* one watcher must not break others */ }
    }
  }
  return true
}

// Unmount and document switch cannot await a cancel round-trip, but they must
// not silently discard a draft the Host has already finalized. Mark the task
// detached, ask the Host to cancel, and keep the original request alive when
// cancellation is refused (409/404/unknown). A later 200 then persists under
// the task's ORIGINAL key; it never touches the replacement document's state.
function detachTask (task) {
  if (task === null || task === undefined || task.cancelled || task.detached) return
  task.detached = true
  void requestCancel(task.requestId).then((reply) => {
    if (task.cancelled) return
    const status = reply?.response?.status ?? null
    if (status === 200 && reply?.data?.cancelled === true) {
      // Confirmed cancel: the Host will not deliver a draft. A result that
      // already arrived wins; the export cannot both cancel and finalize.
      if (task.succeeded !== true) {
        task.cancelled = true
        task.controller.abort()
      }
    }
    // 409 finalizing, 404 already finished, or an unconfirmed network reply:
    // keep the request alive; transcribe() persists its successful result.
  }).catch(() => { /* keep the request alive; its success is authoritative */ })
}

/**
 * Phase 7 milestone B: choose one image, get one reviewable MDX draft, edit it,
 * then insert into the existing Model B editor buffer. This panel never saves
 * or writes a site file; the normal Cmd+S path remains the only formal write.
 */
function ImportPanel ({ open, activePath, taskKey, onClose, onInsert }) {
  const [capabilities, setCapabilities] = React.useState(null)
  const [capabilityError, setCapabilityError] = React.useState(null)
  const [file, setFile] = React.useState(null)
  const [dataUrl, setDataUrl] = React.useState(null)
  const [dataBase64, setDataBase64] = React.useState(null)
  const [mediaType, setMediaType] = React.useState(null)
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [cancelling, setCancelling] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [result, setResult] = React.useState(null)
  const [draft, setDraft] = React.useState('')
  const [resultKey, setResultKey] = React.useState(null)
  const abortRef = React.useRef(null)
  const insertedRef = React.useRef(false)
  const pathRef = React.useRef(activePath)
  const hydratedKeyRef = React.useRef(null)
  const resultKeyRef = React.useRef(null)
  const readerRef = React.useRef(null)
  const readerSeqRef = React.useRef(0)

  // A FileReader callback must never apply to a different selection, document,
  // or unmounted panel. Bumping the sequence invalidates every older read and
  // clearing the payload immediately prevents starting with stale bytes.
  const invalidateReader = () => {
    readerSeqRef.current += 1
    const reader = readerRef.current
    if (reader !== null) {
      reader.onload = null
      reader.onerror = null
      try { reader.abort?.() } catch { /* unavailable */ }
      readerRef.current = null
    }
    setFile(null)
    setDataUrl(null)
    setDataBase64(null)
    setMediaType(null)
    setName('')
  }

  // Hydrate each task key before enabling persistence. A closed-panel mount
  // must not interpret "no in-memory result" as "delete the saved review".
  React.useEffect(() => {
    if (!taskKey) {
      hydratedKeyRef.current = null
      return
    }
    if (hydratedKeyRef.current === taskKey) return
    hydratedKeyRef.current = taskKey
    const current = abortRef.current
    if (current !== null && current.taskKey !== taskKey) {
      abortRef.current = null
      detachTask(current)
      setBusy(false)
    }
    invalidateReader()
    let saved = null
    let fromFallback = false
    try {
      const raw = sessionStorage.getItem(taskKey)
      if (raw) saved = JSON.parse(raw)
    } catch { /* unavailable/corrupt */ }
    if (!saved) {
      const fallback = taskFallback.get(taskKey)
      if (fallback !== undefined && latestTaskSeq.get(taskKey) === fallback.seq) {
        saved = { result: fallback.result, draft: fallback.draft }
        fromFallback = true
      }
    }
    if (saved && typeof saved.draft === 'string' && saved.result && typeof saved.result === 'object') {
      resultKeyRef.current = taskKey
      setResultKey(taskKey)
      setResult(saved.result)
      setDraft(saved.draft)
      insertedRef.current = false
      if (fromFallback) {
        // Retry the write; only report the failure if the review still has no
        // durable owner. The mounted panel can discard it if the user wishes.
        const retried = saveStoredTask(taskKey, saved.result, saved.draft)
        if (retried) taskFallback.delete(taskKey)
        setError(retried ? null : STORAGE_WARNING)
      } else {
        setError(null)
      }
    } else {
      resultKeyRef.current = null
      setResultKey(null)
      setResult(null)
      setDraft('')
    }
  }, [taskKey])

  // A finalized draft may arrive after the panel was reopened for the same
  // document. Publish it into the mounted panel once, without overwriting a
  // newer task's result (publishDetachedResult already enforces the sequence).
  React.useEffect(() => {
    if (!taskKey) return undefined
    let watchers = taskWatchers.get(taskKey)
    if (watchers === undefined) {
      watchers = new Set()
      taskWatchers.set(taskKey, watchers)
    }
    const watcher = (payload) => {
      if (hydratedKeyRef.current !== taskKey) return
      resultKeyRef.current = taskKey
      setResultKey(taskKey)
      setResult(payload.result)
      setDraft(payload.draft)
      insertedRef.current = false
      setBusy(false)
      setCancelling(false)
      setError(payload.saved ? null : STORAGE_WARNING)
    }
    watchers.add(watcher)
    return () => {
      watchers.delete(watcher)
      if (watchers.size === 0) taskWatchers.delete(taskKey)
    }
  }, [taskKey])

  // Persist only a result explicitly owned by the current key. Never delete on
  // an empty mount: that was the closed-panel data-loss path.
  React.useEffect(() => {
    if (!taskKey || resultKey !== taskKey || resultKeyRef.current !== taskKey || !result) return
    saveStoredTask(taskKey, result, draft)
  }, [result, draft, resultKey, taskKey])

  // Handle document changes even while the panel is hidden. A hidden task must
  // not cross into the new document or be persisted under the new key.
  React.useEffect(() => {
    if (pathRef.current === activePath) return
    const previousKey = pathRef.current === null ? null : taskKey
    pathRef.current = activePath
    const current = abortRef.current
    if (current !== null && current.taskKey !== taskKey) {
      abortRef.current = null
      detachTask(current)
      setBusy(false)
    }
    invalidateReader()
    if (resultKeyRef.current !== taskKey) {
      resultKeyRef.current = null
      setResultKey(null)
      setResult(null)
      setDraft('')
      if (open) setError('文档已切换，导入任务已取消；没有插入任何内容')
    }
    // previousKey is intentionally only used for diagnostics/cleanup above.
    void previousKey
    if (open) onClose()
  }, [activePath, taskKey, open])

  // Leaving the tab/body must not leave an orphaned Host request running.
  React.useEffect(() => () => {
    readerSeqRef.current += 1
    const reader = readerRef.current
    if (reader !== null) {
      reader.onload = null
      reader.onerror = null
      try { reader.abort?.() } catch { /* unavailable */ }
      readerRef.current = null
    }
    const current = abortRef.current
    if (!current) return
    abortRef.current = null
    detachTask(current)
  }, [])

  React.useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setCapabilityError(null)
    fetch('/api/live-editor/import/capabilities', { cache: 'no-store' })
      .then((response) => response.json().catch(() => null).then((data) => ({ response, data })))
      .then(({ response, data }) => {
        if (cancelled) return
        if (!response.ok || !data?.ok) {
          setCapabilityError(data?.error ?? `能力检查失败 (${response.status})`)
          return
        }
        setCapabilities(data)
      })
      .catch((err) => { if (!cancelled) setCapabilityError(String(err?.message ?? err)) })
    return () => { cancelled = true }
  }, [open])

  if (!open) return null

  const resetResult = () => {
    resultKeyRef.current = null
    setResultKey(null)
    setResult(null)
    setDraft('')
    setError(null)
  }

  const onFile = (event) => {
    const selected = event.target.files?.[0]
    if (!selected) return
    insertedRef.current = false
    dropStoredTask(taskKey)
    taskFallback.delete(taskKey)
    resetResult()
    // Invalidate the previous reader and clear its payload before accepting the
    // new selection. Otherwise a late onload from the previous file (or from a
    // document that is no longer active) could submit its bytes under the new
    // name. Payload and metadata are only published together, after this read.
    invalidateReader()
    setFile(selected)
    const sequence = readerSeqRef.current
    if (!MEDIA.has(selected.type)) {
      setError('仅支持 PNG/JPEG/WebP/GIF；HEIC 请先转 JPEG')
      return
    }
    const max = capabilities?.limits?.maxImageBytes ?? 20 * 1024 * 1024
    if (selected.size > max) {
      setError(`图片过大（上限 ${max} 字节）`)
      return
    }
    const reader = new FileReader()
    readerRef.current = reader
    reader.onload = () => {
      if (readerSeqRef.current !== sequence || readerRef.current !== reader) return
      const value = String(reader.result ?? '')
      const comma = value.indexOf(',')
      if (comma < 0) { setError('无法读取图片数据'); return }
      setDataUrl(value)
      setDataBase64(value.slice(comma + 1))
      setName(selected.name)
      setMediaType(selected.type)
    }
    reader.onerror = () => {
      if (readerSeqRef.current !== sequence || readerRef.current !== reader) return
      setError('无法读取图片数据')
    }
    reader.readAsDataURL(selected)
  }

  const cancelTranscription = async () => {
    const current = abortRef.current
    if (!current || current.cancelPending) return
    current.cancelPending = true
    setCancelling(true)
    let reply = null
    try {
      reply = await requestCancel(current.requestId)
    } catch { /* network failure is not a confirmed cancel */ }
    const stillCurrent = abortRef.current === current
    if (stillCurrent) setCancelling(false)
    // The original request may have settled, or a newer task may have replaced
    // this one, while the cancel round-trip was in flight. Its terminal state
    // (and its requestId guard) wins; a late cancel reply must not overwrite it.
    if (current.succeeded === true || !stillCurrent || current.cancelled) return
    current.cancelPending = false
    const status = reply?.response?.status ?? null
    if (status === 200 && reply?.data?.cancelled === true) {
      current.cancelled = true
      abortRef.current = null
      current.controller.abort()
      dropStoredTask(current.taskKey)
      taskFallback.delete(current.taskKey)
      setBusy(false)
      setError('已取消转写；没有插入任何内容，可以重新开始')
      return
    }
    if (status === 409) {
      // Host has entered finalization and will still return 200 + draft. Keep
      // this request alive and let its success handler display/persist the draft.
      setError('导入已进入完成阶段，无法取消；正在接收审核草稿，请稍候。')
      return
    }
    if (status === 404) {
      setError('导入任务已结束或不存在；正在按原请求的最终结果处理。')
      return
    }
    setError('取消请求未确认；正在等待原导入结果，草稿不会因本次点击丢失。')
  }

  const transcribe = async () => {
    if (busy || dataBase64 === null || mediaType === null || name === '') return
    insertedRef.current = false
    dropStoredTask(taskKey)
    setBusy(true)
    setCancelling(false)
    setError(null)
    resetResult()
    const controller = new AbortController()
    const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `import-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const task = {
      controller, requestId, taskKey, cancelled: false, detached: false,
      seq: beginTaskSequence(taskKey),
    }
    abortRef.current = task
    try {
      const response = await fetch('/api/live-editor/import/image', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, mediaType, dataBase64, mode: 'verbatim', requestId }),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      if (task.cancelled) return
      if (task.detached) {
        // The panel was closed, unmounted, or switched documents while the Host
        // was finalizing. Persist under the ORIGINAL task key without touching
        // the replacement document's state; reopening the old document restores
        // it from sessionStorage.
        if (response.ok && data?.ok && typeof data.draft === 'string' && data.draft.length > 0) {
          task.succeeded = true
          publishDetachedResult(task, data, data.draft)
        }
        return
      }
      if (abortRef.current !== task || task.taskKey !== taskKey) return
      if (!response.ok || !data?.ok) {
        setError(data?.error ?? `转写失败 (${response.status})`)
        return
      }
      task.succeeded = true
      // A cancel 409/404 (or a network-slow cancel) may have set a neutral
      // waiting notice; the original request's success is authoritative.
      setCancelling(false)
      setError(null)
      resultKeyRef.current = task.taskKey
      setResultKey(task.taskKey)
      setResult(data)
      setDraft(data.draft ?? '')
    } catch (err) {
      if (task.cancelled || task.detached) return
      if (abortRef.current !== task) return
      if (err?.name === 'AbortError') {
        setError('已取消转写；没有插入任何内容，可以重新开始')
      } else {
        setError(`转写请求失败：${String(err?.message ?? err)}；没有插入任何内容`)
      }
    } finally {
      if (abortRef.current === task) {
        abortRef.current = null
        setBusy(false)
      }
    }
  }

  const insert = () => {
    if (insertedRef.current || draft.trim().length === 0) return
    if (resultKeyRef.current !== taskKey) return
    const inserted = onInsert(draft)
    if (inserted === false) {
      setError('草稿未插入：当前文档结构或状态不允许追加。请关闭面板检查文档（例如末尾代码围栏是否闭合）后重试。')
      return
    }
    insertedRef.current = true
    resultKeyRef.current = null
    setResultKey(null)
    setResult(null)
    setDraft('')
    setError(null)
    dropStoredTask(taskKey)
    taskFallback.delete(taskKey)
  }

  const modelLabel = capabilities?.model
    ? `${capabilities.model.provider} / ${capabilities.model.name ?? capabilities.model.model}`
    : '检查中…'
  const usage = result?.usage
  const warnings = result?.warnings ?? []
  const uncertainties = result?.uncertainties ?? []

  return h('div', {
    role: 'presentation',
    onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
    style: {
      position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.28)',
      display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: 40,
    },
  },
  h('div', {
    role: 'dialog', 'aria-label': '导入图片',
    style: {
      width: 'min(860px, 94vw)', maxHeight: 'calc(100vh - 80px)', overflow: 'auto',
      background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: T.radius,
      boxShadow: '0 12px 40px rgba(0,0,0,0.35)', padding: 12,
      display: 'flex', flexDirection: 'column', gap: 10,
      font: `${T.uiSize}/1.45 ${T.font}`,
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('strong', { style: { flex: 1 } }, '导入一张图片 → MDX 草稿'),
      h('span', { style: muted }, modelLabel),
      h('button', { type: 'button', onClick: onClose, style: { ...buttonStyle, border: 0, fontSize: 18 } }, '×')),
    h('div', { style: muted },
      '只生成可审阅草稿；不会覆盖正式笔记。确认后追加到当前文档末尾，再由你按 Cmd+S 走现有 CAS/备份保存。',
      activePath ? ` 当前文档：${activePath}` : ' 当前没有打开的可编辑文档。'),
    capabilityError && h('div', { style: { color: T.error, fontSize: T.uiSmallSize } }, capabilityError),
    capabilities && capabilities.model?.supportsImage !== true && h('div', { style: { color: T.error, fontSize: T.uiSmallSize } },
      '当前默认模型不支持图像输入；请在 DSH 中切换到声明 image 的视觉模型。'),
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      h('input', {
        type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif',
        onChange: onFile, disabled: busy || capabilityError !== null,
        style: { color: T.text, fontSize: T.uiSmallSize },
      }),
      file && h('span', { style: muted }, `${file.name} · ${Math.round(file.size / 1024)} KB`),
      h('button', {
        type: 'button', onClick: transcribe,
        disabled: busy || dataBase64 === null || capabilities?.model?.supportsImage !== true,
        style: { ...buttonStyle, opacity: busy || dataBase64 === null ? 0.55 : 1 },
      }, busy ? '转写中…' : '开始转写'),
      busy && h('button', {
        type: 'button', disabled: cancelling, onClick: () => { void cancelTranscription() },
        style: { ...buttonStyle, color: T.error, borderColor: T.error, opacity: cancelling ? 0.55 : 1 },
      }, cancelling ? '取消中…' : '取消')),
    error && h('div', { style: { color: T.error, fontSize: T.uiSmallSize } }, error),
    dataUrl && h('div', { style: { fontWeight: 600, fontSize: T.uiSmallSize } }, '来源图片（原始内容）'),
    dataUrl && h('img', {
      src: dataUrl, alt: '待转写图片',
      style: { maxWidth: '100%', maxHeight: 300, objectFit: 'contain', alignSelf: 'flex-start', border: `1px solid ${T.border}`, borderRadius: 4 },
    }),
    result && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', ...muted } },
        h('span', null, `图片 ${result.image?.width ?? '?'}×${result.image?.height ?? '?'} · ${result.image?.bytes ?? '?'} B`),
        h('span', null, `输入 ${usage?.inputTokens ?? '?'} · 输出 ${usage?.outputTokens ?? '?'} tokens`),
        h('span', null, `视觉估算 ${result.visualTokens ?? '未提供'} tokens`),
        h('span', null, result.parsed ? '结构化草稿' : '原始文本草稿'),
        result.finish && h('span', null, `结束：${result.finish}`)),
      warnings.map((warning) => h('div', { key: warning, style: { color: T.accent, fontSize: T.uiSmallSize } }, warning)),
      h('div', { style: { fontWeight: 600, fontSize: T.uiSmallSize } },
        '模型草稿（模型整理内容；请人工核对公式、符号与顺序）'),
      h('textarea', {
        'aria-label': '模型生成的 MDX 草稿',
        value: draft,
        onChange: (event) => setDraft(event.target.value),
        spellCheck: false,
        style: {
          width: '100%', minHeight: 220, resize: 'vertical', boxSizing: 'border-box',
          border: `1px solid ${T.border}`, borderRadius: T.radius, background: T.bg, color: T.text,
          padding: 8, font: `${T.uiSmallSize}/1.5 ui-monospace, SFMono-Regular, Menlo, monospace`,
        },
      }),
      uncertainties.length > 0 && h('div', { style: { borderTop: `1px solid ${T.border}`, paddingTop: 6 } },
        h('div', { style: { fontWeight: 600, fontSize: T.uiSmallSize } }, `待人工核对 (${uncertainties.length})`),
        uncertainties.map((item, index) => h('div', { key: `${index}-${item.where}`, style: { ...muted, marginTop: 2 } },
          `${item.where || '未标位置'}：${item.text || '?'}${item.why ? `（${item.why}）` : ''}`))),
      result.sourceNotes && h('div', { style: muted }, `来源说明：${result.sourceNotes}`),
      h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
        h('button', { type: 'button', onClick: onClose, style: buttonStyle }, '取消'),
        h('button', {
          type: 'button', onClick: insert, disabled: draft.trim().length === 0,
          style: { ...buttonStyle, background: T.accent, color: T.bg, borderColor: T.accent, opacity: draft.trim().length === 0 ? 0.55 : 1 },
        }, '插入到文档末尾'))),
  ))
}

module.exports = { ImportPanel }
