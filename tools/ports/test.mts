// test.mts — checks the OpenCode, omp and Hermes adapters without a model:
// each is driven through a fake host with tool calls the studio's hooks and
// .claude/settings.json deny rules must refuse, and ones they must allow.
// Run: node tools/ports/test.mts   (Node 22.6+; python3 for the Hermes rows)
//
// It writes one temporary 64 KB file under design/ (the read guard only
// watches design/, docs/architecture/ and production/session-state/) and
// removes it at the end.

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const BIG = "design/_ports-test-big.md"
process.chdir(ROOT)
process.env.TMPDIR = mkdtempSync(join(tmpdir(), "ports-test-")) // Hermes session marks
writeFileSync(join(ROOT, BIG), "# Big\n" + Array.from({ length: 900 }, (_, i) => `## S${i}\nLorem ipsum dolor sit amet, consectetur adipiscing elit.\n`).join(""))

let fail = 0
const check = (name: string, blocked: boolean, expect: boolean, why = "") => {
  const ok = blocked === expect
  if (!ok) fail++
  console.log(`${ok ? "ok  " : "FAIL"} ${name} -> ${blocked ? "blocked" : "allowed"}${!ok && why ? ` (${why})` : ""}`)
}
const holds = (name: string, value: boolean, why = "") => {
  if (!value) fail++
  console.log(`${value ? "ok  " : "FAIL"} ${name}${!value && why ? ` (${why})` : ""}`)
}

try {
  // ---- OpenCode: execute.before throws to refuse --------------------------
  const oc = (await import(join(ROOT, ".opencode/plugins/claude-studio.ts"))).default
  const ocHooks: Record<string, Function> = {}
  await oc.setup({
    location: { directory: ROOT },
    tool: { hook: (n: string, f: Function) => (ocHooks[`tool.${n}`] = f) },
    session: { hook: (n: string, f: Function) => (ocHooks[`session.${n}`] = f) },
  })
  const ocTry = async (tool: string, input: object) => {
    try { await ocHooks["tool.execute.before"]({ tool, input, agent: "build" }); return false } catch { return true }
  }
  check("opencode read big design doc whole", await ocTry("read", { path: BIG }), true)
  check("opencode read big design doc in a range", await ocTry("read", { path: BIG, offset: 1, limit: 40 }), false)
  check("opencode read .env", await ocTry("read", { path: ".env" }), true)
  check("opencode shell git push --force", await ocTry("shell", { command: "git push --force origin main" }), true)
  check("opencode shell compound with sudo", await ocTry("shell", { command: "git status && sudo ls" }), true)
  check("opencode shell git status", await ocTry("shell", { command: "git status" }), false)
  check("opencode write .uasset", await ocTry("write", { path: "Content/a.uasset", content: "x" }), true)
  check("opencode edit README", await ocTry("edit", { path: "README.md", oldString: "a", newString: "a", replaceAll: false }), false)
  const sys: any[] = []
  await ocHooks["session.context"]({ system: sys })
  holds("opencode session-start context injected", !!sys[0]?.text?.includes("studio-session-start"))

  // ---- omp: tool_call returns { block } ------------------------------------
  const omp = (await import(join(ROOT, ".omp/extensions/claude-studio.ts"))).default
  const on: Record<string, Function> = {}
  omp({ on: (n: string, f: Function) => (on[n] = f) })
  const ompTry = async (toolName: string, input: object) => !!(await on.tool_call({ toolName, input }))?.block
  check("omp read big design doc whole", await ompTry("read", { path: BIG }), true)
  check("omp bash git clean -fdx", await ompTry("bash", { command: "git clean -fdx" }), true)
  check("omp hashline edit naming a .umap", await ompTry("edit", { input: "[README.md#AB12]\nPUT 3.=3:\n+x\n\n[Content/l.umap#CD34]\nREM\n" }), true)
  check("omp hashline edit on README", await ompTry("edit", { input: "[README.md#AB12]\nPUT 3.=3:\n+x\n" }), false)
  const sp = await on.before_agent_start({ systemPrompt: "BASE" })
  holds("omp session-start in system prompt", !!sp?.systemPrompt?.includes("studio-session-start"))

  // ---- Hermes: shell hook prints {"decision":"block"} ----------------------
  const hermes = (event: string, payload: object) => {
    const r = spawnSync("python3", [join(ROOT, "tools/ports/hermes-hook.py"), event], { input: JSON.stringify(payload), encoding: "utf8" })
    return r.stdout || ""
  }
  const hBlock = (tool_name: string, tool_input: object, cwd = ROOT) =>
    hermes("pre_tool_call", { hook_event_name: "pre_tool_call", tool_name, tool_input, session_id: "t", cwd }).includes('"block"')
  check("hermes read_file big design doc whole", hBlock("read_file", { path: BIG }), true)
  check("hermes read_file in a range", hBlock("read_file", { path: BIG, offset: 1, limit: 30 }), false)
  check("hermes terminal git reset --hard (from a subfolder)", hBlock("terminal", { command: "git reset --hard HEAD" }, join(ROOT, "design")), true)
  check("hermes patch .uasset", hBlock("patch", { mode: "replace", path: "x.uasset", old_string: "a", new_string: "b" }), true)
  check("hermes write_file plain", hBlock("write_file", { path: "design/notes.md", content: "hi" }), false)
  check("hermes outside the project is a no-op", hBlock("terminal", { command: "sudo ls" }, tmpdir()), false)
  const first = hermes("pre_llm_call", { session_id: "once", cwd: ROOT })
  const second = hermes("pre_llm_call", { session_id: "once", cwd: ROOT })
  holds("hermes session-start injected once", first.includes("studio-session-start") && !second)

  // ---- generated files are current -----------------------------------------
  const gen = spawnSync(process.execPath, [join(ROOT, "tools/ports/port.mjs"), "--check"], { encoding: "utf8" })
  holds("generated files are current (port.mjs --check)", gen.status === 0, gen.stderr.trim())
} finally {
  rmSync(join(ROOT, BIG), { force: true })
  rmSync(process.env.TMPDIR!, { recursive: true, force: true })
}

console.log(fail ? `\n${fail} failed` : "\nall passed")
process.exit(fail ? 1 : 0)
