import { expect, test } from 'claude-code/testing'
import type { Engine, Mounted, TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const PANE = {
  plugin: 'todo-pane',
  component: 'Pane',
  requestId: 'todo-pane',
  props: {
    title: 'Todos',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

/** The engine's side of the calls the mod makes: tools answer as the real ones do. */
const stubEngine = (on: On, fail = false) => {
  let lastId = 0
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'todos' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => {
    if (fail) return { result: {}, isError: true }
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++lastId), subject: e.subject } } }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId } }

    return { result: {} }
  })
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

type PaneUi = Mounted<'terminal' | 'desktop' | 'vscode' | 'mobile', 'Pane'>

const texts = async (ui: PaneUi, pattern: RegExp) =>
  (await ui.find({ type: 'Text', text: pattern }))?.text

test('an empty list says so, on every surface', async ($, on) => {
  stubEngine(on)
  await start($)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await texts(ui, /No todos here/)).toBe('No todos here.')
    await ui.unmount()
  }
})

test('TodoWrite fills the pane and counts what is done', async ($, on) => {
  stubEngine(on)
  await start($)

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Write code', status: 'completed', activeForm: 'Writing code' },
      { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
      { content: 'Ship it', status: 'pending', activeForm: 'Shipping' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'done-toggle' })
  expect(await texts(ui, /done$/)).toBe(' 1/3 done')
  expect(await texts(ui, /Write code/)).toBe('1 Write code')
  expect(await texts(ui, /Run tests/)).toBe('2 Run tests')
  expect(await texts(ui, /Ship it/)).toBe('3 Ship it')
  await ui.unmount()
})

test('a status change keeps the step in the item history', async ($, on) => {
  stubEngine(on)
  await start($)

  const todos = (status: 'pending' | 'in_progress' | 'completed') => [
    { content: 'Run tests', status, activeForm: 'Running tests' },
  ]
  await $.tool.call({ tool: 'TodoWrite', todos: todos('pending') })
  await $.tool.call({ tool: 'TodoWrite', todos: todos('in_progress') })
  await $.tool.call({ tool: 'TodoWrite', todos: todos('completed') })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const history = /todo \d\d:\d\d → doing \d\d:\d\d → done \d\d:\d\d/
  await ui.press({ key: 'done-toggle' })
  // History stays out of the list until the task is opened.
  expect(await texts(ui, history)).toBeUndefined()
  await ui.press({ key: 'todo-1' })
  expect(await texts(ui, history)).toBeDefined()
  await ui.unmount()
})

test('TaskCreate then TaskUpdate moves the task to done', async ($, on) => {
  stubEngine(on)
  await start($)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Scaffold mod', description: 'files' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui, /^1 Scaffold mod/)).toBe('1 Scaffold mod')
  await ui.unmount()

  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await again.press({ key: 'done-toggle' })
  expect(await texts(again, /^1 Scaffold mod/)).toBe('1 Scaffold mod')
  expect(await texts(again, /done$/)).toBe(' 1/1 done')
  await again.unmount()
})

test('a deleted task leaves the pane', async ($, on) => {
  stubEngine(on)
  await start($)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Throwaway', description: 'x' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'deleted' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui, /Throwaway/)).toBeUndefined()
  await ui.unmount()
})

test('a failed tool call is passed through and not mirrored', async ($, on) => {
  stubEngine(on, true)
  await start($)

  const ran = await $.tool.call({
    tool: 'TodoWrite',
    todos: [{ content: 'Never shown', status: 'pending', activeForm: 'x' }],
  })
  expect(ran.isError).toBe(true)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui, /Never shown/)).toBeUndefined()
  await ui.unmount()
})

test('blocked tasks are grouped apart and move to ready when unblocked', async ($, on) => {
  stubEngine(on)
  await start($)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Write code', description: 'a' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Ship it', description: 'b' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', addBlockedBy: ['1'] })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui, /^Ready/)).toBe('Ready (1)')
  expect(await texts(ui, /^Blocked/)).toBe('Blocked (1)')
  expect(await texts(ui, /waits for/)).toBe('   waits for 1')
  // A blocked row carries a red "!" of its own, apart from the row's text.
  expect((await texts(ui, /^!/))?.trim()).toBe('!')
  await ui.unmount()

  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(after, /^Ready/)).toBe('Ready (1)')
  expect(await texts(after, /Done \(/)).toBe('▸ Done (1)')
  expect(await texts(after, /^Blocked/)).toBeUndefined()
  expect(await texts(after, /waits for/)).toBeUndefined()
  expect(await texts(after, /^!/)).toBeUndefined()
  await after.unmount()
})

test('the all tab is a flat list, after the grouped default', async ($, on) => {
  stubEngine(on)
  await start($)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Only one', description: 'a' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui, /^Ready/)).toBe('Ready (1)')
  expect(await texts(ui, /all 1/)).toBe(' all 1 ')
  await ui.press({ key: 'filter-all' })
  expect(await texts(ui, /^Ready/)).toBeUndefined()
  expect(await texts(ui, /all 1/)).toBe(' all 1 ')
  expect(await texts(ui, /^1 Only one/)).toBe('1 Only one')
  await ui.unmount()
})

test('mandatory and high-priority tasks sort first and carry a badge', async ($, on) => {
  stubEngine(on)
  await start($)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Plain', description: 'a' })
  await $.tool.call({
    tool: 'TaskCreate',
    subject: 'Low one',
    description: 'b',
    metadata: { priority: 'low' },
  })
  await $.tool.call({
    tool: 'TaskCreate',
    subject: 'Must do',
    description: 'c',
    metadata: { priority: 'high', mandatory: true },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await ui.findAll({ type: 'Text', text: /^ *\d+(\.\d+)* \S/ })
  expect(rows.map(row => row.text)).toEqual(['3 ★ Must do', '1 Plain', '2 Low one'])
  await ui.unmount()
})

test('metadata null clears a badge, and bad values are ignored', async ($, on) => {
  stubEngine(on)
  await start($)

  await $.tool.call({
    tool: 'TaskCreate',
    subject: 'Tagged',
    description: 'a',
    metadata: { priority: 'urgent', mandatory: true },
  })
  const tagged = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(tagged, /Tagged/ )).toBeDefined()
  expect((await tagged.find({ type: 'Text', text: /^ *\d+(\.\d+)* \S/ }))?.text).toBe('1 ★ Tagged')
  await tagged.unmount()

  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', metadata: { mandatory: null } })
  const cleared = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await cleared.find({ type: 'Text', text: /^ *\d+(\.\d+)* \S/ }))?.text).toBe('1 Tagged')
  await cleared.unmount()
})

test('tabs show their counts and the active one is selected', async ($, on) => {
  stubEngine(on)
  await start($)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'A', status: 'completed', activeForm: 'a' },
      { content: 'B', status: 'pending', activeForm: 'b' },
      { content: 'C', status: 'pending', activeForm: 'c' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui, /^ group/)).toBe(' group ')
  expect(await texts(ui, /todo 2/)).toBe(' todo 2 ')
  await ui.press({ key: 'filter-pending' })
  expect(await texts(ui, /todo 2/)).toBe(' todo 2 ')
  expect(await texts(ui, /^ *\d+(\.\d+)* \S/)).toBe('2 B')
  await ui.unmount()
})

test('moving the focus onto a tab selects it', async ($, on) => {
  stubEngine(on)
  on('ui.focus', () => ({}))
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.ui.focus({
    component: 'Pane',
    requestId: 'todo-pane',
    plugin: 'todo-pane',
    element: 'filter-done',
    origin: { kind: 'person' },
  })
  expect(await texts(ui, /done 0/)).toBe(' done 0 ')
  await ui.unmount()
})

test('subtasks nest under their parent with a rollup, on the all tab only', async ($, on) => {
  stubEngine(on)
  await start($)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Parent', description: 'p' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Kid one', description: 'a', metadata: { parent: '1' } })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Kid two', description: 'b', metadata: { parent: '1' } })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await ui.findAll({ type: 'Text', text: /^ *\d+(\.\d+)* \S/ })
  expect(rows.map(row => row.text)).toEqual(['  1 Parent', '1.1 Kid one', '1.2 Kid two'])
  expect(await texts(ui, /subtasks/)).toBe('   1/2 subtasks')
  // Only the parent is a top-level item, so the group counts it alone.
  expect(await texts(ui, /^Ready/)).toBe('Ready (1)')

  await ui.press({ key: 'filter-done' })
  const flat = await ui.findAll({ type: 'Text', text: /^ *\d+(\.\d+)* \S/ })
  expect(flat.map(row => row.text)).toEqual(['1.1 Kid one'])
  await ui.unmount()
})

test('an orphaned subtask is shown as a top-level task', async ($, on) => {
  stubEngine(on)
  await start($)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Lost kid', description: 'a', metadata: { parent: '99' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui, /^ *\d+(\.\d+)* \S/)).toBe('1 Lost kid')
  await ui.unmount()
})

test('the Done group is folded until opened', async ($, on) => {
  stubEngine(on)
  await start($)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Finished', description: 'a' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui, /Done \(/)).toBe('▸ Done (1)')
  expect(await texts(ui, /Finished/)).toBeUndefined()
  await ui.press({ key: 'done-toggle' })
  expect(await texts(ui, /Done \(/)).toBe('▾ Done (1)')
  expect(await texts(ui, /Finished/)).toBe('1 Finished')
  // A done row starts with its own green tick.
  expect((await texts(ui, /^✓/))?.trim()).toBe('✓')
  await ui.unmount()
})

test('a finished parent folds its subtasks behind the rollup', async ($, on) => {
  stubEngine(on)
  await start($)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Parent', description: 'p' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Kid', description: 'k', metadata: { parent: '1' } })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'done-toggle' })
  expect(await texts(ui, /Parent/)).toBe('  1 Parent')
  expect(await texts(ui, /1\/1 subtasks/)).toBe('   1/1 subtasks')
  expect(await texts(ui, /Kid/)).toBeUndefined()
  await ui.press({ key: '1' })
  expect(await texts(ui, /Kid/)).toBe('1.1 Kid')
  await ui.unmount()
})

test('there is no doing tab; the todo tab holds in-progress work too', async ($, on) => {
  stubEngine(on)
  await start($)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Running', status: 'in_progress', activeForm: 'Running it' },
      { content: 'Waiting', status: 'pending', activeForm: 'w' },
      { content: 'Finished', status: 'completed', activeForm: 'f' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'filter-in_progress' })).toBeUndefined()
  expect(await texts(ui, /todo 2/)).toBe(' todo 2 ')
  await ui.press({ key: 'filter-pending' })
  const rows = await ui.findAll({ type: 'Text', text: /^ *\d+(\.\d+)* \S/ })
  expect(rows.map(row => row.text)).toEqual(['1 Running', '2 Waiting'])
  await ui.unmount()
})

test('deferred tasks get their own group, ahead of Done, and are not red', async ($, on) => {
  stubEngine(on)
  await start($)

  await $.tool.call({ tool: 'TaskCreate', subject: 'Now', description: 'a' })
  await $.tool.call({
    tool: 'TaskCreate',
    subject: 'Later',
    description: 'b',
    metadata: { deferred: true },
  })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', addBlockedBy: ['1'] })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui, /^Ready/)).toBe('Ready (1)')
  expect(await texts(ui, /^Deferred/)).toBe('Deferred (1)')
  // Deferred wins over blocked: it is not listed as blocked.
  expect(await texts(ui, /^Blocked/)).toBeUndefined()
  await ui.unmount()

  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', metadata: { deferred: null } })
  const back = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(back, /^Deferred/)).toBeUndefined()
  expect(await texts(back, /^Blocked/)).toBe('Blocked (1)')
  await back.unmount()
})

test('a short pane still shows every group header', async ($, on) => {
  stubEngine(on)
  await start($)

  for (let i = 1; i <= 8; i++) await $.tool.call({ tool: 'TaskCreate', subject: `Ready ${i}`, description: 'a' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Stuck', description: 'b' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '9', addBlockedBy: ['1'] })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Parked', description: 'c', metadata: { deferred: true } })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Finished', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '11', status: 'completed' })

  const ui = await $.ui.mount({
    ...PANE,
    surface: 'terminal',
    props: { ...PANE.props, scroll: { offset: 0, bodyRows: 14 } },
  })
  expect(await texts(ui, /^Blocked/)).toBe('Blocked (1)')
  expect(await texts(ui, /^Deferred/)).toBe('Deferred (1)')
  expect(await texts(ui, /Done \(/)).toBe('▸ Done (1)')
  expect(await texts(ui, /more$/)).toBeDefined()
  await ui.unmount()
})

test('a priority dot leads each row: red, yellow, green, or dim with none', async ($, on) => {
  stubEngine(on)
  await start($)

  const mk = (subject: string, metadata?: object) =>
    $.tool.call({ tool: 'TaskCreate', subject, description: 'a', metadata })
  await mk('High', { priority: 'high' })
  await mk('Normal', { priority: 'normal' })
  await mk('Low', { priority: 'low' })
  await mk('None')
  await mk('Finished', { priority: 'high' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '5', status: 'completed' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Sorted high, normal, none (level with normal), low.
  const dots = await ui.findAll({ type: 'Text', text: /^[●·] $/ })
  expect(dots.map(dot => dot.text.trim())).toEqual(['●', '●', '·', '●'])
  // A finished task keeps its dot, with the tick after it.
  await ui.press({ key: 'done-toggle' })
  expect((await ui.findAll({ type: 'Text', text: /^[●·] $/ })).length).toBe(5)
  expect((await ui.findAll({ type: 'Text', text: /^✓/ })).length).toBe(1)
  await ui.unmount()
})

const tab = (ui: PaneUi, pattern: RegExp) => ui.find({ type: 'Text', text: pattern })

test('the active tab is inverse and the others are dim, with the same width', async ($, on) => {
  stubEngine(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await tab(ui, /group/))?.props.inverse).toBe(true)
  expect((await tab(ui, /todo/))?.props.inverse).toBeFalsy()
  expect((await tab(ui, /todo/))?.props.dimColor).toBe(true)
  await ui.press({ key: 'filter-pending' })
  expect((await tab(ui, /todo/))?.props.inverse).toBe(true)
  expect((await tab(ui, /group/))?.props.inverse).toBeFalsy()
  await ui.unmount()
})

test('the header shows a green bar, chips for doing, blocked and deferred, and the current step', async ($, on) => {
  stubEngine(on)
  await start($)

  const mk = (subject: string, metadata?: object) =>
    $.tool.call({ tool: 'TaskCreate', subject, description: 'a', metadata })
  await mk('Running')
  await mk('Waiting')
  await mk('Parked', { deferred: true })
  await mk('Finished')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress', activeForm: 'Running it' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', addBlockedBy: ['1'] })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '4', status: 'completed' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const bar = await ui.find({ type: 'Text', text: /^█/ })
  expect(bar?.text).toBe('███')
  expect(bar?.props.color).toBe('green')
  expect(await texts(ui, /done$/)).toBe(' 1/4 done')
  expect(await texts(ui, /◐ 1$/)).toBe('  ◐ 1')
  expect(await texts(ui, /! 1$/)).toBe('  ! 1')
  expect(await texts(ui, /◌ 1$/)).toBe('  ◌ 1')
  expect(await texts(ui, /^◐ Running it/)).toBe('◐ Running it')
  await ui.unmount()
})

test('one status slot per row: tick, bang, doing or pending', async ($, on) => {
  stubEngine(on)
  await start($)

  const mk = (subject: string, metadata?: object) =>
    $.tool.call({ tool: 'TaskCreate', subject, description: 'a', metadata })
  await mk('Pending')
  await mk('Running')
  await mk('Stuck')
  await mk('Finished')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', addBlockedBy: ['1'] })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '4', status: 'completed' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'done-toggle' })
  const slots = await ui.findAll({ type: 'Text', text: /^[✓!◐○] $/ })
  // Ready: running first, then pending; Blocked; Done.
  expect(slots.map(slot => slot.text.trim())).toEqual(['◐', '○', '!', '✓'])
  expect(slots.map(slot => slot.props.color)).toEqual(['cyan', undefined, 'red', 'green'])
  await ui.unmount()
})

test('numbers are right-aligned to the widest one, across tabs', async ($, on) => {
  stubEngine(on)
  await start($)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Top', description: 'a' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Kid', description: 'b', metadata: { parent: '1' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui, /Top/)).toBe('  1 Top')
  expect(await texts(ui, /Kid/)).toBe('1.1 Kid')
  // The width is the list's, so a flat tab keeps it.
  await ui.press({ key: 'filter-pending' })
  expect(await texts(ui, /Top/)).toBe('  1 Top')
  await ui.unmount()
})

test('a clicked task opens a card: description, facts and timeline behind a bar', async ($, on) => {
  stubEngine(on)
  await start($)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Parent', description: 'p' })
  await $.tool.call({
    tool: 'TaskCreate',
    subject: 'Kid',
    description: 'Do the thing',
    metadata: { parent: '1', priority: 'high', mandatory: true },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const bars = /^ +[│╰] /
  expect((await ui.findAll({ type: 'Text', text: bars })).length).toBe(0)

  await ui.press({ key: '2' })
  const card = await ui.findAll({ type: 'Text', text: bars })
  expect(card.map(line => line.text.trim())).toEqual([
    '│ Do the thing',
    '│ high priority · mandatory · subtask of 1',
    expect.stringMatching(/^╰ todo \d\d:\d\d$/),
  ])

  await ui.press({ key: '2' })
  expect((await ui.findAll({ type: 'Text', text: bars })).length).toBe(0)
  await ui.unmount()
})

const FACTS = {
  model: 'claude-sonnet-5-5',
  promptModel: 'claude-sonnet-5-5',
  surfaces: ['terminal'],
  outputStyle: null,
  traits: [],
} as const

test('the mod tells Claude which metadata to set, only when tasks are on offer', async ($, on) => {
  stubEngine(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hello', scope: 'shared' }] }))

  const withTasks = await $.prompt.compose({ ...FACTS, tools: ['TaskCreate', 'Bash'] })
  const last = withTasks.sections.at(-1)
  expect(last?.id).toBe('todo-pane:task-metadata')
  expect(last?.scope).toBe('session')
  for (const key of ['priority', 'mandatory', 'parent', 'deferred']) expect(last?.text).toContain(key)
  expect(withTasks.sections[0]?.id).toBe('intro')

  const without = await $.prompt.compose({ ...FACTS, tools: ['Bash'] })
  expect(without.sections.map(section => section.id)).toEqual(['intro'])
})
