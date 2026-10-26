export type ToolStatus = 'pending' | 'in_progress' | 'completed'

export type ListTask = {
  id: string
  subject: string
  status: ToolStatus
  blockedBy: string[]
}

/** One folder under `<config>/tasks`, read from its N.json files. */
export type ListInfo = {
  /** The folder name: the id of the session that owned the list. */
  id: string
  /** Slug of the project that session ran in; empty when no transcript names it. */
  project: string
  /** Subject of the list's first task. */
  title: string
  open: number
  done: number
  updatedAt: number
  tasks: ListTask[]
}

export type ListScope = 'repo' | 'all'

declare module 'claude-code' {
  interface PluginState {
    'task-lists': {
      lists: ListInfo[]
      scope: ListScope
      openId: string | null
      /** The session's working directory as a project slug, to match `ListInfo.project`. */
      slug: string
      scannedAt: number
      error: string | null
      /** The list id this mod last pointed CLAUDE_CODE_TASK_LIST_ID at; null is the default. */
      activeId: string | null
      /** What the last "use this list" probe found, shown under the tabs. */
      note: string | null
    }
  }
}
