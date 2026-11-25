// claude-studio — runs Claude Code Game Studios' hooks (.claude/hooks/*.sh)
// inside oh-my-pi: write/read/commit/push guards and the settings.json deny
// rules before a tool runs, asset and skill checks after, the session-start
// recovery block in the system prompt, and the pre-compact and stop hooks.
// The translation lives in tools/ports/claude-hooks.ts.
// Set CLAUDE_STUDIO_DEBUG=/path/file.jsonl to log every tool event.

import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { findRoot, studio, toClaude, type ClaudeCall } from "../../tools/ports/claude-hooks.ts"

const NAMES: Record<string, string> = { bash: "Bash", write: "Write", edit: "Edit", read: "Read" }

const debug = (kind: string, e: unknown) => {
  const f = process.env.CLAUDE_STUDIO_DEBUG
  if (f) try { appendFileSync(f, JSON.stringify({ host: "omp", kind, e }) + "\n") } catch {}
}

export default function (pi: any) {
  const root = findRoot(process.cwd())
  if (!root) return
  process.env.CLAUDE_STUDIO_HOST = "omp"
  const s = studio(root)
  let start: Promise<string> | null = null

  // A call in Claude Code's terms. omp's `edit` is a hashline patch script —
  // `[path#HASH]` headers, then line ops — that may touch several files and
  // whose result cannot be known before it runs. Each file it names is checked
  // as a Write of the file's current content: the path rules (deny globs,
  // protected files, the prototype boundary, the string freeze) all fire; the
  // content rules see the file as it is.
  const calls = (event: any): ClaudeCall[] => {
    if (event?.toolName === "edit" && typeof event?.input?.input === "string") {
      const paths = [...event.input.input.matchAll(/^\[([^\]#\n]+)#[^\]\n]*\]/gm)].map(m => m[1].trim())
      return [...new Set(paths)].map(p => {
        const abs = isAbsolute(p) ? p : join(root, p)
        return { tool: "Write", input: { file_path: abs, content: existsSync(abs) ? readFileSync(abs, "utf8") : "" } }
      })
    }
    const c = toClaude(NAMES, event?.toolName, event?.input)
    return c ? [c] : []
  }

  pi.on("tool_call", async (event: any) => {
    debug("tool_call", event)
    const context: string[] = []
    for (const c of calls(event)) {
      const v = await s.pre(c)
      if (v.block) return { block: true, reason: v.block }
      context.push(...v.context)
    }
    if (context.length) return { additionalContext: context.join("\n") }
  })

  pi.on("tool_result", async (event: any) => {
    debug("tool_result", event)
    if (event?.isError) return
    const notes: string[] = []
    for (const c of calls(event)) {
      if (c.tool !== "Write" && c.tool !== "Edit") continue
      const v = await s.post(c)
      notes.push(...[v.block, ...v.context].filter(Boolean) as string[])
    }
    const note = notes.join("\n")
    if (!note) return
    const content = Array.isArray(event.content) ? event.content : []
    return { content: [...content, { type: "text", text: `[studio check]\n${note}` }] }
  })

  // The SessionStart hooks' output (active.md recovery, gap report), appended
  // to the system prompt for every turn of the session.
  pi.on("before_agent_start", async (event: any) => {
    start = start || s.sessionStart()
    const text = await start
    if (!text) return
    return { systemPrompt: `${event?.systemPrompt ?? ""}\n\n<studio-session-start>\n${text}\n</studio-session-start>` }
  })

  pi.on("session_before_compact", async () => { await s.preCompact() })
  pi.on("session_shutdown", async () => { await s.stop() })
}
