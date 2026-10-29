/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Phase 7 milestone B — Host single-image import with a mocked llm/attachments
 * boundary. No real model calls and no site writes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../..')
const MODULE = path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/import.mjs')
const SAFETY = path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/mdx-safety.mjs')
const { handleImportCapabilities, handleImportImage, handleImportCancel } = await import(pathToFileURL(MODULE).href)
const { validateGeneratedMdx } = await import(pathToFileURL(SAFETY).href)

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII='
const AUDIT = path.join(os.tmpdir(), `dsh-import-audit-${process.pid}-${Date.now()}.jsonl`)

function makeCtx ({ supportsImage = true, streamText = null, finishKind = 'stop', saveImageCalls = [] } = {}) {
  const usage = { inputTokens: 120, outputTokens: 30, totalTokens: 150 }
  return {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    llm: {
      resolveModelInfo: async () => ({
        provider: 'deepseek-account', id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash',
        inputModalities: supportsImage ? ['text', 'image'] : ['text'],
      }),
      imageRequestPricing: () => ({ priceImages: () => [{ visualTokens: 1024 }] }),
      stream: () => (async function * () {
        const text = streamText ?? JSON.stringify({
          mdx: '# Draft\\n\\n$$\\nE = mc^2\\n$$',
          uncertainties: [{ where: 'line 3', text: 'c', why: '手写体可能被看成 e' }],
          sourceNotes: 'test image',
        })
        yield { type: 'text-delta', text }
        yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: finishKind, ...(finishKind === 'error' ? { failure: { message: 'provider failed', code: 'X' } } : {}) } }
      })(),
    },
    attachments: {
      imageLimits: {
        maxImageBytes: 20 * 1024 * 1024, maxImagesPerMessage: 20, maxMessageImageBytes: 200 * 1024 * 1024,
        maxImagePixels: 64_000_000, maxImageDimension: 8192,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      saveImage: async (input) => {
        saveImageCalls.push(input)
        return { attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }
      },
    },
  }
}

function request (body, method = 'POST') {
  return new Request('http://dsh.local/api/live-editor/import/image', {
    method,
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  })
}

async function auditLines () {
  try {
    return (await fs.readFile(AUDIT, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch { return [] }
}

test('capabilities reports the resolved image model and attachment limits', async () => {
  const response = await handleImportCapabilities(makeCtx(), request({}, 'GET'), { auditFile: AUDIT })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.model.supportsImage, true)
  assert.equal(body.milestone, 'B')
  assert.equal(body.limits.maxImageBytes, 20 * 1024 * 1024)
})

test('single-image import returns a parsed draft, usage and visual-token estimate', async () => {
  const saveImageCalls = []
  const response = await handleImportImage(makeCtx({ saveImageCalls }), request({
    name: 'IMG_8152.JPG', mediaType: 'image/png', dataBase64: PNG,
  }), { auditFile: AUDIT })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.match(body.draft, /E = mc\^2/)
  assert.equal(body.uncertainties.length, 1)
  assert.equal(body.usage.outputTokens, 30)
  assert.equal(body.visualTokens, 1024)
  assert.equal(body.image.name, 'IMG_8152.JPG')
  assert.equal(saveImageCalls.length, 1)
  assert.equal(saveImageCalls[0].mediaType, 'image/png')
  const audit = await auditLines()
  assert.ok(audit.some((entry) => entry.event === 'import-image' && entry.status === 200 && entry.visualTokens === 1024))
  await fs.rm(AUDIT, { force: true })
})

test('a text-only model is rejected before saving the image', async () => {
  const saveImageCalls = []
  const response = await handleImportImage(makeCtx({ supportsImage: false, saveImageCalls }), request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG,
  }), { auditFile: AUDIT })
  assert.equal(response.status, 409)
  const body = await response.json()
  assert.equal(body.code, 'IMAGE_MODALITY_UNAVAILABLE')
  assert.equal(saveImageCalls.length, 0)
})

test('unsupported media types are rejected', async () => {
  const response = await handleImportImage(makeCtx(), request({
    name: 'x.heic', mediaType: 'image/heic', dataBase64: PNG,
  }), { auditFile: AUDIT })
  assert.equal(response.status, 415)
  assert.equal((await response.json()).code, 'UNSUPPORTED_IMAGE_TYPE')
})

test('LaTeX bracket delimiters are accepted as native math', async () => {
  const mdx = String.raw`\(\Rightarrow |\Psi(t)\rangle \to N\)-particle state
\(\to\) linear combination of \(\underline{a}^\dagger(\vec{x}_1)\cdots a^\dagger(\vec{x}_N)|0\rangle\)

$$
\mathcal{F} = \bigoplus_{N=0}^{\infty} \mathcal{H}_N
$$`
  const response = await handleImportImage(makeCtx({
    streamText: JSON.stringify({ mdx, uncertainties: [], sourceNotes: 'bracket delimiters' }),
  }), request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG,
  }), { auditFile: AUDIT })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(body.draft.includes(String.raw`\(\Rightarrow`))
  assert.ok(body.draft.includes(String.raw`\underline{a}`))
  assert.doesNotMatch(body.warnings.join(' '), /公式分隔符/)
  assert.equal(validateGeneratedMdx(body.draft).ok, true)
})

test('a model finish error is not returned as a draft', async () => {
  const response = await handleImportImage(makeCtx({ finishKind: 'error' }), request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG,
  }), { auditFile: AUDIT })
  assert.equal(response.status, 502)
  assert.equal((await response.json()).code, 'MODEL_FINISH_ERROR')
})

test('max-tokens finish is surfaced as a completeness warning', async () => {
  const response = await handleImportImage(makeCtx({ finishKind: 'max-tokens' }), request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG,
  }), { auditFile: AUDIT })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.finish, 'max-tokens')
  assert.match(body.warnings.join(' '), /截断/)
})

test('non-JSON model text falls back to a raw draft with a warning', async () => {
  const response = await handleImportImage(makeCtx({ streamText: 'plain transcription' }), request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG,
  }), { auditFile: AUDIT })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.parsed, false)
  assert.equal(body.draft, 'plain transcription')
  assert.match(body.warnings.join(' '), /未返回约定 JSON/)
})

test('an aborted request returns MODEL_ABORTED and does not produce a draft', async () => {
  const ctx = makeCtx()
  ctx.llm.stream = (options) => (async function * () {
    yield { type: 'text-delta', text: 'partial' }
    await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
  })()
  const controller = new AbortController()
  const req = new Request('http://dsh.local/api/live-editor/import/image', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x.png', mediaType: 'image/png', dataBase64: PNG }),
    signal: controller.signal,
  })
  const pending = handleImportImage(ctx, req, { auditFile: AUDIT })
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort()
  const response = await pending
  assert.equal(response.status, 408)
  assert.equal((await response.json()).code, 'MODEL_ABORTED')
})

test('a requestId is reserved before image/model work and cannot run twice', async () => {
  const saveImageCalls = []
  const ctx = makeCtx({ saveImageCalls })
  const originalSave = ctx.attachments.saveImage
  ctx.attachments.saveImage = async (input) => {
    saveImageCalls.push(input)
    await new Promise((resolve) => setTimeout(resolve, 30))
    return originalSave(input)
  }
  ctx.llm.stream = (options) => (async function * () {
    await new Promise((resolve, reject) => {
      if (options.signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
  })()
  const runId = `run-dedupe-${Date.now()}`
  const body = { name: 'x.png', mediaType: 'image/png', dataBase64: PNG, requestId: runId }
  const first = handleImportImage(ctx, request(body), { auditFile: AUDIT })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await handleImportImage(ctx, request(body), { auditFile: AUDIT })
  assert.equal(second.status, 409)
  assert.equal((await second.json()).code, 'IMPORT_IN_PROGRESS')
  assert.equal(saveImageCalls.length, 1)
  await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: runId }),
  }), { auditFile: AUDIT })
  const response = await first
  assert.equal(response.status, 408)
})

test('cancel during image saving stops before the model', async () => {
  const saveImageCalls = []
  let streamCalls = 0
  const ctx = makeCtx({ saveImageCalls })
  ctx.attachments.saveImage = async (input) => {
    saveImageCalls.push(input)
    await new Promise((resolve) => setTimeout(resolve, 30))
    return { attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }
  }
  ctx.llm.stream = () => { streamCalls += 1; return (async function * () {})() }
  const runId = `run-save-cancel-${Date.now()}`
  const pending = handleImportImage(ctx, request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG, requestId: runId,
  }), { auditFile: AUDIT })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: runId }),
  }), { auditFile: AUDIT })
  const response = await pending
  assert.equal(response.status, 408)
  assert.equal((await response.json()).code, 'MODEL_CANCELLED')
  assert.equal(streamCalls, 0)
  assert.equal(saveImageCalls.length, 1)
})

test('request abort during image saving does not run the model', async () => {
  let streamCalls = 0
  const ctx = makeCtx()
  ctx.attachments.saveImage = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 30))
    return { attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name }
  }
  ctx.llm.stream = () => { streamCalls += 1; return (async function * () {})() }
  const abort = new AbortController()
  const req = new Request('http://dsh.local/api/live-editor/import/image', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x.png', mediaType: 'image/png', dataBase64: PNG }),
    signal: abort.signal,
  })
  const pending = handleImportImage(ctx, req, { auditFile: AUDIT })
  await new Promise((resolve) => setTimeout(resolve, 5))
  abort.abort()
  const response = await pending
  assert.equal(response.status, 408)
  assert.equal((await response.json()).code, 'MODEL_ABORTED')
  assert.equal(streamCalls, 0)
})

test('cancel during model resolution stops before image saving', async () => {
  const saveImageCalls = []
  const ctx = makeCtx({ saveImageCalls })
  ctx.llm.resolveModelInfo = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
    return {
      provider: 'deepseek-account', id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash',
      inputModalities: ['text', 'image'],
    }
  }
  const runId = `run-resolve-cancel-${Date.now()}`
  const pending = handleImportImage(ctx, request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG, requestId: runId,
  }), { auditFile: AUDIT })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: runId }),
  }), { auditFile: AUDIT })
  const response = await pending
  assert.equal(response.status, 408)
  assert.equal((await response.json()).code, 'MODEL_CANCELLED')
  assert.equal(saveImageCalls.length, 0)
})

test('cancel endpoint aborts an in-flight request by requestId', async () => {
  const ctx = makeCtx()
  ctx.llm.stream = (options) => (async function * () {
    yield { type: 'text-delta', text: 'partial' }
    await new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
  })()
  const runId = `run-${Date.now()}`
  const pending = handleImportImage(ctx, request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG, requestId: runId,
  }), { auditFile: AUDIT })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const cancelResponse = await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: runId }),
  }), { auditFile: AUDIT })
  assert.equal(cancelResponse.status, 200)
  assert.equal((await cancelResponse.json()).cancelled, true)
  const response = await pending
  assert.equal(response.status, 408)
  assert.equal((await response.json()).code, 'MODEL_CANCELLED')
})

test('a provider aborted finish after cancel maps to MODEL_CANCELLED/408', async () => {
  const ctx = makeCtx()
  ctx.llm.stream = (options) => (async function * () {
    yield { type: 'text-delta', text: 'partial' }
    await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }
  })()
  const runId = `run-abort-${Date.now()}`
  const pending = handleImportImage(ctx, request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG, requestId: runId,
  }), { auditFile: AUDIT })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: runId }),
  }), { auditFile: AUDIT })
  const response = await pending
  assert.equal(response.status, 408)
  assert.equal((await response.json()).code, 'MODEL_CANCELLED')
  const audit = await auditLines()
  assert.ok(audit.some((entry) => entry.event === 'import-image' && entry.code === 'MODEL_CANCELLED' && entry.finish === 'aborted'))
})

test('model-generated executable MDX is rejected without a draft', async () => {
  const unsafe = JSON.stringify({
    mdx: 'import x from "evil"\n\n<script>alert(1)</script>',
    uncertainties: [],
    sourceNotes: 'unsafe test',
  })
  const response = await handleImportImage(makeCtx({ streamText: unsafe }), request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG,
  }), { auditFile: AUDIT })
  assert.equal(response.status, 422)
  const body = await response.json()
  assert.equal(body.code, 'UNSAFE_MDX')
  assert.equal(body.draft, undefined)
  assert.ok(Array.isArray(body.issues) && body.issues.length > 0)
  const audit = await auditLines()
  assert.ok(audit.some((entry) => entry.event === 'import-image' && entry.status === 422 && entry.code === 'UNSAFE_MDX'))
})

test('non-JSON unsafe raw fallback is also rejected', async () => {
  const response = await handleImportImage(makeCtx({ streamText: 'import x from "evil"\n\n# raw' }), request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG,
  }), { auditFile: AUDIT })
  assert.equal(response.status, 422)
  const body = await response.json()
  assert.equal(body.code, 'UNSAFE_MDX')
  assert.equal(body.draft, undefined)
})

test('Docusaurus mdx-code-block and nested mixed fences are rejected in JSON and raw output', async () => {
  const fences = [
    '```mdx-code-block\n{globalThis.__probe__ = 1}\n```',
    '```\n````mdx-code-block\n`\n````\n```\n{globalThis.__DSH_E3_REVIEW__=1}',
  ]
  for (const fence of fences) for (const streamText of [
    JSON.stringify({ mdx: fence, uncertainties: [], sourceNotes: '' }),
    fence,
  ]) {
    const response = await handleImportImage(makeCtx({ streamText }), request({
      name: 'x.png', mediaType: 'image/png', dataBase64: PNG,
    }), { auditFile: AUDIT })
    assert.equal(response.status, 422)
    const body = await response.json()
    assert.equal(body.code, 'UNSAFE_MDX')
    assert.equal(body.draft, undefined)
  }
})

test('cancel racing a normal finish still returns 408 without a draft', async () => {
  const ctx = makeCtx()
  ctx.llm.stream = (options) => (async function * () {
    yield { type: 'text-delta', text: JSON.stringify({ mdx: '# safe', uncertainties: [], sourceNotes: '' }) }
    await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const runId = `run-finish-cancel-${Date.now()}`
  const pending = handleImportImage(ctx, request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG, requestId: runId,
  }), { auditFile: AUDIT })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: runId }),
  }), { auditFile: AUDIT })
  const response = await pending
  assert.equal(response.status, 408)
  const body = await response.json()
  assert.equal(body.code, 'MODEL_CANCELLED')
  assert.equal(body.draft, undefined)
})

test('cancel during success audit is rejected as IMPORT_FINALIZING, not CANCELLED', async () => {
  const ctx = makeCtx()
  const runId = `run-finalizing-${Date.now()}`
  let cancelStatus = null
  let cancelCode = null
  const response = await handleImportImage(ctx, request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG, requestId: runId,
  }), {
    auditFile: AUDIT,
    beforeSuccessAudit: async () => {
      const cancel = await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
        method: 'POST',
        headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: runId }),
      }), { auditFile: AUDIT })
      cancelStatus = cancel.status
      cancelCode = (await cancel.json()).code
    },
  })
  assert.equal(response.status, 200)
  assert.equal(cancelStatus, 409)
  assert.equal(cancelCode, 'IMPORT_FINALIZING')
  const audit = await auditLines()
  assert.ok(audit.some((entry) => entry.event === 'import-image' && entry.runId === runId && entry.status === 200))
  assert.ok(audit.some((entry) => entry.event === 'import-cancel' && entry.requestId === runId && entry.code === 'IMPORT_FINALIZING'))
  assert.equal(audit.some((entry) => entry.event === 'import-cancel' && entry.requestId === runId && entry.code === 'CANCELLED'), false)
})

test('cancel then a late model-resolution exception stays MODEL_CANCELLED/408', async () => {
  const ctx = makeCtx()
  ctx.llm.resolveModelInfo = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25))
    throw new Error('resolve denied')
  }
  const runId = `run-resolve-error-${Date.now()}`
  const pending = handleImportImage(ctx, request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG, requestId: runId,
  }), { auditFile: AUDIT })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: runId }),
  }), { auditFile: AUDIT })
  const response = await pending
  assert.equal(response.status, 408)
  assert.equal((await response.json()).code, 'MODEL_CANCELLED')
  const audit = await auditLines()
  assert.ok(audit.some((entry) => entry.event === 'import-image' && entry.runId === runId && entry.code === 'MODEL_CANCELLED'))
  assert.equal(audit.some((entry) => entry.event === 'import-image' && entry.runId === runId && entry.code === 'MODEL_UNAVAILABLE'), false)
})

test('cancel then a late attachment exception stays MODEL_CANCELLED/408', async () => {
  const ctx = makeCtx()
  ctx.attachments.saveImage = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25))
    throw new Error('save denied')
  }
  const runId = `run-save-error-${Date.now()}`
  const pending = handleImportImage(ctx, request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG, requestId: runId,
  }), { auditFile: AUDIT })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: runId }),
  }), { auditFile: AUDIT })
  const response = await pending
  assert.equal(response.status, 408)
  assert.equal((await response.json()).code, 'MODEL_CANCELLED')
  const audit = await auditLines()
  assert.ok(audit.some((entry) => entry.event === 'import-image' && entry.runId === runId && entry.code === 'MODEL_CANCELLED'))
  assert.equal(audit.some((entry) => entry.event === 'import-image' && entry.runId === runId && entry.code === 'ATTACHMENT_REJECTED'), false)
})

test('import can be disabled by the feature flag', async () => {
  const old = process.env.DSH_LIVE_EDITOR_IMPORT
  process.env.DSH_LIVE_EDITOR_IMPORT = 'off'
  try {
    const response = await handleImportCapabilities(makeCtx(), request({}, 'GET'), { auditFile: AUDIT })
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, 'IMPORT_DISABLED')
  } finally {
    if (old === undefined) delete process.env.DSH_LIVE_EDITOR_IMPORT
    else process.env.DSH_LIVE_EDITOR_IMPORT = old
  }
})

test('cancel settles the handler when model resolution never returns', async () => {
  const ctx = makeCtx()
  let resolveCalls = 0
  ctx.llm.resolveModelInfo = () => { resolveCalls += 1; return new Promise(() => {}) }
  const runId = `run-resolve-hang-${Date.now()}`
  const pending = handleImportImage(ctx, request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG, requestId: runId,
  }), { auditFile: AUDIT })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const cancel = await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: runId }),
  }), { auditFile: AUDIT })
  assert.equal(cancel.status, 200)
  const response = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('handler did not settle after cancel')), 1500)),
  ])
  assert.equal(response.status, 408)
  assert.equal((await response.json()).code, 'MODEL_CANCELLED')
  assert.equal(resolveCalls, 1)
  const again = await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: runId }),
  }), { auditFile: AUDIT })
  assert.equal(again.status, 404, 'the reservation must be released')
})

test('cancel settles the handler when image saving never returns', async () => {
  const ctx = makeCtx()
  let saveCalls = 0
  let streamCalls = 0
  ctx.attachments.saveImage = () => { saveCalls += 1; return new Promise(() => {}) }
  ctx.llm.stream = () => { streamCalls += 1; return (async function * () {})() }
  const runId = `run-save-hang-${Date.now()}`
  const pending = handleImportImage(ctx, request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG, requestId: runId,
  }), { auditFile: AUDIT })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const cancel = await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: runId }),
  }), { auditFile: AUDIT })
  assert.equal(cancel.status, 200)
  const response = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('handler did not settle after cancel')), 1500)),
  ])
  assert.equal(response.status, 408)
  assert.equal((await response.json()).code, 'MODEL_CANCELLED')
  assert.equal(saveCalls, 1)
  assert.equal(streamCalls, 0)
})

test('preparation timeout settles a hung save without a cancel', async () => {
  const ctx = makeCtx()
  ctx.attachments.saveImage = () => new Promise(() => {})
  const runId = `run-prep-timeout-${Date.now()}`
  const pending = handleImportImage(ctx, request({
    name: 'x.png', mediaType: 'image/png', dataBase64: PNG, requestId: runId,
  }), { auditFile: AUDIT, prepareTimeoutMs: 30 })
  const response = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('handler did not time out')), 1500)),
  ])
  assert.equal(response.status, 504)
  assert.equal((await response.json()).code, 'PREPARE_TIMEOUT')
  const again = await handleImportCancel(ctx, new Request('http://dsh.local/api/live-editor/import/cancel', {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: runId }),
  }), { auditFile: AUDIT })
  assert.equal(again.status, 404, 'the reservation must be released after the preparation timeout')
})
