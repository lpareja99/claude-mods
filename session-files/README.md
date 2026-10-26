# session-files

A Claude Code mod that keeps a live list of the files in your session, so you can reuse them without attaching them again and look at them without leaving the terminal.

**What it tracks**

| Source | How it gets in |
| --- | --- |
| pasted | an image you paste into a prompt |
| @ | a file you `@mention` in a prompt (only if it exists) |
| read / edited | a file Claude reads, edits or writes |

**What you can do with a row** (click it, or Tab to it and Enter): **Use** puts `@path` in your prompt at the cursor, **View** shows the file in the panel (images as pictures, text with highlighting and prev/next paging), **Forget** drops it from the list. The `all | mine | Claude's` filter splits what you attached from what Claude touched.

Rows other than pasted images are remembered per project folder between sessions. A pasted image's file lives in the session's temp folder, so it is only listed for that session.

## Layout

By default the files sit under the todo pane in the same side panel: the todo pane keeps its drawing in the top half (`next(e)` on its pane) and the files take the bottom half. `todo-pane` is not changed. `/files` focuses the panel.

Set in the mod's options:

- `layout`: `split` (default) or `tab` (a pane of its own).
- `hostPane`: the pane the files go under, `todo-pane` by default.
- `topShare`: the share of the panel's height the host pane keeps, 50 by default.

For the split to work this mod's hook must sit outside the host pane's in the hook chain; if the todo pane then shows alone, switch `layout` to `tab`.

## Install

```
/plugin install session-files --marketplace lpareja99/claude-mods
/reload-plugins
```

## Notes

- Images draw as real pictures in Ghostty and kitty (not inside tmux). A non-PNG image is converted once with `sips` (macOS).
- Whether `@path` of a pasted image attaches it as an image is up to Claude Code.
- Viewing reads files up to 4 MiB.
