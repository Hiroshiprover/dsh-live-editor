/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Runtime read-only site config. The config file lives in the test site's
 * gitignored state dir; an external root is refused unless explicitly allowed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOST = pathToFileURL(path.join(ROOT, 'prototypes/phase2/dsh-bundle/lib/index.js')).href
const CONFIG = path.join(ROOT, 'prototypes/phase2/site/.dsh-live-editor/site-config.json')
const EXTERNAL_SITE = path.join(os.tmpdir(), `dsh-external-site-${process.pid}`)

const runChild = (code, env = process.env) => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
  env,
  encoding: 'utf8',
})

test('a read-only runtime site makes saves fail and reports writable:false', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-readonly-'))
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true })
  fs.writeFileSync(CONFIG, JSON.stringify({
    root, writable: false, allowExternalSite: true, devOrigin: 'http://localhost:3000', label: 'READ-ONLY',
  }))
  try {
    const code = `
      const m = await import(${JSON.stringify(HOST)})
      const site = await m.handleSite(new Request('http://dsh.local/api/live-editor/site', {
        headers: { origin: 'dsh-app://app' },
      }))
      console.log(JSON.stringify(await site.json()))
      const save = await m.handleSave(null, new Request('http://dsh.local/api/live-editor/save', {
        method: 'POST', headers: { origin: 'dsh-app://app' },
        body: JSON.stringify({ path: 'docs/x.mdx', expectedHash: 'x', content: 'y' }),
      }))
      console.log('save-status', save.status)
    `
    const out = runChild(code)
    assert.equal(out.status, 0, out.stderr)
    const lines = out.stdout.trim().split('\n')
    const site = JSON.parse(lines[0])
    assert.equal(site.writable, false)
    assert.equal(site.label, 'READ-ONLY')
    assert.match(site.siteId, /^site-[0-9a-f]{16}$/)
    assert.equal(lines[1], 'save-status 403')
  } finally {
    fs.rmSync(CONFIG, { force: true })
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an external root is refused without allowExternalSite', () => {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true })
  fs.mkdirSync(EXTERNAL_SITE, { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify({ root: EXTERNAL_SITE, writable: false }))
  try {
    const out = runChild(`await import(${JSON.stringify(HOST)})`)
    assert.notEqual(out.status, 0)
    assert.match(out.stderr, /refuses an external root without allowExternalSite/)
  } finally {
    fs.rmSync(CONFIG, { force: true }); fs.rmSync(EXTERNAL_SITE, { recursive: true, force: true })
  }
})
