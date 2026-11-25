// claude-studio — runs Claude Code Game Studios' hooks (.claude/hooks/*.sh)
// inside OpenCode 2.x: write/read/commit/push guards before a tool runs,
// asset and skill checks after, and the session-start recovery block as
// context. The translation lives in tools/ports/claude-hooks.ts.
// Set CLAUDE_STUDIO_DEBUG=/path/file.jsonl to log every tool event.

import { appendFileSync } from "node:fs"
import { findRoot, studio, toClaude } from "../../tools/ports/claude-hooks.ts"

// OpenCode 2.x tool names -> Claude Code's. `patch` (GPT models) and
// `subagent` carry no single file and are not checked.
const NAMES: Record<string, string> = { shell: "Bash", bash: "Bash", write: "Write", edit: "Edit", read: "Read" }

const debug = (kind: string, e: unknown) => {
  const f = process.env.CLAUDE_STUDIO_DEBUG
  if (f) try { appendFileSync(f, JSON.stringify({ host: "opencode", kind, e }) + "\n") } catch {}
}
// The primary agents are the user's own session; anything else is a subagent.
const subagent = (a: unknown) => (typeof a === "string" && !["build", "plan"].includes(a) ? a : undefined)

const ClaudeStudio = {
  id: "claude-studio",
  async setup(ctx: any) {
    // V2 has ctx.location.directory; take the first candidate that is a path.
    const where = [ctx?.location?.directory, ctx?.directory, ctx?.worktree, ctx?.project?.directory, ctx?.project?.worktree, process.cwd()]
      .find((x: unknown) => typeof x === "string" && x) as string
    const root = findRoot(where)
    if (!root) return
    process.env.CLAUDE_STUDIO_HOST = "opencode"
    const s = studio(root)
    let start: Promise<string> | null = null

    await ctx?.tool?.hook?.("execute.before", async (e: any) => {
      debug("before", e)
      const c = toClaude(NAMES, e?.tool, e?.input)
      if (!c) return
      const v = await s.pre(c, subagent(e?.agent))
      if (v.block) throw new Error(v.block)
    })

    await ctx?.tool?.hook?.("execute.after", async (e: any) => {
      debug("after", e)
      if (e?.status && e.status !== "completed") return
      const c = toClaude(NAMES, e?.tool, e?.input)
      if (!c || (c.tool !== "Write" && c.tool !== "Edit")) return
      const v = await s.post(c, subagent(e?.agent))
      const note = [v.block, ...v.context].filter(Boolean).join("\n")
      if (!note) return
      // Hand the hook's feedback to the model with the tool result.
      if (e.result && typeof e.result.output === "string") e.result.output += `\n\n[studio check]\n${note}`
    })

    // The SessionStart hooks' output (active.md recovery, gap report), once,
    // in every request's system prompt.
    await ctx?.session?.hook?.("context", async (e: any) => {
      start = start || s.sessionStart()
      const text = await start
      // V2 system entries are { type: "text", text } parts, not strings.
      if (text && Array.isArray(e?.system))
        e.system.push({ type: "text", text: `<studio-session-start>\n${text}\n</studio-session-start>` })
    })

    await ctx?.session?.hook?.("compaction", async () => { await s.preCompact() })
  },
}

export default ClaudeStudio
