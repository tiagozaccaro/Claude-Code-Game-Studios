// claude-hooks.ts — runs the studio's Claude Code hooks (.claude/hooks/*.sh)
// for hosts that are not Claude Code. Shared by the OpenCode plugin
// (.opencode/plugins/claude-studio.ts) and the omp extension
// (.omp/extensions/claude-studio.ts); Hermes has the same logic in
// hermes-hook.py.
//
// The hooks are unchanged: each host's tool call is translated into the JSON
// payload Claude Code would send, piped to the script on stdin with
// CLAUDE_PROJECT_DIR set, and the script's answer (exit 2, or a JSON
// permissionDecision / decision / additionalContext) is translated back.
// Which scripts run for which event comes from tools/ports/hooks.json, which
// port.mjs generates from .claude/settings.json.
//
// Node built-ins only, so it loads under Bun (OpenCode, omp) unchanged.

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, isAbsolute } from "node:path"

/** A tool call in Claude Code's vocabulary. */
export type ClaudeCall = { tool: string; input: Record<string, unknown> }

/** What the hooks decided. `block` refuses the call; `context` goes to the model. */
export type Verdict = { block: string | null; context: string[] }

type HookSpec = { script: string; timeout: number; async: boolean }
type HookGroup = { matcher: string; hooks: HookSpec[] }
type PermRule = { tool: string; pattern: string }
type Config = { hooks: Record<string, HookGroup[]>; permissions: { allow: PermRule[]; deny: PermRule[] } }

/** Walks up from `start` to the studio root (the folder holding tools/ports/hooks.json). */
export function findRoot(start: string): string | null {
  let d = start
  for (;;) {
    if (existsSync(join(d, "tools/ports/hooks.json")) && existsSync(join(d, ".claude/hooks"))) return d
    const up = dirname(d)
    if (up === d) return null
    d = up
  }
}

/**
 * Normalizes a host tool call to Claude Code's names and input keys. `names`
 * maps the host's tool name to Claude's (e.g. { shell: "Bash" }). Returns null
 * for tools the hooks do not watch.
 */
export function toClaude(names: Record<string, string>, tool: string, input: any): ClaudeCall | null {
  const t = names[String(tool)]
  if (!t || !input || typeof input !== "object") return null
  const pick = (...keys: string[]) => { for (const k of keys) if (input[k] !== undefined) return input[k]; return undefined }
  const o: Record<string, unknown> = {}
  if (t === "Bash") o.command = pick("command", "cmd")
  else {
    o.file_path = pick("file_path", "filePath", "path")
    if (t === "Write") o.content = pick("content", "text")
    if (t === "Edit") {
      o.old_string = pick("old_string", "oldString", "oldText")
      o.new_string = pick("new_string", "newString", "newText")
      o.replace_all = !!pick("replace_all", "replaceAll")
    }
    if (t === "Read") { o.offset = pick("offset"); o.limit = pick("limit") }
  }
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return { tool: t, input: o }
}

/** A studio bound to one project root. */
export function studio(root: string, sessionId = `port-${process.pid}`) {
  const cfg: Config = JSON.parse(readFileSync(join(root, "tools/ports/hooks.json"), "utf8"))

  /** Runs one hook script with a Claude Code payload; resolves with its exit code and output. */
  function run(h: HookSpec, payload: object): Promise<{ code: number; out: string; err: string }> {
    return new Promise(resolve => {
      const p = spawn("bash", [join(root, h.script)], {
        cwd: root,
        env: { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_STUDIO_HOST: process.env.CLAUDE_STUDIO_HOST || "port" },
        stdio: ["pipe", "pipe", "pipe"],
      })
      let out = "", err = "", done = false
      const finish = (code: number) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }) } }
      const t = setTimeout(() => { p.kill("SIGKILL"); finish(0) }, h.timeout * 1000) // a timeout fails open, as in Claude Code
      p.stdout.on("data", d => (out += d))
      p.stderr.on("data", d => (err += d))
      p.on("error", () => finish(0))
      p.on("close", c => finish(c ?? 0))
      p.stdin.on("error", () => {})
      p.stdin.end(JSON.stringify(payload))
    })
  }

  /** Runs every hook for `event` whose matcher matches `tool`; folds their answers. */
  async function fire(event: string, payload: Record<string, unknown>, tool = ""): Promise<Verdict> {
    const v: Verdict = { block: null, context: [] }
    for (const g of cfg.hooks[event] || []) {
      if (g.matcher && tool && !new RegExp(`^(?:${g.matcher})$`).test(tool)) continue
      for (const h of g.hooks) {
        const body = { session_id: sessionId, transcript_path: "", cwd: root, hook_event_name: event, ...payload }
        if (h.async) { run(h, body); continue }
        const r = await run(h, body)
        if (r.code === 2) { v.block = v.block || r.err.trim() || `${h.script} refused this`; continue }
        const text = r.out.trim()
        if (!text) continue
        let j: any = null
        try { j = JSON.parse(text) } catch { /* plain text */ }
        if (!j || typeof j !== "object") { v.context.push(text); continue }
        const hso = j.hookSpecificOutput || {}
        if (hso.permissionDecision === "deny") v.block = v.block || hso.permissionDecisionReason || j.reason || `${h.script} refused this`
        if (j.decision === "block") v.block = v.block || j.reason || `${h.script} refused this`
        if (hso.additionalContext) v.context.push(String(hso.additionalContext))
        else if (j.systemMessage) v.context.push(String(j.systemMessage))
      }
    }
    return v
  }

  /** The settings.json deny rules for a call, Claude Code's matching: first deny wins. */
  function denied(c: ClaudeCall): string | null {
    for (const r of cfg.permissions.deny) {
      // As in Claude Code, an Edit(...) rule covers every tool that edits files.
      if (r.tool !== c.tool && !(r.tool === "Edit" && c.tool === "Write")) continue
      if (c.tool === "Bash") {
        const cmd = String(c.input.command || "")
        for (const part of cmd.split(/&&|\|\||;|\||\n/).map(s => s.trim()).filter(Boolean))
          if (bashMatch(r.pattern, part)) return `Denied by .claude/settings.json: Bash(${r.pattern})`
      } else {
        const fp = String(c.input.file_path || "")
        const rel = isAbsolute(fp) ? relative(root, fp) : fp
        if (globMatch(r.pattern, rel.split("\\").join("/"))) return `Denied by .claude/settings.json: ${r.tool}(${r.pattern})`
      }
    }
    return null
  }

  return {
    root,
    denied,
    /** PreToolUse: permissions, then the guard hooks. */
    async pre(c: ClaudeCall, agent?: string): Promise<Verdict> {
      const d = denied(c)
      if (d) return { block: d, context: [] }
      return fire("PreToolUse", { tool_name: c.tool, tool_input: c.input, ...(agent ? { agent_type: agent } : {}) }, c.tool)
    },
    /** PostToolUse: a block here is feedback for the model, not a refusal. */
    post: (c: ClaudeCall, agent?: string) =>
      fire("PostToolUse", { tool_name: c.tool, tool_input: c.input, tool_response: {}, ...(agent ? { agent_type: agent } : {}) }, c.tool),
    /** SessionStart output, joined: the session-recovery block and gap report. */
    async sessionStart(): Promise<string> {
      const v = await fire("SessionStart", { source: "startup" })
      return v.context.join("\n\n")
    },
    preCompact: () => fire("PreCompact", { trigger: "auto", custom_instructions: "" }),
    stop: () => fire("Stop", { stop_hook_active: false }),
  }
}

/** Claude Code Bash(...) pattern: `*` is any text; a trailing ` *` also matches the bare command. */
export function bashMatch(pattern: string, cmd: string): boolean {
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*")
  if (new RegExp(`^${esc(pattern)}$`).test(cmd)) return true
  return pattern.endsWith(" *") && cmd === pattern.slice(0, -2)
}

/** Gitignore-style path glob: `**` crosses folders, `*` does not. */
export function globMatch(pattern: string, path: string): boolean {
  let re = ""
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === "*" && pattern[i + 1] === "*") { re += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += pattern[i + 2] === "/" ? 2 : 1 }
    else if (ch === "*") re += "[^/]*"
    else if (ch === "?") re += "[^/]"
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`).test(path)
}
