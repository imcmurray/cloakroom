# Using Cloakroom inside Claude Code

Cloakroom keeps real secrets out of an LLM's context. Wiring it into Claude Code
sounds obvious — "add a sanitize tool" — but there's a catch worth stating up front,
because it determines which mechanism you actually need.

## The catch: a tool the model calls is always too late

Anything the agent *invokes* — an MCP tool, a Bash command — runs **after** the agent
already has the text. By the time Claude could call `cloak sanitize` on a file, it
has already read the file into the transcript that goes to the model. So a
model-invoked sanitizer can protect the *downstream* recipient of an artifact, but it
cannot protect data *from Claude itself*.

To actually stop secrets from entering the context, you have to intercept at the
**boundary** — before the tool result reaches the model. In Claude Code that means
**hooks**, not tools. Here's exactly what hooks can and can't do (verified against the
current hooks docs), because it's the whole ballgame:

| Hook | Can it rewrite? | Field | Use for Cloakroom |
|---|---|---|---|
| `PostToolUse` | **Yes — output** | `hookSpecificOutput.updatedToolOutput` | Sanitize `Read`/`Bash` output before the model sees it |
| `PreToolUse` | **Yes — input** | `hookSpecificOutput.updatedInput` | Restore real values before a `Write`/`Edit` hits disk; or `permissionDecision: "deny"` to block a read |
| `UserPromptSubmit` | **No** (block only) | — | Can't rewrite a pasted prompt; can only refuse it |

Because `UserPromptSubmit` can't rewrite, auto-sanitizing what you paste into the chat
box isn't possible — the best it could do is reject the message. Everything valuable
happens on the tool boundary.

## Three ways to use it, by what they protect

### 1. On request (works today, zero setup)

`cloak` is just a CLI, so Claude can run it when you ask: "sanitize `incident.log`
with cloak and summarize the failure." Claude works from decoys and the sanitized
artifact is safe to paste into a ticket or PR. Protection is for whatever leaves
*after* Claude — not from Claude, which already read the file. The bundled
[`/cloak-sanitize`](../integrations/claude-code/commands/cloak-sanitize.md) slash
command makes this a one-liner.

### 2. The guard (works today, robust — recommended first step)

A `PreToolUse` hook on `Read` runs `cloak scan` and **denies** the read when a file is
full of secrets, so radioactive files can't be pulled into context by accident:

```jsonc
// integrations/claude-code/settings.guard.json
{ "hooks": { "PreToolUse": [ { "matcher": "Read",
  "hooks": [ { "type": "command", "command": "cloak hook guard" } ] } ] } }
```

It reasons over nothing and can't corrupt anything — it either allows the read or
blocks it with an explanation. This is the high-value, low-risk piece, and it doubles
as a way to keep court PII / client data out of transcripts.

One honest limitation: the guard matches the `Read` tool, so a shell read (`cat
secrets.txt` via Bash) bypasses it. Covering shell output is exactly what the
transparent profile's `PostToolUse` sanitizer is for — the guard is a tripwire, not a
perimeter.

### 3. Transparent auto-cloak (the magic — buildable, with sharp edges)

`PostToolUse` sanitizes every `Read`/`Bash`/`Grep` result into decoys before the model
sees it; `PreToolUse` restores real values before a `Write`/`Edit` reaches disk. Claude
does its whole job over decoys and never sees a real secret, while files on disk stay
correct. Verified end-to-end: the model sees `203.0.113.183 / alex.chen@example.com`,
the file written to disk gets the real `10.9.9.9 / admin@bank.com`.

```jsonc
// integrations/claude-code/settings.transparent.json
{ "hooks": {
  "PostToolUse": [ { "matcher": "Read|Bash|Grep",
    "hooks": [ { "type": "command", "command": "cloak hook sanitize" } ] } ],
  "PreToolUse":  [ { "matcher": "Write|Edit",
    "hooks": [ { "type": "command", "command": "cloak hook restore" } ] } ] } }
```

Two things to know before turning this on:

- It needs a session mapping shared across all those reads and writes, so set
  `CLOAK_SESSION_BRIDGE` (a path) and `CLOAK_PASS` (a passphrase) in the shell that
  launches Claude Code. The `cloak hook sanitize` handler accumulates into that bridge
  with `--merge` semantics so a value seen in one read maps to the same decoy in the
  next, and `restore` reverses the whole session consistently.
- The model is now reasoning over decoys. That's perfect for logs, config dumps, and
  diagnostics, and risky for editing **source** files — if Claude rewrites a decoy, the
  restore can't re-anchor it (the engine's `reverseGaps` flags this, but the edit may
  still be wrong). Scope the matcher to diagnostic flows; don't point transparent mode
  at a refactor of secret-bearing source.

Don't run profiles 2 and 3 together: the guard would deny the very reads the sanitizer
wants to transform.

## The `cloak hook` adapter

All three hook behaviors live in one CLI subcommand so the hooks need no `jq`/bash
glue — the config just calls `cloak hook <mode>`. It reads the Claude Code hook event
as JSON on stdin and writes a hook response on stdout:

- `cloak hook guard` — PreToolUse. Scans `tool_input.file_path`; emits a `deny` if it
  holds secrets, otherwise nothing (allow). Fail-open on error (it's a safety net).
- `cloak hook sanitize` — PostToolUse. Sanitizes the tool output, accumulates the
  session bridge, emits `updatedToolOutput`. **Fail-closed**: if it can't sanitize —
  including when the session env vars are missing — it withholds the text rather than
  leak it. Image reads (no text fields) pass through untouched.
- `cloak hook restore` — PreToolUse. Restores decoys in `content` / `old_string` /
  `new_string` / `command` to real values, emits `updatedInput`. **Fail-closed**: if it
  can't restore — env missing, wrong passphrase — it *denies* the tool call rather than
  persist decoy data into a real file (or run a command against a decoy host).

Two contract details worth knowing (verified against the Claude Code binary, v2.1.198):
the PostToolUse payload field is **`tool_response`** (`tool_result` is accepted as a
fallback for other harnesses), and Claude Code **validates `updatedToolOutput` against
the tool's output schema** — so the adapter preserves the response's shape (Bash
`{stdout, stderr, …}`, Read `{file: {content, …}}`) and transforms only the
text-bearing fields, leaving paths and metadata untouched.

## Setup

```bash
npm run build:cli && npm link          # put `cloak` on PATH
mkdir -p .claude .cloak                 # .cloak/ holds the session bridge; git-ignore it

# Guard profile (recommended): copy the hooks block into .claude/settings.json
#   from integrations/claude-code/settings.guard.json

# Transparent profile: copy settings.transparent.json's hooks block, and export:
export CLOAK_SESSION_BRIDGE="$PWD/.cloak/session.cloak"
export CLOAK_PASS="…"
```

The session bridge is encrypted at rest but accumulates the run's real values — treat
it like a secret, keep `.cloak/` out of git, and delete it when the session is done.

## My recommendation

Start with the **guard** plus the **on-request** slash command: robust, immediately
useful, and enough for "don't let secrets leak into transcripts." Graduate to
**transparent** mode for log/diagnostic-heavy sessions once you're comfortable with the
decoy-reasoning trade-off.
