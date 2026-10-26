export type FileSource = 'pasted' | 'mention' | 'read' | 'edit'
export type FileKind = 'image' | 'pdf' | 'text' | 'other'
export type FileFilter = 'all' | 'mine' | 'claude'

export type FileRow = {
  /** Absolute path. */
  path: string
  name: string
  kind: FileKind
  /** How the file came into the session; a file can have several. */
  sources: FileSource[]
  firstAt: number
  lastAt: number
  /** How many times it was put back into a prompt with Use. */
  uses: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-files': {
      files: FileRow[]
      selected: string | null
      /** The path being viewed in the panel, or null for the list. */
      viewing: string | null
      /** First line (text) shown while viewing. */
      viewOffset: number
      /** The bottom half shows thumbnail tiles or the plain list. */
      mode: 'grid' | 'list'
      /** The grid's current page, from 0. */
      gridPage: number
      /** The list's current page, from 0. */
      listPage: number
      /** The viewer takes the whole panel, the host pane's part included. */
      expanded: boolean
      filter: FileFilter
    }
  }
}
