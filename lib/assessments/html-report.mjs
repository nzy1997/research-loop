export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function scoreText(interval) {
  return `${interval.estimate} (${interval.min}-${interval.max})`;
}

function dimensionRows(dimensions) {
  return dimensions.map((item) => `
    <tr>
      <th scope="row">${escapeHtml(item.label)}</th>
      <td>${escapeHtml(item.id)}</td>
      <td>${escapeHtml(item.weight)}</td>
      <td>${escapeHtml(scoreText(item.score))}</td>
      <td>${escapeHtml(item.evidenceState)}</td>
      <td>${escapeHtml(item.rationale)}</td>
      <td>${escapeHtml(item.evidenceRefs.join(", "))}</td>
    </tr>`).join("");
}

export function renderAssessmentReport({ run, input, envelope, computed }) {
  const assessment = envelope.assessment;
  return `<!doctype html>
<html lang="${escapeHtml(envelope.language)}">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.problemId)} Assessment Report</title>
  <style>
    body { margin: 0; background: #f3f0e8; color: #17211d; font: 14px/1.55 system-ui, sans-serif; }
    main { width: min(1040px, calc(100% - 48px)); margin: 0 auto; padding: 42px 0 72px; }
    h1 { margin: 0 0 8px; font-size: 32px; line-height: 1.1; }
    h2 { margin: 28px 0 10px; font-size: 18px; }
    table { width: 100%; border-collapse: collapse; background: #fbfaf6; }
    th, td { border: 1px solid #d9d7ce; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #e9e6dc; }
    code { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .summary { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin: 18px 0; }
    .summary div { border: 1px solid #d9d7ce; background: #fbfaf6; padding: 12px; }
    .muted { color: #65716c; }
    @media print { main { width: auto; padding: 0; } }
  </style>
</head>
<body>
<main>
  <p class="muted">${escapeHtml(run.runId)} · policy ${escapeHtml(input.policyVersion)}</p>
  <h1>${escapeHtml(input.problemId)} Research Problem Assessment</h1>
  <p>${escapeHtml(input.problemTitle)}</p>
  <p>${escapeHtml(assessment.normalizedProblem)}</p>
  <section class="summary" aria-label="Assessment summary">
    <div><strong>Verdict</strong><br>${escapeHtml(assessment.verdict.label)}</div>
    <div><strong>Recommendation</strong><br>${escapeHtml(assessment.recommendation)}</div>
    <div><strong>Confidence</strong><br>${escapeHtml(assessment.confidence.level)}</div>
    <div><strong>Research Value</strong><br>${escapeHtml(scoreText(computed.scores.researchValue))}</div>
    <div><strong>Autoresearch Suitability</strong><br>${escapeHtml(scoreText(computed.scores.autoresearchSuitability))}</div>
    <div><strong>Combined</strong><br>${escapeHtml(scoreText(computed.scores.combined))}</div>
  </section>
  <h2>Input Digest</h2>
  <table><tbody>
    <tr><th scope="row">problem.json</th><td><code>${escapeHtml(input.problemJsonHash)}</code></td></tr>
    <tr><th scope="row">problem.md</th><td><code>${escapeHtml(input.problemMdHash)}</code></td></tr>
    <tr><th scope="row">skill</th><td><code>${escapeHtml(input.skillHash)}</code></td></tr>
    <tr><th scope="row">schema</th><td><code>${escapeHtml(input.schemaHash)}</code></td></tr>
  </tbody></table>
  <h2>Bottleneck and Reframe</h2>
  <p><strong>Largest bottleneck:</strong> ${escapeHtml(assessment.largestBottleneck)}</p>
  <p><strong>Recommended reframe:</strong> ${escapeHtml(assessment.recommendedReframe.text)}</p>
  <h2>Research Value Audit</h2>
  <table><thead><tr><th>Dimension</th><th>ID</th><th>Weight</th><th>Score</th><th>Evidence</th><th>Rationale</th><th>Refs</th></tr></thead><tbody>${dimensionRows(assessment.dimensions.researchValue)}</tbody></table>
  <h2>Autoresearch Fit Audit</h2>
  <table><thead><tr><th>Dimension</th><th>ID</th><th>Weight</th><th>Score</th><th>Evidence</th><th>Rationale</th><th>Refs</th></tr></thead><tbody>${dimensionRows(assessment.dimensions.autoresearchSuitability)}</tbody></table>
  <h2>Information Gaps</h2>
  <ul>${assessment.informationGaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join("") || "<li>None recorded.</li>"}</ul>
  <h2>Evidence Appendix</h2>
  <table><thead><tr><th>ID</th><th>Kind</th><th>Path</th><th>Locator</th><th>Summary</th></tr></thead><tbody>${assessment.evidence.map((item) => `<tr><th scope="row">${escapeHtml(item.id)}</th><td>${escapeHtml(item.kind)}</td><td><code>${escapeHtml(item.path)}</code></td><td>${escapeHtml(item.locator)}</td><td>${escapeHtml(item.summary)}</td></tr>`).join("")}</tbody></table>
</main>
</body>
</html>`;
}
