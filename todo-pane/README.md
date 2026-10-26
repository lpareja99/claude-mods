# todo-pane

A side pane for Claude Code that shows the todo list Claude keeps, live, so the intermediate steps of a long task do not get lost in the conversation.

It is a mod: everything it needs is in this folder. Nothing goes in your `CLAUDE.md`.

## Install

In a Claude Code session:

```
/plugin install todo-pane --marketplace lpareja99/claude-mods
```

Or from a local copy of this repository:

```
claude plugin marketplace add <path to this repository>
claude plugin install todo-pane@local-mods
```

Then run `/reload-plugins` (or start a new session) and open the pane with `/todos`.

## What you see

```
███████░░░ 11/15 done  ◐ 1  ! 2  ◌ 2
◐ Running the tests
──────────────────────────────────────
 group   todo 4   done 11   all 15
──────────────────────────────────────
Ready (2)
● ◐ 20 Writing the parser
● ○ 17 ★ Update the docs
──────────────────────────────────────
Blocked (1)
· ! 22 ★ Ship it                 waits for 21
──────────────────────────────────────
Deferred (1)
· ○ 23 Rewrite the importer
──────────────────────────────────────
▸ Done (11)
```

Each row is: priority dot, status, number, then the name.

| Mark | Meaning |
| --- | --- |
| `●` red / yellow / green | high / normal / low priority |
| `·` dim | no priority set |
| `✓` green | done |
| `!` red | blocked: it waits for tasks that are not done |
| `◐` cyan | in progress |
| `○` | pending |
| `★` | mandatory: cannot be skipped |
| `↳` and `12.1` | a subtask of 12, numbered under its parent |

Tabs: **group** (Ready, Blocked, Deferred, Done), **todo** (everything unfinished), **done**, **all** (flat). Click a tab or press `1`-`4`. Press `d` to fold or unfold the Done group.

Click a task to open its card: description, facts (priority, mandatory, deferred, parent) and its status timeline.

The status line also shows progress (`3/8 · current step`) when the pane is closed.

## How it gets its data

The mod watches Claude's `TodoWrite`, `TaskCreate` and `TaskUpdate` calls. Blocked tasks come from `addBlockedBy`, which Claude already uses.

For priority, mandatory, subtasks and deferred, the mod adds a short section to Claude's system prompt (only when the task tools are available) asking it to set task `metadata`:

| Metadata | Values |
| --- | --- |
| `priority` | `"high"`, `"normal"`, `"low"` |
| `mandatory` | `true` |
| `parent` | id of the parent task |
| `deferred` | `true` |

You can also ask Claude directly to set them on existing tasks.

## Limits

- The pane is read-only: clicking opens a card, it does not change tasks.
- It sees task changes made after it loaded. At session start it reads the existing task list, which has no metadata, so older tasks show without priority.
- `TodoWrite` lists have no ids, blockers or metadata, so those rows are plain.
- Claude following the metadata guidance is likely but not guaranteed.
- Built and tested against Claude Code 2.1.304.

## Develop

```
claude plugin validate .
claude plugin test .
```

The tests are in `hooks/register.test.tsx`. Edit the files, then run `/reload-plugins`.

## Author

Laura Pareja Prieto
