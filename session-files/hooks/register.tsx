import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { FileFilter, FileRow } from '../types'
import { absolute, addFile, fitBox, keepable, kindOf, mentionOf, mentionPaths, sourcesLabel, touched, visibleFiles } from './files'
import { fitCells, imageNumbers, pngSize } from './layout'

const PANE = 'session-files'
// A gallery tile's picture box, in cells (the tile adds a border, a gap and a name row).
const TILE_COLUMNS = 12
const TILE_ROWS = 3
// Rows a tile takes: its border, the picture box and the name under it.
const TILE_HEIGHT = TILE_ROWS + 3
const MIN_ROWS = 3
// A viewed text file is read again at most this often while the pane redraws.
const TEXT_TTL_MS = 1500
// The longest side of a converted preview: big enough to stay sharp when the viewer takes the whole panel.
const PREVIEW_PX = 1600

const files = atom({ plugin: 'session-files', key: 'files' } as const, [] as FileRow[])
const selected = atom({ plugin: 'session-files', key: 'selected' } as const, null as string | null)
const viewing = atom({ plugin: 'session-files', key: 'viewing' } as const, null as string | null)
const viewOffset = atom({ plugin: 'session-files', key: 'viewOffset' } as const, 0)
const mode = atom({ plugin: 'session-files', key: 'mode' } as const, 'grid' as 'grid' | 'list')
const gridPage = atom({ plugin: 'session-files', key: 'gridPage' } as const, 0)
const expanded = atom({ plugin: 'session-files', key: 'expanded' } as const, false)
const filter = atom({ plugin: 'session-files', key: 'filter' } as const, 'all' as FileFilter)

type PaneInput = RenderInput<'Pane'>

const FILTERS: { value: FileFilter; label: string }[] = [
  { value: 'all', label: 'all' },
  { value: 'mine', label: 'mine' },
  { value: 'claude', label: "Claude's" },
]

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n))

/** Tracking is best-effort: it must never fail a prompt or one of Claude's tool calls. */
const safely = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
  } catch {
    // The list may lag; the call itself is unaffected.
  }
}

const storeKey = async ($: EngineInterface) => `files:${await $.session.cwd()}`

const save = async ($: EngineInterface) => $.store.set(await storeKey($), keepable(await read($, files)))

async function track($: EngineInterface, path: string, source: FileRow['sources'][number]) {
  const cwd = await $.session.cwd()
  await update($, files, list => addFile(list, absolute(cwd, path), source, Date.now()))
  await save($)
}

// Claude Code caches each paste as <tmp>/claude-<uid>/<project>/<session>/images/<n>.<ext>.
let sessionDir: { sessionId: string; dir: string } | undefined

async function imagesDir($: EngineInterface): Promise<string | undefined> {
  const sessionId = await $.session.id()
  if (sessionDir?.sessionId === sessionId) return sessionDir.dir
  const uid = (await $.process.run(['id', '-u'])).stdout.trim()
  const root = `${((await $.env.get('CLAUDE_CODE_TMPDIR')) ?? '/tmp').replace(/\/+$/, '')}/claude-${uid}`
  for (const entry of await $.fs.list(root).catch(() => [])) {
    const dir = `${root}/${entry.name}/${sessionId}/images`
    if (entry.kind === 'dir' && (await $.fs.exists(dir))) {
      sessionDir = { sessionId, dir }
      return dir
    }
  }
  return undefined
}

/** The cached file of a pasted image; a PNG is preferred over another format of the same paste. */
async function pastedFile($: EngineInterface, n: number): Promise<string | undefined> {
  const dir = await imagesDir($)
  if (dir === undefined) return undefined
  const png = `${dir}/${n}.png`
  if (await $.fs.exists(png)) return png
  const entry = (await $.fs.list(dir).catch(() => [])).find(one => one.kind === 'file' && one.name.startsWith(`${n}.`))

  return entry === undefined ? undefined : `${dir}/${entry.name}`
}

/** What the terminal can draw: a PNG as is; any other image, or a PDF's first page, converted once (sips, macOS) beside the pastes. */
async function previewPng($: EngineInterface, path: string): Promise<string | undefined> {
  if (/\.png$/i.test(path)) return path
  const dir = await imagesDir($)
  if (dir === undefined) return undefined
  let hash = 0x811c9dc5
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193)
  const out = `${dir.replace(/\/images$/, '')}/session-files-${hash >>> 0}-${PREVIEW_PX}.png`
  if (await $.fs.exists(out)) return out
  const { exitCode } = await $.process
    .run(['sips', '-s', 'format', 'png', '-Z', String(PREVIEW_PX), path, '--out', out])
    .catch(() => ({ exitCode: 1 }))

  return exitCode === 0 ? out : undefined
}

const texts = new Map<string, { at: number; text: string | undefined }>()

async function textOf($: EngineInterface, path: string): Promise<string | undefined> {
  const hit = texts.get(path)
  if (hit && Date.now() - hit.at < TEXT_TTL_MS) return hit.text
  const text = await $.fs.read(path).catch(() => undefined)
  texts.set(path, { at: Date.now(), text })

  return text
}

async function useFile($: EngineInterface, row: FileRow) {
  const mention = mentionOf(await $.session.cwd(), row.path)
  await $.prompt.fill({ text: ` @${mention.includes(' ') ? `"${mention}"` : mention} `, mode: 'insert' })
  await update($, files, list => list.map(one => (one.path === row.path ? { ...one, uses: one.uses + 1 } : one)))
  await save($)
}

/** The whole file in the system's own viewer (Preview on macOS), for what a terminal panel can't show big. */
async function openOutside($: EngineInterface, row: FileRow) {
  const isMac = (await $.process.run(['uname'])).stdout.trim() === 'Darwin'
  await $.process.run([isMac ? 'open' : 'xdg-open', row.path])
}

async function forgetFile($: EngineInterface, row: FileRow) {
  await update($, files, list => list.filter(one => one.path !== row.path))
  await update($, selected, () => null)
  await save($)
}

/** The files list, or the file being viewed, drawn into `bodyRows` rows. */
async function filesView($: EngineInterface, e: PaneInput, bodyRows: number) {
  const open = await read($, viewing)
  const list = await read($, files)
  const row = open === null ? undefined : list.find(one => one.path === open)

  if (row) return viewer($, e, row, bodyRows)

  return (await read($, mode)) === 'grid' ? grid($, e, list, bodyRows) : browser($, e, list, bodyRows)
}

/** Title, view switch (grid or list) and filter, as chips: the one in use is drawn inverted, the others dim. */
function header($: EngineInterface, e: PaneInput, count: number, by: FileFilter, view: 'grid' | 'list') {
  const { Box, Text, Button } = $.ui.resolve(e)
  const chip = (label: string, isOn: boolean) => (
    <Text inverse={isOn} bold={isOn} dimColor={!isOn}> {label} </Text>
  )

  return (
    <Box flexDirection="row" columnGap={1}>
      <Text bold>Files</Text>
      <Text dimColor>{count}</Text>
      <Text dimColor>│</Text>
      {(['grid', 'list'] as const).map(v => (
        <Button key={`files-mode-${v}`} plain onPress={() => update($, mode, () => v)}>{chip(v === 'grid' ? '▦' : '≡', view === v)}</Button>
      ))}
      <Text dimColor>│</Text>
      {FILTERS.map(f => (
        <Button
          key={`files-filter-${f.value}`}
          plain
          onPress={async () => {
            await update($, gridPage, () => 0)
            await update($, filter, () => f.value)
          }}
        >
          {chip(f.label, by === f.value)}
        </Button>
      ))}
    </Box>
  )
}

async function browser($: EngineInterface, e: PaneInput, list: FileRow[], bodyRows: number) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const by = await read($, filter)
  const pick = await read($, selected)
  const shown = visibleFiles(list, by)
  const chosen = shown.find(row => row.path === pick)
  const room = Math.max(1, bodyRows - 3 - (chosen ? 3 : 0))
  const icon = (row: FileRow) => {
    const kind = kindOf(row.path)

    return kind === 'image' ? '▣' : kind === 'pdf' ? '▤' : kind === 'text' ? '≡' : '·'
  }

  return (
    <Box flexDirection="column">
      {header($, e, list.length, by, 'list')}
      {shown.length === 0 && (
        <Text dimColor>
          {list.length === 0 ? 'Nothing yet: paste an image, @mention a file, or let Claude read one.' : 'No files in this filter.'}
        </Text>
      )}
      {shown.slice(0, room).map(row => (
        <Button key={`files-row-${row.path}`} plain onPress={() => update($, selected, cur => (cur === row.path ? null : row.path))}>
          <Text bold={row.path === pick}>{row.path === pick ? '❯' : ' '} {icon(row)} {row.name}</Text>
          <Text dimColor> {sourcesLabel(row)}</Text>
        </Button>
      ))}
      {shown.length > room && <Text dimColor>+{shown.length - room} more</Text>}
      {chosen && (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate-start">{chosen.path}</Text>
          <Box flexDirection="row" columnGap={2}>
            <Button key="files-use" onPress={() => useFile($, chosen)}>Use</Button>
            <Button
              key="files-view"
              onPress={async () => {
                await update($, viewOffset, () => 0)
                await update($, expanded, () => false)
                await update($, viewing, () => chosen.path)
              }}
            >
              View
            </Button>
            <Button key="files-forget" onPress={() => forgetFile($, chosen)}>Forget</Button>
            {chosen.uses > 0 && <Text dimColor>used {chosen.uses}×</Text>}
          </Box>
        </Box>
      )}
    </Box>
  )
}

/** How the viewer is driven: the split panel's own state, or the gallery's (always big, no toggle). */
type ViewerControl = { prefix: string; isBig: boolean; toggle?: () => Promise<unknown>; close: () => Promise<unknown> }

async function viewer($: EngineInterface, e: PaneInput, row: FileRow, bodyRows: number, ctl?: ViewerControl) {
  const { Box, Text, Button, Code } = $.ui.resolve(e)
  const room = Math.max(1, bodyRows - 3)
  const control: ViewerControl = ctl ?? {
    prefix: 'files',
    isBig: await read($, expanded),
    toggle: () => update($, expanded, was => !was),
    close: async () => {
      await update($, viewing, () => null)
      await update($, expanded, () => false)
    },
  }
  const { prefix: p, isBig } = control
  const back = (
    <Box flexDirection="row" columnGap={1}>
      <Button key={`${p}-back`} plain onPress={control.close}>← Back</Button>
      <Text bold wrap="truncate">{row.name}</Text>
      <Button key={`${p}-use`} onPress={() => useFile($, row)}>Use</Button>
      {control.toggle && <Button key={`${p}-expand`} onPress={control.toggle}>{isBig ? 'Shrink' : 'Expand'}</Button>}
      <Button key={`${p}-open`} onPress={() => openOutside($, row)}>Open</Button>
    </Box>
  )
  const note = (text: string) => (
    <Box flexDirection="column">
      {back}
      <Text dimColor>{text}</Text>
    </Box>
  )

  // The kind is read from the path, not the stored row: a row saved by an older version may be stale.
  const kind = kindOf(row.path)
  if (kind === 'image' || kind === 'pdf') {
    // Only the terminal's element table draws a picture from a file.
    if (e.surface !== 'terminal') return note('Images are shown in the terminal.')
    const { Image } = $.ui.resolve(e)
    const png = await previewPng($, row.path)
    if (png === undefined) return note(kind === 'pdf' ? 'No preview for this PDF here: use Open.' : 'No preview for this image format here.')
    const base64 = await $.fs.read(png, { as: 'bytes' }).then(b => b.base64, () => undefined)
    if (base64 === undefined) return note("Can't read this image (over 4 MiB or gone).")
    // Shrunk: the thumbnail's size. Expanded: fill the panel, as wide as it is and as tall as is left.
    const maxRows = Math.max(3, room - (kind === 'pdf' ? 1 : 0))
    const size = pngSize(base64)
    const fit = isBig ? fitBox(size, Math.max(4, e.props.bodyColumns - 1), maxRows) : fitCells(size, maxRows)
    const columns = fit.columns

    return (
      <Box flexDirection="column">
        {back}
        <Image key={`${p}-image-${row.path}`} source={{ file: png, format: 'png' }} columns={columns} rows={fit.rows} alt={row.name} />
        {kind === 'pdf' && <Text dimColor>First page only. Open shows the whole document.</Text>}
      </Box>
    )
  }

  if (kind === 'other') return note('A binary file: open it outside the terminal.')
  const text = await textOf($, row.path)
  if (text === undefined) return note("Can't read this file (over 4 MiB or gone).")
  const lines = text.split('\n')
  const offset = clamp(await read($, viewOffset), 0, Math.max(0, lines.length - room))
  const step = (by: number) => update($, viewOffset, () => clamp(offset + by, 0, Math.max(0, lines.length - room)))

  return (
    <Box flexDirection="column">
      {back}
      <Box flexDirection="row" columnGap={2}>
        <Button key={`${p}-prev`} plain onPress={() => step(-room)}>↑ prev</Button>
        <Button key={`${p}-next`} plain onPress={() => step(room)}>↓ next</Button>
        <Text dimColor>{offset + 1}–{Math.min(lines.length, offset + room)} of {lines.length}</Text>
      </Box>
      <Code
        key={`${p}-code-${row.path}`}
        source={lines.slice(offset, offset + room).join('\n')}
        path={row.path}
        startLine={offset + 1}
        wrap="truncate-end"
      />
    </Box>
  )
}

/** A converted-or-original PNG and its size, kept so a redraw doesn't convert or read it again. */
const previews = new Map<string, { png: string; size: { width: number; height: number } | null } | null>()

async function previewOf($: EngineInterface, path: string) {
  if (previews.has(path)) return previews.get(path) ?? undefined
  const png = await previewPng($, path)
  const base64 = png === undefined ? undefined : await $.fs.read(png, { as: 'bytes' }).then(b => b.base64, () => undefined)
  const hit = png === undefined || base64 === undefined ? null : { png, size: pngSize(base64) }
  // A file still being written or converted is looked at again on the next draw.
  if (hit !== null) previews.set(path, hit)

  return hit ?? undefined
}

/** The grid: every file as a thumbnail tile, a page at a time; a tile's name opens the file. */
async function grid($: EngineInterface, e: PaneInput, list: FileRow[], bodyRows: number) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const by = await read($, filter)
  const shown = visibleFiles(list, by)
  const perRow = Math.max(1, Math.floor((e.props.bodyColumns + 1) / (TILE_COLUMNS + 3)))
  // The header takes a row and the pager one; the tiles get the rest, at least one row of them.
  const rowsPerPage = Math.max(1, Math.floor((bodyRows - 2) / TILE_HEIGHT))
  const perPage = perRow * rowsPerPage
  const pages = Math.max(1, Math.ceil(shown.length / perPage))
  const page = clamp(await read($, gridPage), 0, pages - 1)
  const tiles = shown.slice(page * perPage, (page + 1) * perPage)
  const rows: FileRow[][] = []
  for (let i = 0; i < tiles.length; i += perRow) rows.push(tiles.slice(i, i + perRow))
  const label = (name: string) => (name.length > TILE_COLUMNS ? `${name.slice(0, TILE_COLUMNS - 1)}…` : name)
  const open = async (path: string) => {
    await update($, viewOffset, () => 0)
    await update($, expanded, () => false)
    await update($, viewing, () => path)
  }

  const picture = async (one: FileRow) => {
    const kind = kindOf(one.path)
    if ((kind === 'image' || kind === 'pdf') && e.surface === 'terminal') {
      const { Image } = $.ui.resolve(e)
      const preview = await previewOf($, one.path)
      if (preview) {
        const fit = fitBox(preview.size, TILE_COLUMNS, TILE_ROWS)

        return <Image key={`grid-image-${one.path}`} source={{ file: preview.png, format: 'png' }} columns={fit.columns} rows={fit.rows} alt={one.name} />
      }
    }
    if (kind === 'text') {
      const lines = ((await textOf($, one.path)) ?? '').split('\n').filter(line => line.trim() !== '').slice(0, TILE_ROWS)

      return (
        <Box flexDirection="column" width={TILE_COLUMNS}>
          {lines.map((line, i) => (
            <Text key={`grid-line-${one.path}-${i}`} dimColor wrap="truncate">{line.trim()}</Text>
          ))}
        </Box>
      )
    }

    return <Text dimColor>{kind === 'pdf' ? 'PDF' : kind === 'image' ? 'image' : 'file'}</Text>
  }

  return (
    <Box flexDirection="column">
      {header($, e, shown.length, by, 'grid')}
      {shown.length === 0 && <Text dimColor>Nothing yet: paste an image, @mention a file, or let Claude read one.</Text>}
      {await Promise.all(
        rows.map(async (cells, r) => (
          <Box key={`grid-row-${r}`} flexDirection="row" columnGap={1}>
            {await Promise.all(
              cells.map(async one => (
                <Box key={`grid-tile-${one.path}`} flexDirection="column" alignItems="center" borderStyle="round" borderDimColor width={TILE_COLUMNS + 2}>
                  <Box height={TILE_ROWS} width={TILE_COLUMNS} alignItems="center" justifyContent="center" overflow="hidden">
                    {await picture(one)}
                  </Box>
                  <Button key={`grid-open-${one.path}`} plain onPress={() => open(one.path)}>{label(one.name)}</Button>
                </Box>
              )),
            )}
          </Box>
        )),
      )}
      {pages > 1 && (
        <Box flexDirection="row" columnGap={2}>
          <Button key="grid-prev" plain onPress={() => update($, gridPage, () => Math.max(0, page - 1))}>‹ prev</Button>
          <Text dimColor>{page + 1}/{pages}</Text>
          <Button key="grid-next" plain onPress={() => update($, gridPage, () => Math.min(pages - 1, page + 1))}>next ›</Button>
        </Box>
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  const isSplit = String(options.layout ?? 'split') !== 'tab'
  const hosts = String(options.hostPanes ?? 'todo-pane,task-lists')
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '')
  const share = clamp(Number(options.topShare ?? 50), 20, 80)

  on('session.start', async ($, e, next) => {
    await safely(() => $.command.register({ name: 'files', description: "Show the session's files in the side panel" }))
    await safely(() => $.command.register({ name: 'gallery', description: "Show the session's files as a grid of thumbnails" }))
    void safely(async () => {
      const saved = await $.store.get(await storeKey($))
      if (Array.isArray(saved)) await update($, files, list => (list.length > 0 ? list : (saved as FileRow[]).map(row => ({ ...row, kind: kindOf(row.path) }))))
    })
    if (!isSplit) void $.ui.open({ id: PANE, title: 'Files' })
    // The Gallery tab of 0.3.0 is gone (the grid is the bottom half now); a pane left open by an earlier load stays until closed.
    void safely(() => $.ui.close({ id: 'session-files-gallery' }))

    return next(e)
  })

  on('command.run', { command: 'files' }, async $ => {
    await $.ui.open(isSplit ? { id: hosts[0] ?? 'todo-pane', focus: true } : { id: PANE, title: 'Files', focus: true })

    return { text: 'Files shown in the side panel.' }
  })

  on('command.run', { command: 'gallery' }, async $ => {
    await update($, mode, () => 'grid')
    await $.ui.open(isSplit ? { id: hosts[0] ?? 'todo-pane', focus: true } : { id: PANE, title: 'Files', focus: true })

    return { text: 'Files shown as a grid in the side panel.' }
  })

  // Files Claude reads or changes.
  on('tool.call', async ($, e, next) => {
    const hit = touched(e)
    if (hit) await safely(() => track($, hit.path, hit.source))

    return next(e)
  })

  // Files the person pastes or @mentions in a prompt.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') {
      await safely(async () => {
        const cwd = await $.session.cwd()
        for (const n of imageNumbers(e.text)) {
          const path = await pastedFile($, n)
          if (path !== undefined) await track($, path, 'pasted')
        }
        for (const mention of mentionPaths(e.text)) {
          const path = absolute(cwd, mention)
          const stat = await $.fs.stat(path).catch(() => undefined)
          if (stat?.kind === 'file') await track($, path, 'mention')
        }
      })
    }

    return next(e)
  })

  // A pane of its own, for the tab layout (and as the fallback when the host pane is not drawn).
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => filesView($, e, e.props.scroll.bodyRows))

  // Split layout: the host pane keeps its drawing in the top part and the files take the rest.
  // The files stay put while the top half changes tabs: every host pane gets the same bottom half.
  if (isSplit) {
    for (const host of hosts) {
      on('ui.render', { component: 'Pane', requestId: host }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        // One row goes to the divider between the parts.
        const rows = Math.max(2 * MIN_ROWS + 1, e.props.scroll.bodyRows)
        const topRows = clamp(Math.round(((rows - 1) * share) / 100), MIN_ROWS, rows - 1 - MIN_ROWS)
        const bottomRows = rows - 1 - topRows
        const rule = '─'.repeat(Math.max(4, e.props.bodyColumns))
        // A viewer opened big takes the whole panel; the host pane's part waits behind it.
        if ((await read($, viewing)) !== null && (await read($, expanded))) return filesView($, e, e.props.scroll.bodyRows)
        const upper = await next({ ...e, props: { ...e.props, scroll: { ...e.props.scroll, bodyRows: topRows } } })

        return (
          <Box flexDirection="column">
            <Box key="files-top" flexDirection="column" height={topRows} overflow="hidden">
              {upper}
            </Box>
            <Text dimColor>{rule}</Text>
            <Box key="files-bottom" flexDirection="column" height={bottomRows} overflow="hidden">
              {await filesView($, e, bottomRows)}
            </Box>
          </Box>
        )
      })
    }
  }
}
