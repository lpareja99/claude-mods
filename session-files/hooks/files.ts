import type { FileFilter, FileKind, FileRow, FileSource } from '../types'

const MAX_ROWS = 200
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|heic|tiff?)$/i
const BINARY = /\.(pdf|zip|gz|tar|dmg|exe|bin|mp[34]|mov|wav|docx?|xlsx?|pptx?)$/i

export const kindOf = (path: string): FileKind => (IMAGE.test(path) ? 'image' : BINARY.test(path) ? 'other' : 'text')

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
