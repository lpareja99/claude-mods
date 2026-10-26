# local-mods

A Claude Code marketplace holding two mods.

| Mod | What it does |
| --- | --- |
| [todo-pane](./todo-pane) | A side pane showing Claude's todo list live: status, priority, blockers, subtasks |
| [task-lists](./task-lists) | A pane listing every saved task list, for this repo or all, to choose which one the session uses |

They work on their own and work best together: pick a list in task-lists and the todo-pane follows. `/todo` opens both panes.

## Install

```
/plugin install todo-pane --marketplace lpareja99/claude-mods
/plugin install task-lists --marketplace lpareja99/claude-mods
```

From a local copy:

```
claude plugin marketplace add <path to this folder>
claude plugin install todo-pane@local-mods
claude plugin install task-lists@local-mods
```

See [todo-pane/README.md](./todo-pane/README.md) and [task-lists/README.md](./task-lists/README.md) for what each shows and how it works.
