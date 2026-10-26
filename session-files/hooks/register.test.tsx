import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { absolute, addFile, fitBox, kindOf, mentionOf, mentionPaths, touched } from './files'

const pane = (requestId: string) =>
  ({
    plugin: 'session-files',
    component: 'Pane',
    requestId,
    surface: 'terminal',
    props: {
      title: 'Files',
      isFocused: false,
      bodyColumns: 50,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  }) as const

type Dollar = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

// The hooks beneath the plugin are registered first, as a module registers its own in register().
const engine = (on: On) => {
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('store.set', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
}
const start = ($: Dollar) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

test('a file Claude reads shows up in the list, and Use puts its @mention in the draft', async ($, on) => {
  engine(on)
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  await start($)

  await $.tool.call({ tool: 'Read', file_path: '/work/src/notes.md' })

  const ui = await $.ui.mount(pane('session-files'))
  // The bottom half starts as a grid of tiles; the mode button switches it to the list.
  expect(await ui.find({ type: 'Button', text: /notes\.md/ })).toBeDefined()
  await ui.press({ plugin: 'session-files', key: 'files-mode' })
  await ui.press({ plugin: 'session-files', key: 'files-row-/work/src/notes.md' })
  await ui.press({ plugin: 'session-files', key: 'files-use' })
  expect(filled).toEqual([' @src/notes.md '])
  await ui.unmount()
})

test('in split layout the host pane keeps its drawing and the files go under it', async ($, on) => {
  engine(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{`host rows=${e.component === 'Pane' ? e.props.scroll.bodyRows : 0}`}</Text>
  })
  await start($)

  const ui = await $.ui.mount(pane('todo-pane'))
  expect((await ui.find({ type: 'Text', text: /host rows=10/ }))?.text).toBe('host rows=10')
  expect(await ui.find({ type: 'Text', text: /Files/ })).toBeDefined()
  await ui.unmount()
})

test('files helpers', () => {
  expect(kindOf('/a/Doc.PDF')).toBe('pdf')
  // 1600x800 into 40x30 cells: width-bound; into 100x5: height-bound.
  expect(fitBox({ width: 1600, height: 800 }, 40, 30)).toEqual({ columns: 40, rows: 10 })
  expect(fitBox({ width: 1600, height: 800 }, 100, 5)).toEqual({ columns: 20, rows: 5 })
  expect(mentionPaths('look at @src/a.ts, and @"my dir/b.png". @someone said hi')).toEqual(['src/a.ts', 'my dir/b.png'])
  expect(absolute('/work/app', '../lib/x.ts')).toBe('/work/lib/x.ts')
  expect(mentionOf('/work', '/work/a/b.ts')).toBe('a/b.ts')
  expect(mentionOf('/work', '/tmp/c.png')).toBe('/tmp/c.png')
  expect(touched({ tool: 'Read', file_path: '/a' } as never)).toEqual({ path: '/a', source: 'read' })
  expect(touched({ tool: 'Bash' })).toBeUndefined()
  const list = addFile(addFile([], '/a.png', 'pasted', 1), '/a.png', 'mention', 2)
  expect(list).toHaveLength(1)
  expect(list[0]!.sources).toEqual(['pasted', 'mention'])
  expect(list[0]!.kind).toBe('image')
})

test('View shows a text file in the panel and Back returns to the list', async ($, on) => {
  engine(on)
  on('fs.read', () => ({ value: 'first line\nsecond line' }))
  await start($)
  await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount(pane('session-files'))
  await ui.press({ plugin: 'session-files', key: 'files-mode' })
  await ui.press({ plugin: 'session-files', key: 'files-row-/work/a.ts' })
  await ui.press({ plugin: 'session-files', key: 'files-view' })
  expect((await ui.find({ type: 'Code' }))?.text).toContain('second line')
  await ui.press({ plugin: 'session-files', key: 'files-back' })
  expect(await ui.find({ type: 'Text', text: /edited/ })).toBeDefined()
  await ui.unmount()
})

test('View shows the shrunk version; Expand takes the panel and Shrink brings the host pane back', async ($, on) => {
  engine(on)
  on('fs.read', () => ({ value: 'one\ntwo' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>host pane</Text>
  })
  await start($)
  await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })

  const ui = await $.ui.mount(pane('todo-pane'))
  await ui.press({ plugin: 'session-files', key: 'files-mode' })
  await ui.press({ plugin: 'session-files', key: 'files-row-/work/a.ts' })
  await ui.press({ plugin: 'session-files', key: 'files-view' })
  expect(await ui.find({ type: 'Text', text: /host pane/ })).toBeDefined()
  await ui.press({ plugin: 'session-files', key: 'files-expand' })
  expect(await ui.find({ type: 'Text', text: /host pane/ })).toBeUndefined()
  await ui.press({ plugin: 'session-files', key: 'files-expand' })
  expect(await ui.find({ type: 'Text', text: /host pane/ })).toBeDefined()
  await ui.unmount()
})

test('the bottom half is a grid of tiles under every host tab, and a tile opens the file with Back to the grid', async ($, on) => {
  engine(on)
  on('fs.read', () => ({ value: 'one\ntwo' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{`top: ${e.requestId}`}</Text>
  })
  await start($)
  await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  await $.tool.call({ tool: 'Read', file_path: '/work/shot.png' })

  // Switching the top tab keeps the same bottom half.
  for (const host of ['todo-pane', 'task-lists']) {
    const tab = await $.ui.mount(pane(host))
    expect(await tab.find({ type: 'Text', text: new RegExp(`top: ${host}`) })).toBeDefined()
    expect(await tab.find({ type: 'Button', text: /a\.ts/ })).toBeDefined()
    await tab.unmount()
  }

  const ui = await $.ui.mount(pane('todo-pane'))
  expect(await ui.find({ type: 'Text', text: /one/ })).toBeDefined()
  await ui.press({ plugin: 'session-files', key: 'grid-open-/work/a.ts' })
  expect((await ui.find({ type: 'Code' }))?.text).toContain('two')
  expect(await ui.find({ type: 'Text', text: /top: todo-pane/ })).toBeDefined()
  await ui.press({ plugin: 'session-files', key: 'files-back' })
  expect(await ui.find({ type: 'Button', text: /a\.ts/ })).toBeDefined()
  await ui.unmount()
})
