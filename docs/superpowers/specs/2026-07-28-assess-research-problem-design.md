# Assess Research Problem Skill Design

Date: 2026-07-28
Status: Approved for planning

## Purpose

Add a read-only local skill named `assess-research-problem` that evaluates two
separate questions:

1. Is a proposed research problem worth pursuing?
2. Is it suitable for the autoresearch loop represented by this repository?

The separation matters. A foundational problem can be scientifically important
while offering almost no useful feedback to an automated experimental loop.
Conversely, a benchmark can be easy to automate while offering little research
value. The skill must preserve that distinction instead of collapsing both
judgements into an intuitive yes-or-no answer.

## Scope and boundaries

The skill evaluates, explains, and suggests one reformulation. It does not:

- answer the research question;
- search for or implement a solution;
- run an experiment;
- create or update a record under `problems/`;
- modify `knowledge/`, `drafts/`, or `literature/`; or
- treat its assessment as trusted research knowledge.

The skill is read-only. A separate workflow may later use its output when
creating a problem record, but this skill neither performs nor authorizes that
write.

## Inputs

The minimum input is a candidate research question. Useful optional context
includes:

- the current baseline or known gap;
- the artifact that an autoresearch attempt would modify;
- the proposed metric and correctness checks;
- the development and fresh-evaluation data split;
- the estimated runtime of one attempt; and
- available compute, data, and dependency constraints.

Do not turn missing context into a failing score. Represent an unknown input as
a score range, reduce confidence, and ask one highest-impact question at a time
when further clarification is necessary.

## Trust-boundary behavior

Before stating a research fact, definition, benchmark, parameter, or
interpretation, follow `read-knowledge`: run
`make knowledge-resolve QUERY="<the candidate research question>"` and act on
its returned status.

- On `match`, read every file in `bundle.orderedFiles`, in order, before using
  the repository's learned knowledge in the assessment.
- On `ambiguous`, present every alternative and let the user choose. Do not
  continue the evidence-dependent assessment by silently selecting a topic.
- On `no-match`, say the learned knowledge has no match and mark affected
  evidence-dependent dimensions as unknown. Do not fall back to `drafts/` or
  `literature/`.

Only enter an explicitly named external-research workflow if the user asks for
one. Keep any external findings labelled as external evidence. An assessment is
never promoted into trusted knowledge by being produced or scored.

## Evaluation workflow

1. Restate the candidate as one precise research objective without silently
   changing its scope.
2. Extract the baseline, modifiable search object, evaluation procedure,
   correctness safeguards, fresh-evaluation plan, and expected attempt time.
3. Resolve and read trusted knowledge before making evidence-dependent research
   claims.
4. Score research value `V` and autoresearch suitability `A` independently.
5. Calculate their harmonic mean `S` so that a weak axis cannot be hidden by a
   strong one.
6. Report the verdict, confidence, strongest evidence, largest bottleneck, one
   recommended reformulation, and remaining information gaps.

No individual dimension is a hard veto. Runtime is a soft penalty. A candidate
such as proving P = NP should receive high research value and extremely low
autoresearch suitability, producing a low combined score naturally rather than
being rejected by a special-case blacklist.

## Scoring scale and evidence state

Score each known dimension from 0 to 5:

- `0`: absent or fundamentally unsuitable;
- `1`: very weak;
- `2`: weak;
- `3`: adequate;
- `4`: strong;
- `5`: exceptional.

Attach one evidence state to every dimension:

- `supported`: backed by trusted evidence or explicit user-provided facts;
- `inferred`: a reasoned inference from the supplied problem formulation;
- `unknown`: information needed for the judgement is missing.

`unknown` is not a numeric zero. Preserve the plausible score interval for an
unknown dimension and calculate an overall interval. Do not emit a falsely
precise exact score when important inputs remain unknown.

## Research value score

Calculate `V` on a 0–100 scale from the following weighted dimensions:

| Dimension | Weight | Question |
|---|---:|---|
| Importance | 20% | Would success resolve a consequential scientific or methodological need? |
| Gap and novelty | 20% | Is there a specific, evidence-supported gap beyond reproducing known work? |
| Plausibility | 15% | Is there a credible reason to expect useful progress? |
| Learning from failure | 15% | Would unsuccessful attempts still reduce uncertainty or teach something reusable? |
| Generality and publication potential | 15% | Could the result transfer beyond one instance and support a clear contribution? |
| Expected value relative to cost | 15% | Is the likely knowledge gain worth the compute and human attention? |

For known scores `v_i` on the 0–5 scale and percentage weights `w_i`, compute:

```text
V = sum(w_i * v_i / 5)
```

## Autoresearch suitability score

Calculate `A` on a 0–100 scale from the following weighted dimensions:

| Dimension | Weight | Question |
|---|---:|---|
| Modifiable search object | 20% | Is there code, an algorithm, a model, or configuration that repeated attempts can change? |
| Executable objective | 20% | Can a script evaluate each attempt consistently? |
| Correctness and anti-gaming | 15% | Does the evaluation verify validity and resist leakage, hard-coding, and metric gaming? |
| Incremental feedback | 15% | Do failed attempts provide directional information rather than only a terminal pass or fail? |
| Fresh evaluation | 10% | Can a frozen or hidden evaluation distinguish general progress from overfitting? |
| Reproducibility and auditability | 10% | Can code, inputs, environment, logs, and results be reproduced and inspected in this repository? |
| Attempt runtime | 10% | How quickly can one complete feedback cycle run? |

For known scores `a_i` and weights `w_i`, compute:

```text
A = sum(w_i * a_i / 5)
```

### Runtime score

Five minutes is the ideal attempt duration, not a hard limit. For an estimated
runtime `t` in minutes, compute:

```text
T = clamp(5 - log2(max(t, 5) / 5), 0, 5)
```

This gives the following anchors:

| Runtime | Score |
|---:|---:|
| 5 minutes or less | 5 |
| 10 minutes | 4 |
| 20 minutes | 3 |
| 40 minutes | 2 |
| 80 minutes | 1 |
| 160 minutes or more | 0 |

Use the continuous value between anchors. When runtime is unknown, preserve its
score as unknown rather than assuming a five-minute attempt.

## Combined score and verdict

For exact `V` and `A`, compute the harmonic mean:

```text
S = 0                          when V + A = 0
S = 2 * V * A / (V + A)       otherwise
```

If either axis is an interval, propagate its lower and upper endpoints through
the calculation and report an interval for `S`.

Interpret each axis using these decision bands:

- `strong`: 70–100;
- `mixed`: 40–69.99;
- `weak`: 0–39.99.

These bands classify the completed axis scores; they are not single-dimension
eligibility gates. `S` is useful for ranking candidates, but the verdict uses
`V` and `A` separately so that it can name whether value or mechanism fit is the
limiting factor.

Choose one verdict using the following rules:

- `DO NOW`: both `V` and `A` are strong.
- `REFRAME`: `V` is strong, `A` is not strong, and one credible bounded
  reformulation could materially improve `A`.
- `NOT AUTORESEARCH`: `V` is strong, `A` is weak, and no credible bounded
  reformulation is apparent.
- `DEFER`: every remaining case, including a candidate whose executability is
  stronger than its current research-value case.

When an unknown-score interval permits more than one verdict, report the
midpoint verdict as provisional, set confidence to low, show the verdict range,
and ask the one question most likely to resolve the boundary. Use medium
confidence when unknowns remain but cannot change the verdict, and high
confidence only when every decision-relevant dimension is supported or based
on explicit user-provided facts.

Do not use a single dimension as an automatic rejection rule. Explain which
axis drove the verdict. In particular, describe high-value, low-suitability
problems as poor fits for autoresearch, not as unworthy research.

## Output contract

Return the following sections in order:

1. `Normalized problem` — one sentence stating the evaluated objective.
2. `Verdict` — one label, `V`, `A`, `S`, and overall confidence.
3. `Research value` — a compact table of score, weight, evidence state, and
   one-line rationale for every `V` dimension.
4. `Autoresearch suitability` — the same fields for every `A` dimension.
5. `Largest bottleneck` — exactly one factor that most limits the current
   decision.
6. `Recommended reframe` — exactly one bounded reformulation that preserves as
   much of the original research value as possible. If none is credible, say
   so rather than inventing one.
7. `Information gaps` — only unknowns that could materially change the verdict.

Keep research value, mechanism fit, and evidence confidence visibly separate.

## Error and uncertainty handling

- If the candidate is too broad to identify the research objective, state the
  ambiguity and ask one scope question before scoring.
- If key details are missing but a partial assessment is still useful, report
  score intervals and ask about the unknown with the greatest effect on the
  verdict.
- If the runtime is missing, leave only the runtime dimension unknown; do not
  erase other available scores.
- If the proposed metric can be gamed, lower the correctness and anti-gaming
  score and name the failure mode.
- If correctness cannot be checked independently of the optimized metric,
  reflect that weakness separately from speed or headline performance.
- If the resolver is ambiguous, stop the evidence-dependent assessment until
  the user selects a topic.
- If trusted knowledge has no match, do not infer novelty or importance from
  untrusted repository trees.

## Repository shape

Implementation adds one canonical skill file:

```text
skills/assess-research-problem/SKILL.md
```

The repository convention that each local skill is a single `SKILL.md` takes
precedence over adding skill-specific scripts, assets, reference files, or UI
metadata. Update `docs/skills.md` to document the new ownership boundary and
extend `tests/agent/skill-contracts.test.ts` so the trust and scoring clauses
cannot disappear silently.

## Verification

Contract tests should cover the presence of the two-axis model, harmonic mean,
soft runtime formula, read-only boundary, resolver behavior, and prohibition on
using `drafts/` or `literature/` as answer sources.

Behavioral forward-tests should include:

1. `Resolve P = NP.` Expect high research value, near-zero autoresearch
   suitability, and `NOT AUTORESEARCH` unless a genuinely bounded neighboring
   problem is proposed.
2. `Search for a faster exact SAT algorithm on a frozen benchmark with witness
   verification.` Expect materially higher suitability than the foundational
   P = NP question.
3. Evaluate the same candidate at five and twenty minutes per attempt. Expect
   only the runtime component to change from 5 to 3.
4. Optimize a public benchmark whose answers can be hard-coded. Expect a low
   correctness and anti-gaming score with the exploit named.
5. Optimize a reproducible but scientifically trivial metric. Expect high
   executability but a `DEFER` verdict driven by research value.
6. Evaluate a candidate with no trusted knowledge match. Expect unknown
   evidence-dependent scores and no claims sourced from `drafts/` or
   `literature/`.

The test set should verify explanations and boundaries rather than demand one
exact subjective score for every dimension.
