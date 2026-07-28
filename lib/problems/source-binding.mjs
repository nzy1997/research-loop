const REQUIRED_FIELDS = ["kind", "repository", "revision", "path", "digest"];
const REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHttpsRepository(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isRepositoryRelativePosixPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function validateSourceBinding(binding) {
  const errors = [];
  const addError = (field, message) => errors.push({ field, message });

  if (!isObject(binding)) {
    addError("binding", "sourceBinding must be an object.");
    return { ok: false, errors };
  }

  for (const field of Object.keys(binding)) {
    if (!REQUIRED_FIELDS.includes(field)) {
      addError(field, `Unknown source binding field: ${field}.`);
    }
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in binding)) {
      addError(field, "Required source binding field is missing.");
    }
  }

  if (binding.kind !== "git-path") {
    addError("kind", "kind must be git-path.");
  }
  if (!isHttpsRepository(binding.repository)) {
    addError("repository", "repository must be an HTTPS URL without credentials.");
  }
  if (typeof binding.revision !== "string" || !REVISION_PATTERN.test(binding.revision)) {
    addError("revision", "revision must be a lowercase 40- or 64-character hexadecimal commit ID.");
  }
  if (!isRepositoryRelativePosixPath(binding.path)) {
    addError("path", "path must be a normalized repository-relative POSIX path.");
  }
  if (typeof binding.digest !== "string" || !DIGEST_PATTERN.test(binding.digest)) {
    addError("digest", "digest must be a sha256: value followed by 64 lowercase hexadecimal characters.");
  }

  return errors.length === 0 ? { ok: true, value: binding } : { ok: false, errors };
}

export function verifySourceBinding(binding, observed) {
  const declared = validateSourceBinding(binding);
  if (!declared.ok) {
    return {
      ok: false,
      errors: declared.errors.map((error) => ({
        field: `binding.${error.field}`,
        message: error.message,
      })),
    };
  }

  const observedValidation = validateSourceBinding(observed);
  if (!observedValidation.ok) {
    return {
      ok: false,
      errors: observedValidation.errors.map((error) => ({
        field: `observed.${error.field}`,
        message: error.message,
      })),
    };
  }

  const messages = {
    repository: "Observed repository does not match the declared binding.",
    revision: "Observed revision does not match the declared binding.",
    path: "Observed path does not match the declared binding.",
    digest: "Observed digest does not match the declared binding.",
  };
  const errors = Object.keys(messages)
    .filter((field) => binding[field] !== observed[field])
    .map((field) => ({ field, message: messages[field] }));

  return errors.length === 0 ? { ok: true, value: binding } : { ok: false, errors };
}
