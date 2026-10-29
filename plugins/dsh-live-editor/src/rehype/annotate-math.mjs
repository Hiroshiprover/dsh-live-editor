/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Dev-only rehype plugin: wrap display math in a div carrying the MDX source
 * line before rehype-katex runs, so the wrapper attributes survive.
 * Moved from prototypes/phase0b/site/plugins/annotate-math.mjs without changes.
 */
const classesOf = (node) => {
  const value = node?.properties?.className
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean)
  return []
}

export default function annotateMath() {
  return (tree) => {
    const walk = (node) => {
      if (!node || !Array.isArray(node.children)) return
      for (let i = 0; i < node.children.length; i += 1) {
        const child = node.children[i]
        if (child?.type === 'element' && child.tagName === 'pre') {
          const code = (child.children ?? []).find((c) => c?.type === 'element' && c.tagName === 'code')
          const classes = classesOf(code)
          if (classes.includes('language-math') && classes.includes('math-display')) {
            const line = child.position?.start?.line
            const end = child.position?.end?.line ?? line
            node.children[i] = {
              type: 'element',
              tagName: 'div',
              properties: {
                'data-dsh-src-line': String(line),
                'data-dsh-src-end': String(end),
                'data-dsh-math': 'display',
                className: ['dsh-src-math-block'],
              },
              children: [child],
              position: child.position,
            }
            continue
          }
        }
        walk(child)
      }
    }
    walk(tree)
  }
}
