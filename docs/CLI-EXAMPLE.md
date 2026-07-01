# Cloakroom CLI — a real-world walkthrough

A worked example of the `cloak` command line on the kind of text people actually
paste into an LLM: a production incident log full of things that must never leave
the building. The scenario here is a court CM/ECF filing failure, but the shape is
the same for any ops log, support ticket, or stack trace.

Everything runs locally. The only artifact that ever contains your real data is an
AES-256-GCM encrypted **bridge file** (`.cloak`), and it never leaves the machine.

## Setup

```bash
npm run build:cli        # → dist-cli/cloak.mjs
npm link                 # optional: puts `cloak` on your PATH
export CLOAK_PASS='…'    # bridge passphrase for this shell (or omit to be prompted)
```

## The situation

A filing is being rejected and you want an LLM's help reading the failure. The log
is radioactive — it contains an attorney's email, internal gateway IPs, a sealed
case number and caption, a clerk override secret, and a filer's SSN that shouldn't
have been captured in the first place:

```
[2026-06-29 14:22:01] ECF auth-service ERROR: filing rejected in case 2:23-cv-00456-DBB
  attorney jane.roe@wasatchlaw.com (bar 12345) from 10.14.22.108
  upstream gateway 10.14.22.1 returned 502; retried from 10.14.22.108
  matter "Roe v. Millcreek City" doc #4111 sealed
  clerk override token=sk-live_9fKQ2mZ7bT4wR1nY8xL3cV6 by user "Ian McMurray"
  filer SSN on cover sheet 528-19-4432 (should have been redacted)
```

## Step 1 — sanitize on the way out

Names and the case caption aren't reliably auto-detected, so declare them with
`--custom`. Keep the HTTP status code readable with `--whitelist`. `--audit` prints
a masked summary to **stderr** so you can eyeball what was caught without the real
values ever hitting your screen.

```bash
cloak sanitize ecf-incident.log --bridge ecf.cloak \
  --custom "Ian McMurray,Roe v. Millcreek City" \
  --whitelist "502" --audit > ecf-san.txt
```

Audit (stderr) — every value masked, showing count and the decoy it became:

```
Detected 8 distinct value(s):
  API_KEY        1×  sk████████V6  → ko-icfn_4bYE5wK0tW4oU0fV0vN6qM7
  CASE_NUMBER    1×  2:████████BB  → 6:82-cv-42799-PWQ
  CUSTOM         1×  Ia████████ay  → Exa NwUnwntd
  CUSTOM         1×  Ro████████ty  → Kny c. Ldbaqlwty Pxzt
  EMAIL          1×  ja████████om  → casey.nguyen@example.net
  IPV4           2×  10████████08  → 203.0.113.76
  IPV4           1×  10██████.1  → 203.0.113.233
  SSN            1×  52███████32  → 971-87-7317
```

Sanitized text (stdout, `ecf-san.txt`) — this is what you paste into the LLM:

```
[2026-06-29 14:22:01] ECF auth-service ERROR: filing rejected in case 6:82-cv-42799-PWQ
  attorney casey.nguyen@example.net (bar 12345) from 203.0.113.76
  upstream gateway 203.0.113.233 returned 502; retried from 203.0.113.76
  matter "Kny c. Ldbaqlwty Pxzt" doc #4111 sealed
  clerk override token=ko-icfn_4bYE5wK0tW4oU0fV0vN6qM7 by user "Exa NwUnwntd"
  filer SSN on cover sheet 971-87-7317 (should have been redacted)
```

Two things worth noticing. The decoys come from **reserved/test ranges** — the IPs
are RFC 5737 (`203.0.113.0/24`), the email is `example.net`, the case number keeps
its `office:yy-cv-number-judge` shape — so they read as real to the model but are
provably not real-world values. And the relationship is preserved: the gateway
`10.14.22.108` appears twice and maps to the **same** decoy both times, while the
other IP (`10.14.22.1`) gets a distinct one, so the model can still reason that "the
filer retried from one host through a different gateway."

## Step 2 — hand the decoys to the LLM

Paste `ecf-san.txt` into Claude/ChatGPT/whatever and ask your question. The model
reasons over the decoys and answers in terms of them, e.g.:

```
Root cause: gateway 203.0.113.233 returned 502, so auth-service could not validate
the filer at 203.0.113.76. Rotate the clerk override token ko-icfn_4bYE5wK0tW4oU0fV0vN6qM7
and re-run the filing for case 6:82-cv-42799-PWQ.
```

## Step 3 — restore on the way back

Feed the model's reply back through the same bridge and the real values snap back in:

```bash
cloak restore llm-reply.txt --bridge ecf.cloak
```

```
Root cause: gateway 10.14.22.1 returned 502, so auth-service could not validate
the filer at 10.14.22.108. Rotate the clerk override token sk-live_9fKQ2mZ7bT4wR1nY8xL3cV6
and re-run the filing for case 2:23-cv-00456-DBB.

⚠ 4 value(s) never reappeared in the input and could not be restored (the model may
have paraphrased or dropped them): SSN, CUSTOM, CUSTOM, EMAIL
```

The advice comes back fully de-decoyed and actionable. The warning is Cloakroom
being honest, not failing: the model's reply simply never mentioned the SSN, the two
names, or the email, so there was nothing to restore for those. If a value you
*expected* to see is listed there, it means the model dropped or reworded it.

## The clipboard one-liner

Once you trust it, the whole round trip is two piped commands:

```bash
cat ecf-incident.log | cloak sanitize --bridge ecf.cloak | pbcopy   # paste to LLM
pbpaste                | cloak restore  --bridge ecf.cloak           # real data back
```

(`pbcopy`/`pbpaste` on macOS; use `xclip -sel clip` / `xclip -o` or `wl-copy`/`wl-paste`
on Linux.)

## Bonus — `scan` as a pre-commit / CI guardrail

`cloak scan` detects without ever writing a mapping, and **exits 3** if it finds
anything. That makes it a drop-in secret-leak gate:

```bash
cloak scan ecf-incident.log; echo $?   # → 3 (secrets present)
```

As a git pre-commit hook that blocks a commit carrying live PII/secrets:

```bash
# .git/hooks/pre-commit
for f in $(git diff --cached --name-only --diff-filter=ACM); do
  cloak scan "$f" >/dev/null 2>&1 || {
    echo "cloak: '$f' contains PII/secrets — commit blocked. Run 'cloak scan $f' to see what."
    exit 1
  }
done
```

## Handling the bridge

The bridge is the secret — treat it like a private key. It's encrypted at rest, but:

- `.cloak` files are already in `.gitignore`; keep them there.
- The passphrase is read from `$CLOAK_PASS` or a hidden prompt — never a CLI flag,
  so it stays out of your shell history and the process table.
- `cloak inspect --bridge ecf.cloak` shows the masked audit again without exposing
  originals, so you can confirm a bridge's contents before restoring.
- Delete the bridge when the round trip is done (`rm ecf.cloak`) and the mapping is
  gone for good.
