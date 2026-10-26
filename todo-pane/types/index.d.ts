export type TodoStatus = 'pending' | 'in_progress' | 'done'

/** One status change of a todo, kept so intermediate steps are not lost. */
export type TodoTransition = { status: TodoStatus; at: number }

export type TodoItem = {
  id: string
  text: string
  /** Present-continuous label ("Running tests"), when the tool gave one. */
  activeForm?: string
  /** Longer description, from TaskCreate. */
  description?: string
  blockedBy: string[]
  priority?: TodoPriority
  mandatory?: boolean
  /** Id of the parent task, from metadata.parent: this item is its subtask. */
  parent?: string
  /** From metadata.deferred: parked on purpose, shown in its own group. */
  deferred?: boolean
  status: TodoStatus
  updatedAt: number
  history: TodoTransition[]
}

/** Set by Claude through task metadata: `priority` and `mandatory`. */
export type TodoPriority = 'high' | 'normal' | 'low'

export type TodoFilter = 'group' | 'all' | TodoStatus

declare module 'claude-code' {
  interface PluginState {
    'todo-pane': {
      items: TodoItem[]
      selectedId: string | null
      filter: TodoFilter
      doneOpen: boolean
    }
  }
}
