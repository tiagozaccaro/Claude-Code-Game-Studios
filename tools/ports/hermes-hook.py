#!/usr/bin/env python3
"""hermes-hook.py — runs Claude Code Game Studios' hooks (.claude/hooks/*.sh)
from Hermes Agent's shell hooks. Hermes loads hooks only from the user's
~/.hermes/config.yaml; `node tools/ports/port.mjs hermes-snippet` prints the
block to paste there. Outside a studio project this script does nothing.

Usage (from config.yaml): python3 /abs/tools/ports/hermes-hook.py <event>
  pre_tool_call   settings.json deny rules + PreToolUse guards; blocks
  post_tool_call  PostToolUse checks (Hermes shows them in its log only)
  pre_llm_call    SessionStart output, injected once per session as context
  on_session_end  the Stop hooks

Same translation as tools/ports/claude-hooks.ts. Python 3.8+, stdlib only.
Set CLAUDE_STUDIO_DEBUG=/path/file.jsonl to log every payload.
"""
import json, os, re, subprocess, sys, tempfile

NAMES = {"terminal": "Bash", "write_file": "Write", "patch": "Edit", "read_file": "Read"}


def find_root(start):
    d = os.path.abspath(start or os.getcwd())
    while True:
        if os.path.isfile(os.path.join(d, "tools/ports/hooks.json")) and os.path.isdir(os.path.join(d, ".claude/hooks")):
            return d
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up


def to_claude(tool, inp):
    t = NAMES.get(tool or "")
    if not t or not isinstance(inp, dict):
        return None
    o = {}
    if t == "Bash":
        o["command"] = inp.get("command")
    else:
        o["file_path"] = inp.get("path", inp.get("file_path"))
        if t == "Write":
            o["content"] = inp.get("content")
        if t == "Edit":
            if inp.get("mode") not in (None, "replace"):
                return None  # V4A multi-file patch: no single old/new pair to check
            o["old_string"] = inp.get("old_string")
            o["new_string"] = inp.get("new_string")
            o["replace_all"] = bool(inp.get("replace_all"))
        if t == "Read":
            o["offset"], o["limit"] = inp.get("offset"), inp.get("limit")
    return {"tool": t, "input": {k: v for k, v in o.items() if v is not None}}


def bash_match(pattern, cmd):
    rx = re.escape(pattern).replace(r"\*", r"[\s\S]*")
    return bool(re.fullmatch(rx, cmd)) or (pattern.endswith(" *") and cmd == pattern[:-2])


def glob_match(pattern, path):
    rx, i = "", 0
    while i < len(pattern):
        ch = pattern[i]
        if pattern.startswith("**/", i):
            rx += "(?:.*/)?"; i += 3; continue
        if pattern.startswith("**", i):
            rx += ".*"; i += 2; continue
        rx += "[^/]*" if ch == "*" else "[^/]" if ch == "?" else re.escape(ch)
        i += 1
    return bool(re.fullmatch(rx, path))


def denied(cfg, root, c):
    for r in cfg["permissions"]["deny"]:
        # As in Claude Code, an Edit(...) rule covers every tool that edits files.
        if r["tool"] != c["tool"] and not (r["tool"] == "Edit" and c["tool"] == "Write"):
            continue
        if c["tool"] == "Bash":
            for part in re.split(r"&&|\|\||;|\||\n", c["input"].get("command") or ""):
                if part.strip() and bash_match(r["pattern"], part.strip()):
                    return "Denied by .claude/settings.json: Bash(%s)" % r["pattern"]
        else:
            fp = c["input"].get("file_path") or ""
            rel = os.path.relpath(fp, root) if os.path.isabs(fp) else fp
            if glob_match(r["pattern"], rel.replace("\\", "/")):
                return "Denied by .claude/settings.json: %s(%s)" % (r["tool"], r["pattern"])
    return None


def fire(cfg, root, event, payload, tool="", session="hermes"):
    block, context = None, []
    env = dict(os.environ, CLAUDE_PROJECT_DIR=root, CLAUDE_STUDIO_HOST="hermes")
    for g in cfg["hooks"].get(event, []):
        if g["matcher"] and tool and not re.fullmatch("(?:%s)" % g["matcher"], tool):
            continue
        for h in g["hooks"]:
            body = dict(session_id=session, transcript_path="", cwd=root, hook_event_name=event, **payload)
            try:
                p = subprocess.run(["bash", os.path.join(root, h["script"])], input=json.dumps(body),
                                   capture_output=True, text=True, cwd=root, env=env, timeout=h["timeout"])
            except (subprocess.TimeoutExpired, OSError):
                continue  # fails open, as in Claude Code
            if p.returncode == 2:
                block = block or p.stderr.strip() or "%s refused this" % h["script"]
                continue
            out = p.stdout.strip()
            if not out:
                continue
            try:
                j = json.loads(out)
            except ValueError:
                context.append(out); continue
            if not isinstance(j, dict):
                context.append(out); continue
            hso = j.get("hookSpecificOutput") or {}
            if hso.get("permissionDecision") == "deny" or j.get("decision") == "block":
                block = block or hso.get("permissionDecisionReason") or j.get("reason") or "%s refused this" % h["script"]
            if hso.get("additionalContext"):
                context.append(str(hso["additionalContext"]))
            elif j.get("systemMessage"):
                context.append(str(j["systemMessage"]))
    return block, context


def main():
    event = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    dbg = os.environ.get("CLAUDE_STUDIO_DEBUG")
    if dbg:
        try:
            with open(dbg, "a") as f:
                f.write(json.dumps({"host": "hermes", "kind": event, "e": data}) + "\n")
        except OSError:
            pass
    root = find_root(data.get("cwd"))
    if not root:
        return 0
    with open(os.path.join(root, "tools/ports/hooks.json")) as f:
        cfg = json.load(f)
    session = data.get("session_id") or "hermes"

    if event == "pre_tool_call":
        c = to_claude(data.get("tool_name"), data.get("tool_input"))
        if not c:
            return 0
        reason = denied(cfg, root, c)
        if not reason:
            reason, _ = fire(cfg, root, "PreToolUse", {"tool_name": c["tool"], "tool_input": c["input"]}, c["tool"], session)
        if reason:
            print(json.dumps({"decision": "block", "reason": reason}))
        return 0

    if event == "post_tool_call":
        c = to_claude(data.get("tool_name"), data.get("tool_input"))
        if c and c["tool"] in ("Write", "Edit"):
            block, ctx = fire(cfg, root, "PostToolUse", {"tool_name": c["tool"], "tool_input": c["input"], "tool_response": {}}, c["tool"], session)
            note = "\n".join(x for x in [block] + ctx if x)
            if note:
                sys.stderr.write("[studio check] %s\n" % note)
        return 0

    if event == "pre_llm_call":
        mark = os.path.join(tempfile.gettempdir(), "claude-studio-hermes-%s" % re.sub(r"[^\w.-]", "_", session))
        if os.path.exists(mark):
            return 0
        open(mark, "w").close()
        _, ctx = fire(cfg, root, "SessionStart", {"source": "startup"}, "", session)
        if ctx:
            print(json.dumps({"context": "<studio-session-start>\n%s\n</studio-session-start>" % "\n\n".join(ctx)}))
        return 0

    if event == "on_session_end":
        fire(cfg, root, "Stop", {"stop_hook_active": False}, "", session)
    return 0


if __name__ == "__main__":
    sys.exit(main())
