import generatedIndex from "../../../.generated/problem-index.json";
import generatedResearchIndex from "../../../.generated/research-index.json";
import {
  getStaticResearchExample,
  isStaticResearchExampleProblem,
} from "@/lib/problems/example-research.mjs";
import { buildExampleResearchLedger } from "@/lib/problems/example-presentation.mjs";
import { createProblemRepository } from "@/lib/problems/repository.mjs";
import { createResearchRepository } from "@/lib/problems/research-repository.mjs";
import { buildProblemDetailResearchState } from "@/lib/problems/research-route-data.mjs";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AssessmentPanel } from "./assessment-panel";
import { StaticAutoresearchPanel } from "./static-autoresearch-panel";

export default async function ProblemDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const repository = createProblemRepository(generatedIndex);
  const problem = repository.getProblem(id);

  if (!problem) {
    notFound();
  }

  const researchRepository = createResearchRepository(generatedResearchIndex);
  const researchRecord = researchRepository.getResearchRecord(problem.id);
  const researchDiagnostics = researchRepository.getDiagnostics(problem.id);
  const researchState = buildProblemDetailResearchState({
    problem,
    researchRecord,
    diagnostics: researchDiagnostics,
  });
  const sidecarAvailable = Boolean(
    process.env.AUTORESEARCH_SERVICE_ORIGIN
      && process.env.AUTORESEARCH_CAPABILITY_TOKEN,
  );

  if (isStaticResearchExampleProblem(problem.id)) {
    const example = getStaticResearchExample(problem.id);
    if (!example) {
      notFound();
    }
    const ledger = buildExampleResearchLedger(example);

    return (
      <main className="detail-shell research-shell">
        <Link className="back-link" href="/">← Back to problems</Link>
        <header className="research-header">
          <div>
            <p className="eyebrow">{problem.id}</p>
            <h1>{problem.title}</h1>
            <p className="detail-summary">{problem.summary}</p>
          </div>
          <div className="research-badges" aria-label="Research metadata">
            <span>Solving</span>
            <span>Example data</span>
            <span>Blind evaluation</span>
            <span>300 s / run</span>
          </div>
        </header>

        <StaticAutoresearchPanel />

        <p className="example-disclaimer">{example.manifest.disclaimer}</p>
        <AssessmentPanel problemId={problem.id} />

        <dl className="research-metric-strip" aria-label="Research metrics">
          {ledger.cards.map((card) => (
            <div key={card.label}>
              <dt>{card.label}</dt>
              <dd>{card.value}</dd>
            </div>
          ))}
        </dl>

        <section className="attempt-ledger" aria-labelledby="attempt-ledger-heading">
          <div className="section-heading-row">
            <h2 id="attempt-ledger-heading">Attempts</h2>
            <p>{ledger.rows.length} synthetic attempts</p>
          </div>
          <div className="attempt-table-wrap">
            <table className="attempt-table">
              <thead>
                <tr>
                  <th scope="col">Attempt</th><th scope="col">Method</th><th scope="col">Stage</th><th scope="col">Decision</th><th scope="col">Gate</th><th scope="col">Verified</th><th scope="col">Hits</th><th scope="col">Quality</th><th scope="col">Runtime</th><th scope="col">P95</th><th scope="col">Speedup</th><th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {ledger.rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row"><Link href={row.href}>{row.id}</Link></th>
                    <td><strong>{row.method}</strong><span>{row.summary}</span></td>
                    <td>{row.stage}</td>
                    <td>{row.decision}</td>
                    <td>{row.gate.map((item) => <span key={item.label}>{item.label}: {item.value}</span>)}</td>
                    <td>{row.verified}</td>
                    <td>{row.hits}</td>
                    <td>{row.quality}</td>
                    <td>{row.runtime}</td>
                    <td>{row.p95}</td>
                    <td>{row.speedup}</td>
                    <td><Link href={row.href}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="attempt-card-list" aria-label="Attempt cards">
            {ledger.rows.map((row) => (
              <Link className="attempt-card" href={row.href} key={row.id}>
                <span>{row.id}</span>
                <strong>{row.method}</strong>
                <small>{row.decision} · {row.verified} verified · {row.speedup}</small>
              </Link>
            ))}
          </div>
        </section>
      </main>
    );
  }

  const { AutoresearchPanel } = await import("./autoresearch-panel");

  if (researchState.kind === "research") {
    const ledger = researchState.ledger;
    return (
      <main className="detail-shell research-shell">
        <Link className="back-link" href="/">← Back to problems</Link>
        <header className="research-header">
          <div>
            <p className="eyebrow">{problem.id}</p>
            <h1>{problem.title}</h1>
            <p className="detail-summary">{problem.summary}</p>
          </div>
          <div className="research-badges" aria-label="Research metadata">
            <span>{problem.status}</span>
            <span>Imported record</span>
            <span>{ledger.rows.length} attempts</span>
          </div>
        </header>
        <AutoresearchPanel problemId={problem.id} initialEligibility={problem.status === "qualifying" || problem.status === "accepted"} sidecarAvailable={sidecarAvailable} />
        <AssessmentPanel problemId={problem.id} />
        <p className="example-disclaimer">{researchState.disclaimer}</p>
        <dl className="research-metric-strip" aria-label="Research metrics">
          {ledger.cards.map((card) => (
            <div key={card.label}><dt>{card.label}</dt><dd>{card.value}</dd></div>
          ))}
        </dl>
        <section className="attempt-ledger" aria-labelledby="attempt-ledger-heading">
          <div className="section-heading-row">
            <h2 id="attempt-ledger-heading">Attempts</h2>
            <p>{ledger.rows.length} imported attempts</p>
          </div>
          <div className="attempt-table-wrap">
            <table className="attempt-table">
              <thead>
                <tr>
                  <th scope="col">Attempt</th><th scope="col">Method</th><th scope="col">Decision</th><th scope="col">Public contract</th><th scope="col">Runs</th><th scope="col">Verified</th><th scope="col">Hits</th><th scope="col">Quality</th><th scope="col">Runtime</th><th scope="col">P95</th><th scope="col">Candidate</th><th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {ledger.rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row"><Link href={row.href}>{row.id}</Link></th>
                    <td><strong>{row.method}</strong><span>{row.summary}</span></td>
                    <td>{row.decision}</td>
                    <td>{row.publicContract}</td>
                    <td>{row.runs}</td>
                    <td>{row.verified}</td>
                    <td>{row.hits}</td>
                    <td>{row.quality}</td>
                    <td>{row.runtime}</td>
                    <td>{row.p95}</td>
                    <td>{row.candidate}</td>
                    <td><Link href={row.href}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="attempt-card-list" aria-label="Attempt cards">
            {ledger.rows.map((row) => (
              <Link className="attempt-card" href={row.href} key={row.id}>
                <span>{row.id}</span>
                <strong>{row.method}</strong>
                <small>{row.decision} · {row.verified} verified · {row.candidate}</small>
              </Link>
            ))}
          </div>
        </section>
      </main>
    );
  }

  if (researchState.kind === "research-diagnostics") {
    return (
      <main className="detail-shell">
        <Link className="back-link" href="/">← Back to problems</Link>
        <p className="eyebrow">{problem.id}</p>
        <h1>{problem.title}</h1>
        <section className="detail-panel" aria-labelledby="research-diagnostics-heading">
          <h2 id="research-diagnostics-heading">Imported record integrity diagnostics</h2>
          <p>The imported research record could not be rendered.</p>
          <ul>
            {researchState.diagnostics.map((diagnostic) => (
              <li key={`${diagnostic.relativePath}:${diagnostic.field}:${diagnostic.message}`}>
                <code>{diagnostic.relativePath}</code>: {diagnostic.message}
              </li>
            ))}
          </ul>
        </section>
      </main>
    );
  }

  return (
    <main className="detail-shell">
      <Link className="back-link" href="/">← Back to problems</Link>
      <p className="eyebrow">{problem.id}</p>
      <h1>{problem.title}</h1>
      <p className="detail-summary">{problem.summary}</p>
      <AutoresearchPanel problemId={problem.id} initialEligibility={problem.status === "qualifying" || problem.status === "accepted"} sidecarAvailable={sidecarAvailable} />
      <AssessmentPanel problemId={problem.id} />
      <section className="detail-panel" aria-labelledby="detail-status-heading">
        <h2 id="detail-status-heading">Problem detail</h2>
        <p>The detailed problem workspace will be designed next; this page currently locks the route, identity, and return path.</p>
      </section>
    </main>
  );
}
