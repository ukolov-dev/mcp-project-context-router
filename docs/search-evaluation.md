# Search relevance evaluation

Run from a development checkout with dependencies installed:

```sh
npm run search:eval -- --output artifacts/search-eval-report.json
```

The default is seven warm measurements per query and engine. Use `--samples 25`
to collect more observations. Without `--output`, the script prints the complete
JSON report. With it, stdout contains the summary and the file contains the full
report. `artifacts/` is ignored by Git; reports and temporary databases are not
published in the npm package. The harness and fixture are development tools and
are also excluded from the package. The TypeScript evaluator is intentionally
outside the checkout's runtime `source_globs`; `doctor` lists it for coverage
review rather than treating it as production source.

## Corpus and fixed judgments

`test/fixtures/search-eval.json` version 2 contains 40 synthetic Markdown records
and 60 authored queries: 51 with relevant results and nine with no answer in
scope. The original 32 records and 40 query judgments are unchanged; eight hard
negative records and 20 queries were appended before running the candidates.
Every query lists relevant record IDs, expected file references and the reason
for that judgment. Labels were authored before the candidate engines were run.
No consumer records, credentials or workstation paths are used.

| Category | Queries | Purpose |
| --- | ---: | --- |
| exact | 8 | Titles, tags, error and configuration terms |
| natural-language | 8 | Questions rather than copied titles |
| language-and-tokens | 8 | Russian, inflections, partial camelCase identifiers and punctuation |
| relations | 6 | Supporting evidence through explicit outgoing/incoming links |
| scope-and-negatives | 10 | Module aliases, global records, archive opt-in, drafts and no-answer queries |
| hard-long | 5 | Long conversational questions, current policies and several supporting facts |
| hard-language | 5 | Russian paraphrases, inflections, mixed-language errors and partial identifiers |
| hard-ambiguity | 5 | Retired policies, term-frequency noise and unrelated records with matching terms |
| hard-negatives | 5 | Absent topics that still share ordinary words with existing records |

Related-record judgments intentionally include useful supporting materials that
do not repeat the query's words. They are not labels derived from graph results.
Distractors cover SQL syntax, browser caches, zip archives and similarly named
topics in other modules. This is a starting diagnostic corpus, not a held-out
production benchmark or a complete set of all possibly relevant documents.

The validator rejects missing IDs, duplicate labels, unsafe reference paths,
unknown relationships and relevant labels outside the query's module/archive
scope. Expected files must be referenced by a labeled relevant record.

## Compared variants

- **current:** calls the existing `searchIndex` directly, with a limit of five.
- **fts5:** an experimental FTS5 table in the same temporary SQLite database;
  `unicode61`, weighted BM25 (title 10, body 2, tags 6), and deterministic path
  tie-breaking. Natural-language tokens are quoted and OR-joined. Token
  boundaries differ from current substring matching. Neither variant has a new
  stopword list, stemmer, synonym expansion or embeddings. Operator-looking
  query text remains literal, matching current search's free-text API.
- **current+relations / fts5+relations:** expand the five lexical hits by one
  hop using explicit `related` IDs and `source_task`, in either direction.
  Take at most five unique neighbors, ordered by seed position and then ID;
  fuse lexical and graph rankings with equal-weight RRF, `k = 60`, returning
  five records. This is a prototype for comparison, not runtime graph search.
- **hybrid:** fuse the top five FTS5 hits and top five current-search hits with
  equal-weight RRF, `k = 60`. Ties prefer the FTS5 position, then record ID.
  Return five direct hits; no query-specific switches or fitted weights.
- **hybrid+support:** preserve the hybrid's five direct hits exactly and return
  up to five additional unique neighbors separately in `supportingIds`. In this
  variant, the one-hop graph also recognizes existing `target_id` and
  `retries_evidence_id` fields, in either direction. Seed rank then ID determine
  neighbor order. A retry link is supporting history, not an authority decision;
  an older partial verification may still appear among the neighbors.
- **fts5+identifiers:** preserve the entire FTS5 top-five prefix and append
  up to five unique proper identifier substring matches. Filter eligible matches
  in a disposable identifier projection, rank/deduplicate before Markdown reads,
  fill vacant direct slots, then expose overflow
  in `identifierIds`. The append-policy follow-up below supersedes the historical
  single reserved-slot experiment.
- **fts5+identifiers+support:** same direct and identifier blocks, plus the
  existing bounded evidence block; no graph re-ranking. Exclude identifier
  duplicates from the five graph neighbors without backfilling that block.

All variants use the current index's record selection, including module aliases,
global records, duplicate precedence and archive selection. Ordinary search
includes drafts and history; the evaluator deliberately preserves that behavior.
Graph traversal cannot cross the eligible record set. No relevance labels are
passed to retrieval functions. An empty lexical result has no graph seeds.

For synthetic input the script materializes records and reference files under a temporary repository,
builds the current index and an experimental full-text table, then removes that
repository in `finally`. It never changes the checkout's production search,
index schema, CLI/MCP interface or context-pack ranking. Missing FTS5 support
fails visibly rather than silently evaluating a substitute engine.

## Metrics and timing boundaries

The report contains aggregate and category metrics, plus IDs, scores and timing
samples for every query/engine. Relevance metrics are macro-averages over the
positive queries in each supplied dataset; no-answer queries are evaluated separately:

- `hitAt5`: any labeled relevant record appears in the first five.
- `recallAt5`: fraction of the query's relevant records retrieved.
- `precisionAt5`: labeled relevant hits divided by five, even when fewer hits
  are returned; unjudged records count as irrelevant in this initial corpus.
- `mrrAt5`: reciprocal position of the first relevant record, or zero.
- `fileReferenceRecallAt5`: expected paths covered by the five returned
  records' `files`. This is reference coverage, **not symbol/file-search recall**.
- `negativeAccuracy`: fraction of negative queries returning no records.
- `evidenceRecallAt10`: recall across the first ten unique records in direct,
  identifier-overflow, supporting order. Without expansion it equals `recallAt5`.
  It must not be compared to top-five recall as an equal-budget improvement.
- `expandedRecall`: recall across the entire expanded stream, up to fifteen
  for `fts5+identifiers+support`, ten for other expanding candidates. Per-query
  `expandedLimit` records the cap; this metric does not imply equal context cost.
- `expandedTextTokensMean`: direct, identifier-overflow and supporting title/body size.
- `lexicalPoolRecallAt10` and `lexicalPoolTextTokensMean`: hybrid's complete
  union of both top-five lexical streams, up to ten unique records. This is a
  slot-budget control without graph expansion, **not** a fresh top-ten search
  from each engine or an equal token-budget comparison. For the identifier
  candidates these fields instead report a fresh FTS5 top-ten control without
  fallback or links. They are null for the four original engines. Per-query `lexicalPoolIds` makes the control inspectable.
- `returnedTextTokensMean`: mean direct returned title/body size, estimated as
  characters / 4 and rounded up per query, over all queries. It is not a
  model tokenizer count, excerpt budget or context-pack size.

Index construction, fixture I/O, frozen query eligibility and initial warm-up
are excluded from latency. Timed calls include each engine's SQLite read and
selected Markdown parsing; relation variants also construct and traverse their
eligible graph. Query and engine ordering rotate between rounds, and each
round must reproduce the warm-up's IDs exactly. Budget packing runs outside
retrieval timings.

The FTS prototype uses a frozen eligible-ID list in SQL for this small corpus.
Production-scale evaluation needs proper scope joins instead. BM25 statistics
cover the whole fixture, even though result eligibility is scoped. Reported
latency is local, warm and excludes CLI/MCP startup and network transport.

Provenance includes dataset SHA256, the digest and explicit list of measured
source files, Git HEAD, Node/SQLite versions, platform, architecture and CPU.
The source digest includes current working-tree contents; HEAD alone does not
identify uncommitted code. No absolute checkout or temporary paths are emitted.

## Initial version 1 comparison, 2026-10-12

This historical comparison used the original 32 records and 40 queries. In this
workspace that frozen input is retained as `artifacts/search-eval-v1.json` and
can be replayed with `--fixture artifacts/search-eval-v1.json`. The version 2
numbers below use extra distractors, so the old 40-query portion also becomes
harder even though its judgments have not changed.

Two independent seven-sample confirmation runs produced identical result IDs
and relevance metrics. Node 22.23.2, SQLite 3.51.3, macOS arm64. Earlier runs had
more timing variation; the table shows the confirmation runs' p50 range rather
than a speed guarantee.

| Variant | Hit@5 | Recall@5 | MRR@5 | File-reference recall | p50, ms | Text tokens, mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| current | 100% | 87.50% | 1.000 | 88.89% | 0.55–0.58 | 115.2 |
| fts5 | 94.44% | 84.72% | 0.944 | 86.11% | 0.40–0.41 | 101.5 |
| current+relations | 100% | 99.07% | 0.972 | 99.07% | 0.58–0.59 | 142.5 |
| fts5+relations | 94.44% | 93.52% | 0.926 | 93.52% | 0.41–0.42 | 129.5 |

All four negative queries returned no records for all variants.

Concrete findings:

- `Q21 ModuleName` and `Q22 buildContext` match substrings inside identifiers
  with current search and return nothing with token-only FTS5. A complete
  replacement would need an identifier/substrings path.
- On the eight natural-language questions, FTS5 raises recall from 89.58% to
  95.83%. Its overall loss therefore does not mean it is worse on every slice.
- On the six explicit-support queries, one-hop relations raise recall from
  47.22% to 100% with either lexical engine.
- Current+relations demotes the first relevant result on `Q15` (concurrent
  readers) and `Q24` (busy/readonly) from position one to two. More context is
  not automatically better ordering.
- `Q09` still misses the rebuild runbook with current+relations: the five
  result slots are occupied by other lexical/linked records.

Keep current runtime search for now. This corpus justifies investigating bounded
supporting-record expansion, with controls against direct-hit demotion. It does
not yet justify choosing a production ranking rule: exact-hit performance is
already saturated on this small corpus. Add harder independently judged queries
and more distractors before tuning or selecting a default. Freeze a new dataset
version when labels or documents change; do not remove failed cases to improve
the aggregate score.

Regression coverage is in `test/search-eval.test.ts`: metric calculations,
fixture integrity, graph direction and one-hop/scope boundaries, cleanup on
failure, and actual SQLite/Markdown retrieval through every compared variant.

## Hard queries and real project memory, 2026-10-12

The same four engines were run without changing tokenization, BM25 weights,
supported relation fields, RRF weights, candidate counts or runtime search.
Both the expanded synthetic corpus and the real-memory snapshot were replayed
twice, with identical result IDs and relevance metrics. All judgments stayed
fixed after the first candidate run.

### Expanded synthetic corpus

| Variant | Hit@5 | Recall@5 | MRR@5 | No-answer accuracy |
| --- | ---: | ---: | ---: | ---: |
| current | 98.04% | 83.01% | 0.828 | 55.56% |
| fts5 | 94.12% | 81.70% | 0.853 | 66.67% |
| current+relations | 98.04% | 93.30% | 0.871 | 55.56% |
| fts5+relations | 94.12% | 90.20% | 0.846 | 66.67% |

On the 15 newly added positive queries alone, recall is 72.22%, 74.44%, 82.78%
and 82.22%, respectively. On the five added no-answer queries, current search
returns nothing correctly once and FTS5 twice; graph expansion does not change
those counts. None of the variants is a reliable answerability detector.

`Q21 ModuleName` still misses the actual identifier-handling record with FTS5;
it now retrieves a matching glossary distractor. `Q22 buildContext` still has
no token match. `Q48`, a Russian paraphrase over an English-only boundary
record, misses entirely for all four engines. Retired decisions remain ordinary
search candidates and can outrank the maintained policy; this experiment does
not add context-pack authority/history rules to plain record search.

### Frozen real-memory snapshot

The snapshot was captured before creating this evaluation task. It includes
50 real records: four backlog items, 13 tasks, 18 verification records, four
refactor drafts and 11 run summaries. It excludes the three records belonging
to the previous synthetic evaluation so its own results cannot become answers.
There are no decision/pattern records, global records or archived records in
this snapshot. It contains reviewed history and unreviewed drafts, not live
implementation proof.

Thirty additional queries were authored by reading the exact record sources:
24 positive and six negative. Eight ask for policies/contracts, nine for
specific verification or release evidence, four use Russian paraphrases,
three target supporting relationships and six have no relevant record in scope.
Evidence-specific labels distinguish a verified result from an intention or an
older partial report. These are initial agent-authored judgments, not an
independent human relevance assessment.

The local snapshot stores original Markdown bytes, their repository-relative
paths, frozen module names/aliases, explicit exclusions and the fixed judgments.
It is evaluated in a temporary repository. Reference targets and source code
are not copied: this measures record retrieval, not capability search, file
health, code excerpts or context-pack generation. The original project database
is never opened by snapshot replay. Dataset SHA256 covers the entire snapshot,
including original Markdown, aliases and labels. Runtime implementation changes
are identified separately by the measured-source digest.

Replay the local inputs:

```sh
npm run search:eval -- --fixture artifacts/project-search-snapshot.json --output artifacts/project-search-report.json
npm run search:eval -- --fixture artifacts/project-search-snapshot.json --output artifacts/project-search-confirmation.json
```

`artifacts/project-search-queries.json` contains the separately authored real
judgments. These files, the frozen corpus and full reports stay local and ignored;
they are not fixtures to commit or publish. A future snapshot needs refreshed
judgments and exclusions before the engines are run. Synthetic regression tests
exercise replay using generic records, not copies of this project's memory.

| Variant | Hit@5 | Recall@5 | MRR@5 | No-answer accuracy | Text tokens, mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| current | 70.83% | 61.11% | 0.625 | 50% | 1865.9 |
| fts5 | 83.33% | 77.78% | 0.764 | 50% | 1523.6 |
| current+relations | 70.83% | 61.81% | 0.590 | 50% | 1716.0 |
| fts5+relations | 87.50% | 80.56% | 0.733 | 50% | 1543.0 |

Concrete real-record findings:

- `R02` (uncached fallback) retrieves all three labeled records with FTS5
  versus one with current search, or two with current+relations.
- `R05` (the Windows 0-of-8 → 8-of-8 regression) finds the exact verification
  at position three with FTS5; current search misses it in the first five.
- `R03` (279 → 140 and 21 → 43 measurements) ranks the exact verification
  second with current search and first with FTS5. FTS5+relations demotes it to
  third by promoting unrelated task/summary pairs.
- `R21` (research contract plus summary) has recall 50% with either lexical
  engine, 0% with current+relations and 100% with FTS5+relations. Graph benefits
  depend on which lexical seeds enter the expansion, and may evict direct hits.
- `R12` (MCP transport versus client-chat attachment) misses the exact evidence
  with all variants. `R13` (final v0.7.0 proof rather than the partial candidate)
  misses with both lexical engines; FTS5+relations rescues one of two expected
  records. The remaining ranking problem is visible, not averaged away.
- Both fully Russian questions `R04` and `R24` miss with every engine. Mixed
  questions containing specific English terms fare better. FTS5 does not supply
  translation or semantic recall on its own.
- `R25`/`R26`/`R27`, about absent vector search, MySQL and Kubernetes topics,
  return unrelated records with every engine. Kafka, the unrelated vocabulary
  control and the unknown-module control return nothing.
- File-reference recall is 95% for current search while record recall is only
  61.11%: many unrelated records share paths such as package and runtime files.
  File-reference coverage cannot stand in for retrieval of the correct evidence.

The graph has 15 supported `source_task` edges, from summaries/refactor drafts.
The 18 verification records use `target_id`; there is also a retry-evidence
pointer. Neither field is traversed by the unchanged prototype. Its weak
real-corpus gain is evidence about that prototype, not proof that all explicit
relationships are unhelpful. No inferred relationships were added to the corpus.

FTS5 is a stronger candidate on this project's long task/evidence records than
the initial synthetic comparison suggested. Direct replacement is still not
justified: it loses identifier substrings, does not solve bilingual recall or
absent-topic noise, and naive graph fusion sometimes hurts first-result quality.
Keep runtime search unchanged. The hybrid follow-up below tests lexical fusion and supporting evidence against
these frozen queries without changing runtime search.

This is still only 50 local-memory records and hand-authored relevance labels.
Warm timings exclude index construction, source discovery and MCP transport;
they do not establish concurrent or large-corpus performance. The numeric
relevance findings concern the frozen record-search scope, not current runtime
truth or production quality across consumer projects.


## Hybrid follow-up on the unchanged datasets

Two additional candidates were run twice, seven serial warm rounds each, on
exactly the previous 60 synthetic and 30 real-memory queries. Neither corpus,
query text, relevance label nor original engine was tuned. The source digest
changed because the evaluator gained candidates; dataset digests are unchanged.
All four legacy engines reproduced every result ID and relevance metric from
the previous reports. Both new candidates also reproduced all direct,
supporting and lexical-pool IDs and non-timing metrics between runs.

```sh
npm run search:eval -- --output artifacts/search-eval-hybrid-report.json
npm run search:eval -- --fixture artifacts/project-search-snapshot.json \
  --output artifacts/project-search-hybrid-report.json
```

The corresponding `*-hybrid-confirmation.json` files contain independent repeat
runs. Real record snapshots and full reports remain local ignored artifacts.

| Corpus / engine | Direct Recall@5 | Direct MRR@5 | Recall with support, up to 10 | Estimated direct → expanded tokens |
| --- | ---: | ---: | ---: | ---: |
| Synthetic current | 83.01% | 0.828 | 83.01% | 165 → 165 |
| Synthetic FTS5 | 81.70% | 0.853 | 81.70% | 146 → 146 |
| Synthetic hybrid | 87.25% | 0.892 | 87.25% | 163 → 163 |
| Synthetic hybrid+support | 87.25% | 0.892 | 97.06% | 163 → 219 |
| Real current | 61.11% | 0.625 | 61.11% | 1866 → 1866 |
| Real FTS5 | 77.78% | 0.764 | 77.78% | 1524 → 1524 |
| Real hybrid | 75.00% | 0.733 | 75.00% | 1696 → 1696 |
| Real hybrid+support | 75.00% | 0.733 | 87.50% | 1696 → 2970 |

The lexical-pool control gives 87.25% synthetic and 79.86% real recall using
up to ten slots without links. Graph support reaches 97.06% and 87.50%,
respectively, so additional slots alone do not explain the entire recall gain.
The control is limited to the original top-five candidate pools. Its estimated
real-context cost is 2497 tokens versus 2970 with graph support, about 19% more
for the latter; this is not equal token cost. This does not prove a graph beats every larger lexical search.

Specific findings:

- `Q21` / `Q22` recover `ModuleName` / `buildContext` partial identifiers in the
  hybrid top five, preserving the current engine's advantage over FTS5.
  Synthetic recall has no per-query losses versus FTS5; `Q41` and `Q47` also
  gain relevant records. Negative accuracy drops from FTS5's 6/9 to 5/9.
- On real records, hybrid loses one labeled record each in `R02` (uncached
  index fallback) and `R18` (v0.5.0 publication evidence) compared with FTS5.
  It has no real-query recall gain over FTS5. `R05`, `R14`, `R19` also demote
  the first relevant record. Equal-weight fusion therefore fails the goal of
  retaining FTS5 quality while restoring substring recall.
- Additive evidence rescues both final publication records in `R13`, and the
  missing release summary in `R19`; the top-ten lexical pool misses those.
  Supporting records also restore `R02`, `R18` and `R21`, but those gains can
  also come from the larger lexical pool. Direct order is identical to hybrid
  for every query, so graph expansion introduces no additional demotion.
- Real policy recall rises from 91.67% to 100%, evidence from 68.52% to 88.89%,
  and relationship questions from 83.33% to 100% when support is included.
  Russian questions remain at 50% recall; fully Russian `R04` and `R24` and
  the attachment-evidence query `R12` still miss. Negative accuracy remains
  3/6. More neighbors cannot fix weak lexical seeds or absent-topic noise.
- Real expanded context is about 75% larger than direct hybrid context and
  95% larger than FTS5's direct context. Both lexical engines run for hybrid;
  on this tiny warm corpus its median latency is roughly three times FTS5's.
  Timings are diagnostics, not production performance estimates.

Recommendation: keep production search unchanged and reject automatic
**equal-weight fusion** as the default. The stronger next candidate is FTS5
ranking with a narrowly specified substring fallback for identifiers, tested
against these same regressions. Explicit evidence links are useful as a
separate, bounded supporting section; their ordering needs an authority policy
before treating retry history as current proof. We did not implement that next
candidate, tune a threshold, translate queries, or change any labels.

This remains a diagnostic local experiment with agent-authored judgments.
Independent relevance review, other consumer corpora, token-bounded context
packs and production-scale indexing/concurrency are not established here.


## FTS5 with identifier fallback and separate evidence

This follow-up adds `fts5+identifiers` and `fts5+identifiers+support` without
changing production code or any of the frozen 60 synthetic / 30 real queries.
All six previous engines reproduce their earlier IDs and non-timing metrics.
Both datasets were evaluated twice with seven serial warm samples per engine;
corpus digests and all original Markdown bytes remain unchanged.

The rule was fixed before the candidate runs:

1. Recognize query words containing a lowercase-to-uppercase transition
   (`ModuleName`, `buildContext`) or an internal underscore (`load_record`).
   This is an orthographic heuristic, not a code parser; names such as
   `GitHub` and `MySQL` also qualify for inspection.
2. For each distinct marked token in query order, run existing substring search
   with the same module/archive scope, taking up to five candidates. Retain
   only records with that token as a **proper substring** of a longer word
   that itself has identifier-style casing or underscores, in title/body/tags.
   Ordinary lowercase prose and exact glossary matches cannot provide fallback.
3. If a qualifying candidate is absent from FTS5's direct five hits, use the
   first candidate in token order/current-search order. Retain the first four
   FTS5 hits and append this candidate. If fewer than five FTS5 hits exist,
   append after them; if there is no new candidate, keep FTS5 unchanged.
   Only one slot is reserved. This may evict the fifth FTS5 hit on other data.
4. The evidence variant reuses the existing one-hop graph, including
   `related`, `source_task`, `target_id`, `retries_evidence_id`; it appends up
   to five distinct supporting records separately, without altering direct
   hits or traversing outside eligible modules/archive scope.

The JSON includes recognized `identifierTerms`, inserted `fallbackIds`, and
aggregate `fallbackQueries`. These are explanations of retrieval, not inputs
from relevance labels. Small code helpers and scoped SQLite/Markdown tests
cover the reserved slot, prose queries, longer versus exact/lowercase words,
camel/snake fragments, module aliases, unknown modules and archive opt-in.
No lowercase-fragment inference, acronym splitting, synonym list, authority
policy or new production option was added. Candidate-pool depth can miss a
proper identifier below the first five substring matches; widen and retest
that limit before evaluating larger corpora.

```sh
npm run search:eval -- --output artifacts/search-eval-identifiers-report.json
npm run search:eval -- --fixture artifacts/project-search-snapshot.json \
  --output artifacts/project-search-identifiers-report.json
```

The `*-identifiers-confirmation.json` reports contain repeat runs. All full
reports and the actual-memory snapshot remain ignored and outside npm contents.

| Corpus / engine | Direct Recall@5 | Direct MRR@5 | Recall with support, up to 10 | Negative accuracy | Estimated direct → expanded tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Synthetic FTS5 | 81.70% | 0.853 | 81.70% | 6/9 | 146 → 146 |
| Synthetic FTS5+identifiers | 85.62% | 0.882 | 85.62% | 6/9 | 147 → 147 |
| Synthetic FTS5+identifiers+support | 85.62% | 0.882 | 97.06% | 6/9 | 147 → 205 |
| Real FTS5 | 77.78% | 0.764 | 77.78% | 3/6 | 1524 → 1524 |
| Real FTS5+identifiers | 77.78% | 0.764 | 77.78% | 3/6 | 1524 → 1524 |
| Real FTS5+identifiers+support | 77.78% | 0.764 | 87.50% | 3/6 | 1524 → 2667 |

Fallback insertion occurs **only in `Q21` and `Q22`**. `ModuleName` retrieves
its relevant longer-identifier record after the exact glossary; `buildContext`
retrieves its longer identifier despite FTS5 missing it. Every other synthetic
query has exactly the original FTS5 direct IDs, so there are no per-query recall
or first-relevant-rank regressions versus FTS5 on this corpus. The real set has
four recognized identifier-style queries but no qualifying new fallback hit:
**all 30 real direct lists are exactly FTS5's**. This demonstrates preservation,
not a measured benefit for real-project partial-identifier queries.

Compared with equal-weight hybrid, this candidate retains the real `R02` and
`R18` records and FTS5's first-relevant rank in `R05`, `R14`, `R19`. It also
retains FTS5's 6/9 synthetic negative accuracy, while the hybrid had 5/9.
Hybrid still has higher synthetic direct recall (87.25% versus 85.62%); the
narrow fallback deliberately does not reproduce its general prose gains.

Separate support improves real `R01`, `R13`, `R19`, `R21` and reaches 87.50%
recall without any direct-hit demotion. Final publication evidence in `R13`
remains absent from the direct five, so supporting recall is not a claim that
primary ranking is fixed. Russian misses `R04` / `R24`, attachment-evidence
miss `R12`, and absent-topic noise remain unresolved.

A fresh **FTS5 top-ten** slot-budget control has 82.35% synthetic and 79.86%
real recall, versus 97.06% and 87.50% with fallback/support. Real mean full-text
cost is about 3102 tokens for FTS5 top-ten, versus 2667 with support (14% less).
Support still costs about 75% more than the direct five. These are title/body
character estimates, not model-token budgets; they do not establish dominance
on other corpora or under excerpt trimming. For a consistent comparator, the
identifier variants read ten FTS hits, return five and retain all ten only in
`lexicalPoolIds`. Their timed calls therefore include that extra parsing, plus
substring searches when a query has marked tokens; latency is not a standalone
production implementation estimate.

Recommendation: this is a better next implementation candidate than automatic
equal-weight fusion. It preserves real FTS5 ranking and restores the tested
identifier cases, with bounded support separate from direct results. Keep the
main search unchanged until identifier queries from other real consumer
corpora, independent judgments, evidence authority and token-bounded context
packs are checked. None of those checks or production changes were performed
by this experiment.


## Actual identifier queries and equal context budgets

This section records the historical reserved-slot candidate. Its artifacts
remain unchanged; the current evaluator implements the append policy below,
so replaying this command now produces the corrected candidate's results.

The next local dataset, `artifacts/project-search-snapshot-v2.json`, preserves
all 50 original Markdown documents and the original 30 queries, and appends
16 queries (`R31`–`R46`), for 46 total: 38 positive and eight negative. Its
changed dataset digest reflects added judgments, **not** changed record text.
The 12 main identifier questions cover `relPath`, `quick_validate`,
`feature_request`, `pull_request_template`, `ISSUE_TEMPLATE`, `bug_report`,
`node_modules`, `ready_to_merge` and `PROJECT_CONTEXT`; three are phrased with
context instead of a bare fragment. Four controls cover a missing identifier,
unknown module, a lowercase fragment and a metadata-only retry pointer.

All new judgments and exact source annotations were saved in ignored
`artifacts/project-search-identifier-queries-v2.json` before running candidates.
Broad lookups label every source record actually discussing the identifier;
`ready_to` has nine relevant records, so recall@5 has a natural ceiling.
The contract-specific `R41` instead requires the lifecycle backlog and its
implementation contract, and deliberately does not label unrelated verification
records as contracts. No labels or retrieval rules were changed after results.
All eight engines retain identical original-query IDs and metrics, and repeat
runs reproduce both raw and budgeted results.

| Slice / engine | Current Recall@5 | FTS5 Recall@5 | FTS5+identifiers Recall@5 | With support, up to 10 |
| --- | ---: | ---: | ---: | ---: |
| Original 24 positive questions | 61.11% | 77.78% | 77.78% | 87.50% |
| 12 new main identifier questions | 92.13% | 37.96% | 66.99% | 75.79% |
| Two positive identifier controls | 50.00% | 0% | 0% | 0% |
| All 38 positive questions | 70.32% | 61.11% | 70.28% | 79.20% |

Fallback inserts a record in nine of the new queries. It recovers `relPa`,
`feature_req`, `PROJECT_CONT` and a first result for `quick_valid`, `ISSUE_TEMPL`,
`bug_rep`, `node_mod`. However, returning only one fallback record leaves broad
multi-record lookups substantially behind current substring search. FTS5's
underscore tokenization already handles some prefixes such as `pull_request`,
and contextual prose can recover records without fallback.

A new regression is explicit: on `R41` (`ready_to confirmed lifecycle contract`),
FTS5 retrieves both required contracts; reserved-slot fallback replaces the
fifth, relevant task with a verification record, cutting direct recall from
100% to 50%. Graph support restores the task in the unbounded ten-record stream,
but that does not justify hurting direct retrieval. Lowercase `relpa` (`R45`)
is retrieved only by current search. The metadata-only `retries_evid` (`R46`)
is missed by every engine because the indexed title/body/tags do not contain
the field name; the source annotation identifies the actual frontmatter field.

### Fixed budget protocol

```sh
npm run search:eval -- --fixture artifacts/project-search-snapshot-v2.json \
  --budgets 500,1000,2000,4000 --output artifacts/project-search-budget-report.json
```

The four ceilings were fixed before candidate runs. `--budgets` accepts one to
eight distinct integer ceilings from 32 to 100000; the default is the four
shown above. The evaluator reuses the production **estimator** `estimateTokens`
from `src/context-pack/pack.ts`: serialized JSON UTF-8 bytes divided by three,
rounded up. It does not reuse or modify production context-pack selection.
These numbers are project estimates, not a model tokenizer count.
Earlier chars/4 metrics remain available for historical raw-stream comparisons;
they must not be substituted for the new budget cost.

Each included unit contains ID, type, status, title and the **entire body**.
The payload always has `direct`, `supporting`, `continuation` arrays, including
empty arrays, and their JSON overhead counts against the same ceiling. No
excerpt, partial record or title-only placeholder is counted as retained
relevance. Records are deduplicated, processed in rank order and skipped if
the complete unit does not fit; the packer then tries the next record. This
simple whole-record policy can skip higher-ranked large records and is not
monotonic across budgets. It is intentionally a diagnostic, not the application's
excerpt selection, source/playbook budget, model response, or authority policy.

For the principal comparison both streams pack the same five direct
FTS5+identifier hits first. One then tries the five scoped graph neighbors;
the control instead tries up to five remaining records from FTS5 top-ten,
excluding direct duplicates. Neither stream can evict a direct unit already
retained at that ceiling. Supporting seeds come from original retrieval before
budgeting; a short neighbor may fit even if its oversized seed was skipped.
The control is a bounded lexical continuation after the same direct five,
not another ranking tuned to the budget.

Per-query `budgets` log the ceiling, retained direct/support/continuation IDs,
skipped IDs, exact estimator cost and SHA256 of the complete serialized payload.
Their `lexicalControl` contains the comparator. Summaries and category slices
report retained-record recall/hit/MRR, costs and omission counts. This recall
measures whole labeled records preserved in context, not correctness of a
model-generated answer. Budget-negative accuracy can improve just because noise
was too large to fit; raw no-answer accuracy still shows the search failures.

### Results under the same ceilings

All 38 positive queries, with mean estimated cost over all 46 queries:

| Ceiling | Direct only recall | Direct + lexical continuation recall | Direct + related evidence recall | Mean lexical → evidence cost |
| --- | ---: | ---: | ---: | ---: |
| 500 | 33.36% | 33.36% | 34.24% | 298 → 312 |
| 1000 | 52.73% | 52.73% | 52.73% | 648 → 671 |
| 2000 | 67.28% | 67.28% | 68.60% | 1300 → 1368 |
| 4000 | 70.28% | 71.89% | 77.59% | 2533 → 2478 |

At 1000, added support costs context without increasing recall. At 2000, the
net gain over lexical continuation is 1.32 percentage points and comes from
`R13`: the final publication verification fits, but its summary still does not.
At 4000, links improve `R01`, `R13`, `R19`, `R21` and `R39` over the continuation
control. The nine original evidence questions improve from 72.22% to 83.33%
retained recall at this ceiling, versus 68.52% to 74.07% at 2000. The final
publication query `R13` still retains only one of its two required records at
4000. Expanded raw-stream recall of 79.20% therefore overstates what fits in
the bounded payload (77.59%). No per-query budget comparison has a recall loss
from support versus the lexical control in this sample.

At 500 the tiny aggregate gain is a short verification fitting when the direct
seed records do not; at 1000 a larger direct unit occupies that space. This is
one example of why whole-record greedy packing need not be monotonic. Small
ceilings do not consistently establish graph benefit. Russian and metadata
misses remain; limits do not repair an empty or wrong seed stream.

Recommendation: keep main search unchanged. The real queries confirm useful
identifier recovery, **and reject the current reserved-slot policy as ready for
integration** because it evicts a relevant contract and under-serves broad
identifier lookups. Related evidence has a measured benefit when this complete-
record protocol leaves room, especially at 4000; it should remain an optional,
separate bounded section rather than a fixed allocation. A subsequent retrieval
change should preserve direct FTS hits and address fallback depth before any
production choice. Independent judgments, other real corpora, actual tokenizer
budgets, excerpt-based packs and authority-aware evidence are still untested.

## Append-policy correction, 2026-10-13

The corrected experiment retains every FTS5 top-five result in its original
position. It scans all scoped substring candidates for each marked query term,
then applies the existing proper-longer-identifier filter and deduplicates by ID.
At most five new matches are appended in query-term/search-rank order. They fill
vacant direct slots; any remainder goes into `identifierIds`, separate from both
the direct five and graph support. The old early five-candidate cutoff and
single reserved-slot replacement are removed. Marker detection, module/archive
scope, FTS weights, graph rules and judgments are unchanged.

The unchanged 60 synthetic and 46 real questions were each replayed twice,
with seven warm samples and the same four ceilings. Source digest is
`c96b0694298b55dafb486432664b4f9f108c9c546c44cef5d357d83892e54834`;
the real dataset digest remains
`d1528552b04eb0ed34facf57c2675cc55f481510f2892d3f63ecff159ae601ae`.
All 50 original Markdown documents remain byte-identical. Reports are local,
ignored artifacts; source-project records and generated indexes are not packaged.

```sh
npm run search:eval -- --output artifacts/search-eval-append-report.json
npm run search:eval -- --fixture artifacts/project-search-snapshot-v2.json \
  --budgets 500,1000,2000,4000 --output artifacts/project-search-append-report.json
```

Both confirmation runs reproduce IDs, relevance, costs and context hashes.
The six other engines have exactly their historical raw and budgeted outcomes.
Every corrected direct list begins with the complete unchanged FTS5 list;
every FTS5 record retained under a ceiling is still retained in the corrected
context. There are no top-five recall/MRR regressions against FTS5 or per-query
bounded-recall regressions against the old fallback/support on these corpora.
Synthetic direct recall stays 85.62%, with 97.06% expanded supporting recall
and unchanged six-of-nine raw negative accuracy.

| Real positive-query slice | FTS5 Recall@5 | Old fallback Recall@5 | Corrected Recall@5 | Corrected expanded, with support |
| --- | ---: | ---: | ---: | ---: |
| Original 24 questions | 77.78% | 77.78% | 77.78% | 87.50% |
| 12 main identifier questions | 37.96% | 66.99% | 96.30% | 100% |
| Two positive controls | 0% | 0% | 0% | 0% |
| All 38 questions | 61.11% | 70.28% | 79.53% | 86.84% |

The R41 contract regression is fixed: both labeled contracts remain in the
original FTS5 positions, with 100% direct recall rather than the old 50%.
Broad lookups now recover four of four `quick_valid` records, five of five
`ISSUE_TEMPL` and `bug_rep` records, and three of three `node_mod` records.
`ready_to` retains its original five of nine relevant records directly and
finds the other four in the identifier block. Thus 96.30% direct recall reflects
the five-slot ceiling; full expanded recall on the twelve questions is 100%.
Fallback still contributes on nine queries; depth, rather than trigger coverage,
accounts for the gain. Raw negative accuracy remains five of eight.

### Corrected bounded comparison

The same full-record JSON payload and estimator remain in use. Both candidates
pack direct records first and identifier overflow second. One then tries up to
five graph neighbors; its lexical control instead tries up to five remaining
FTS5 top-ten records. Each candidate can therefore offer up to fifteen unique
records before packing, but both obey the same token ceiling. Identifier
records use the existing `continuation` array; per-query `identifierIds` tells
which continuation candidates belong to the identifier block. Graph traversal
still starts from the five direct hits, before budget packing. It does not add
identifier overflow as extra graph seeds.

Neither support nor lexical continuation can evict a retained direct or
identifier unit. Exact JSON overhead, full bodies, skip-if-too-large behavior
and the absence of truncation remain unchanged. Top-five, expanded and bounded
recall are separate measurements; offering more candidates does not mean that
more relevant records fit. On this sample expanded recall also equals
`evidenceRecallAt10`, but the engine's general expanded cap is fifteen.

All 38 positive questions; mean estimated costs include all 46 questions:

| Ceiling | Old fallback + support recall | Corrected direct + identifiers recall | Corrected lexical control recall | Corrected + support recall | Mean lexical → support cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| 500 | 34.24% | 34.02% | 34.02% | 34.90% | 306 → 309 |
| 1000 | 52.73% | 54.44% | 54.44% | 54.44% | 676 → 691 |
| 2000 | 68.60% | 74.34% | 74.34% | 75.66% | 1415 → 1459 |
| 4000 | 77.59% | 79.82% | 79.82% | 84.65% | 2659 → 2646 |

Support beats the lexical control on R01 at 500, R13 at 2000, and R01, R13,
R19, R21 at 4000, with no per-query recall losses in this sample. The former
R39 support gain disappears because the corrected identifier search already
retrieves all its relevant records. At 1000 support adds estimated context cost
without recall benefit. At 4000 the net support gain is 4.82 percentage points,
while total bounded recall improves 7.06 points over the old candidate.
R13 still retains only one of two required publication records; `ready_to`
retains six of nine at 4000 despite all nine being found. Whole-record budgets
therefore still constrain completeness.

The recommendation remains to keep production search unchanged. This correction
removes the observed FTS5 eviction and makes the experimental identifier reserve
more useful; graph support remains optional after the lexical/identifier base.
Scanning all eligible candidates is suitable for this small corpus and needs
larger-corpus performance measurements before integration. Lowercase `relpa`,
metadata-only `retries_evid`, Russian paraphrases, evidence authority, independent
judgments, real model tokenization and answer quality remain unresolved or
untested. No production source, database schema or context-pack behavior changed.

## Larger-corpus speed and quality experiment, 2026-10-13

This section records the historical full-Markdown-scan reserve. The projection
follow-up below supersedes its implementation; replaying the command with the
current evaluator uses the optimized reserve. Historical reports are preserved.

This experiment keeps the corrected retrieval rules and adds deterministic load
to both frozen bases: the 40-record/60-query synthetic fixture and the 50-record/
46-query project snapshot. Each is evaluated at its original size, 1000 and
10000 total records. The original records, Markdown bytes, questions, relevance
labels and four context ceilings remain unchanged. This is a controlled load
experiment with synthetic negative additions, not a 10000-record real consumer
benchmark.

`scripts/search-scale.ts` generates generic source records from three authored
negative templates. The periodic mix is approximately 80% unrelated museum
census, 10% fictional vocabulary containing common project words, and 10% exact
identifier-fragment glossaries. Glossaries contain fragments without the longer
identifiers or implementation facts requested by the fixed questions. Their
retrieval is therefore a labeled negative, including for broad identifier
questions. Repeated terms intentionally stress candidate enumeration and
lexical noise. Generated records have three body sizes, approximately 90% router,
5% docs and 5% security scope, and 10% archive. Ratios vary slightly for incomplete
periods. All graph edges connect only generated records, never original answers.
This creates neither extra positive labels nor a shortcut to original evidence.

The generator does not copy original record text. Its manifest logs base,
expanded-dataset and generator SHA256 values. Generated inputs, reports and
manifests remain ignored under `artifacts/`; the generator and harness are
excluded from the npm package.

```sh
node --import tsx scripts/search-scale.ts \
  --fixture artifacts/project-search-snapshot-v2.json --records 10000 \
  --output artifacts/scale-project-10000.json
npm run search:eval -- --fixture artifacts/scale-project-10000.json \
  --engines current,fts5,fts5+identifiers,fts5+identifiers+support \
  --samples 7 --budgets 500,1000,2000,4000 \
  --output artifacts/scale-project-10000-run1.json
```

`--engines` selects a nonempty unique subset of the eight existing candidates;
its omission still evaluates all eight. The harness reuses frozen eligible
record arrays for identical module/archive scopes, reducing setup memory.
Selection and array reuse do not change any selected engine's results or
retrieval implementation. Per-query `eligibleRecords` and
`substringCandidatesParsed` expose scope size and the number of Markdown
candidates parsed by the identifier reserve across marked terms, before filtering
and deduplication. The count includes exact glossary hits rejected by the proper
longer-identifier filter, and can count a record once per matching query term.

Each corpus/size has two serial seven-sample runs with rotated query/engine order.
The measurements include the existing one-second freshness-check throttle;
filesystem scans that fall inside calls can affect latency tails. Index building,
corpus generation, eligibility materialization, initial result calculation and
budget packing remain outside retrieval latency. Read connections, FTS5's
frozen eligible-ID SQL list, current search's scoped text scoring, selected-file
parsing, full identifier-candidate parsing and optional graph construction are
inside. This is local warm single-request timing, not cold-start, concurrent
load, network transport or end-to-end model latency.

### Warm latency results

Two runs per cell; ranges show run-to-run p50 / p95 in milliseconds on Node
22.23.2, SQLite 3.51.3, macOS arm64, Apple M5 Pro. They are descriptive local
measurements, not confidence intervals. Each real-based engine/scale has
322 timed calls (46 queries × seven rounds).

| Real-based total records | Current p50 / p95 | FTS5 p50 / p95 | Identifier reserve p50 / p95 | Reserve + support p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| 50 | 0.93–1.00 / 1.29–1.36 | 0.50–0.50 / 0.62–0.64 | 0.68–0.69 / 2.04–2.28 | 0.69–0.70 / 2.44–2.49 |
| 1000 | 7.88–8.15 / 11.06–11.20 | 1.10–1.12 / 2.15–2.26 | 2.01–2.05 / 16.94–17.22 | 2.30–2.34 / 17.42–17.78 |
| 10000 | 87.22–90.01 / 115.63–126.02 | 6.31–7.02 / 48.93–50.55 | 15.86–16.04 / 175.12–180.68 | 19.62–19.85 / 187.19–214.38 |

Overall medians hide the costly reserve path: 19 of 46 real queries contain
marked identifier terms, while others skip the reserve. Those 19 include
no-match and unknown-scope controls, so the twelve main identifier questions
are also retained as a narrower slice.

| Marked real queries, total records | Current p50 / p95 | FTS5 p50 / p95 | Identifier reserve p50 / p95 | Reserve + support p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| 50 | 0.77–0.81 / 1.21–1.23 | 0.36–0.39 / 0.59–0.60 | 1.19–1.22 / 3.20–3.21 | 1.23–1.24 / 3.35–3.42 |
| 1000 | 6.70–6.81 / 10.64–10.77 | 1.02–1.05 / 2.00–2.31 | 16.17–16.21 / 17.33–17.98 | 16.52–16.71 / 18.18–18.58 |
| 10000 | 69.70–71.13 / 112.64–120.33 | 5.88–6.39 / 45.53–45.91 | 167.31–168.60 / 178.17–191.00 | 172.17–173.84 / 215.97–221.57 |

On the twelve main identifier queries at 10000, reserve p50 is 169.71–171.37 ms
versus about 69 ms for current search and about 6 ms for FTS5. The allowed scope
contains 8199 records; the reserve parses a mean 750.75 substring candidates per
main query, up to 824 for `ready_to`, before rejecting exact glossary fragments.
The corresponding mean at 1000 is 74.25. Across all marked queries the counts
are 58 and 562.95. Most of that work yields no new proper identifier hit.
This makes the full candidate scan expensive even though appended results are
capped at five. The inference from code and these counts is that repeated scoped
substring scoring, Markdown parsing and the post-parse identifier filter are the
reserve's scaling problem; no profiler attribution was performed.

The synthetic base confirms the same pattern. At 10000 its overall reserve
p50 is only 3.46–3.93 ms, but marked-query p50 is 73.67–77.75 ms and p95 is
180.61–211.63 ms, with up to 818 parsed candidates. Current overall p50 is
71.93–72.21 ms, and FTS5's is 3.38–3.70 ms. Thus a low overall reserve median
is not evidence that identifier recovery remains cheap. FTS tails include
periodic freshness scans and the prototype's large scope-ID list; these numbers
are not the expected latency of a production SQL scope-join implementation.

### Quality under load and the unchanged budgets

Every original base outcome still matches the previous append-policy report.
At each larger size both repeats have identical IDs, quality, costs and context
hashes. Original source bytes and judgments are unchanged. All retained FTS5
budget units and the entire FTS5 direct prefix survive; identifier/support
blocks are scoped, deduplicated and within the four ceilings. These structural
checks pass even when noise causes FTS5 itself to retrieve the wrong records.

| Corpus / records | Current Recall@5 | FTS5 Recall@5 | Reserve Recall@5 | Reserve expanded | With support expanded |
| --- | ---: | ---: | ---: | ---: | ---: |
| Real base / 50 | 70.32% | 61.11% | 79.53% | 80.70% | 86.84% |
| Real base + load / 1000 | 48.10% | 56.87% | 56.87% | 76.75% | 82.02% |
| Real base + load / 10000 | 48.10% | 55.99% | 55.99% | 75.88% | 80.70% |
| Synthetic / 40 | 83.01% | 81.70% | 85.62% | 85.62% | 97.06% |
| Synthetic + load / 1000 | 77.12% | 80.72% | 80.72% | 84.64% | 95.10% |
| Synthetic + load / 10000 | 77.12% | 80.72% | 80.72% | 84.64% | 95.10% |

FTS5 now fills direct slots with exact glossary hits on bare fragment queries.
Preserving that prefix moves recovered proper identifiers into overflow, so
expanded recall improves while top-five recall does not. On the twelve real
identifier questions direct reserve recall falls from 96.30% to 34.26%, but
expanded recall retains 97.22% at both enlarged sizes. This is a ranking/noise
problem as well as a speed problem. The raw no-answer accuracy at larger sizes
is 4/8 for all four real-based engines; real FTS/reserve was 5/8 at the base.
Synthetic FTS/reserve falls from 6/9 to 5/9; current stays 5/9. No labels were
adjusted to hide the extra false positives.

Real-based 10000 corpus, retained-record recall over the same 38 positive queries:

| Estimated-token ceiling | Current | FTS5 | Reserve | Reserve + lexical continuation | Reserve + support |
| --- | ---: | ---: | ---: | ---: | ---: |
| 500 | 19.59% | 22.88% | 22.88% | 22.88% | 24.63% |
| 1000 | 28.14% | 38.01% | 38.01% | 38.01% | 38.01% |
| 2000 | 42.18% | 50.73% | 63.22% | 63.22% | 63.22% |
| 4000 | 48.10% | 55.99% | 75.29% | 78.80% | 79.24% |

At 1000 total records the reserve/support recalls under the four ceilings are
23.76%/24.63%, 38.01%/38.01%, 65.85%/65.85%, 76.17%/81.43%. At 10000,
mean estimated context costs at 4000 are 2673 for current, 1934 for FTS5,
2201 for reserve, 3061 for its lexical control and 3167 for reserve/support;
these are means over all 46 queries and include JSON overhead. The budgets
remain estimates from UTF-8 JSON bytes/3, not model tokenizer counts. Full bodies
are packed without truncation; retrieval latency excludes this packing work.

The support advantage over the lexical control shrinks from 4.82 percentage
points at the 50-record base to 1.75 points at 1000 and **0.44 points at 10000**
under the 4000 ceiling. At both larger sizes `R19` loses one relevant record
compared with the lexical continuation (50% recall versus 0% with support).
At 10000 links gain `R01` and `R02`, while `R19` goes backward. Links have no
aggregate recall benefit over continuation at 1000/2000 token ceilings there.
A separate evidence block preserves direct/identifier units but does not
universally beat spending the remaining budget on lexical results.

Measured source digest:
`12a2e49ec7ae88fc9fd5dfb650d28341ba879a05d68ea5ff000a33b2ccf00d43`.
Generator digest:
`2586f428dea355e09a30ad2f2db3c904fcff4d16ccfd76bae971920f1d708a85`.
Real-based 10000 dataset digest:
`6521ae600c986b966bbc8deb1079140a2f7eef52007b277dfae9815df38bc716`.
The per-query reports and manifest hashes distinguish synthetic additions from
unchanged real sources. The 1000-record synthetic timings were rerun in isolation
after an overlapping focused test run; earlier files are retained separately,
and the tables use the isolated repetitions. Large-corpus repetitions ran
without this task's tests/build/package checks alongside them.

Recommendation: keep main search unchanged. The reserve's recall remains useful
when identifier overflow fits, but the all-candidate Markdown scan is unsuitable
as the next production implementation. A subsequent scoped experiment should
filter proper identifier candidates before reading their Markdown and repeat
these fixed quality/budget checks; simply reinstating the old early cutoff
would reintroduce missed matches. Graph support also needs evaluation against
lexical continuation per query, because the large noisy corpus exposes a real
loss. Independent large consumer data, concurrent/cold latency, profiler
attribution, actual tokenizers and answer quality remain untested.

## Identifier projection before Markdown reads, 2026-10-13

The next experiment preserves the retrieval and budget rules and changes where
identifier filtering happens. The temporary evaluation database gains an
`eval_identifiers` table of record ID and normalized identifier, with a unique
key per pair. It is built from indexed title/body/tags using the existing
`identifierTerms` parser and JavaScript Unicode lowercase, without new Markdown
reads. This derived table is created only when an identifier engine is selected;
it is removed with the temporary repository. Runtime source, production schema,
main search and the corpus generator are unchanged.

At query time, SQL selects eligible records with a **proper longer** identifier
containing the normalized term, using literal substring matching and rejecting
the exact term. No early five-candidate cutoff is applied. Only matching records'
indexed text is fetched for the original title10/tags6/body2 single-term score,
including the squared matched-term contribution. JavaScript path `localeCompare`
retains the old tie order, and query-term stream order remains unchanged.
FTS5 seed duplicates and repeated matches are removed before selecting at most
five new pointers. Only those pointers read Markdown. The existing generic
append helper works on ID/path pointers as well as records, retaining the same
FTS prefix, direct slots and identifier overflow. Support, lexical controls and
whole-body context packing do not change.

This moves identifier extraction to preparation, so `identifierIndex` reports
unique entry count and measured `buildMs` separately from warm query latency.
The legacy `substringCandidatesParsed` counter now counts only Markdown records
read for the reserve, at most five unique additions per query; it excludes FTS
reads, existing index construction and support records. New
`identifierCandidateMatches` counts SQL-matched record candidates across terms,
before direct-hit exclusion and deduplication. It does not count every vocabulary
entry inspected by the substring scan. Exact glossaries now cause zero reserve
Markdown reads. The lookup still scans an identifier vocabulary and uses large
frozen eligible-ID lists; it is an experimental implementation.

```sh
npm run search:eval -- --fixture artifacts/scale-project-10000.json \
  --engines current,fts5,fts5+identifiers,fts5+identifiers+support \
  --samples 7 --budgets 500,1000,2000,4000 \
  --output artifacts/prefilter-project-10000-run1.json
```

All six existing corpus inputs were read as saved, without regeneration: original
synthetic and project bases and their 1000/10000-record versions. Each has two
serial seven-sample runs, using the same four engines, questions and ceilings.
Historical scale reports remain unchanged. Build and test commands run after
the timed comparisons. Freshness checks and rotated query/engine order remain
inside the same timing protocol; initial setup and budget packing stay outside.

### Repeated latency and preparation results

Two runs per cell, same local runtime and machine as the scale experiment. Values are run-to-run ranges of p50 / p95 milliseconds over the same 19 real-based marked queries; they are not confidence intervals.

| Total records | Current p50 / p95 | FTS5 p50 / p95 | Optimized reserve p50 / p95 | Optimized reserve + support p50 / p95 |
| --- | ---: | ---: | ---: | ---: |
| 50 | 0.83–0.85 / 1.25–1.25 | 0.36–0.40 / 0.61–0.61 | 0.80–0.86 / 1.12–1.18 | 0.81–0.86 / 1.15–1.21 |
| 1000 | 6.64–7.62 / 10.67–24.43 | 1.05–1.42 / 2.21–2.96 | 1.69–2.25 / 2.64–3.83 | 1.94–2.61 / 2.95–4.75 |
| 10000 | 67.71–72.73 / 112.88–116.60 | 6.07–6.21 / 48.13–48.20 | 7.99–8.83 / 18.40–19.29 | 11.80–12.88 / 22.16–22.74 |

At 10000 real-based records, marked-query reserve p50 changes from 167.31–168.60 ms to 7.99–8.83 ms (about 19–21× faster in these runs). Its p95 changes from 178.17–191.00 ms to 18.40–19.29 ms. On the twelve main identifier questions, p50 is 8.08–8.95 ms and p95 is 11.54–12.21 ms. Other engine timings still vary with local load and which calls encounter periodic freshness checks; the measured control engines were not optimized.

Across all 46 questions at 10000, optimized reserve p50 is 7.88–8.61 ms and p95 is 17.59–23.51 ms; with support it is 11.68–12.85 / 22.16–28.99 ms. On the synthetic 10000 corpus overall reserve p95 falls from 151.74–164.65 ms to 17.12–17.65 ms.

| Corpus / total records | Identifier entries | Additional projection build time, ms |
| --- | ---: | ---: |
| synthetic / 40 | 10 | 2.08–2.13 |
| synthetic / 1000 | 1162 | 67.30–78.35 |
| synthetic / 10000 | 11962 | 687.80–799.68 |
| project / 50 | 56 | 3.74–3.80 |
| project / 1000 | 1196 | 70.34–71.00 |
| project / 10000 | 11996 | 686.82–1366.93 |

Projection construction includes reading indexed text, identifier extraction, inserts, commit and entry counting. It adds about 0.69–1.37 seconds at 10000 real-based records, outside warm request timing. This is a full disposable rebuild; incremental upkeep, cold latency and storage overhead were not measured.

On the twelve main real identifier questions, reserve Markdown reads fall from a mean 750.75 to **2.5**, at most five. SQL returns a mean 3.67 proper record matches before direct-hit exclusion and deduplication. Across all 19 marked questions the mean reads fall from 562.95 to 1.58. The original direct FTS reads (up to ten for these candidates) remain separate and unchanged.


### Quality preservation and remaining limits

All twelve benchmark runs reproduce their counterpart's IDs, quality, full-body
context hashes and estimator costs. Across all six corpora, the previous scale
reports' per-query direct/identifier/support streams, lexical pools and controls,
raw metrics and every budgeted payload outcome remain identical. Only latency,
preparation metadata and candidate/read counters change. Dataset hashes are
unchanged, and both new repetitions reproduce all non-timing outputs. Additional
all-eight-engine checks on the two original bases also match the preceding
append-policy reports, including the six untouched engines. Tests cover Unicode
folding, weighted fields, path ties, query-term ordering, exact-glossary rejection,
candidates beyond the old cutoff, scope/archive eligibility and pre-read dedup.

The 10000 real-based budget recalls therefore remain exactly:

| Estimated-token ceiling | Current | FTS5 | Optimized reserve | Reserve + lexical continuation | Reserve + support |
| --- | ---: | ---: | ---: | ---: | ---: |
| 500 | 19.59% | 22.88% | 22.88% | 22.88% | 24.63% |
| 1000 | 28.14% | 38.01% | 38.01% | 38.01% | 38.01% |
| 2000 | 42.18% | 50.73% | 63.22% | 63.22% | 63.22% |
| 4000 | 48.10% | 55.99% | 75.29% | 78.80% | 79.24% |

The optimization repairs cost, not ranking or evidence authority. The noise-induced
top-five misses, four-of-eight raw negative accuracy, lowercase/metadata controls,
whole-record packing limits and `R19` support loss versus lexical continuation
remain unchanged. The graph's 4000-budget net advantage over that control is still
only 0.44 percentage points on the large noisy corpus. No recall change is claimed
as a speed gain, and no records are trimmed to fit.

Measured source digest:
`373a91dfe1487defc2aeadcbecd2a1f82a7807f2a5c9378cb6ac3fcf99ffa682`.
The real-based 10000 input digest remains
`6521ae600c986b966bbc8deb1079140a2f7eef52007b277dfae9815df38bc716`.
New ignored artifacts use `prefilter-{synthetic|project}-{0|1000|10000}-run{1|2}.json`;
`0` denotes the unchanged original base. Historical `scale-*` inputs and reports
are preserved.

Recommendation: this projection is a more useful experimental reserve than the
full candidate Markdown scan: it retains the measured recall while substantially
reducing identifier-query cost. Keep main search unchanged. Production integration
still requires an incremental index lifecycle and freshness design, scope joins,
and independent large real data. Substring vocabulary scans, ambiguous FTS seeds
and graph usefulness under a fixed budget remain separate questions. No concurrent
or cold request latency, real model tokenizer, generated answers, profiler or
independent judgment checks were performed.

## Opt-in runtime FTS5 and actual context packs, 2026-10-13

The local runtime now accepts `searchEngine: "fts5"`; omission and explicit
`"current"` preserve the current default selection. CLI `search`, `pack` and
`build-project-context-pack` accept `--search-engine current|fts5`. MCP
`build_context_pack`, `build_project_context_pack` and the local part of
`retrieve_project_context` expose the corresponding enum. Portal search mode
remains independent. This integration does not expand graph neighbors.

The runtime lazily constructs disposable FTS5 and identifier tables from the
plain search index. A base-index rebuild invalidates both through the metadata
marker; projection population and publication are transactional. Direct matches,
reserve matches and selected metadata share one SQLite read snapshot. A focused
regression reproduced mixed old/new record bodies when another connection
rebuilt between direct and reserve reads; the read transaction fixes it. A
projection invalidated before that snapshot is pinned falls back to current
retrieval. Setup failures do not delete a healthy plain index, and fallback packs
warn and disable caching. Source-file excerpts are still normal Markdown reads,
so the entire pack is not an atomic snapshot across concurrent filesystem edits.

SQL joins enforce module aliases/global records, archive scope and, for packs,
draft/history policy before result caps. BM25 seeds occupy at most five slots;
up to five deduplicated proper identifier candidates follow, subject to the
request's total limit. Standard packs allow ten automatic records in this mode,
versus the current pack's eight; fast packs cap the total at five. Current packs
retain their existing type/confirmation reranking and module-only candidates;
FTS5 packs retain the BM25 prefix and append reserve results. These are complete
pipeline comparisons, not a claim that all quality changes come from SQL speed.
Pack-cache version 6 and normalized engine inputs isolate mode caches.

### Replay protocol and interpretation

Six saved corpus files were reused without regenerating, editing records or
changing the 60 synthetic / 46 project queries and their judgments: the 40/50
bases and their 1000/10000-record versions. The large project-based corpora still
contain 50 real records plus generated negative load, not 10000 independent real
consumer records. The generator and its saved manifest hashes are unchanged.

The evaluator's `--context-packs` flag calls the actual `buildContextPack` in
standard workflow at 500/1000/2000/4000, with both engines and two history
settings. It uses the same frozen minimal project configuration as the preceding
retrieval experiment: module paths/aliases, no configured commands or playbooks.
Real snapshot source-code files are not copied. This exercises the production
record/excerpt/provenance/cache/budget path on the frozen data; it is not a full
replay of a consumer's source files, mandatory playbooks or Portal context.

Both passes contain 5088 packs each. One complete pass used the initial
integration; a second used the read-snapshot correction. Every per-query ID,
excerpt, retained-reference-only ID, warning, budget counter, estimated cost and
payload hash matched across passes; timing and cache status are excluded from
that equality check. Required runtime tests additionally cover aliases/global
records, archive/draft/history filters, bounded reserve selection, Unicode,
query-term order, cache separation, additions/edits/deletions/moves, missing or
corrupt indexes, failed projection rollback, four concurrent first requests,
CLI/MCP calls and local-mode forwarding by the unified pack.

```sh
node --import tsx scripts/search-eval.ts \
  --fixture artifacts/scale-project-10000.json \
  --engines current,fts5+identifiers --samples 1 --context-packs \
  --budgets 500,1000,2000,4000 \
  --output artifacts/runtime-pack-project-10000-final.json
```

`contextPacks` is separate from the unchanged prototype retrieval metrics.
`recall` counts retained record references; `excerptRecall` counts only relevant
records with a nonempty excerpt. Neither proves the answer-bearing passage was
included or that a model answered correctly. `sourceOnlyIds` expose links whose
text was removed by the existing trimmer. Costs use the existing UTF-8 JSON/3
estimator, including the production pack envelope; no real tokenizer is used.

The original judgments remain fixed. By default, 31 of the 38 positive project
queries have no policy-visible relevant record: most target finished tasks,
verification/run history or drafts. `includeHistory: true` makes 35 queries have
at least one visible relevant record; R31, R32 and R45 remain draft-only and are
not made visible by that switch. The report records hidden relevant IDs and a
separately named `visibleRecall`; it never silently relabels a search miss.

Pack routing also differs from the prototype's literal scope. Unknown explicit
modules on R30/R44 are ignored by existing inference. In the frozen configuration
no configured fallback module resolves, leaving an empty module list and thus
unscoped retrieval, with warnings. R44 yields additional results under load. Both
engines preserve that existing pack behavior. The report's
`routedModules` and `requestedScopeExtraIds` make the expansion explicit; returned
records are checked against the actual routed scope and visibility policy.

### Quality at the real pack boundary

Project-based 10000 corpus, excerpt recall over all 38 original positive queries:

| Estimated budget | Current, default history | FTS5 + reserve, default history | Current, history included | FTS5 + reserve, history included |
| --- | ---: | ---: | ---: | ---: |
| 500 | 0.00% | 0.00% | 0.00% | 0.00% |
| 1000 | 2.63% | 10.53% | 12.57% | 30.77% |
| 2000 | 2.63% | 10.53% | 12.57% | 47.66% |
| 4000 | 10.53% | 10.53% | 28.36% | 59.12% |

At 4000, both engines find all policy-visible relevant records on the seven
positive questions with any visible answers under default history. That is
100% `visibleRecall`, alongside only 10.53% of the original all-query recall.
Under included history, FTS5's visible recall is 79.05%, versus current's 35.56%.
The distinction describes the product policy, not a newly expanded relevance set.

| Corpus size, history included, budget 4000 | Current excerpt recall | FTS5 + reserve excerpt recall | Per-query gains / losses against current |
| --- | ---: | ---: | ---: |
| Real base / 50 | 28.36% | 60.88% | 19 / 0 |
| Real base + load / 1000 | 28.36% | 60.00% | 19 / 0 |
| Real base + load / 10000 | 28.36% | 59.12% | 18 / 0 |
| Synthetic + load / 10000 | 72.71% | 82.68% | 14 / 5 |

Synthetic history-included regressions at 4000 are Q30, Q41, Q42, Q48 and Q49.
Under default history, synthetic recall at that ceiling is 79.08% current versus
80.39% FTS5, with eight gains and six losses (Q26, Q30, Q42, Q47, Q48, Q49).
These remain reported; this integration does not tune ranking to erase them.

At 500, retained-reference recall can look substantially better than delivered
text: on the large synthetic corpus FTS5 retains references covering 52.61% of
labels with history included but delivers no record excerpts. On the large
project-based corpus the corresponding reference recall is 3.29%, again with
zero excerpts. High negative accuracy at tiny budgets can similarly come from
removing every result. With history included at 4000 on the large project-based
corpus, empty-result negative accuracy is still only 2/8 for FTS5 and 0/8 for
current. More relevant evidence does not establish reliable abstention.

### Performance and remaining boundaries

Actual-pack timings include per-request freshness checking, cache dependency
scans, indexed retrieval, selected Markdown excerpts, budget trimming and cache
writes. Each mode/history/budget/query combination is a cache miss; lazy
projection creation is included in the first FTS5 pack. The preceding prototype
retrieval loop warms the plain index first. These are serial single-observation
pack replays on Node 22.23.2 / SQLite 3.51.3 / macOS arm64, not cold process,
concurrent throughput or minimum-supported-Node benchmarks. Core pack costs
remain much larger than the earlier 8–9 ms retrieval-only measurements.

Two-pass ranges at 10000 records, standard workflow and budget 4000; p50/p95
are over all queries in each pass, not confidence intervals:

| Corpus / history | Current pack p50 / p95, ms | FTS5 + reserve pack p50 / p95, ms |
| --- | ---: | ---: |
| Project-based / default | 364.25–385.07 / 403.64–667.66 | 112.72–116.35 / 126.59–162.17 |
| Project-based / included | 364.40–372.51 / 475.31–487.37 | 108.35–112.12 / 128.47–141.57 |
| Synthetic / default | 305.40–333.74 / 382.81–502.57 | 104.07–112.09 / 120.61–160.95 |
| Synthetic / included | 305.69–327.83 / 390.82–468.68 | 102.14–108.81 / 120.66–142.86 |

Ignored artifacts are `runtime-pack-{synthetic|project}-{0|1000|10000}.json` and
`*-final.json`, with logs beside them; `0` denotes the unchanged base. Earlier
reports remain intact. The corrected pass's measured eight-file source digest is
`5f1a467403412eb0e70838d434a38efe59e668f9f8df20c25d8f65329af0ff47`.
The audit additionally captures source/launcher/evaluator file digests and verifies
saved dataset digests against previous reports.

The opt-in mode is implemented and the current default is retained. It offers
better measured project-history coverage, but synthetic query losses,
false-positive/abstention problems, draft/history exclusions and insufficient
small-budget text remain material limits. No graph support, incremental
projection maintenance, independent large real consumer corpus, model-answer
judging or actual tokenizer evaluation is included in this change.

Verification: build, 307 tests in 44 files, strict evaluator typecheck, package
allowlist check (214 entries, no missing/forbidden files), scoped whitespace
checks and doctor (17 OK, four existing WARN, zero failures) pass. Heuristic
refactor review recommends deferring cross-module cleanup to a separate task.
Real snapshots, generated databases and reports remain ignored artifacts.

## Independent real consumer replay (2026-10-13)

The next evaluation uses another real software project's local memory: 1175
unique records (789 active, 174 archived, 212 drafts), without synthetic load or
an imported external knowledge corpus. The consumer contains portal/backend
product knowledge as well as vendored Router support history, so this is another
project and workload, not an independently authored organizational benchmark.

The frozen silver set has 41 queries: nine current decisions, three multi-record
questions, six historical questions, one archive question, two module aliases,
one scope-negative, five unrelated-domain negatives and fourteen actual partial
identifiers. Positive answer anchors were selected from exact source records
before retrieval; identifiers use all literal proper-identifier matches within
the selected module/archive scope. There are 35 positive and six negative queries.
Non-identifier anchors are a target set, not exhaustive relevance annotations.
A scope preflight caught an archived target before any retrieval ran; archive
inclusion was corrected before freezing the measured inputs. Labels were not
changed after seeing search results.

Two configurations use identical Markdown bytes and judgments:

- **Consumer guidance replay:** original project YAML, routing, aliases,
  verification command metadata and nine original configured/discovered guidance
  files. These files are treated as pack data, not executed instructions or
  commands. Ordinary product source files, Git metadata, runtime services and
  credential files are not mirrored; this does not establish a complete checkout
  or live deployment replay.
- **Minimal-config control:** the same module paths/aliases with no consumer
  guidance or command configuration, matching the previous evaluation protocol.

Both configurations run actual standard `buildContextPack` with current versus
FTS5 plus reserve, budgets **500/1000/2000/4000**, and both default and explicitly
included history. Each configuration is replayed twice serially: **2624 packs**
altogether. IDs, excerpts, budget counters, warnings and cache-independent payload
hashes match between passes. No returned record falls outside the requested
module/archive scope or pack visibility policy. The source manifest verifies
that the frozen record/YAML/guidance bytes remain identical to the captured
sources. An initial live-source check passed. During final verification, the
original project changed concurrently: four captured files changed and six became
absent. The final comparison still uses the unchanged frozen snapshot; it is not
a claim about the consumer's newer live state. Both source-check stages are saved.
Current remains the default; runtime search/ranking, graph evidence and consumer
files/indexes are unchanged by this task.

### Actual consumer budget and quality

The two mandatory guidance files selected by these queries consume **1753**
estimated tokens before the response envelope. At budgets 500, 1000 and 2000,
**every one of the 41 queries**, for both engines and history settings, loses all
record payload and reports `budget.exceedsLimit` with the existing required-
guidance warning. This is an observed pack constraint, not successful bounded
retrieval. Empty results at these budgets must not count as correct abstention.
The evaluator now records this expected guidance-only overflow while still
rejecting inconsistent flags or overflows with retained optional payload.

At 4000, all consumer replay packs fit the estimate. Macro excerpt recall below
means that a target record has any non-empty delivered excerpt; it does not mean
that the answer itself is present. The denominator is the unchanged 35 positive
queries, including targets hidden by the selected policy.

| Configuration / history at 4000 | Current excerpt recall | FTS5 + reserve excerpt recall | Gains / losses |
| --- | ---: | ---: | ---: |
| Consumer / default | 33.96% | 47.32% | 10 / 0 |
| Consumer / included | 49.67% | 73.51% | 17 / 0 |
| Minimal control / default | 41.58% | 49.89% | 7 / 1 |
| Minimal control / included | 64.44% | 78.94% | 12 / 1 |

The minimal-control loss is V10, a multi-record document-lifecycle question:
FTS5's five direct seeds miss one of three target decisions. At 1000 with history
included, minimal-control excerpt recall slightly regresses, 46.82% current versus
45.92% FTS5, with losses V12 and V20. Removing consumer guidance therefore does
not justify a claim that the new ranking never regresses. At 500 the minimal
control also delivers no record text, even though it fits the budget.

As a stricter check, source-derived literal answer anchors were frozen alongside
the judgments and checked against delivered excerpts. At 4000 in the consumer
replay, macro literal-anchor coverage is **10.15% current / 18.27% FTS5** under
default history, and **11.58% / 28.75%** with history included. This deliberately
conservative substring measure ignores paraphrases and is not model-answer
judging. It exposes the large gap between finding the right record and delivering
its decisive passage; the existing excerpt selection and trimming remain unchanged.

At 4000, FTS5 returns no records for the absent identifier and the scope-negative,
**2/6 negatives**, versus **0/6** current. The remaining four unrelated-domain
questions still get irrelevant records. Broad OR matches and current module-based
selection do not establish that the question has an answer.

A separate pure-FTS prototype ablation on the fourteen identifier queries gives
raw macro target recall **11.90% FTS5 / 82.39% with reserve**, improving thirteen
queries. The original FTS top-five prefix is preserved. This raw control includes
eligible history/drafts; it is not actual pack coverage. The runtime pack records
reserve provenance separately. At 4000 with history included, eleven queries
that pure FTS cannot answer retain reserve records in the consumer pack; one
other identifier query has only draft targets and correctly delivers none.
Result caps and budgets prevent complete recall for identifiers occurring in many
records. Guidance can remove otherwise retrieved reserve evidence as well.

### Speed and release assessment

Actual consumer replay at 4000, two-pass p50/p95 ranges in milliseconds:

| History / mode | p50 | p95 |
| --- | ---: | ---: |
| Default / current | 89.44–94.38 | 108.97–109.48 |
| Default / FTS5 + reserve | 16.87–17.06 | 19.79–20.11 |
| Included / current | 91.52–92.44 | 110.07–114.21 |
| Included / FTS5 + reserve | 16.82–16.97 | 20.24–21.64 |

These timings include actual pack assembly, freshness checks, selected Markdown
reads, guidance budgeting and cache writes. Each query/mode/history/budget input
is a cache miss. The prototype loop warms the plain index before pack measurement;
lazy FTS projection creation is included in the first FTS pack. Measurements use
Node 22.23.2 / SQLite 3.51.3 / macOS arm64, one serial observation per input per
pass; they do not establish cold-process or concurrent-throughput latency.

**Recommendation:** the evidence supports shipping FTS5 plus reserve as an
explicitly experimental opt-in with current still the default. It does not
support replacing current or promising stable answer quality at all four budgets.
For stable promotion, first address guidance-only budget overflow, select excerpts
around relevant evidence, and reduce unrelated-domain false positives; rerun this
unchanged set and review fresh human-authored questions without tuning labels.

At evaluation time, the working tree identified itself as 0.7.0 while the
released baseline was 0.7.1. Distribution preparation must put the scoped change on
the current release baseline, assign the next version consistently, update release
notes and run CI on the immutable candidate plus a clean consumer installation.
This task does not publish a release, bump versions or claim independent acceptance.
Minimum-supported Node, Windows and live consumer deployment remain unverified.

Private corpus bytes and detailed per-query reports remain ignored artifacts:
`second-project-{consumer|control}.json`, corresponding `-run{1|2}.json` reports,
`second-project-source-manifest.json`, `second-project-audit.json` and
`second-project-identifier-ablation.json`. No consumer records or workstation paths
are included in this public summary or npm package. Consumer dataset SHA-256 is
`e1f13a35dbd54a14e8f828df4c76a0d5800c4b38ae3220c1340547144dc360d9`;
minimal control is
`1fc9d18a89642607ce8b01fd32dab867b26fb6b400a9dc3f08c9acbd05cb661f`.
The measured eight-file source digest is
`b219a4c23cc23a6a0522d7ee4b74c9c1587f0c19dff98ba107d80128f936e5bd`.

Verification for this evaluation: build, **308 tests in 44 files**, strict
TypeScript check of the evaluator, package check (214 entries, no missing or
forbidden files), scoped refactor/whitespace review and doctor (17 OK, four
existing WARN, zero failures) pass. A source manifest confirms that all runtime
and launcher files match the prior verified integration; only evaluator support,
its regression test and this report changed in this task. The local derived
index was refreshed after workflow/configuration changes.
