/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const React = require('react')
const { T } = require('./tokens.cjs')
const { ancestorPaths } = require('../state/sidebar-tree.mjs')
const h = React.createElement

const EXPANDED_KEY = 'live-editor:tree-expanded:v1'

function readExpanded () {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return new Set(parsed.filter((value) => typeof value === 'string'))
  } catch {
    return null
  }
}

function writeExpanded (expanded) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]))
  } catch { /* storage unavailable */ }
}

function buildTree (entries) {
  const root = { kind: 'root', path: '', children: [] }
  const dirs = new Map()
  const ensureDir = (parts) => {
    let parent = root
    for (let i = 0; i < parts.length; i += 1) {
      const path = parts.slice(0, i + 1).join('/')
      let node = dirs.get(path)
      if (node === undefined) {
        const entry = entries.find((item) => item.kind === 'dir' && item.path === path)
        node = {
          kind: 'dir',
          path,
          label: entry?.label ?? parts[i],
          position: entry?.position ?? null,
          children: [],
        }
        dirs.set(path, node)
        parent.children.push(node)
      }
      parent = node
    }
    return parent
  }
  for (const entry of entries) {
    if (entry.kind === 'dir') {
      ensureDir(entry.path.split('/'))
    } else if (entry.kind === 'doc') {
      const parts = entry.path.split('/')
      ensureDir(parts.slice(0, -1)).children.push({ ...entry, label: entry.title ?? entry.name ?? entry.path })
    } else if (entry.kind === 'other') {
      // Non-doc files (_category_.json etc.) are read-only rows, not docs.
      const parts = entry.path.split('/')
      ensureDir(parts.slice(0, -1)).children.push({
        kind: 'other',
        path: entry.path,
        label: entry.path,
        title: entry.path,
        editable: false,
      })
    }
  }
  const sort = (node) => {
    node.children.sort((a, b) => {
      if (a.kind === 'dir' && b.kind !== 'dir') return -1
      if (b.kind === 'dir' && a.kind !== 'dir') return 1
      const pa = a.position ?? 9999
      const pb = b.position ?? 9999
      if (pa !== pb) return pa - pb
      const la = String(a.label ?? a.title ?? a.name ?? a.path)
      const lb = String(b.label ?? b.title ?? b.name ?? b.path)
      return la.localeCompare(lb)
    })
    for (const child of node.children) if (child.kind === 'dir') sort(child)
  }
  sort(root)
  return root
}

/**
 * The Docusaurus sidebar payload only contains docs. Append the Host index's
 * non-doc entries (_category_.json etc.) under "其他文件" as locked rows.
 */
function attachOtherEntries (tree, otherEntries) {
  if (!tree || !Array.isArray(tree.children) || otherEntries.length === 0) return tree
  const nodes = otherEntries.map((entry) => ({
    kind: 'other',
    path: entry.path,
    label: entry.path,
    title: entry.path,
    editable: false,
  }))
  const other = tree.children.find((child) => child?.kind === 'dir'
    && (child.path === '__other__' || child.label === '其他文件'))
  if (other !== undefined) {
    return {
      ...tree,
      children: tree.children.map((child) => child === other
        ? { ...child, children: [...(child.children ?? []), ...nodes] }
        : child),
    }
  }
  return {
    ...tree,
    children: [...tree.children, {
      kind: 'dir',
      path: '__other_files__',
      label: '其他文件',
      indexPath: null,
      indexDisabled: false,
      children: nodes,
    }],
  }
}

function nodeText (node) {
  return `${node.label ?? ''} ${node.title ?? ''} ${node.path ?? ''} ${node.docId ?? ''} ${node.href ?? ''}`.toLowerCase()
}

function filterTree (node, query) {
  if (node.kind === 'doc' || node.kind === 'link') {
    return nodeText(node).includes(query) ? node : null
  }
  if (!Array.isArray(node.children)) return null
  const children = node.children.map((child) => filterTree(child, query)).filter(Boolean)
  if (children.length > 0) return { ...node, children }
  return nodeText(node).includes(query) ? { ...node, children } : null
}

function defaultExpandedDirs (tree) {
  const result = new Set()
  const visit = (node) => {
    if (!node || !Array.isArray(node.children)) return
    for (const child of node.children) {
      if (child.kind === 'dir') {
        if (child.defaultCollapsed !== true) result.add(child.path)
        visit(child)
      }
    }
  }
  visit(tree)
  return result
}

function FilePanel (props) {
  const { entries, sidebarTree, activePath, draftPaths, pinned, onOpen, onClose, onTogglePin, onRefresh, discoveredInstances, discoveredDocs, onOpenReadOnly } = props
  const [query, setQuery] = React.useState('')
  const [notice, setNotice] = React.useState('')
  React.useEffect(() => {
    if (notice === '') return undefined
    const timer = setTimeout(() => setNotice(''), 4000)
    return () => clearTimeout(timer)
  }, [notice])
  const baseTree = React.useMemo(() => {
    const tree = sidebarTree ?? buildTree(Array.isArray(entries) ? entries : [])
    if (!sidebarTree) return tree
    const others = Array.isArray(entries) ? entries.filter((entry) => entry?.kind === 'other') : []
    return attachOtherEntries(tree, others)
  }, [sidebarTree, entries])
  const storedExpanded = React.useRef(readExpanded())
  const [expanded, setExpanded] = React.useState(
    () => storedExpanded.current ?? defaultExpandedDirs(baseTree),
  )
  const initialized = React.useRef(false)

  React.useEffect(() => {
    if (initialized.current) return
    if (!sidebarTree && (!Array.isArray(entries) || entries.length === 0)) return
    initialized.current = true
    if (storedExpanded.current !== null) return
    setExpanded(defaultExpandedDirs(baseTree))
  }, [baseTree, entries, sidebarTree])

  React.useEffect(() => {
    if (!initialized.current) return
    writeExpanded(expanded)
  }, [expanded])

  React.useEffect(() => {
    if (typeof activePath !== 'string' || activePath.length === 0) return
    const chain = ancestorPaths(baseTree, activePath)
    if (chain.length === 0) return
    setExpanded((previous) => {
      if (chain.every((path) => previous.has(path))) return previous
      const next = new Set(previous)
      for (const path of chain) next.add(path)
      return next
    })
  }, [activePath, baseTree])

  const filtering = query.trim() !== ''
  const tree = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return q === '' ? baseTree : (filterTree(baseTree, q) ?? { kind: 'root', path: '', children: [] })
  }, [baseTree, query])

  const rows = []
  const walk = (node, depth) => {
    for (const child of node.children ?? []) {
      rows.push({ node: child, depth })
      if (child.kind === 'dir' && (filtering || expanded.has(child.path))) walk(child, depth + 1)
    }
  }
  walk(tree, 0)

  const toggle = (path) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const rowButtonStyle = (depth, active) => ({
    display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
    border: 0, cursor: 'pointer',
    background: active ? T.bgMuted : 'transparent',
    color: active ? T.text : T.textSecondary,
    padding: `3px 8px 3px ${8 + depth * 12 + 14}px`, font: `${T.uiSmallSize}/1.5 ${T.font}`,
  })

  return h('div', {
    'aria-label': '文件树',
    style: {
      flex: pinned ? '0 0 268px' : 'none',
      width: pinned ? 268 : 280,
      maxWidth: '70%',
      minHeight: 0, display: 'flex', flexDirection: 'column',
      background: T.bg, color: T.text,
      borderRight: pinned ? `1px solid ${T.border}` : 0,
      ...(pinned ? {} : {
        position: 'absolute', left: 0, top: 0, bottom: 0, zIndex: 30,
        boxShadow: '4px 0 18px rgba(0,0,0,0.22)',
      }),
    },
  },
  h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
      borderBottom: `1px solid ${T.border}`, flex: '0 0 auto',
    },
  },
    h('span', {
      title: sidebarTree
        ? '按 Docusaurus 侧栏顺序显示'
        : '尚未收到预览侧栏数据；当前按文件系统顺序显示',
      style: { fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, sidebarTree ? '侧边栏' : '文件 · 未连接'),
    h('button', {
      type: 'button', onClick: onTogglePin, title: pinned ? '取消固定，改为抽屉' : '固定为左栏',
      style: { border: `1px solid ${T.border}`, background: T.bg, color: T.textSecondary, borderRadius: T.radius, padding: '1px 6px', cursor: 'pointer' },
    }, pinned ? '收起' : '固定'),
    h('button', {
      type: 'button', onClick: onRefresh, title: '刷新文件列表',
      style: { border: `1px solid ${T.border}`, background: T.bg, color: T.textSecondary, borderRadius: T.radius, padding: '1px 6px', cursor: 'pointer' },
    }, '刷新'),
    !pinned && h('button', {
      type: 'button', onClick: onClose, title: '关闭文件树',
      style: { border: 0, background: 'transparent', color: T.textSecondary, cursor: 'pointer', fontSize: '15px', padding: '0 4px' },
    }, '×'),
  ),
  h('div', { style: { padding: '6px 8px', borderBottom: `1px solid ${T.border}`, flex: '0 0 auto' } },
    h('input', {
      value: query,
      onChange: (event) => setQuery(event.target.value),
      placeholder: '过滤文件…',
      'aria-label': '过滤文件',
      style: {
        width: '100%', boxSizing: 'border-box', border: `1px solid ${T.border}`,
        borderRadius: T.radius, background: T.bgMuted, color: T.text,
        padding: '4px 6px', font: `${T.uiSmallSize}/1.4 ${T.font}`, outline: 'none',
      },
    }),
  ),
  notice !== '' && h('div', {
    role: 'status',
    style: {
      padding: '4px 10px', borderBottom: `1px solid ${T.border}`,
      background: T.bgMuted, color: T.textTertiary,
      font: `${T.uiSmallSize}/1.4 ${T.font}`, flex: '0 0 auto',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    },
  }, notice),
  h('div', { style: { flex: '1 1 auto', overflow: 'auto', padding: '4px 0' } },
    rows.length === 0 && h('div', { style: { padding: '10px 12px', color: T.textTertiary, fontSize: T.uiSmallSize } }, '没有匹配的文件'),
    rows.map(({ node, depth }) => {
      if (node.kind === 'dir') {
        const open = filtering || expanded.has(node.path)
        const hasIndex = typeof node.indexPath === 'string' && node.indexPath.length > 0
        const active = hasIndex && node.indexPath === activePath
        const draft = hasIndex && Array.isArray(draftPaths) && draftPaths.includes(node.indexPath)
        const activate = () => {
          if (hasIndex && node.indexDisabled !== true) onOpen(node.indexPath)
          else toggle(node.path)
        }
        return h('div', {
          key: `d:${node.path}`,
          style: {
            display: 'flex', alignItems: 'center', width: '100%',
            padding: `2px 8px 2px ${8 + depth * 12}px`,
            background: active ? T.bgMuted : 'transparent',
          },
        },
          h('button', {
            type: 'button',
            onClick: (event) => { event.stopPropagation(); toggle(node.path) },
            title: open ? '收起分类' : '展开分类',
            'aria-label': open ? '收起分类' : '展开分类',
            style: {
              border: 0, background: 'transparent', color: T.textTertiary,
              cursor: 'pointer', padding: '0 2px', width: 16, font: `${T.uiSmallSize}/1.5 ${T.font}`,
            },
          }, open ? '▾' : '▸'),
          h('button', {
            type: 'button',
            onClick: activate,
            title: hasIndex
              ? `打开分类页：${node.indexTitle ?? node.indexPath}`
              : node.path,
            style: {
              flex: 1, minWidth: 0, textAlign: 'left', border: 0, background: 'transparent',
              color: active ? T.text : T.textSecondary, cursor: 'pointer', padding: 0,
              font: `${T.uiSmallSize}/1.5 ${T.font}`,
              fontWeight: active ? 600 : 400,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            },
          }, node.label ?? node.path),
          draft && h('span', {
            title: '有未保存草稿',
            style: { width: 6, height: 6, borderRadius: '50%', background: T.warning, flex: '0 0 auto' },
          }),
          hasIndex && h('span', {
            title: '分类首页',
            style: { color: T.textTertiary, fontSize: 10, flex: '0 0 auto' },
          }, '◇'),
        )
      }
      if (node.kind === 'other') {
        return h('div', {
          key: `o:${node.path}`,
          title: `不可编辑：${node.path}`,
          style: {
            display: 'flex', alignItems: 'center', gap: 6,
            padding: `3px 8px 3px ${8 + depth * 12 + 14}px`,
            color: T.textTertiary, font: `${T.uiSmallSize}/1.5 ${T.font}`, opacity: 0.72,
          },
        },
          h('span', { 'aria-hidden': 'true', style: { width: 10, flex: '0 0 auto' } }, '🔒'),
          h('button', {
            type: 'button',
            'aria-disabled': 'true',
            title: `不可编辑：${node.path}`,
            onClick: () => setNotice(`不可编辑：${node.path}`),
            style: {
              flex: 1, minWidth: 0, textAlign: 'left', border: 0, background: 'transparent',
              color: 'inherit', cursor: 'help', padding: 0, font: 'inherit',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, node.label ?? node.path),
        )
      }
      if (node.kind === 'link') {
        return h('div', {
          key: node.key ?? `link:${depth}:${node.label}`,
          title: node.href,
          style: {
            display: 'flex', alignItems: 'center', gap: 6, color: T.textTertiary,
            padding: `3px 8px 3px ${8 + depth * 12 + 14}px`, font: `${T.uiSmallSize}/1.5 ${T.font}`,
            opacity: 0.7,
          },
        },
          h('span', { style: { width: 10 } }, '🔒'),
          h('span', {
            style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, node.label ?? node.href),
        )
      }
      const active = node.path === activePath
      const draft = Array.isArray(draftPaths) && draftPaths.includes(node.path)
      return h('button', {
        key: `f:${node.path}`,
        type: 'button',
        onClick: () => onOpen(node.path),
        title: node.path,
        style: rowButtonStyle(depth, active),
      },
        h('span', {
          style: {
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontWeight: active ? 600 : 400,
          },
        }, node.label ?? node.title ?? node.path),
        draft && h('span', {
          title: '有未保存草稿',
          style: { width: 6, height: 6, borderRadius: '50%', background: T.warning, flex: '0 0 auto' },
        }),
      )
    }),
    Array.isArray(discoveredInstances) && discoveredInstances.length > 0
      && h('div', { style: { marginTop: 10, borderTop: `1px solid ${T.border}`, paddingTop: 6 } },
        h('div', {
          style: { padding: '3px 10px', color: T.textTertiary, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
        }, '只读内容'),
        discoveredInstances.map((entry) => {
          const docs = Array.isArray(discoveredDocs)
            ? discoveredDocs.filter((doc) => doc && doc.instanceId === entry.instanceId)
            : []
          return h('div', { key: `instance:${entry.instanceId}` },
            h('div', {
              title: entry.routePath ?? entry.instanceId,
              style: {
                display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px',
                color: T.textTertiary, font: `${T.uiSmallSize}/1.5 ${T.font}`, opacity: 0.8,
              },
            },
              h('span', { style: { width: 10 } }, '🔒'),
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                entry.instanceId,
                h('span', { style: { color: T.textTertiary } }, entry.routePath ? `  ${entry.routePath}` : ''),
              ),
            ),
            docs.map((doc) => h('button', {
              key: `instance-doc:${entry.instanceId}:${doc.source}`,
              type: 'button',
              title: doc.source,
              disabled: typeof onOpenReadOnly !== 'function',
              onClick: typeof onOpenReadOnly === 'function' ? () => onOpenReadOnly(doc) : undefined,
              style: {
                display: 'flex', gap: 6, width: 'calc(100% - 0px)', border: 0,
                textAlign: 'left', background: 'transparent', padding: '1px 10px 1px 26px',
                color: T.textTertiary, font: `${T.uiSmallSize}/1.5 ${T.font}`,
                opacity: 0.78, cursor: typeof onOpenReadOnly === 'function' ? 'pointer' : 'default',
              },
            },
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                doc.title ?? doc.source),
              h('span', { style: { flex: '0 0 auto', fontSize: 10, opacity: 0.7 } }, '只读'),
            )),
          )
        }),
      )
  ))
}

module.exports = { FilePanel, __buildTree: buildTree, __filterTree: filterTree, __defaultExpandedDirs: defaultExpandedDirs }
