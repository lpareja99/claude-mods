# task-lists

A pane for Claude Code that lists every saved task list and lets you choose which one the session uses, so a `/clear` or a new session never leaves your todos stranded.

It is a mod: everything it needs is in this folder. Nothing goes in your `CLAUDE.md`.

## Why

Claude Code keeps each session's tasks in their own folder (`<config dir>/tasks/<session id>/N.json`). A `/clear` or a new session starts a new, empty list and the old one stays on disk, out of sight. This mod shows those lists and points the session back at one of them.

## Install

In a Claude Code session:

```
/plugin install task-lists --marketplace lpareja99/claude-mods
```

Or from a local copy of this repository:

```
claude plugin marketplace add <path to this repository>
claude plugin install task-lists@local-mods
```

Then run `/reload-plugins` (or start a new session).

It works on its own. With [todo-pane](../todo-pane) installed as well, the Todos pane follows the list you pick.

## Commands

| Command | What it does |
| --- | --- |
| `/task-lists` | Opens the Task lists pane |
| `/todo` | Opens the Task lists pane and, when todo-pane is installed, the Todos pane too |

## Using it

The top of the pane says which list is in use. Each row is `title  done/total  age`, and a `●` marks the list in use. Click a row to see its tasks, then click **Use this list**.

| Key | Action |
| --- | --- |
| `1` / `2` | Lists of this repo / of all repos |
| `r` | Refresh |
| `u` | Use the open list |
| `s` | Go back to this session's own list |

Keys work while the pane has focus (click it, or open it with `/task-lists`).

"This repo" is worked out from the session transcripts under `<config dir>/projects/`: a list belongs to the repo whose transcript has the same session id. A list with no transcript only shows under "all repos", unless it is the one in use.

A list has no name of its own, so a row shows the subject of its first task.

## How the switch works

Picking a list sets `CLAUDE_CODE_TASK_LIST_ID` for the running session, then asks `TaskList` what it sees. If the tasks match the list you picked, the switch is confirmed: Claude's task tools now read and write that list, and the Todos pane re-reads it through `/todos-sync`. If they do not match, the variable is put back and the pane says so.

## Limits

- It relies on Claude Code reading `CLAUDE_CODE_TASK_LIST_ID` on every call. That is not documented; it was checked on 2.1.304. The pane tells you when a switch does not take.
- The choice lasts for the session. A restart goes back to the session's own list unless you launch with the variable set.
- Claude's new tasks go into the list in use, so pick the right one before work continues.
- Counts and order refresh when you open the pane or press `r`, not on every task change.
- The pane only reads task files and never deletes or edits them.
- Built and tested against Claude Code 2.1.304. It has no automated tests yet.

## Develop

```
claude plugin validate .
```

Edit the files, then run `/reload-plugins`.

## Author

Laura Pareja Prieto
