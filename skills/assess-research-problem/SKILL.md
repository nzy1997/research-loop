---
name: assess-research-problem
description: Use when judging whether a proposed research problem is worth doing, worth pursuing now, suitable for this repository's autoresearch loop, or should be reframed, deferred, or rejected as an autoresearch target.
---

# assess-research-problem

## Overview

Judge research value and autoresearch suitability separately.

This skill is read-only. Do not answer the research question or solve the
research problem, run experiments, create or update `problems/`, or modify
`knowledge/`, `drafts/`, or `literature/`.

## Trust boundary

Before research facts or interpretations, use `read-knowledge`:

```bash
make knowledge-resolve QUERY="<the candidate research question>"
```

On `match`, read every `bundle.orderedFiles` path before using knowledge. On
`ambiguous`, present every alternative and ask the user to choose. On
`no-match`, say the learned knowledge has no match and mark affected dimensions
unknown.

Never use `drafts/` as learned knowledge. Never use `literature/` as learned
knowledge. External research requires an explicit user request; label it
external evidence.

## Scoring

Score dimensions 0-5 as `supported`, `inferred`, or `unknown`; keep `unknown`
as an interval, not zero.

Research value `V` is 0-100:

| Dimension | Weight | Score question |
|---|---:|---|
| Importance | 20 | Would success resolve a consequential need? |
| Gap and novelty | 20 | Is the gap specific and evidence-supported? |
| Plausibility | 15 | Is useful progress credible? |
| Learning from failure | 15 | Would failure reduce uncertainty? |
| Generality | 15 | Would the result transfer beyond one instance? |
| Expected value relative to cost | 15 | Is the knowledge gain worth the cost? |

Autoresearch suitability `A` is 0-100:

| Dimension | Weight | Score question |
|---|---:|---|
| Modifiable search object | 20 | Can attempts change code, algorithms, models, or config? |
| Executable objective | 20 | Can a script score attempts consistently? |
| Correctness and anti-gaming | 15 | Are validity, leakage, and hard-coding checked? |
| Incremental feedback | 15 | Do failures provide directional information? |
| Fresh evaluation | 10 | Is there frozen or hidden evaluation? |
| Reproducibility and auditability | 10 | Are code, inputs, environment, logs, and results inspectable? |
| Attempt runtime | 10 | How fast is one feedback cycle? |

Runtime is soft. 5 minutes ideal, not a hard limit:

```text
T = clamp(5 - log2(max(t, 5) / 5), 0, 5)
```

The combined score is the harmonic mean: `S = 0` when `V + A = 0`, otherwise
`S = 2 * V * A / (V + A)`.

No individual dimension is a hard veto. P = NP should naturally score as high
research value and low autoresearch suitability, not as a special-case
blacklist.

## Verdicts

Bands: strong 70-100, mixed 40-69.99, weak 0-39.99.

| Verdict | Condition |
|---|---|
| `DO_NOW` | `V` and `A` strong. |
| `REFRAME` | `V` strong; a bounded reformulation could improve `A`. |
| `NOT_AUTORESEARCH` | `V` strong, `A` weak, with no credible bounded reformulation. |
| `DEFER` | Otherwise. |

If intervals cross verdict boundaries, report the midpoint verdict as
provisional, confidence low, its range, and one question likely to resolve it.

## Structured output mode

When Codex is invoked with the repository's structured output schema, return
one JSON object matching that schema instead of Markdown sections. Use
`outcome: "assessment"` only after the resolver path has produced enough
information to score the problem. Use the `needs_input` outcome when the
resolver result is ambiguous and include every alternative exactly as reported.

The JSON keys, dimension IDs, evidence states, verdict labels, and
recommendation enums are English. Allowed verdict labels: `DO_NOW`, `REFRAME`,
`NOT_AUTORESEARCH`, `DEFER`. Allowed autoresearch recommendation values:
`proceed`, `reframe`, `reject`, `defer`. Human-readable rationales should
follow the primary language of the candidate `problem.md`.

For `match`, include the resolver query, topic, and every ordered bundle path
that was read. For `no-match`, include the resolver query and mark
evidence-dependent dimensions as `unknown`. For `ambiguous`, do not score the
problem and do not choose among alternatives.

Keep Markdown sections for normal conversation mode when no structured output
schema is supplied.

## Output

Return these sections, in order: `Normalized problem` (one sentence);
`Verdict` (label, `V`, `A`, `S`, confidence); `Research value` and
`Autoresearch suitability` (score, weight, evidence state, rationale per
dimension); `Largest bottleneck` (exactly one); `Recommended reframe` (exactly
one bounded reformulation, or none); and `Information gaps` (material
unknowns).
