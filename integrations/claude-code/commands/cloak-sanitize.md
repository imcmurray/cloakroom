---
description: Sanitize a file or text with Cloakroom before sharing it
argument-hint: [file path]
---

Strip PII/secrets from `$ARGUMENTS` using the Cloakroom CLI, so the result is safe
to share outside this machine.

Run:

```bash
cloak sanitize $ARGUMENTS --bridge .cloak/session.cloak --merge --audit
```

Then show me the sanitized output and the masked audit table. Do **not** print the
original secret values back to me — the whole point is that they stay local. If I
later paste an AI reply that references the decoys, restore it with:

```bash
cloak restore - --bridge .cloak/session.cloak
```
