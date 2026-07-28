# Assess Research Problem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the local `assess-research-problem` skill so agents can judge research value separately from fit for this repository's autoresearch loop.

**Architecture:** This is a repository-local agent skill, not runtime code. The behavior is specified in one `skills/assess-research-problem/SKILL.md`, documented in `docs/skills.md`, and guarded by `tests/agent/skill-contracts.test.ts`.

**Tech Stack:** Markdown skills, YAML frontmatter parsed by `yaml`, Node's built-in `node:test`.

## Global Constraints

- Implement only in the current `research-loop` checkout.
- Keep every local skill as a single `SKILL.md`; do not add skill-specific scripts, assets, references, or `agents/openai.yaml`.
- Preserve the trust boundary: `knowledge/**/*.qmd` is the only trusted repository content authority, `drafts/` is untrusted, and `literature/` is external evidence.
- The new skill is read-only: it may assess, explain, and suggest one reformulation, but it must not answer the problem, run experiments, create records, or modify `knowledge/`, `drafts/`, or `literature/`.
- Use test-first edits: add the failing contract test before creating the new skill.
- Runtime is a soft score only: `T = clamp(5 - log2(max(t, 5) / 5), 0, 5)`.

---

### Task 1: Contract Tests

**Files:**
- Modify: `tests/agent/skill-contracts.test.ts`

**Interfaces:**
- Consumes: existing `readSkill(name)`, `Clause`, and contract-test loops.
- Produces: `SKILL_NAMES` includes `"assess-research-problem"` and `CLAUSES["assess-research-problem"]` guards the new skill.

- [ ] **Step 1: Write the failing test**

Change the local skill list and type:

```ts
const SKILL_NAMES = ["download-ref", "read-knowledge", "review-draft", "assess-research-problem"] as const;
```

Add this clause block before `CLAUSES`:

```ts
/** The plan's requirements for `assess-research-problem`, clause by clause. */
const ASSESS_RESEARCH_PROBLEM: readonly Clause[] = [
  { requirement: "triggers on judging whether a research problem is worth doing", in: "description", pattern: /worth (doing|pursuing)/i },
  { requirement: "triggers on judging autoresearch fit", in: "description", pattern: /autoresearch/i },
  { requirement: "separates research value from autoresearch suitability", in: "body", pattern: /research value[^.\n]*autoresearch suitability/i },
  { requirement: "requires the read-knowledge resolver before research facts", in: "body", pattern: /make knowledge-resolve QUERY="<the candidate research question>"/ },
  { requirement: "does not use drafts as a fallback", in: "body", pattern: /(never|do not|don't)[^.\n]*`drafts\/`[^.\n]*fallback/i },
  { requirement: "does not use literature as learned knowledge", in: "body", pattern: /(never|do not|don't)[^.\n]*`literature\/`[^.\n]*learned knowledge/i },
  { requirement: "is read-only", in: "body", pattern: /read-only/i },
  { requirement: "does not answer the research problem", in: "body", pattern: /(do not|don't|never)[^.\n]*answer[^.\n]*research (question|problem)/i },
  { requirement: "does not create problem records", in: "body", pattern: /(do not|don't|never)[^.\n]*(create|write|update)[^.\n]*`problems\/`/i },
  { requirement: "scores research value on a 0-100 axis", in: "body", pattern: /`V`[^.\n]*0[^.\n]*100/i },
  { requirement: "scores autoresearch suitability on a 0-100 axis", in: "body", pattern: /`A`[^.\n]*0[^.\n]*100/i },
  { requirement: "uses the harmonic mean for the combined score", in: "body", pattern: /harmonic mean/i },
  { requirement: "contains the runtime soft penalty formula", in: "body", pattern: /T = clamp\(5 - log2\(max\(t, 5\) \/ 5\), 0, 5\)/ },
  { requirement: "states five minutes is not a hard limit", in: "body", pattern: /5 minutes[^.\n]*not a hard limit/i },
  { requirement: "keeps unknowns as intervals", in: "body", pattern: /unknown[^.\n]*interval/i },
  { requirement: "does not use any dimension as a hard veto", in: "body", pattern: /No individual dimension[^.\n]*hard veto/i },
  { requirement: "handles P equals NP as high value and low suitability", in: "body", pattern: /P = NP[^.\n]*high research value[^.\n]*low autoresearch suitability/i },
  { requirement: "returns the normalized problem section", in: "body", pattern: /`Normalized problem`/ },
  { requirement: "returns the verdict section", in: "body", pattern: /`Verdict`/ },
  { requirement: "returns exactly one largest bottleneck", in: "body", pattern: /`Largest bottleneck`[^.\n]*exactly one/i },
  { requirement: "returns exactly one recommended reframe", in: "body", pattern: /`Recommended reframe`[^.\n]*exactly one/i },
];
```

Add the new block to `CLAUSES`:

```ts
const CLAUSES: Readonly<Record<SkillName, readonly Clause[]>> = {
  "read-knowledge": READ_KNOWLEDGE,
  "review-draft": REVIEW_DRAFT,
  "download-ref": DOWNLOAD_REF,
  "assess-research-problem": ASSESS_RESEARCH_PROBLEM,
};
```

Update the exact-skill assertion message:

```ts
"skills/ must hold exactly the documented local skills"
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/agent/skill-contracts.test.ts
```

Expected: FAIL because `skills/assess-research-problem/SKILL.md` does not exist and `docs/skills.md` has no row for the new skill.

- [ ] **Step 3: Commit**

Do not commit this red state. Continue to Task 2.

### Task 2: Skill Document

**Files:**
- Create: `skills/assess-research-problem/SKILL.md`

**Interfaces:**
- Consumes: contract clauses from Task 1 and the approved design spec.
- Produces: one self-contained local skill with frontmatter `name: assess-research-problem`.

- [ ] **Step 1: Write the minimal skill**

Create `skills/assess-research-problem/SKILL.md` with this structure:

```markdown
---
name: assess-research-problem
description: Use when judging whether a proposed research problem is worth doing, worth pursuing now, suitable for this repository's autoresearch loop, or should be reframed, deferred, or rejected as an autoresearch target.
---

# assess-research-problem

## Overview

Judge two axes separately: research value and autoresearch suitability. A problem can be important science and still be a poor fit for an automated loop.

This skill is read-only. Do not answer the research question or solve the research problem, run experiments, create or update `problems/`, or modify `knowledge/`, `drafts/`, or `literature/`.

## Trust boundary

Before stating a research fact, definition, benchmark, parameter, novelty claim, or interpretation, use `read-knowledge`:

```bash
make knowledge-resolve QUERY="<the candidate research question>"
```

On `match`, read every path in `bundle.orderedFiles` before using repository knowledge. On `ambiguous`, present every alternative and ask the user to choose before continuing evidence-dependent assessment. On `no-match`, say the learned knowledge has no match and mark affected evidence-dependent dimensions unknown.

Never use `drafts/` as a fallback. Do not use `literature/` as learned knowledge. Enter external research only when the user explicitly asks, and label it as external evidence.

## Scoring

Score each dimension 0-5 with evidence state `supported`, `inferred`, or `unknown`. Keep `unknown` as an interval, not zero.

Research value `V` is 0-100:

| Dimension | Weight |
|---|---:|
| Importance | 20 |
| Gap and novelty | 20 |
| Plausibility | 15 |
| Learning from failure | 15 |
| Generality and publication potential | 15 |
| Expected value relative to cost | 15 |

Autoresearch suitability `A` is 0-100:

| Dimension | Weight |
|---|---:|
| Modifiable search object | 20 |
| Executable objective | 20 |
| Correctness and anti-gaming | 15 |
| Incremental feedback | 15 |
| Fresh evaluation | 10 |
| Reproducibility and auditability | 10 |
| Attempt runtime | 10 |

Runtime is soft. 5 minutes is ideal, not a hard limit:

```text
T = clamp(5 - log2(max(t, 5) / 5), 0, 5)
```

The combined score is the harmonic mean: `S = 0` when `V + A = 0`, otherwise `S = 2 * V * A / (V + A)`.

No individual dimension is a hard veto. P = NP should naturally score as high research value and low autoresearch suitability, not as a special-case blacklist.

## Verdicts

Use axis bands: strong 70-100, mixed 40-69.99, weak 0-39.99.

| Verdict | Condition |
|---|---|
| `DO NOW` | `V` and `A` are strong. |
| `REFRAME` | `V` is strong, `A` is not strong, and one bounded reformulation could improve `A`. |
| `NOT AUTORESEARCH` | `V` is strong, `A` is weak, and no credible bounded reformulation is apparent. |
| `DEFER` | Every remaining case. |

If score intervals cross verdict boundaries, report the midpoint verdict as provisional, confidence low, the verdict range, and one question most likely to resolve it.

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
```

- [ ] **Step 2: Run focused skill contract test**

Run:

```bash
node --test tests/agent/skill-contracts.test.ts
```

Expected: FAIL only for missing `docs/skills.md` row or command documentation, because the skill exists but the docs are not updated yet.

### Task 3: Documentation, Verification, Commit

**Files:**
- Modify: `docs/skills.md`

**Interfaces:**
- Consumes: `skills/assess-research-problem/SKILL.md`.
- Produces: documentation row and command mapping that agree with tests.

- [ ] **Step 1: Document the new local skill**

Add this row to the skill ownership table:

```markdown
| `assess-research-problem` | Judge whether a candidate research problem is worth pursuing and whether it fits this repository's autoresearch loop. | Original to Research Loop. | User-provided problem statement and trusted `knowledge/**/*.qmd` only through `read-knowledge`. | Nothing. It reads, scores, explains, and recommends one reframe. | Answering or solving the research problem; running experiments; creating `problems/`; modifying `knowledge/`, `drafts/`, or `literature/`; treating `drafts/` or `literature/` as learned knowledge. |
```

Add this command row:

```markdown
| `make knowledge-resolve QUERY="…"` | `read-knowledge`, `assess-research-problem` |
```

Replace the old single-owner row for that command rather than duplicating it.

- [ ] **Step 2: Run focused tests**

Run:

```bash
node --test tests/agent/skill-contracts.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run skill validation target**

Run:

```bash
make skills
```

Expected: PASS.

- [ ] **Step 4: Inspect the scoped diff**

Run:

```bash
git diff -- docs/superpowers/plans/2026-07-28-assess-research-problem.md skills/assess-research-problem/SKILL.md docs/skills.md tests/agent/skill-contracts.test.ts
```

Expected: only the planned files changed.

- [ ] **Step 5: Commit only scoped files**

Run:

```bash
git add docs/superpowers/plans/2026-07-28-assess-research-problem.md skills/assess-research-problem/SKILL.md docs/skills.md tests/agent/skill-contracts.test.ts
git commit -m "feat: add research problem assessment skill"
```
