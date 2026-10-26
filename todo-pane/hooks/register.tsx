import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TodoFilter, TodoItem, TodoPriority, TodoStatus } from '../types'

const PANE = 'todo-pane'
const items = atom({ plugin: 'todo-pane', key: 'items' } as const, [] as TodoItem[])
const selected = atom({ plugin: 'todo-pane', key: 'selectedId' } as const, null as string | null)
const doneOpen = atom({ plugin: 'todo-pane', key: 'doneOpen' } as const, false)
const filter = atom({ plugin: 'todo-pane', key: 'filter' } as const, 'group' as TodoFilter)

/** The `todo` tab holds everything unfinished, in-progress included. */
const matches = (item: TodoItem, by: TodoFilter) =>
  by === 'all' || by === 'group' || (by === 'pending' ? item.status !== 'done' : item.status === by)

const FILTERS: { value: TodoFilter; label: string }[] = [
  { value: 'group', label: 'group' },
  { value: 'pending', label: 'todo' },
  { value: 'done', label: 'done' },
  { value: 'all', label: 'all' },
]

type ToolStatus = 'pending' | 'in_progress' | 'completed'

type ListResult = {
  tasks: { id: string; subject: string; status: ToolStatus; blockedBy: string[] }[]
}

const fromTool = (status: ToolStatus): TodoStatus =>
  status === 'completed' ? 'done' : status

/** Applies a change of status, appending to the history only when it moved. */
const withStatus = (item: TodoItem, status: TodoStatus, at: number): TodoItem =>
  item.status === status
    ? item
    : { ...item, status, updatedAt: at, history: [...item.history, { status, at }] }

/** Mirroring is best-effort: a failure here must never fail Claude's tool call. */
const safely = async ($: EngineInterface, fn: () => Promise<unknown>) => {
  try {
    await fn()
    await showStatus($)
  } catch {
    // The pane may lag; the tool call itself is unaffected.
  }
}

/** "3/8 · Writing tests": progress stays visible with the pane closed. */
const showStatus = async ($: EngineInterface) => {
  const list = await read($, items)
  if (list.length === 0) return $.ui.status(undefined)
  const done = list.filter(item => item.status === 'done').length
  const current = list.find(item => item.status === 'in_progress')

  return $.ui.status(`${done}/${list.length}${current ? ` · ${current.activeForm ?? current.text}` : ''}`)
}

type Group = 'ready' | 'blocked' | 'deferred' | 'done'

/** The blockers of an item that are still open; a blocker that is gone no longer blocks. */
const openBlockers = (item: TodoItem, list: TodoItem[]) =>
  item.status === 'done'
    ? []
    : item.blockedBy.filter(id => list.some(one => one.id === id && one.status !== 'done'))

const groupOf = (item: TodoItem, list: TodoItem[]): Group =>
  item.status === 'done'
    ? 'done'
    : item.deferred
      ? 'deferred'
      : openBlockers(item, list).length > 0
        ? 'blocked'
        : 'ready'

const GROUPS: { group: Group; title: string }[] = [
  { group: 'ready', title: 'Ready' },
  { group: 'blocked', title: 'Blocked' },
  { group: 'deferred', title: 'Deferred' },
  { group: 'done', title: 'Done' },
]

const PRIORITIES: TodoPriority[] = ['high', 'normal', 'low']

/** Reads the metadata convention (priority, mandatory); anything else is ignored. */
const readMeta = (meta: unknown): Partial<Pick<TodoItem, 'priority' | 'mandatory' | 'parent' | 'deferred'>> => {
  const m = (meta ?? {}) as Record<string, unknown>

  return {
    ...(PRIORITIES.includes(m.priority as TodoPriority) ? { priority: m.priority as TodoPriority } : {}),
    ...(typeof m.mandatory === 'boolean' ? { mandatory: m.mandatory } : {}),
    ...(typeof m.deferred === 'boolean' ? { deferred: m.deferred } : {}),
    ...(typeof m.parent === 'string' || typeof m.parent === 'number' ? { parent: String(m.parent) } : {}),
  }
}

/** An update may clear a key by setting it to null, as TaskUpdate's metadata does. */
const mergeMeta = (item: TodoItem, meta: unknown): TodoItem => {
  const m = (meta ?? {}) as Record<string, unknown>
  const next = { ...item, ...readMeta(meta) }
  if (m.priority === null) delete next.priority
  if (m.mandatory === null) delete next.mandatory
  if (m.parent === null) delete next.parent
  if (m.deferred === null) delete next.deferred

  return next
}

/** Mandatory first, then high to low; the sort is stable for equals. */
const rank = (item: TodoItem) =>
  (item.mandatory ? 0 : 3) + (item.priority ? PRIORITIES.indexOf(item.priority) : 1)

const badge = (item: TodoItem) => (item.mandatory ? '★' : '')

/** The traffic-light dot in front of a row: red high, yellow normal, green low, a dim dot with none. */
const PRIORITY_COLOR: Record<TodoPriority, string> = { high: 'red', normal: 'yellow', low: 'green' }

/** "3", or "3.1" for the first subtask of 3; a TodoWrite item's `todo-3` shows as 3 too. */
const label = (item: TodoItem, list: TodoItem[], depth = 0): string => {
  const parent = list.find(one => one.id === item.parent && one.id !== item.id)
  if (!parent || depth >= 3) return item.id.replace(/^todo-/, '')
  const siblings = list.filter(one => one.parent === parent.id && one.id !== parent.id)

  return `${label(parent, list, depth + 1)}.${siblings.indexOf(item) + 1}`
}

const isTop = (item: TodoItem, list: TodoItem[]) =>
  !item.parent || item.parent === item.id || !list.some(one => one.id === item.parent)

/** An item then its subtasks, each with its depth; depth is capped so a cycle ends. */
const flatten = (
  item: TodoItem,
  list: TodoItem[],
  depth = 0,
  fold: (one: TodoItem) => boolean = () => false,
): { item: TodoItem; depth: number }[] => [
  { item, depth },
  ...(depth >= 3 || fold(item)
    ? []
    : list
        .filter(kid => kid.parent === item.id && kid.id !== item.id)
        .flatMap(kid => flatten(kid, list, depth + 1, fold))),
]

const LABEL: Record<TodoStatus, string> = { pending: 'todo', in_progress: 'doing', done: 'done' }

const clock = (at: number) => {
  const d = new Date(at)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const fresh = (id: string, text: string, status: TodoStatus, at: number): TodoItem => ({
  id,
  text,
  blockedBy: [],
  status,
  updatedAt: at,
  history: [{ status, at }],
})

type RawTask = {
  id?: unknown
  subject?: unknown
  status?: unknown
  blockedBy?: unknown
  description?: unknown
  activeForm?: unknown
  metadata?: unknown
}

/**
 * The tasks of a list pinned with CLAUDE_CODE_TASK_LIST_ID, read from its folder so
 * descriptions and metadata come along (TaskList leaves them out). Undefined when
 * no list is pinned; a pinned list with no folder yet is an empty one.
 */
const readPinned = async ($: EngineInterface, at: number): Promise<TodoItem[] | undefined> => {
  const id = await $.env.get('CLAUDE_CODE_TASK_LIST_ID')
  if (!id) return undefined
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  const folder = `${dir ? dir.replace(/\/$/, '') : `${home ?? ''}/.claude`}/tasks/${id}`
  const files = (await $.fs.list(folder).catch(() => [])).filter(
    f => f.kind === 'file' && f.name.endsWith('.json'),
  )
  const raw = await Promise.all(
    files.map(async f => {
      try {
        return JSON.parse(await $.fs.read(`${folder}/${f.name}`)) as RawTask
      } catch {
        return undefined
      }
    }),
  )

  return raw
    .filter((t): t is RawTask => t !== undefined && t.id !== undefined && typeof t.subject === 'string')
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map(t => {
      const status: ToolStatus =
        t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending'

      return {
        ...fresh(String(t.id), String(t.subject), fromTool(status), at),
        blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [],
        ...(typeof t.description === 'string' ? { description: t.description } : {}),
        ...(typeof t.activeForm === 'string' ? { activeForm: t.activeForm } : {}),
        ...readMeta(t.metadata),
      }
    })
}

/** The session's active task list: the pinned one, else whatever TaskList answers. */
const readActive = async ($: EngineInterface, at: number): Promise<TodoItem[]> => {
  const pinned = await readPinned($, at)
  if (pinned) return pinned
  const listed = await $.tool.call({ tool: 'TaskList' })
  const tasks = (listed.result as ListResult | undefined)?.tasks ?? []

  return tasks.map(t => ({
    ...fresh(t.id, t.subject, fromTool(t.status), at),
    blockedBy: t.blockedBy,
  }))
}

/** What the model is told so the pane can show more than status: the metadata the pane reads. */
const GUIDE = [
  'todo-pane shows your tasks in a side pane. When you create tasks with TaskCreate, set `metadata` so it can sort and group them:',
  '- `priority`: "high", "normal" or "low".',
  '- `mandatory`: true only for steps that cannot be skipped.',
  '- `parent`: the id of the parent task, for a subtask.',
  '- `deferred`: true for a task parked on purpose.',
  'Leave metadata off trivial tasks. Use `addBlockedBy` for real dependencies: the pane lists those tasks as blocked.',
].join('\n')

export const register: Register = on => {
  // The mod brings its own instructions, so it needs nothing in anyone's CLAUDE.md.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes('TaskCreate')) return composed

    return {
      sections: [...composed.sections, { id: 'todo-pane:task-metadata', text: GUIDE, scope: 'session' }],
    }
  })

  on('session.start', async ($, e, next) => {
    // Never let the pane's setup keep the session from starting.
    await safely($, () =>
      $.command.register({
        name: 'todos',
        description: "Show Claude's todo list in a pane",
      }),
    )
    // Other mods (task-lists) run this after pointing the task tools at another list.
    await safely($, () =>
      $.command.register({
        name: 'todos-sync',
        description: 'Re-read the active task list into the Todos pane',
      }),
    )
    void $.ui.open({ id: PANE, title: 'Todos' })

    // Pick up tasks that exist already, e.g. after a mod reload; off the start path.
    void safely($, async () => {
      const tasks = await readActive($, Date.now())
      await update($, items, list => (list.length > 0 ? list : tasks))
    })

    return next(e)
  })

  on('command.run', { command: 'todos' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Todos', focus: true })

    return { text: 'Todos pane opened.' }
  })

  // The active list changed under the pane: show the new one, not the old one's events.
  on('command.run', { command: 'todos-sync' }, async $ => {
    await safely($, async () => {
      const tasks = await readActive($, Date.now())
      await update($, items, () => tasks)
      await update($, selected, () => null)
    })
    const shown = await read($, items)

    return { text: `Todos pane now shows the active task list (${shown.length} tasks).` }
  })

  // TodoWrite replaces the whole list; keep history for items that persist.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    const at = Date.now()
    await safely($, () => update($, items, list =>
      e.todos.map((todo, i) => {
        const status = fromTool(todo.status)
        const known = list.find(item => item.text === todo.content)
        const item = known ?? fresh(`todo-${i + 1}`, todo.content, status, at)

        return { ...withStatus(item, status, at), activeForm: todo.activeForm }
      }),
    ))

    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    const task = ran.result.task
    await safely($, () => update($, items, list => [
      ...list.filter(item => item.id !== task.id),
      {
        ...fresh(task.id, task.subject, 'pending', Date.now()),
        activeForm: e.activeForm,
        description: e.description,
        ...readMeta(e.metadata),
      },
    ]))

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || !ran.result.success) return ran

    const at = Date.now()
    const status = e.status === 'deleted' ? undefined : e.status
    await safely($, () => update($, items, list =>
      e.status === 'deleted'
        ? list.filter(item => item.id !== e.taskId)
        : list.map(item => {
            if (item.id !== e.taskId) return item
            const moved = status ? withStatus(item, fromTool(status), at) : item

            return {
              ...mergeMeta(moved, e.metadata),
              text: e.subject ?? moved.text,
              description: e.description ?? moved.description,
              activeForm: e.activeForm ?? moved.activeForm,
              blockedBy: [...new Set([...moved.blockedBy, ...(e.addBlockedBy ?? [])])],
              updatedAt: at,
            }
          }),
    ))

    return ran
  })

  // The tabs select as the focus ring lands on them, so the arrows switch tabs.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const tab = FILTERS.find(f => `filter-${f.value}` === e.element)
    if (tab) await safely($, () => update($, filter, () => tab.value))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, items)
    const open = await read($, selected)
    const by = await read($, filter)
    const isGrouped = by === 'group'
    // Group and all show top-level tasks with their subtasks nested; the rest are flat.
    const nest = by === 'group' || by === 'all'
    const isDoneOpen = await read($, doneOpen)
    const done = list.filter(item => item.status === 'done').length
    const current = list.find(item => item.status === 'in_progress')
    const visible = nest ? list.filter(item => isTop(item, list)) : list.filter(item => matches(item, by))
    // The pane's own visible rows: header block (5 lines) and one more-line come off the top,
    // and in the group view every section keeps a header line and a rule below it.
    const bodyRows = e.props.scroll.bodyRows
    const sectionCount = isGrouped ? GROUPS.filter(g => visible.some(item => groupOf(item, list) === g.group)).length : 0
    const room = Math.max(1, bodyRows - 6 - sectionCount * 2)
    const rule = '─'.repeat(Math.max(10, Math.min(60, e.props.bodyColumns)))
    const chips = {
      doing: list.filter(item => item.status === 'in_progress').length,
      blocked: list.filter(item => groupOf(item, list) === 'blocked').length,
      deferred: list.filter(item => groupOf(item, list) === 'deferred').length,
    }
    const filled = list.length > 0 ? Math.round((10 * done) / list.length) : 0

    // Grouped: ready (doing first), blocked, deferred, done. Flat: the latest items.
    const sections = isGrouped
      ? GROUPS.map(({ group, title }) => ({
          title,
          rows: visible
            .filter(item => groupOf(item, list) === group)
            .sort(
              (a, b) =>
                Number(b.status === 'in_progress') - Number(a.status === 'in_progress') ||
                rank(a) - rank(b),
            ),
        })).filter(section => section.rows.length > 0)
      : [{ title: '', rows: visible.length > room ? visible.slice(-room) : visible }]
    let budget = isGrouped ? room : Infinity
    const trimmed = sections.map(section => {
      // The Done group stays folded until opened; its header still counts it.
      const isFolded = isGrouped && section.title === 'Done' && !isDoneOpen
      const rows = isFolded ? [] : section.rows.slice(0, Math.max(0, budget))
      budget -= rows.length

      return { ...section, rows, total: section.rows.length, isFolded }
    })
    const hidden = isGrouped
      ? trimmed.reduce((n, section) => n + (section.isFolded ? 0 : section.total - section.rows.length), 0)
      : visible.length - (sections[0]?.rows.length ?? 0)
    // A finished parent folds its subtasks behind the rollup, unless it is opened.
    const fold = (one: TodoItem) => one.status === 'done' && open !== one.id

    // Numbers are right-aligned to the widest one in the whole list, so tabs don't shift them.
    const labelWidth = Math.max(1, ...list.map(one => label(one, list).length))

    // What a clicked task opens: its description, its facts, and its timeline.
    const card = (item: TodoItem) => {
      const parent = list.find(one => one.id === item.parent && one.id !== item.id)
      const facts = [
        item.priority ? `${item.priority} priority` : '',
        item.mandatory ? 'mandatory' : '',
        item.deferred ? 'deferred' : '',
        parent ? `subtask of ${label(parent, list)}` : '',
      ].filter(Boolean)

      return [
        item.description ?? '',
        facts.join(' · '),
        item.history.map(step => `${LABEL[step.status]} ${clock(step.at)}`).join(' → '),
      ].filter(Boolean)
    }

    const row = (item: TodoItem, depth: number) => {
      const waits = openBlockers(item, list)
      const kids = nest ? list.filter(kid => kid.parent === item.id && kid.id !== item.id) : []

      return (
        <Box flexDirection="column" paddingLeft={depth * 2}>
          <Button
            key={item.id}
            plain
            onPress={() => update($, selected, now => (now === item.id ? null : item.id))}
          >
            {depth > 0 && <Text dimColor>{'↳ '}</Text>}
            {item.priority ? (
              <Text color={PRIORITY_COLOR[item.priority]}>{'● '}</Text>
            ) : (
              <Text dimColor>{'· '}</Text>
            )}
            {/* One status slot: done, blocked, doing or pending, so every row lines up. */}
            {item.status === 'done' ? (
              <Text bold color="green">
                {'✓ '}
              </Text>
            ) : waits.length > 0 ? (
              <Text bold color="red">
                {'! '}
              </Text>
            ) : item.status === 'in_progress' ? (
              <Text color="cyan">{'◐ '}</Text>
            ) : (
              <Text>{'○ '}</Text>
            )}
            <Text
              bold={item.status === 'in_progress'}
              dimColor={item.status === 'done'}
              color={item.status === 'in_progress' ? 'cyan' : undefined}
            >
              {label(item, list).padStart(labelWidth)} {badge(item) ? `${badge(item)} ` : ''}{item.text}
            </Text>
          </Button>
          {kids.length > 0 && (
            <Text dimColor>
              {'   '}
              {kids.filter(kid => kid.status === 'done').length}/{kids.length} subtasks
            </Text>
          )}
          {waits.length > 0 && (
            <Text dimColor>
              {'   '}waits for {waits.map(id => { const blocker = list.find(one => one.id === id); return blocker ? label(blocker, list) : id }).join(', ')}
            </Text>
          )}
          {open === item.id &&
            card(item).map((line, i, lines) => (
              <Text dimColor>
                {'    '}
                {i === lines.length - 1 ? '╰ ' : '│ '}
                {line}
              </Text>
            ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text color="green">{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(10 - filled)}</Text>
          <Text bold>{` ${done}/${list.length} done`}</Text>
          {chips.doing > 0 && <Text color="cyan">{`  ◐ ${chips.doing}`}</Text>}
          {chips.blocked > 0 && <Text color="red">{`  ! ${chips.blocked}`}</Text>}
          {chips.deferred > 0 && <Text dimColor>{`  ◌ ${chips.deferred}`}</Text>}
        </Box>
        <Text color="cyan">{current ? `◐ ${current.activeForm ?? current.text}` : ' '}</Text>
        <Text dimColor>{rule}</Text>
        <Box>
          {FILTERS.map((f, i) => {
            const count = list.filter(item => matches(item, f.value)).length

            return (
              <Button
                key={`filter-${f.value}`}
                plain
                hotkey={String(i + 1)}
                onPress={() => update($, filter, () => f.value)}
              >
                <Text bold={by === f.value} inverse={by === f.value} dimColor={by !== f.value}>
                  {` ${f.label}${f.value === 'group' ? '' : ` ${count}`} `}
                </Text>
                <Text>{' '}</Text>
              </Button>
            )
          })}
        </Box>
        <Text dimColor>{rule}</Text>
        {visible.length === 0 && <Text dimColor>No todos here.</Text>}
        {!isGrouped && hidden > 0 && <Text dimColor>… {hidden} earlier</Text>}
        {trimmed.map((section, i) => (
          <Box flexDirection="column">
            {isGrouped && i > 0 && <Text dimColor>{rule}</Text>}
            {isGrouped && section.title === 'Done' && (
              <Button key="done-toggle" plain hotkey="d" onPress={() => update($, doneOpen, was => !was)}>
                <Text bold dimColor>
                  {section.isFolded ? '▸' : '▾'} Done ({section.total})
                </Text>
              </Button>
            )}
            {isGrouped && section.title !== 'Done' && (
              <Text bold dimColor>
                {section.title} ({section.total})
              </Text>
            )}
            {section.rows
              .flatMap(top => (nest ? flatten(top, list, 0, fold) : [{ item: top, depth: 0 }]))
              .map(r => row(r.item, r.depth))}
          </Box>
        ))}
        {isGrouped && hidden > 0 && <Text dimColor>… {hidden} more</Text>}
      </Box>
    )
  })
}
