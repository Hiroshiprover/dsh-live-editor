/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * P1-A: the Live Editor plugin must harden the Docusaurus dev server through
 * the public configureWebpack hook (no node_modules patch).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PLUGIN = path.join(ROOT, 'plugins/dsh-live-editor/src/index.mjs')
const { resolveDevOrigin, devServerSecurity, previewOriginAllowed, healthOriginAllowed } = await import(pathToFileURL(PLUGIN).href)

test('dev origin accepts only loopback http(s) origins', () => {
  assert.equal(resolveDevOrigin('http://localhost:3000'), 'http://localhost:3000')
  assert.equal(resolveDevOrigin('http://127.0.0.1:3001'), 'http://127.0.0.1:3001')
  assert.equal(resolveDevOrigin('http://localhost:3000/'), 'http://localhost:3000')
  for (const bad of [
    'http://evil.example:3000',
    'https://localhost.evil.example',
    'http://localhost:3000/path',
    'http://localhost:3000?x=1',
    'file:///tmp/x',
    'javascript:alert(1)',
    '',
    null,
  ]) {
    assert.equal(resolveDevOrigin(bad), 'http://localhost:3000', String(bad))
  }
})

test('dev server security blocks arbitrary Hosts and removes wildcard CORS', () => {
  const security = devServerSecurity('http://localhost:3000')
  assert.deepEqual(security.allowedHosts.includes('all'), false)
  assert.ok(security.allowedHosts.includes('localhost'))
  assert.ok(security.allowedHosts.includes('127.0.0.1'))
  assert.equal(security.headers['access-control-allow-origin'], 'http://localhost:3000')
  assert.notEqual(security.headers['access-control-allow-origin'], '*')
  assert.equal(security.headers['cross-origin-resource-policy'], 'same-origin')
})

test('preview Origin allowlist accepts only the loopback counterpart', () => {
  assert.equal(previewOriginAllowed('http://localhost:3000', 'http://localhost:3000'), true)
  assert.equal(previewOriginAllowed('http://127.0.0.1:3000', 'http://localhost:3000'), true)
  assert.equal(previewOriginAllowed('http://localhost:3000', 'http://127.0.0.1:3000'), true)
  assert.equal(previewOriginAllowed('', 'http://localhost:3000'), true)
  assert.equal(previewOriginAllowed(null, 'http://localhost:3000'), true)
  assert.equal(previewOriginAllowed('http://evil.example', 'http://localhost:3000'), false)
  assert.equal(previewOriginAllowed('http://localhost:3001', 'http://localhost:3000'), false)
  assert.equal(previewOriginAllowed('http://localhost.evil.example:3000', 'http://localhost:3000'), false)
})

test('dev server exposes a server-side Origin middleware', () => {
  const security = devServerSecurity('http://localhost:3000')
  assert.equal(typeof security.setupMiddlewares, 'function')
  const middlewares = []
  security.setupMiddlewares(middlewares)
  assert.equal(middlewares.length, 1)
})

test('health probe origin allows loopback and DSH only', () => {
  assert.equal(healthOriginAllowed('http://127.0.0.1:64644'), true)
  assert.equal(healthOriginAllowed('http://localhost:64644'), true)
  assert.equal(healthOriginAllowed('dsh-app://app'), true)
  assert.equal(healthOriginAllowed('http://evil.example'), false)
  assert.equal(healthOriginAllowed(''), true)
  assert.equal(healthOriginAllowed(null), true)
})

test('health endpoint answers the DSH probe without opening content', () => {
  const security = devServerSecurity('http://localhost:3000')
  const middlewares = []
  security.setupMiddlewares(middlewares)
  const run = (url, origin) => {
    const res = {
      statusCode: 0, headers: {}, body: '',
      setHeader (key, value) { this.headers[key.toLowerCase()] = value },
      end (body) { this.body = body },
    }
    let nextCalled = false
    middlewares[0]({ url, headers: { origin } }, res, () => { nextCalled = true })
    return { res, nextCalled }
  }
  const ok = run('/__dsh-live-editor/health', 'http://127.0.0.1:64644')
  assert.equal(ok.res.statusCode, 200)
  assert.equal(ok.res.headers['access-control-allow-origin'], 'http://127.0.0.1:64644')
  assert.equal(ok.res.headers['cross-origin-resource-policy'], 'cross-origin')
  assert.equal(ok.res.body, '{"ok":true}')
  assert.equal(ok.nextCalled, false)
  const evil = run('/__dsh-live-editor/health', 'http://evil.example')
  assert.equal(evil.res.statusCode, 403)
  const content = run('/', 'http://127.0.0.1:64644')
  assert.equal(content.res.statusCode, 403, 'GUI origin must still not read content')
  const contentOk = run('/', 'http://localhost:3000')
  assert.equal(contentOk.nextCalled, true)
})
