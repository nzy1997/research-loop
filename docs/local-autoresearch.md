# Local autoresearch preparation

Autoresearch preparation is a local-only, operator-run phase. `make dev` starts
the Problem Console and its loopback sidecar; `make autoresearch-service`
starts the sidecar alone. Both require
`AUTORESEARCH_PRIVATE_ROOT=/absolute/private-data`. This operator-owned,
absolute directory must be readable and writable only by the evaluator host;
it is never placed in the browser, a repository record, or a deployed asset.

The sidecar listens only on loopback and uses a per-process capability token
between the development proxy and service. The browser never receives the
token. There is no production route, remote queue, cloud worker, or Pages
execution command.

## Preparation flow

From a qualifying or accepted local problem, preparation moves through queued,
scaffolding, benchmark construction, dataset preparation, and preflight. A job
may enter `needs_input`; it asks one visible question and resumes only after
the operator provides that answer. A successful job becomes ready; PR 1 stops
there. It prepares infrastructure and does not start attempt batches or a
campaign.

Public inputs stay in the staged candidate workspace. Development and blind
inputs stay below the private root and are exposed only to evaluator checks.
Candidate code does not receive private or blind data. Staging revisions live
under `.generated/autoresearch-*`; after host validation, the ready revision is
published under `problems/<id>/infrastructure/`.

## Preflight and recovery

Preflight validates the manifest, candidate API, public smoke and negative
checks, containment, private-data isolation, baseline reproduction, score
arithmetic, and reproducibility. If a check fails, inspect the local job's
events and stderr in its private job directory; do not copy `events.jsonl`,
`stderr.log`, preflight reports, or infrastructure files into Pages, commits,
or knowledge. Correct the local input or contract and prepare again.

On `SIGINT` or `SIGTERM`, the service shuts down its scheduler and marks active
preparation work interrupted. A later local preparation can retry it. GitHub
Pages is a static `Prob-000` showcase only: its preparation panel says
`Available in local mode` and has no controls or local route.
