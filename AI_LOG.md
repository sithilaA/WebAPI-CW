# AI disclosure log (appendix source)

The coursework requires AI-generated code to be declared, with prompts and AI-aid references recorded
in the report appendix. Keep this file up to date as you work; copy it into the appendix.

**Tool used:** Claude Code (Claude Sonnet 5.5), in the Claude desktop app.

## Prompts

| # | Date | Prompt (summary or verbatim) | Outcome | What I reviewed / changed |
|---|---|---|---|---|
| 1 | 2026-10-06 | Pasted the coursework brief and asked for a plan to do it | Staged plan: stack, schema, endpoints, security, report outline | |
| 2 | 2026-10-06 | Asked to plan the endpoints in two sections (device writes, user reads) and how each authenticates | Device API key vs user JWT; authorization matrix | |
| 3 | 2026-10-06 | Asked whether Redis could buffer device data instead of writing directly to the DB | Recommended direct DB insert (201 + Location requirement); Redis as future work | |
| 4 | 2026-10-06 | Asked what issues arise with 10,000 devices reporting every minute | Capacity analysis: partitioning, pooling, jitter, rate limiting | |
| 5 | 2026-10-06 | Asked to implement the plan | Generated the API, schema, seed script, OpenAPI spec and 27 tests | |

## Things to be able to explain at the viva

Add your own notes here as you study each file. You own everything you submit.

- Why `generation_reading` is its own table and not `last_power` on the installation.
- Why the device key is hashed with SHA-256 (random 256-bit key, indexed lookup) while user passwords use bcrypt.
- How `requireDevice` ties a key to exactly one installation, and why a national user still gets 403 on ingest.
- How scope is applied: SQL condition for lists vs load-then-check (404 then 403) for single resources.
- Why `201` + `Location` (direct DB insert) rather than `202` + a queue.
- How ETag / `If-None-Match` produce `304` with an empty body; why collections have no `Last-Modified`.
- Why readings return `405` for PUT / PATCH / DELETE (append-only).
- Why DELETE of a hierarchy node returns `409` while children exist, but deleting an installation cascades to its readings.

## AI-aid references

- Claude Code / Claude Sonnet 5.5 (Anthropic): code generation, test generation, OpenAPI drafting.
- Report prose must be written by you; do not paste AI-generated text into the report.
