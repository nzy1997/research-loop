import { setupLocalAssessmentFixture } from "./local-assessment-fixture";
import { main } from "../../scripts/dev-problem-index.mjs";

await setupLocalAssessmentFixture();
await main({ vinextDevArgs: process.argv.slice(2) });
