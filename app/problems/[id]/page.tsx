import generatedIndex from "../../../.generated/problem-index.json";
import {
  getStaticResearchExample,
  isStaticResearchExampleProblem,
} from "@/lib/problems/example-research.mjs";
import { buildExampleResearchLedger } from "@/lib/problems/example-presentation.mjs";
import { createProblemRepository } from "@/lib/problems/repository.mjs";
import Link from "next/link";
import { notFound } from "next/navigation";

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

        <p className="example-disclaimer">{example.manifest.disclaimer}</p>

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

  return (
    <main className="detail-shell">
      <Link className="back-link" href="/">← Back to problems</Link>
      <p className="eyebrow">{problem.id}</p>
      <h1>{problem.title}</h1>
      <p className="detail-summary">{problem.summary}</p>
      <section className="detail-panel" aria-labelledby="detail-status-heading">
        <h2 id="detail-status-heading">Problem detail</h2>
        <p>The detailed problem workspace will be designed next; this page currently locks the route, identity, and return path.</p>
      </section>
      {problem.sourceBinding ? (
        <section className="detail-panel authoritative-source-panel" aria-labelledby="authoritative-source-heading">
          <h2 id="authoritative-source-heading">Authoritative source</h2>
          <p>This console record is not the authoritative definition.</p>
          <dl className="authoritative-source-list">
            <div>
              <dt>Repository</dt>
              <dd><a href={problem.sourceBinding.repository} target="_blank" rel="noreferrer">{problem.sourceBinding.repository}</a></dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd><code>{problem.sourceBinding.revision}</code></dd>
            </div>
            <div>
              <dt>Path</dt>
              <dd><code>{problem.sourceBinding.path}</code></dd>
            </div>
            <div>
              <dt>Digest</dt>
              <dd><code>{problem.sourceBinding.digest}</code></dd>
            </div>
          </dl>
        </section>
      ) : null}
    </main>
  );
}
