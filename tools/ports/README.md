# Running the studio on OpenCode, Hermes Agent and oh-my-pi

The studio is written for Claude Code. This folder makes the same skills,
agents, rules and hooks work on three other agent hosts:

| Host | Tested with | Works after cloning? |
|---|---|---|
| [OpenCode](https://opencode.ai) | 2.3.2 | Yes |
| [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) | 19.1.1 | Yes |
| [Hermes Agent](https://hermes-agent.nousresearch.com) | 0.23.3 | After two setup steps (below) |

`.claude/` stays the only source. Everything host-specific is generated from
it by `port.mjs` and marked "GENERATED". Edit the source, never the copy.

## What goes where

| Studio piece (source) | OpenCode | omp | Hermes |
|---|---|---|---|
| `CLAUDE.md` + its `@` imports | `AGENTS.md` (generated, imports inlined) | `AGENTS.md` | `AGENTS.md` |
| 78 skills, `.claude/skills/` | read in place | read in place, `/skill:<name>` | `.hermes/skills` → symlink |
| `/name` for a skill | `.opencode/commands/<name>.md` | `/skill:<name>` (built in) | `/<name>` (built in) |
| 49 agents, `.claude/agents/` | `.opencode/agents/<name>.md` | `.omp/agents/<name>.md` | none: a `delegate_task` recipe in `AGENTS.md` |
| 14 path rules, `.claude/rules/` | an index in `AGENTS.md` | `.omp/rules/<name>.md` (glob-scoped) | an index in `AGENTS.md` |
| Hooks, `.claude/hooks/*.sh` | `.opencode/plugins/claude-studio.ts` | `.omp/extensions/claude-studio.ts` | `hermes-hook.py`, via `~/.hermes/config.yaml` |
| Permission rules, `settings.json` | `opencode.json` | `.omp/config.yml` + the extension | enforced by `hermes-hook.py` |

The hook scripts are not rewritten. Each adapter turns the host's tool call
into the JSON payload Claude Code would send, runs the unchanged script, and
turns its answer (exit 2, `permissionDecision`, `additionalContext`) back into
the host's own form. `claude-hooks.ts` holds that translation for OpenCode and
omp; `hermes-hook.py` is the same logic in Python. `hooks.json` lists which
script runs on which event; it is generated from `.claude/settings.json`.

## Setup

**OpenCode and omp:** nothing. Start them in the repo root.

**Hermes:** Hermes loads hooks only from your user config, never from a
project, and skills only from trusted projects.

```bash
hermes skills trust                       # in the repo root: load .hermes/skills
node tools/ports/port.mjs hermes-snippet  # paste its output into ~/.hermes/config.yaml
```

Hermes asks you to approve each hook the first time it runs. The hook script
does nothing outside a studio project, so it is safe to leave installed.

## After changing the studio

```bash
node tools/ports/port.mjs           # regenerate
node tools/ports/port.mjs --check   # exit 1 if anything generated is stale
node tools/ports/test.mts           # adapters against fake hosts (Node 22.6+, python3)
```

Re-run the generator after changing an agent, a rule, a skill's frontmatter,
`CLAUDE.md`, or `.claude/settings.json`.

## What does not carry over

Claude Code has features these hosts lack. They are dropped or approximated:

**On every host**

- **Model pins.** The `model:` set on 77 skills is ignored, so skills run on
  the session's model. The 49 agents' `opus`/`sonnet` pins are also dropped,
  except that omp maps `opus` to its `@slow` role.
- **`allowed-tools`.** A skill can no longer pre-approve its own tools, so you
  will see more permission prompts. The studio scripts' allow rules carry over,
  which removes most of them.
- **`!` preprocessing.** Claude Code runs a skill's first-line
  `` !`resolve_config …` `` command before the model reads the skill. Elsewhere,
  `AGENTS.md` tells the model to run it, which depends on the model doing so.
  The exception is OpenCode's `/name` commands, which do run it.
- **Claude tool names in prompts.** Skills still say `AskUserQuestion`,
  `Agent`, `Skill` and so on. A glossary in `AGENTS.md` (and in each agent's
  prompt) translates them, which also depends on the model.
- **Subagent hooks.** `SubagentStart`/`SubagentStop` logging and
  `validate-agent-artifact.sh` need Claude's transcript files, so they are not
  ported.
- **Desktop notifications** (`notify.sh`), the **status line**
  (`statusline.sh`) and **`isolation: worktree`** (one agent) are not ported.
- **Agent memory and preloaded skills.** On OpenCode and omp these become
  instructions in the agent's prompt rather than automatic injection. omp's
  `autoloadSkills` does preload the skills natively.

**OpenCode**

- Hook feedback after a write (asset and skill checks) is appended to the
  tool's output. That path is tested against a fake host only, not live.
- The `patch` tool (GPT models' multi-file edit) and `Stop` (session log) are
  not checked.

**omp**

- `edit` is a hash-anchored patch script whose result is unknown until it
  runs. Before an edit, each file it names is checked as a write of its
  current content: path rules (deny globs, protected files, prototype
  boundary, string freeze) fire, but content rules see the old text. The
  normal checks run after the edit.
- Approval mode is set to `write`, the closest match to Claude Code's default
  of asking before edits and unlisted commands. The project's `rm -rf`,
  force-push and similar denies apply.

**Hermes** (the largest gap)

- **No named agents.** The 49 agents become a `delegate_task` recipe, and a
  child agent inherits the parent's tools, so per-agent tool limits are gone.
- Hooks and trust are per user, not per repo. A fresh clone is unguarded until
  the two setup steps above are done.
- Hook feedback after a write goes to Hermes's log, not to the model. There is
  no pre-compact hook.
- `disable-model-invocation` (8 skills) is ignored, so the model may start
  those skills on its own.
