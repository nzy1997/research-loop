---
name: assess-research-problem
description: Use when judging whether a proposed research problem is worth doing, worth pursuing now, suitable for this repository's autoresearch loop, or should be reframed, deferred, or rejected as an autoresearch target.
---

# assess-research-problem

## Overview

Judge two axes separately: research value and autoresearch suitability. A
problem can be important science and still be a poor fit for an automated loop.

This skill is read-only. Do not answer the research question or solve the
research problem, run experiments, create or update `problems/`, or modify
`knowledge/`, `drafts/`, or `literature/`.

## Trust boundary

Before stating a research fact, definition, benchmark, parameter, novelty
claim, or interpretation, use `read-knowledge`:

```bash
make knowledge-resolve QUERY="<the candidate research question>"
```

On `match`, read every path in `bundle.orderedFiles` before using repository
knowledge. On `ambiguous`, present every alternative and ask the user to choose
before continuing evidence-dependent assessment. On `no-match`, say the
learned knowledge has no match and mark affected evidence-dependent dimensions
unknown.

Never use `drafts/` as a fallback. Do not use `literature/` as learned
knowledge. Enter external research only when the user explicitly asks, and
label it as external evidence.

## Scoring

Score each dimension 0-5 with evidence state `supported`, `inferred`, or
`unknown`. Keep `unknown` as an interval, not zero.

Research value `V` is 0-100:

| Dimension | Weight | Score question |
|---|---:|---|
| Importance | 20 | Would success resolve a consequential need? |
| Gap and novelty | 20 | Is the gap specific and evidence-supported? |
| Plausibility | 15 | Is useful progress credible? |
| Learning from failure | 15 | Would failure reduce uncertainty? |
| Generality and publication potential | 15 | Would the result transfer beyond one instance? |
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

Runtime is soft. 5 minutes is ideal, not a hard limit:

```text
T = clamp(5 - log2(max(t, 5) / 5), 0, 5)
```

The combined score is the harmonic mean: `S = 0` when `V + A = 0`, otherwise
`S = 2 * V * A / (V + A)`.

No individual dimension is a hard veto. P = NP should naturally score as high
research value and low autoresearch suitability, not as a special-case
blacklist.

## Verdicts

Use axis bands: strong 70-100, mixed 40-69.99, weak 0-39.99.

| Verdict | Condition |
|---|---|
| `DO NOW` | `V` and `A` are strong. |
| `REFRAME` | `V` is strong, `A` is not strong, and one bounded reformulation could improve `A`. |
| `NOT AUTORESEARCH` | `V` is strong, `A` is weak, and no credible bounded reformulation is apparent. |
| `DEFER` | Every remaining case. |

If score intervals cross verdict boundaries, report the midpoint verdict as
provisional, confidence low, the verdict range, and one question most likely to
resolve it.

## Output

Return exactly these sections, in order:

1. `Normalized problem` - one sentence.
2. `Verdict` - one label plus `V`, `A`, `S`, and confidence.
3. `Research value` - score, weight, evidence state, and one-line rationale for each dimension.
4. `Autoresearch suitability` - score, weight, evidence state, and one-line rationale for each dimension.
5. `Largest bottleneck` - exactly one limiting factor.
6. `Recommended reframe` - exactly one bounded reformulation, or say none is credible.
7. `Information gaps` - only unknowns that could materially change the verdict.

Keep research value, mechanism fit, and evidence confidence visibly separate.
