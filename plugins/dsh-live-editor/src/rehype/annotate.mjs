/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Dev-only rehype plugin: annotate block elements with their MDX source lines.
 * Moved from prototypes/phase0b/site/plugins/annotate.mjs without changes.
 */
const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'table', 'blockquote', 'li'])

export default function annotate() {
  return (tree) => {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      const classes = node.type === 'element' && Array.isArray(node.properties?.className)
        ? node.properties.className
        : []
      const isDisplayMath = classes.includes('katex-display') || classes.includes('math-display')
      if (node.type === 'element' && (BLOCK.has(node.tagName) || isDisplayMath)) {
        const line = node.position?.start?.line
        const end = node.position?.end?.line ?? line
        if (Number.isFinite(line)) {
          node.properties = node.properties ?? {}
          if (node.properties['data-dsh-src-line'] === undefined) {
            node.properties['data-dsh-src-line'] = String(line)
            node.properties['data-dsh-src-end'] = String(end)
          }
        }
      }
      if (Array.isArray(node.children)) for (const child of node.children) walk(child)
    }
    walk(tree)
  }
}
