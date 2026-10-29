/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOST = path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/index.js')
const FILE = path.join(ROOT, 'prototypes/phase2/site/.dsh-live-editor/instances.json')
const { handleInstances, handleInstanceDocuments, handleInstanceSource } = await import(pathToFileURL(HOST).href)
const request = (url) => new Request(url, { headers: { origin: 'dsh-app://app' } })

test('instances API returns legacy read-only discovery when no descriptor exists', async () => {
  const before = await fs.readFile(FILE, 'utf8').catch(() => null)
  await fs.rm(FILE, { force: true })
  try {
    const res = await handleInstances(null, request('http://dsh.local/api/live-editor/instances'))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.source, 'legacy')
    assert.equal(body.instances[0].instanceId, 'default')
    assert.deepEqual(body.instances[0].sourceRoots, ['docs'])
    assert.equal(body.instances[0].capability, 'legacy')
  } finally {
    if (before !== null) await fs.writeFile(FILE, before)
  }
})

test('instances API exposes only sanitized descriptor fields and rejects bad roots', async () => {
  const before = await fs.readFile(FILE, 'utf8').catch(() => null)
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  await fs.writeFile(FILE, JSON.stringify({
    version: 1,
    generatedAt: 'now',
    errors: [],
    instances: [{
      pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'proj',
      routePath: '/proj', sourceRoots: ['proj'], capability: 'docs-editable',
      sourcePath: 'secret/path', docs: [{ source: 'proj/index.mdx' }],
    }],
  }))
  try {
    const res = await handleInstances(null, request('http://dsh.local/api/live-editor/instances'))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.source, 'descriptor')
    assert.deepEqual(body.instances[0], {
      pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'proj',
      routePath: '/proj', sourceRoots: ['proj'], capability: 'docs-editable', preview: false, versions: [],
    })
    await fs.writeFile(FILE, JSON.stringify({ instances: [{ instanceId: 'x', pluginType: 'docs', sourceRoots: ['../outside'] }] }))
    const bad = await handleInstances(null, request('http://dsh.local/api/live-editor/instances'))
    assert.equal(bad.status, 500)
    assert.equal((await bad.json()).code, 'INVALID_INSTANCE_DESCRIPTOR')
  } finally {
    if (before !== null) await fs.writeFile(FILE, before)
    else await fs.rm(FILE, { force: true })
  }
})

test('instances API hides the internal staging preview instance from discovery', async () => {
  const before = await fs.readFile(FILE, 'utf8').catch(() => null)
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  const doc = { sourcePath: 'proj/index.mdx', docId: 'index', permalink: '/proj/', title: 'P', versionName: 'current', sourceRoot: 'proj' }
  await fs.writeFile(FILE, JSON.stringify({
    version: 1, generatedAt: 'now', errors: [],
    instances: [
      { pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'proj', sourceRoots: ['proj'], capability: 'docs-editable', preview: false, versions: [], docs: [doc] },
      { pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'live-preview', sourceRoots: ['.dsh-live-editor/preview-docs'], capability: 'docs-editable', preview: true, versions: [], docs: [
        { ...doc, sourcePath: '.dsh-live-editor/preview-docs/index.mdx', sourceRoot: '.dsh-live-editor/preview-docs' },
      ] },
    ],
  }))
  try {
    const res = await handleInstances(null, request('http://dsh.local/api/live-editor/instances'))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.instances.map((entry) => entry.instanceId), ['proj'])
  } finally {
    if (before !== null) await fs.writeFile(FILE, before)
    else await fs.rm(FILE, { force: true })
  }
})


test('descriptor validator rejects malformed roots, scalar fields, version and registry errors', async () => {
  const before = await fs.readFile(FILE, 'utf8').catch(() => null)
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  const base = { version: 1, generatedAt: 'now', errors: [], instances: [{
    pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'proj',
    routePath: '/proj', sourceRoots: ['proj'], capability: 'docs-editable', preview: false, versions: [],
  }] }
  const write = (value) => fs.writeFile(FILE, JSON.stringify(value))
  const get = () => handleInstances(null, request('http://dsh.local/api/live-editor/instances'))
  try {
    await write({ ...base, instances: [{ ...base.instances[0], sourceRoots: ['C:/outside'] }] })
    assert.equal((await get()).status, 500)
    await write({ ...base, instances: [{ ...base.instances[0], sourceRoots: 'proj' }] })
    assert.equal((await get()).status, 500)
    await write({ ...base, instances: [{ ...base.instances[0], pluginName: { nested: true } }] })
    assert.equal((await get()).status, 500)
    await write({ ...base, generatedAt: { nested: true } })
    assert.equal((await get()).status, 500)
    await write({ ...base, version: 2 })
    assert.equal((await get()).status, 500)
    await write({ ...base, errors: [{ error: 'duplicate-route' }] })
    const invalid = await get()
    assert.equal(invalid.status, 422)
    assert.equal((await invalid.json()).code, 'INVALID_INSTANCE_REGISTRY')
  } finally {
    if (before !== null) await fs.writeFile(FILE, before)
    else await fs.rm(FILE, { force: true })
  }
})

test('routePath is derived from a single version and versions stay visible', async () => {
  const before = await fs.readFile(FILE, 'utf8').catch(() => null)
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  await fs.writeFile(FILE, JSON.stringify({
    version: 1, generatedAt: 'now', errors: [], instances: [{
      pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'proj',
      sourceRoots: ['proj'], capability: 'docs-editable', preview: false,
      versions: [{ versionName: 'current', routePath: '/base/proj', sourceRoots: ['proj'] }],
    }],
  }))
  try {
    const res = await handleInstances(null, request('http://dsh.local/api/live-editor/instances'))
    const body = await res.json()
    assert.equal(body.instances[0].routePath, '/base/proj')
    assert.deepEqual(body.instances[0].versions, [{ versionName: 'current', routePath: '/base/proj', sourceRoots: ['proj'] }])
  } finally {
    if (before !== null) await fs.writeFile(FILE, before)
    else await fs.rm(FILE, { force: true })
  }
})


test('drive-relative roots and malformed version containers are rejected', async () => {
  const before = await fs.readFile(FILE, 'utf8').catch(() => null)
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  const base = {
    version: 1, generatedAt: 'now', errors: [], instances: [{
      pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'proj',
      routePath: '/proj', sourceRoots: ['proj'], capability: 'docs-editable', preview: false, versions: [],
    }],
  }
  const write = (value) => fs.writeFile(FILE, JSON.stringify(value))
  const get = () => handleInstances(null, request('http://dsh.local/api/live-editor/instances'))
  try {
    for (const root of ['C:outside', 'C:']) {
      await write({ ...base, instances: [{ ...base.instances[0], sourceRoots: [root] }] })
      assert.equal((await get()).status, 500, `root ${root}`)
    }
    for (const versions of [{}, 'bad']) {
      await write({ ...base, instances: [{ ...base.instances[0], versions }] })
      assert.equal((await get()).status, 500, `versions ${JSON.stringify(versions)}`)
    }
    await write({ ...base, instances: [{ ...base.instances[0], versions: undefined }] })
    const omitted = await get()
    assert.equal(omitted.status, 200)
    assert.deepEqual((await omitted.json()).instances[0].versions, [])
  } finally {
    if (before !== null) await fs.writeFile(FILE, before)
    else await fs.rm(FILE, { force: true })
  }
})


test('instance documents API is read-only, instance-scoped, and duplicate IDs stay separate', async () => {
  const before = await fs.readFile(FILE, 'utf8').catch(() => null)
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  await fs.writeFile(FILE, JSON.stringify({
    version: 1, generatedAt: 'now', errors: [],
    instances: [
      { pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'default', sourceRoots: ['docs'], capability: 'legacy', preview: false, versions: [], docs: [
        { sourcePath: 'docs/intro.mdx', docId: 'intro', permalink: '/docs/intro/', title: 'Default', versionName: 'current', sourceRoot: 'docs' },
      ] },
      { pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'proj', sourceRoots: ['proj'], capability: 'docs-editable', preview: false, versions: [], docs: [
        { sourcePath: 'proj/index.mdx', docId: 'intro', permalink: '/proj/', title: 'Project', versionName: 'current', sourceRoot: 'proj' },
      ] },
    ],
  }))
  try {
    const req = (instance) => handleInstanceDocuments(null, new Request(`http://dsh.local/api/live-editor/instances/docs?instance=${instance}`, { headers: { origin: 'dsh-app://app' } }))
    const proj = await req('proj')
    assert.equal(proj.status, 200)
    const projBody = await proj.json()
    assert.deepEqual(projBody.documents.map((d) => [d.instanceId, d.source, d.docId, d.editable]), [['proj', 'proj/index.mdx', 'intro', false]])
    const missing = await req('missing')
    assert.equal(missing.status, 404)
  } finally {
    if (before !== null) await fs.writeFile(FILE, before)
    else await fs.rm(FILE, { force: true })
  }
})

test('instance documents API rejects absolute/path-escaping source records', async () => {
  const before = await fs.readFile(FILE, 'utf8').catch(() => null)
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  await fs.writeFile(FILE, JSON.stringify({
    version: 1, generatedAt: 'now', errors: [],
    instances: [{ pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'proj', sourceRoots: ['proj'], capability: 'docs-editable', preview: false, versions: [], docs: [
      { sourcePath: 'C:/outside.mdx', docId: 'x', permalink: '/proj/x/', title: 'X', versionName: 'current', sourceRoot: 'proj' },
    ] }],
  }))
  try {
    const res = await handleInstanceDocuments(null, new Request('http://dsh.local/api/live-editor/instances/docs?instance=proj', { headers: { origin: 'dsh-app://app' } }))
    assert.equal(res.status, 500)
    assert.equal((await res.json()).code, 'INVALID_INSTANCE_DOCUMENT')
  } finally {
    if (before !== null) await fs.writeFile(FILE, before)
    else await fs.rm(FILE, { force: true })
  }
})


test('instance source API reads an exact registered doc from its approved root only', async () => {
  const before = await fs.readFile(FILE, 'utf8').catch(() => null)
  const target = path.resolve(import.meta.dirname, '../../prototypes/phase2/site/proj/source-api-test.mdx')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, '# Source API\nread-only content\n')
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  await fs.writeFile(FILE, JSON.stringify({
    version: 1, generatedAt: 'now', errors: [],
    instances: [{ pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'proj', sourceRoots: ['proj'], capability: 'docs-editable', preview: false, versions: [{ versionName: 'current', routePath: '/proj', sourceRoots: ['proj'] }], docs: [
      { sourcePath: 'proj/source-api-test.mdx', docId: 'source-api', permalink: '/proj/source-api/', title: 'Source API', versionName: 'current', sourceRoot: 'proj' },
    ] }],
  }))
  const call = (query) => handleInstanceSource(null, new Request(`http://dsh.local/api/live-editor/instances/source?${query}`, { headers: { origin: 'dsh-app://app' } }))
  try {
    const ok = await call('instance=proj&docId=source-api&source=proj%2Fsource-api-test.mdx')
    assert.equal(ok.status, 200)
    assert.match((await ok.json()).text, /read-only content/)
    const forged = await call('instance=proj&docId=source-api&source=proj%2Fother.mdx')
    assert.equal(forged.status, 404)
    const traversal = await call('instance=proj&docId=source-api&source=..%2Fpackage.json')
    assert.equal(traversal.status, 400)
  } finally {
    await fs.rm(target, { force: true })
    if (before !== null) await fs.writeFile(FILE, before)
    else await fs.rm(FILE, { force: true })
  }
})


test('instance source API rejects symlinks, non-regular files, oversize files and traversal', async () => {
  const before = await fs.readFile(FILE, 'utf8').catch(() => null)
  const root = path.resolve(import.meta.dirname, '../../prototypes/phase2/site/proj')
  await fs.mkdir(root, { recursive: true })
  const symlink = path.join(root, 'source-symlink.mdx')
  const directory = path.join(root, 'source-dir.mdx')
  const large = path.join(root, 'source-large.mdx')
  await fs.rm(symlink, { force: true })
  await fs.symlink('/tmp/dsh-instance-source-outside.mdx', symlink)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(large, 'x'.repeat(4 * 1024 * 1024 + 1))
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  const docs = [
    ['source-link', 'proj/source-symlink.mdx'],
    ['source-dir', 'proj/source-dir.mdx'],
    ['source-large', 'proj/source-large.mdx'],
  ].map(([docId, sourcePath]) => ({ sourcePath, docId, permalink: `/proj/${docId}/`, title: docId, versionName: 'current', sourceRoot: 'proj' }))
  await fs.writeFile(FILE, JSON.stringify({
    version: 1, generatedAt: 'now', errors: [],
    instances: [{ pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'proj', sourceRoots: ['proj'], capability: 'docs-editable', preview: false, versions: [{ versionName: 'current', routePath: '/proj', sourceRoots: ['proj'] }], docs }],
  }))
  const call = (query) => handleInstanceSource(null, new Request(`http://dsh.local/api/live-editor/instances/source?${query}`, { headers: { origin: 'dsh-app://app' } }))
  try {
    assert.equal((await call('instance=proj&docId=source-link&source=proj%2Fsource-symlink.mdx')).status, 403)
    assert.equal((await call('instance=proj&docId=source-dir&source=proj%2Fsource-dir.mdx')).status, 403)
    assert.equal((await call('instance=proj&docId=source-large&source=proj%2Fsource-large.mdx')).status, 413)
    assert.equal((await call('instance=proj&docId=source-link&source=proj%2F..%2Fpackage.json')).status, 400)
  } finally {
    await fs.rm(symlink, { force: true })
    await fs.rm(directory, { recursive: true, force: true })
    await fs.rm(large, { force: true })
    if (before !== null) await fs.writeFile(FILE, before)
    else await fs.rm(FILE, { force: true })
  }
})


test('instance source API rejects a symlinked instance root', async () => {
  const before = await fs.readFile(FILE, 'utf8').catch(() => null)
  const root = path.resolve(import.meta.dirname, '../../prototypes/phase2/site')
  const link = path.join(root, 'linked-instance-root')
  const realRoot = path.join(root, 'proj')
  await fs.mkdir(realRoot, { recursive: true })
  await fs.writeFile(path.join(realRoot, 'linked-test.mdx'), '# linked\n')
  await fs.rm(link, { force: true })
  await fs.symlink(realRoot, link)
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  await fs.writeFile(FILE, JSON.stringify({
    version: 1, generatedAt: 'now', errors: [],
    instances: [{ pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'linked', sourceRoots: ['linked-instance-root'], capability: 'docs-editable', preview: false, versions: [{ versionName: 'current', routePath: '/linked', sourceRoots: ['linked-instance-root'] }], docs: [
      { sourcePath: 'linked-instance-root/linked-test.mdx', docId: 'linked-test', permalink: '/linked/test/', title: 'Linked', versionName: 'current', sourceRoot: 'linked-instance-root' },
    ] }],
  }))
  try {
    const res = await handleInstanceSource(null, new Request('http://dsh.local/api/live-editor/instances/source?instance=linked&docId=linked-test&source=linked-instance-root%2Flinked-test.mdx', { headers: { origin: 'dsh-app://app' } }))
    assert.equal(res.status, 403)
  } finally {
    await fs.rm(link, { force: true })
    await fs.rm(path.join(realRoot, 'linked-test.mdx'), { force: true })
    if (before !== null) await fs.writeFile(FILE, before)
    else await fs.rm(FILE, { force: true })
  }
})


test('instance source API rejects a FIFO without blocking', { timeout: 5000 }, async () => {
  const before = await fs.readFile(FILE, 'utf8').catch(() => null)
  const fifo = path.resolve(import.meta.dirname, '../../prototypes/phase2/site/proj/source-fifo.mdx')
  await fs.mkdir(path.dirname(fifo), { recursive: true })
  await fs.rm(fifo, { force: true })
  execFileSync('mkfifo', [fifo])
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  await fs.writeFile(FILE, JSON.stringify({
    version: 1, generatedAt: 'now', errors: [],
    instances: [{ pluginType: 'docs', pluginName: 'docusaurus-plugin-content-docs', instanceId: 'proj', sourceRoots: ['proj'], capability: 'docs-editable', preview: false, versions: [{ versionName: 'current', routePath: '/proj', sourceRoots: ['proj'] }], docs: [
      { sourcePath: 'proj/source-fifo.mdx', docId: 'source-fifo', permalink: '/proj/source-fifo/', title: 'FIFO', versionName: 'current', sourceRoot: 'proj' },
    ] }],
  }))
  try {
    const started = Date.now()
    const res = await handleInstanceSource(null, new Request('http://dsh.local/api/live-editor/instances/source?instance=proj&docId=source-fifo&source=proj%2Fsource-fifo.mdx', { headers: { origin: 'dsh-app://app' } }))
    assert.equal(res.status, 403)
    assert.ok(Date.now() - started < 3000)
  } finally {
    await fs.rm(fifo, { force: true })
    if (before !== null) await fs.writeFile(FILE, before)
    else await fs.rm(FILE, { force: true })
  }
})
