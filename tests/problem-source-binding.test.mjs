import assert from "node:assert/strict";
import test from "node:test";

import {
  validateSourceBinding,
  verifySourceBinding,
} from "../lib/problems/source-binding.mjs";

const binding = {
  kind: "git-path",
  repository: "https://github.com/example/research-problems",
  revision: "0123456789abcdef0123456789abcdef01234567",
  path: "problems/Prob-017",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

test("accepts an immutable Git-path source binding", () => {
  assert.deepEqual(validateSourceBinding(binding), { ok: true, value: binding });
});

test("rejects mutable or unsafe source binding fields", () => {
  const cases = [
    [{ ...binding, repository: "http://github.com/example/research-problems" }, "repository"],
    [{ ...binding, revision: "main" }, "revision"],
    [{ ...binding, path: "problems/../private" }, "path"],
    [{ ...binding, digest: "sha256:not-a-digest" }, "digest"],
  ];

  for (const [candidate, field] of cases) {
    const result = validateSourceBinding(candidate);
    assert.equal(result.ok, false, field);
    assert.equal(result.errors[0].field, field);
  }
});

test("reports source drift without fetching or changing the binding", () => {
  const result = verifySourceBinding(binding, {
    ...binding,
    revision: "fedcba9876543210fedcba9876543210fedcba98",
    digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });

  assert.deepEqual(result, {
    ok: false,
    errors: [
      { field: "revision", message: "Observed revision does not match the declared binding." },
      { field: "digest", message: "Observed digest does not match the declared binding." },
    ],
  });
  assert.equal(binding.revision, "0123456789abcdef0123456789abcdef01234567");
});
