import { teardownLocalAssessmentFixture } from "./local-assessment-fixture";

export default async function globalTeardown() {
  await teardownLocalAssessmentFixture();
}
