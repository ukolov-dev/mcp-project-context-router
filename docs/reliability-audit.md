# Portable reliability audit and regression plan

This document retains only general findings from a practical consumer audit. Consumer records, code excerpts, infrastructure addresses and local paths are deliberately excluded. Consumer measurements are not measurements of this repository; no time or token savings were measured.

| Finding | Standalone result and change | Consumer responsibility |
| --- | --- | --- |
| Undeclared `doc` fallback | Reproduced in pack, task and verification APIs; use configured defaults and explain unmatched signals | Configure existing modules, query aliases in team languages and suitable defaults |
| Missing source extensions and deployment coverage | Explicit narrow globs remain authoritative; doctor inventories omitted source/config candidates; default scaffolding includes mjs/mts/cts | Review coverage suggestions and add actual deployment/test paths and commands |
| Legacy module names | Explicit unique aliases resolve queries and stored record mappings; dry-run doctor suggests spelling candidates without rewriting | Review aliases and any record migration; ambiguity remains unresolved |
| Historical claims appear current | Superseded/cancelled/retired statuses hidden by default; history opt-in retains provenance; decisions and explicit confirmation improve ranking | Correct falsely active retired records through review; the router cannot infer semantic truth from prose |
| Healthy-looking diagnostics hide missing links | Active missing references warn normally and fail commit validation; lint reports WARN and grouped lifecycle categories | Fix active links or record intentional deletion in deleted_files; do not delete history to silence diagnostics |
| Passed checks imply complete work | Required plan checks cannot be downgraded or omitted; partial/blocked evidence and retry links are explicit; core APIs reuse execution snapshot and acceptance gates | Review legacy evidence and pending acceptance; do not bulk-close old tasks |
| Local knowledge is absent in new checkouts | Doctor reports untracked/ignored active Markdown without staging it | Commit reviewed durable records and publish through the team's normal workflow |
| Static client config treated as runtime proof | Diagnostics distinguish declared configuration from verified client availability | Restart/reconnect the actual client and inspect tools in its session |
| Refactor review includes unrelated edits | Explicit file/task/base scopes, visible fallback, no automatic draft side effects | Supply concrete task files; output is a heuristic, not semantic code review |

Regression fixtures live in `test/portable-reliability.test.ts`, with accepted/stale completion tests in `test/execution-acceptance.test.ts`. Existing portability, Windows, CLI/MCP, execution and pack-budget tests remain part of the full suite. Synthetic fixtures use unrelated module names and temporary repositories.

The implementation preserves history and intentional indexing exclusions. Doctor suggestions are read-only. Source coverage is a candidate inventory, not proof that all supported languages have semantic symbol extraction. Metadata records declared authority and dates; neither approval nor a recent timestamp proves current runtime behavior.
