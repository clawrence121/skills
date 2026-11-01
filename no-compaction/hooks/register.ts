import { atom, read, update } from 'claude-code'
import type { Register, SessionMessage } from 'claude-code'

// Kept in $.state so a mod reload mid-session still knows where the log is.
const transcriptPath = atom({ plugin: 'no-compaction', key: 'transcriptPath' } as const, '')

// ---------- Haiku handoff summary (text only, no tool calls) ----------

const PER_MESSAGE_CHARS = 1500
const DIGEST_BUDGET_CHARS = 60_000
const HEAD_USER_MESSAGES = 3

function clean(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g, '')
    .trim()
}

function clip(text: string): string {
  return text.length <= PER_MESSAGE_CHARS ? text : `${text.slice(0, PER_MESSAGE_CHARS)} […]`
}

function buildDigest(messages: readonly SessionMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const text = clean(m.text)
    if (text === '') continue
    lines.push(`${m.role === 'user' ? 'USER' : 'CLAUDE'}: ${clip(text)}`)
  }

  // Head: up to the first few user messages (the goal).
  const head: string[] = []
  let userSeen = 0
  let headEnd = 0
  for (; headEnd < lines.length && userSeen < HEAD_USER_MESSAGES; headEnd++) {
    const line = lines[headEnd]!
    head.push(line)
    if (line.startsWith('USER: ')) userSeen++
  }
  let used = head.reduce((n, l) => n + l.length, 0)

  // Tail: fill backwards from the end (where we are now).
  const tail: string[] = []
  for (let i = lines.length - 1; i >= headEnd; i--) {
    const line = lines[i]!
    if (used + line.length > DIGEST_BUDGET_CHARS) break
    tail.unshift(line)
    used += line.length
  }
  const omitted = lines.length - head.length - tail.length
  return [...head, ...(omitted > 0 ? [`[… ${omitted} messages omitted …]`] : []), ...tail].join('\n\n')
}

const SUMMARY_SYSTEM = 'You write handoff notes for a coding agent whose memory was just wiped.'

function summaryPrompt(digest: string): string {
  return (
    'Below is the conversation so far (tool calls removed). Write a terse handoff in exactly this format, ' +
    'no preamble:\n\n' +
    'Working on: <one line: the overall goal>\n' +
    'Up to: <one or two lines: what was just done / in progress>\n' +
    'Next: <the immediate next step, if clear; else "unclear, check transcript">\n' +
    'Key facts:\n- <up to 5 bullets: decisions, names, values the user stated>\n\n' +
    `<conversation>\n${digest}\n</conversation>`
  )
}

// ---------- Deterministic extras from tool calls ----------

type Todo = { content: string; status: string }

function latestTodos(messages: readonly SessionMessage[]): Todo[] {
  // Newer builds use TaskCreate/TaskUpdate; older ones TodoWrite. Replay whichever appears.
  let todoWrite: Todo[] | undefined
  const tasks = new Map<string, Todo>()
  for (const m of messages) {
    for (const use of m.toolUses) {
      const input = use.input as Record<string, any>
      if (use.tool === 'TodoWrite' && Array.isArray(input.todos)) {
        todoWrite = input.todos.map((t: any) => ({ content: String(t.content), status: String(t.status) }))
      } else if (use.tool === 'TaskCreate') {
        const id = (use.result as any)?.task?.id
        if (id !== undefined) tasks.set(String(id), { content: String(input.subject), status: 'pending' })
      } else if (use.tool === 'TaskUpdate' && tasks.has(String(input.taskId))) {
        const t = tasks.get(String(input.taskId))!
        if (input.status === 'deleted') tasks.delete(String(input.taskId))
        else tasks.set(String(input.taskId), {
          content: input.subject !== undefined ? String(input.subject) : t.content,
          status: input.status !== undefined ? String(input.status) : t.status,
        })
      }
    }
  }
  return tasks.size > 0 ? [...tasks.values()] : (todoWrite ?? [])
}

function formatTodos(todos: Todo[]): string {
  const mark: Record<string, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' }
  return todos.map(t => `${mark[t.status] ?? '[ ]'} ${t.content}`).join('\n')
}

const EDIT_TOOLS: Record<string, string> = {
  Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path',
}

function editedPaths(messages: readonly SessionMessage[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    for (const use of m.toolUses) {
      const key = EDIT_TOOLS[use.tool]
      const p = key ? (use.input as Record<string, unknown>)[key] : undefined
      if (typeof p === 'string' && !use.isError) out.push(p)
    }
  }
  return out
}

/**
 * Collapse edited file paths into at most `max` code areas.
 * Start with each file's directory; while there are too many groups, take the
 * deepest level and fold the children of the parent that has the most of them
 * into that parent (so siblings merge first, then the tree shrinks upwards).
 */
function codeAreas(paths: string[], cwd: string, max = 10): string[] {
  const rel = [...new Set(paths)].map(p => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p))
  type Group = { files: number; sample: string; collapsed: boolean }
  const groups = new Map<string, Group>()
  const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
  const depth = (d: string) => (d === '' ? 0 : d.split('/').length)
  for (const p of rel) {
    const d = dirOf(p)
    const g = groups.get(d)
    if (g) g.files++
    else groups.set(d, { files: 1, sample: p, collapsed: false })
  }

  while (groups.size > max) {
    const maxDepth = Math.max(...[...groups.keys()].map(depth))
    if (maxDepth === 0) break
    const byParent = new Map<string, string[]>()
    for (const d of groups.keys()) {
      if (depth(d) !== maxDepth) continue
      const parent = dirOf(d)
      byParent.set(parent, [...(byParent.get(parent) ?? []), d])
    }
    const best = [...byParent.entries()].sort((a, b) => b[1].length - a[1].length)[0]
    if (!best) break
    const [parent, children] = best
    const merged = groups.get(parent) ?? { files: 0, sample: '', collapsed: false }
    for (const c of children) {
      merged.files += groups.get(c)!.files
      groups.delete(c)
    }
    merged.collapsed = true
    groups.set(parent, merged)
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].files - a[1].files)
    .map(([d, g]) => {
      if (g.files === 1 && !g.collapsed) return g.sample
      const base = d === '' ? '.' : d
      return `${base}/${g.collapsed ? '**' : '*'} (${g.files} files)`
    })
}

// ---------- The resume message ----------

function resumeMessage(path: string, extras: { summary?: string; todos?: string; areas?: string[] }): string {
  const parts: string[] = []
  if (extras.summary) {
    parts.push(
      'No-compaction workflow: your context filled up and was cleared. Quick handoff ' +
        '(written by a small model from the chat text only, so it is lossy: verify specifics ' +
        'against the transcript before acting on them):\n\n' +
        extras.summary,
    )
  } else {
    parts.push('No-compaction workflow: your context filled up and was cleared.')
  }
  if (extras.todos) parts.push(`Task list at the time:\n${extras.todos}`)
  if (extras.areas && extras.areas.length > 0) {
    parts.push(
      'Code areas edited via Edit/Write (edits made by scripts or Bash are not counted):\n' +
        extras.areas.map(a => `- ${a}`).join('\n'),
    )
  }
  parts.push(
    `Full history: ${path}. Read or search it like any normal file to recall details and ` +
      'resume as seamlessly as possible from where you left off.\n\n' +
      'Tips:\n' +
      '- Each line is one JSON message, some with huge tool results: never cat or tail it raw, ' +
      'cap each block to a few hundred chars.\n' +
      '- The end shows where you stopped; the first user messages show the goal.\n' +
      '- The last few lines are this new request, so skip them.',
  )
  return parts.join('\n\n')
}

export const register: Register = on => {
  // Only classic events carry transcript_path; record it as early and as often as we can.
  on('classic.SessionStart', async ($, e, next) => {
    await update($, transcriptPath, () => e.transcript_path)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await update($, transcriptPath, () => e.transcript_path)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Nothing to precompute: the replacement is cheap enough to do at compaction time.
  on('session.compact', { trigger: 'precompute' }, () => ({ skip: 'no-compaction mod' }))

  on('session.compact', async ($, e, next) => {
    // Subagents keep their own transcript files we can't locate; let them compact normally.
    if (e.trigger === 'precompute' || e.agentId !== undefined) {
      return next(e)
    }
    const path = await read($, transcriptPath)
    if (path === '') {
      $.ui.toast('no-compaction: transcript path unknown, using normal compaction')
      return next(e)
    }

    // Each extra is best-effort: a failure just leaves it out.
    let summary: string | undefined
    try {
      const r = await $.model.complete({
        model: 'haiku',
        system: SUMMARY_SYSTEM,
        prompt: summaryPrompt(buildDigest(e.messages)),
        maxTokens: 400,
        effort: 'low',
        timeoutMs: 20_000,
      })
      if (r.isAnswered && r.text.trim() !== '') summary = r.text.trim()
      else $.ui.toast('no-compaction: summary unavailable, sending transcript pointer only')
    } catch {
      $.ui.toast('no-compaction: summary failed, sending transcript pointer only')
    }

    let todos: string | undefined
    let areas: string[] | undefined
    try {
      const t = latestTodos(e.messages)
      if (t.length > 0) todos = formatTodos(t)
    } catch {}
    try {
      areas = codeAreas(editedPaths(e.messages), await $.session.cwd())
    } catch {}

    return {
      messages: [{ role: 'user', text: resumeMessage(path, { summary, todos, areas }), toolUses: [] }],
    }
  }).catch(($, e, next) => next(e))
}
