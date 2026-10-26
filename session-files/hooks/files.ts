import type { FileFilter, FileKind, FileRow, FileSource } from '../types'

const MAX_ROWS = 200
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i
const PDF = /\.pdf$/i
const BINARY = /\.(zip|gz|tar|dmg|exe|bin|mp[34]|mov|wav|docx?|xlsx?|pptx?)$/i

export const kindOf = (path: string): FileKind => (IMAGE.test(path) ? 'image' : PDF.test(path) ? 'pdf' : BINARY.test(path) ? 'other' : 'text')

export const nameOf = (path: string) => path.split(/[\\/]/).pop() || path

/** Absolute form of a path the model or the person gave, relative to the working directory. */
export function absolute(cwd: string, path: string): string {
  if (path.startsWith('/')) return path
  const parts = `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return `/${out.join('/')}`
}

/** What goes after "@" to mention the file: relative inside the working directory, else absolute. */
export function mentionOf(cwd: string, path: string): string {
  const base = `${cwd.replace(/\/+$/, '')}/`
  return path.startsWith(base) ? path.slice(base.length) : path
}

/** The paths an `@` mention names in a prompt, quotes and trailing punctuation removed. */
export function mentionPaths(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/(?:^|\s)@("[^"]+"|\S+)/g)) {
    const path = match[1]!.replace(/^"|"$/g, '').replace(/[,.;:!?)\]]+$/, '')
    if (path.includes('/') || /\.[A-Za-z0-9]{1,5}$/.test(path)) found.push(path)
  }
  return found
}

/** Adds a file, or notes another way it came in; the latest touched stays first. */
export function addFile(list: FileRow[], path: string, source: FileSource, at: number): FileRow[] {
  const old = list.find(row => row.path === path)
  const row: FileRow = old
    ? { ...old, sources: old.sources.includes(source) ? old.sources : [...old.sources, source], lastAt: at }
    : { path, name: nameOf(path), kind: kindOf(path), sources: [source], firstAt: at, lastAt: at, uses: 0 }

  return [row, ...list.filter(one => one.path !== path)].slice(0, MAX_ROWS)
}

const isMine = (row: FileRow) => row.sources.some(s => s === 'pasted' || s === 'mention')
const isClaudes = (row: FileRow) => row.sources.some(s => s === 'read' || s === 'edit')

export function visibleFiles(list: FileRow[], filter: FileFilter): FileRow[] {
  return filter === 'mine' ? list.filter(isMine) : filter === 'claude' ? list.filter(isClaudes) : list
}

const WORDS: Record<FileSource, string> = { pasted: 'pasted', mention: '@', read: 'read', edit: 'edited' }
export const sourcesLabel = (row: FileRow) => row.sources.map(s => WORDS[s]).join(' · ')

/** Rows worth keeping between sessions: a pasted image's file lives in the session's temp folder. */
export const keepable = (list: FileRow[]) => list.filter(row => row.sources.some(s => s !== 'pasted'))

const TOOL_PATHS: Record<string, { key: string; source: FileSource }> = {
  Read: { key: 'file_path', source: 'read' },
  Edit: { key: 'file_path', source: 'edit' },
  MultiEdit: { key: 'file_path', source: 'edit' },
  Write: { key: 'file_path', source: 'edit' },
  NotebookEdit: { key: 'notebook_path', source: 'edit' },
}

/** The file a tool call touches, when it is one of the file tools. */
export function touched(e: { tool: string }): { path: string; source: FileSource } | undefined {
  const spec = TOOL_PATHS[e.tool]
  const path = spec && (e as unknown as Record<string, unknown>)[spec.key]

  return spec && typeof path === 'string' && path !== '' ? { path, source: spec.source } : undefined
}

// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2

/** The biggest box of cells that keeps a picture's shape inside `maxColumns` x `maxRows`. */
export function fitBox(size: { width: number; height: number } | null, maxColumns: number, maxRows: number) {
  const { width, height } = size ?? { width: 16, height: 10 }
  let columns = Math.max(1, maxColumns)
  let rows = Math.max(1, Math.round((columns * height) / (CELL_ASPECT * width)))
  if (rows > maxRows) {
    rows = Math.max(1, maxRows)
    columns = Math.max(1, Math.min(maxColumns, Math.round((rows * CELL_ASPECT * width) / height)))
  }

  return { columns, rows }
}

/** The files a filter and a search box leave: every word of the query must be in the name or the path. */
export function matching(list: FileRow[], by: FileFilter, query: string): FileRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(word => word !== '')

  return visibleFiles(list, by).filter(row => {
    const hay = `${row.name} ${row.path}`.toLowerCase()

    return words.every(word => hay.includes(word))
  })
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`

  return `${Math.round(seconds / 86400)}d ago`
}
