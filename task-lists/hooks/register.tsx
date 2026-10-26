import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ListInfo, ListScope, ListTask, ToolStatus } from '../types'

const PANE = 'task-lists'
const lists = atom({ plugin: 'task-lists', key: 'lists' } as const, [] as ListInfo[])
const scope = atom({ plugin: 'task-lists', key: 'scope' } as const, 'repo' as ListScope)
const openId = atom({ plugin: 'task-lists', key: 'openId' } as const, null as string | null)
const slug = atom({ plugin: 'task-lists', key: 'slug' } as const, '')
const scannedAt = atom({ plugin: 'task-lists', key: 'scannedAt' } as const, 0)
const failure = atom({ plugin: 'task-lists', key: 'error' } as const, null as string | null)
const activeId = atom({ plugin: 'task-lists', key: 'activeId' } as const, null as string | null)
const note = atom({ plugin: 'task-lists', key: 'note' } as const, null as string | null)

type RawTask = {
  id?: unknown
  subject?: unknown
  status?: unknown
  blockedBy?: unknown
}

const ICON: Record<ToolStatus, string> = { pending: '○', in_progress: '▶', completed: '✓' }

/** Claude Code names a project folder after its path, every other character a dash. */
const projectSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** "-Users-me-Documents-CV-Portal" reads as "Documents-CV-Portal". */
const shortProject = (project: string) =>
  project === '' ? 'unknown repo' : project.replace(/^-Users-[^-]+-/, '')

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text

const pad = (text: string, width: number) =>
  text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length)

/** "5m", "3h", "2d": how long ago a list last changed. */
const age = (at: number) => {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`

  return `${Math.round(minutes / 1440)}d`
}

const stamp = (at: number) => {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

const configRoot = async ($: EngineInterface) => {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return dir.replace(/\/$/, '')
  const home = await $.env.get('HOME')

  return `${home ?? ''}/.claude`
}

const readTask = async ($: EngineInterface, path: string): Promise<ListTask | undefined> => {
  try {
    const raw = JSON.parse(await $.fs.read(path)) as RawTask
    if (typeof raw.id !== 'string' || typeof raw.subject !== 'string') return undefined
    const status: ToolStatus =
      raw.status === 'completed' || raw.status === 'in_progress' ? raw.status : 'pending'

    return {
      id: raw.id,
      subject: raw.subject,
      status,
      blockedBy: Array.isArray(raw.blockedBy) ? raw.blockedBy.map(String) : [],
    }
  } catch {
    return undefined
  }
}

/** Which project each session id belongs to, from the transcripts named after them. */
const sessionOwners = async ($: EngineInterface, root: string) => {
  const owners = new Map<string, string>()
  const projects = await $.fs.list(`${root}/projects`).catch(() => [])
  for (const project of projects) {
    if (project.kind !== 'dir') continue
    const files = await $.fs.list(`${root}/projects/${project.name}`).catch(() => [])
    for (const file of files) {
      if (file.name.endsWith('.jsonl')) owners.set(file.name.slice(0, -'.jsonl'.length), project.name)
    }
  }

  return owners
}

const scan = async ($: EngineInterface) => {
  const root = await configRoot($)
  const owners = await sessionOwners($, root)
  const found: ListInfo[] = []

  // No tasks folder yet is an empty answer, not an error.
  for (const dir of await $.fs.list(`${root}/tasks`).catch(() => [])) {
    if (dir.kind !== 'dir') continue
    const entries = await $.fs.list(`${root}/tasks/${dir.name}`)
    const files = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json'))
    const read = await Promise.all(files.map(f => readTask($, `${root}/tasks/${dir.name}/${f.name}`)))
    const tasks = read
      .filter((t): t is ListTask => t !== undefined)
      .sort((a, b) => Number(a.id) - Number(b.id))
    if (tasks.length === 0) continue

    const done = tasks.filter(t => t.status === 'completed').length
    found.push({
      id: dir.name,
      project: owners.get(dir.name) ?? '',
      title: tasks[0]?.subject ?? '',
      open: tasks.length - done,
      done,
      updatedAt: Math.max(...files.map(f => f.mtimeMs)),
      tasks,
    })
  }

  // Lists with work left come first, newest first within each half.
  found.sort((a, b) => Number(b.open > 0) - Number(a.open > 0) || b.updatedAt - a.updatedAt)
  await update($, lists, () => found)
  await update($, scannedAt, () => Date.now())
  await update($, failure, () => null)
}

/** A scan that fails shows its reason in the pane and never breaks the session. */
const refresh = async ($: EngineInterface) => {
  try {
    await scan($)
  } catch (error) {
    await update($, failure, () => (error instanceof Error ? error.message : String(error)))
  }
}

/** Two quick picks would race the variable, the check and the sync; one at a time. */
let switching = false

/**
 * Points the task tools at a saved list, or back at the session's own with no list,
 * then checks that TaskList really sees it. Only a list the engine confirms becomes
 * the active one and reaches the Todos pane; otherwise the variable is put back.
 */
const useList = async ($: EngineInterface, list: ListInfo | undefined) => {
  if (switching) return
  switching = true
  try {
    const before = await $.env.get('CLAUDE_CODE_TASK_LIST_ID')
    const set = await $.env.set('CLAUDE_CODE_TASK_LIST_ID', list?.id)
    if (set.deny !== undefined) {
      await update($, note, () => `⚠ Refused: ${set.deny}`)

      return
    }

    if (list !== undefined) {
      const listed = await $.tool.call({ tool: 'TaskList' })
      const seen = (listed.result as { tasks?: { id: unknown; subject: unknown }[] } | undefined)?.tasks ?? []
      const isSame =
        seen.length === list.tasks.length &&
        list.tasks.every(task => seen.some(s => String(s.id) === task.id && s.subject === task.subject))
      if (!isSame) {
        await $.env.set('CLAUDE_CODE_TASK_LIST_ID', before)
        await update($, note, () => `⚠ Claude is still using its current list; "${clip(list.title, 24)}" was not applied`)

        return
      }
    }

    await update($, activeId, () => list?.id ?? null)
    await update($, note, () => (list ? `✓ Claude now uses "${clip(list.title, 28)}"` : "✓ Back on this session's own list"))
    // The Todos pane follows task events, not the folder: ask it to re-read. A session
    // without todo-pane has no such command, and the switch itself still stands.
    await $.command.run({ command: 'todos-sync' }).catch(() => undefined)
    void refresh($)
  } catch (error) {
    await update($, note, () => `⚠ Switch failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    switching = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, slug, () => projectSlug(e.cwd))
    // A list pinned before this load (a reload, a launcher) is the one in use.
    await update($, activeId, () => null)
    const pinned = await $.env.get('CLAUDE_CODE_TASK_LIST_ID')
    if (pinned) await update($, activeId, () => pinned)
    await $.command.register({
      name: 'task-lists',
      description: 'Show every saved task list, for this repo or all',
    })
    // A short name for both panes at once; a refused name must not stop the session starting.
    await $.command
      .register({ name: 'todo', description: 'Open the Todos pane and the Task lists pane together' })
      .catch(() => undefined)
    void refresh($)

    return next(e)
  })

  on('command.run', { command: 'todo' }, async $ => {
    // Todos belongs to the todo-pane mod: open it only where that mod is installed.
    const hasTodos = (await $.command.list()).some(c => c.name === 'todos')
    await $.ui.open({ id: PANE, title: 'Task lists' })
    if (hasTodos) await $.ui.open({ id: 'todo-pane', title: 'Todos', focus: true })
    void refresh($)

    return { text: hasTodos ? 'Todos and Task lists panes opened.' : 'Task lists pane opened (todo-pane is not installed).' }
  })

  on('command.run', { command: 'task-lists' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Task lists', focus: true })
    void refresh($)

    return { text: 'Task lists pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, lists)
    const by = await read($, scope)
    const mine = await read($, slug)
    const open = await read($, openId)
    const when = await read($, scannedAt)
    const problem = await read($, failure)
    const active = await read($, activeId)
    const verdict = await read($, note)
    // /clear changes the id without a session.start, so it is read at every draw.
    const sessionId = await $.session.id()

    const width = Math.max(30, e.props.bodyColumns)
    const rule = '─'.repeat(width)
    // The list the task tools use: the pinned one, else the session's own.
    const inUse = (list: ListInfo) => list.id === (active ?? sessionId)
    const using = all.find(inUse)

    // A list in use never disappears behind a filter, even with no transcript to place it.
    const visible = (by === 'all' ? all : all.filter(list => list.project === mine || inUse(list)))
      .slice()
      .sort((a, b) => Number(inUse(b)) - Number(inUse(a)))
    const openLists = visible.filter(list => list.open > 0).length

    const banner = using
      ? clip(using.title, width - 8)
      : active
        ? `list ${active.slice(0, 8)}`
        : "this session's own list (empty)"
    const detail = using ? `${using.open} open · ${using.done} done · ${using.id.slice(0, 8)}` : ''

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          Using: {banner}
        </Text>
        <Text dimColor wrap="truncate-end">
          {detail === '' ? ' ' : detail}
        </Text>
        <Text dimColor>{rule}</Text>
        <Box>
          <Button
            key="scope-repo"
            plain
            hotkey="1"
            onPress={async () => {
              await update($, scope, () => 'repo')
              await update($, note, () => null)
            }}
          >
            <Text bold={by === 'repo'} dimColor={by !== 'repo'}>
              this repo{' '}
            </Text>
          </Button>
          <Button
            key="scope-all"
            plain
            hotkey="2"
            onPress={async () => {
              await update($, scope, () => 'all')
              await update($, note, () => null)
            }}
          >
            <Text bold={by === 'all'} dimColor={by !== 'all'}>
              all repos{' '}
            </Text>
          </Button>
          <Button key="refresh" plain hotkey="r" onPress={() => void refresh($)}>
            <Text dimColor>refresh</Text>
          </Button>
        </Box>
        <Text dimColor>
          {visible.length} lists · {openLists} with open tasks
        </Text>
        {verdict !== null && (
          <Text color={verdict.startsWith('⚠') ? 'red' : 'green'} wrap="truncate-end">
            {verdict}
          </Text>
        )}
        {problem !== null && <Text color="red">Could not read the lists: {problem}</Text>}
        {problem === null && visible.length === 0 && (
          <Text dimColor>
            {when === 0
              ? 'Reading the lists…'
              : all.length === 0
                ? 'No saved lists yet.'
                : 'No lists for this repo. Press 2 for all.'}
          </Text>
        )}
        {visible.map(list => {
          const isOpen = open === list.id
          const total = list.open + list.done
          const meta = `${list.done}/${total} ${age(list.updatedAt)}`
          const head = `${isOpen ? '▾' : '▸'}${inUse(list) ? '●' : ' '} `
          const room = Math.max(8, width - head.length - meta.length - 1)

          return (
            <Box flexDirection="column">
              <Button
                key={list.id}
                plain
                onPress={() => update($, openId, now => (now === list.id ? null : list.id))}
              >
                <Text
                  bold={inUse(list)}
                  color={inUse(list) ? 'green' : list.open === 0 ? undefined : 'yellow'}
                  dimColor={!inUse(list) && list.open === 0}
                >
                  {head}
                  {pad(clip(list.title, room), room)} {meta}
                </Text>
              </Button>
              {isOpen && (
                <Text dimColor wrap="truncate-end">
                  {'   '}
                  {list.id.slice(0, 8)} · {shortProject(list.project)} · {stamp(list.updatedAt)}
                </Text>
              )}
              {isOpen &&
                list.tasks.slice(0, 12).map(task => (
                  <Text dimColor={task.status === 'completed'} wrap="truncate-end">
                    {'   '}
                    {ICON[task.status]} #{task.id} {task.subject}
                  </Text>
                ))}
              {isOpen && list.tasks.length > 12 && (
                <Text dimColor>
                  {'   '}… {list.tasks.length - 12} more
                </Text>
              )}
              {isOpen && !inUse(list) && (
                <Button key={`use-${list.id}`} hotkey="u" onPress={() => void useList($, list)}>
                  <Text>Use this list</Text>
                </Button>
              )}
              {isOpen && inUse(list) && <Text dimColor>{'   '}in use</Text>}
            </Box>
          )
        })}
        <Text dimColor>{rule}</Text>
        <Box>
          <Button key="use-own" plain hotkey="s" onPress={() => void useList($, undefined)}>
            <Text dimColor>this session's own list</Text>
          </Button>
        </Box>
        <Text dimColor wrap="truncate-end">
          {e.props.isFocused ? 'u use the open list' : 'click the pane to enable hotkeys'}
        </Text>
      </Box>
    )
  })
}
