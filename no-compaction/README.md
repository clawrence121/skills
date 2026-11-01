# no-compaction

A Claude Code mod that replaces compaction's lossy summary. When the context fills up, it clears the
context and leaves one message that contains:

- a short **handoff note** written by Haiku from the chat text only (Working on / Up to / Next / Key facts)
- the **task list** at the time (TodoWrite or TaskCreate/TaskUpdate)
- up to 10 **code areas** edited, collapsed from file paths (e.g. `apps/my_app/routes/*`)
- a **pointer to the session's own transcript**, so Claude can search the real history for details

If the Haiku call fails, the message is sent without the note. Subagents compact normally.

Based on [Tomcc's no-compaction gist](https://gist.github.com/Tomcc/b7b0f348b1628ad94bdef918e449b330).
Requires Claude Code 2.1.316+.

## Install

Copy this folder to `~/.claude/skills/no-compaction/` (or a project's `.claude/skills/`), restart the
session, and check `claude plugin list` shows `no-compaction@skills-dir ... ✔ loaded`.
