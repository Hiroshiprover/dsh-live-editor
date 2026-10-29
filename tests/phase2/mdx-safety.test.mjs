/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '../..')
const MODULE = path.resolve(ROOT, 'prototypes/phase2/dsh-bundle/lib/mdx-safety.mjs')
const siteRequire = createRequire(path.join(ROOT, 'prototypes/phase2/site/package.json'))
const { unwrapMdxCodeBlocks } = siteRequire('@docusaurus/utils')
const { validateGeneratedMdx } = await import(pathToFileURL(MODULE).href)

test('E3: Markdown, math and MDX comments are allowed', () => {
  const safe = [
    '③ Schrödinger equation',
    '',
    '$$',
    'i\\hbar \\frac{\\partial \\psi}{\\partial t} = \\hat H \\psi',
    '$$',
    '',
    '{/* 待人工核对：底部符号 */}',
    '',
    '普通 [相对链接](/docs/intro) 和 `inline code`。',
  ].join('\n')
  const result = validateGeneratedMdx(safe)
  assert.equal(result.ok, true, JSON.stringify(result.errors))
})

test('E3: ESM, JSX, raw HTML and executable expressions are rejected', () => {
  for (const unsafe of [
    'import x from "evil"\n\n# hi',
    'export const x = 1',
    '<script>alert(1)</script>',
    '<div>hi</div>',
    'A {1 + 1} B',
    '[x](javascript:alert(1))',
    '![x](https://example.com/tracker.png)',
    '{/* harmless */ ; alert(1) /* */}',
    '```mdx-code-block\n{globalThis.__probe__ = 1}\n```',
    '````mdx-code-block\n{globalThis.__probe__ = 1}\n````',
    '```\n````mdx-code-block\n`\n````\n```\n{globalThis.__DSH_E3_REVIEW__=1}',
    '[x][bad]\n\n[bad]: javascript:alert(1)',
  ]) {
    const result = validateGeneratedMdx(unsafe)
    assert.equal(result.ok, false, unsafe)
    assert.ok(result.errors.length > 0)
  }
})

test('E3: native TeX-style inline and display math pass', () => {
  const source = String.raw`Inline \( \underline{a}^\dagger(\vec{x}_1) \).

\[
\mathcal{F} = \bigoplus_{N=0}^{\infty} \mathcal{H}_N
\]`
  const result = validateGeneratedMdx(source)
  assert.equal(result.ok, true, JSON.stringify(result.errors))
})

test('E3: braces inside native TeX math are not MDX expressions', () => {
  const source = String.raw`\(\underline{a}^\dagger(\vec{x}_1)\cdots a^\dagger(\vec{x}_N)|0\rangle\)`
  const result = validateGeneratedMdx(source)
  assert.equal(result.ok, true, JSON.stringify(result.errors))
})

test('E3: safe relative and reference links pass', () => {
  const result = validateGeneratedMdx('[相对](intro) 和 [引用][ref]\n\n[ref]: /docs/intro')
  assert.equal(result.ok, true, JSON.stringify(result.errors))
})

test('E3: Docusaurus aliases and parent traversal in links are rejected', () => {
  for (const unsafe of [
    '[x](@site/../package.json)',
    '[x](@site/%2e%2e/package.json)',
    '[x](@site/static/file.pdf)',
    '[x](../package.json)',
    '[x](.%2e/package.json)',
    '[x](%2e%2e/package.json)',
    '[x](..%2fpackage.json)',
    '[x](/../../package.json)',
    '[x](..\\package.json)',
    '[x](<@site/../package.json>)',
    '[x](<../package.json>)',
    '[x](..%2Fpackage.json)',
    '[x](%2e%2e%2fpackage.json)',
    '[x](%40site/../package.json)',
    '[x][ref]\n\n[ref]: @site/../package.json',
    '[x][ref]\n\n[ref]: ../package.json',
  ]) {
    const result = validateGeneratedMdx(unsafe)
    assert.equal(result.ok, false, unsafe)
    assert.match(result.errors[0].message, /链接|别名|父级/u)
  }
})

test('E3: same-folder assets, site paths, anchors and https links still pass', () => {
  const safe = [
    '[图](./figure.png)',
    '[站点](/img/logo.svg)',
    '[文档](intro)',
    '[锚点](#section)',
    '[外链](https://example.com/a?b=1)',
    '[邮件](mailto:a@example.com)',
    '[引用][ref]',
    '',
    '[ref]: /docs/intro',
  ].join('\n')
  const result = validateGeneratedMdx(safe)
  assert.equal(result.ok, true, JSON.stringify(result.errors))
})

test('E3: the actual Docusaurus transformer would export traversal targets', async (t) => {
  const transformerPath = path.join(
    ROOT,
    'prototypes/phase2/site/node_modules/@docusaurus/mdx-loader/lib/remark/transformLinks/index.js',
  )
  // The acceptance environment mounts the real test-site dependencies. Only a
  // genuinely missing mount may skip; a present-but-broken loader must fail.
  if (!existsSync(transformerPath)) {
    t.skip('test-site node_modules is not mounted; transformer regression cannot run')
    return
  }
  const phase = (name) => import(pathToFileURL(path.join(ROOT, 'prototypes/phase2/node_modules', name)).href)
  const { unified } = await phase('unified/index.js')
  const remarkParse = (await phase('remark-parse/index.js')).default
  const remarkMdx = (await phase('remark-mdx/index.js')).default
  const { VFile } = await phase('vfile/index.js')
  const mod = await import(pathToFileURL(transformerPath).href)
  const transformLinks = mod.default?.default ?? mod.default
  const site = path.join(ROOT, 'prototypes/phase2/site')
  for (const raw of [
    '@site/../package.json',
    '../package.json',
    '%2e%2e/package.json',
    '@site/%2e%2e/package.json',
    '<@site/../package.json>',
    '<../package.json>',
    '..%2fpackage.json',
  ]) {
    const mdx = `[x](${raw})`
    const processor = unified().use(remarkParse).use(remarkMdx).use(transformLinks, {
      siteDir: site,
      staticDirs: [path.join(site, 'static')],
      onBrokenMarkdownLinks: 'warn',
    })
    const file = new VFile({ path: path.join(site, 'docs/01-intro.mdx'), value: mdx })
    file.data.compilerName = 'client'
    const out = JSON.stringify(await processor.run(processor.parse(file), file))
    assert.ok(out.includes('require('), `${raw} should be rewritten to a file-loader require`)
    assert.equal(validateGeneratedMdx(mdx).ok, false, raw)
  }
})

test('E3: the actual Docusaurus preprocessor would unwrap the mixed fence', () => {
  const mixed = '```\n````mdx-code-block\n`\n````\n```\n{globalThis.__DSH_E3_REVIEW__=1}'
  assert.notEqual(unwrapMdxCodeBlocks(mixed), mixed)
  assert.equal(validateGeneratedMdx(mixed).ok, false)
})

test('E3: code fences are text, not executed', () => {
  const result = validateGeneratedMdx('```js\nalert(1)\n```\n\n$\\frac{a}{b}$')
  assert.equal(result.ok, true, JSON.stringify(result.errors))
})
