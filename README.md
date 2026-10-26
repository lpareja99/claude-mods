# local-mods

A Claude Code marketplace holding four mods.

| Mod | What it does |
| --- | --- |
| [todo-pane](./todo-pane) | A side pane showing Claude's todo list live: status, priority, blockers, subtasks |
| [task-lists](./task-lists) | A pane listing every saved task list, for this repo or all, to choose which one the session uses |
| [session-files](./session-files) | A live list of the session's files (pasted, @mentioned, read or edited by Claude): reuse them in a prompt or view them in the side panel, under the todo pane |
| [image-preview](./image-preview) | Thumbnails of pasted images above the prompt and on the sent message, and no duplicate pastes |

They work on their own and work best together: pick a list in task-lists and the todo-pane follows. `/todo` opens both panes.

## Install

```
/plugin install todo-pane --marketplace lpareja99/claude-mods
/plugin install task-lists --marketplace lpareja99/claude-mods
/plugin install image-preview --marketplace lpareja99/claude-mods
/plugin install session-files --marketplace lpareja99/claude-mods
```

From a local copy:

```
claude plugin marketplace add <path to this folder>
claude plugin install todo-pane@local-mods
claude plugin install task-lists@local-mods
claude plugin install image-preview@local-mods
claude plugin install session-files@local-mods
```

See [todo-pane/README.md](./todo-pane/README.md) and [task-lists/README.md](./task-lists/README.md) for what each shows and how it works.
