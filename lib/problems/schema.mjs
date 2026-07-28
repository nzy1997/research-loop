import { validateSourceBinding } from "./source-binding.mjs";

export const PROBLEM_STATUSES = [
  "draft",
  "qualifying",
  "accepted",
  "solving",
  "solved",
  "publishing",
  "published",
  "rejected",
  "archived",
];

export const VISIBLE_STATUS_LABELS = {
  draft: "Draft",
  qualifying: "Qualifying",
  accepted: "Accepted",
  solving: "Solving",
  solved: "Solved",
  publishing: "Publishing",
  published: "Published",
  rejected: "Rejected",
  archived: "Archived",
};

export const GATE_READINESS = ["missing", "specified", "executable", "passed"];
export const ACTIVE_WITH_GATE_STATUSES = [
  "accepted",
  "solving",
  "solved",
  "publishing",
  "published",
];
export const SOLVED_OR_LATER_STATUSES = ["solved", "publishing", "published"];
export const PUBLISHED_STATUSES = ["published"];
export const REJECTION_KINDS = ["automatic", "human"];

export const REQUIRED_PROBLEM_MD_HEADINGS = [
  "Background and Gap",
  "Research Objective",
  "Publication Threshold",
  "Executable Gate",
  "Novelty Evidence",
  "Provenance",
  "Fresh Evaluation Plan",
];

export const PROBLEM_ID_PATTERN = /^Prob-(\d{3})$/;

const REQUIRED_FIELDS = [
  "schemaVersion",
  "id",
  "title",
  "summary",
  "status",
  "gate",
  "provenance",
  "lastActivity",
  "createdAt",
  "updatedAt",
];

const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, "rejection", "sourceBinding"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function markdownHasHeading(markdown, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(`^#{1,6}\\s+${escapedHeading}\\s*#*\\s*$`);
  let fence = null;

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const closingFence = new RegExp(`^\\s*${fence.marker}{${fence.length},}\\s*$`);
      if (closingFence.test(line)) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length };
      continue;
    }
    if (headingPattern.test(line)) {
      return true;
    }
  }

  return false;
}

export function isRunnableGate(readiness) {
  return readiness === "executable" || readiness === "passed";
}

export function isAcceptedOrLater(status) {
  return ACTIVE_WITH_GATE_STATUSES.includes(status);
}

export function validateProblemManifest(manifest, context = {}) {
  const errors = [];
  const relativePath = context.relativePath ?? "problem.json";
  const addError = (field, message) => errors.push({ relativePath, field, message });

  if (!isObject(manifest)) {
    addError("manifest", "Manifest must be an object.");
    return { ok: false, errors };
  }

  for (const field of Object.keys(manifest)) {
    if (!ALLOWED_FIELDS.has(field)) {
      addError(field, `Unknown top-level field: ${field}.`);
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in manifest)) {
      addError(field, "Required top-level field is missing.");
    }
  }

  if (manifest.schemaVersion !== 1) {
    addError("schemaVersion", "schemaVersion must be 1.");
  }
  if (typeof manifest.id !== "string" || !PROBLEM_ID_PATTERN.test(manifest.id)) {
    addError("id", "id must match Prob-###.");
  }
  for (const field of ["title", "summary"]) {
    if (!isNonEmptyString(manifest[field])) {
      addError(field, `${field} must be a non-empty string.`);
    }
  }
  if (!PROBLEM_STATUSES.includes(manifest.status)) {
    addError("status", "status must be a known lifecycle status.");
  }

  if (!isObject(manifest.gate)) {
    addError("gate", "gate must be an object.");
  } else {
    if (!isNonEmptyString(manifest.gate.type)) {
      addError("gate.type", "gate.type must be a non-empty string.");
    }
    if (!GATE_READINESS.includes(manifest.gate.readiness)) {
      addError("gate.readiness", "gate.readiness must be a known readiness value.");
    } else if (isAcceptedOrLater(manifest.status) && !isRunnableGate(manifest.gate.readiness)) {
      addError("gate.readiness", "Accepted and later statuses require an executable or passed gate.");
    }
  }

  if (!isObject(manifest.provenance) || !Number.isInteger(manifest.provenance.sourceCount) || manifest.provenance.sourceCount < 0) {
    addError("provenance.sourceCount", "provenance.sourceCount must be a non-negative integer.");
  }

  if (!isObject(manifest.lastActivity)) {
    addError("lastActivity", "lastActivity must be an object.");
  } else {
    if (!isNonEmptyString(manifest.lastActivity.summary)) {
      addError("lastActivity.summary", "lastActivity.summary must be a non-empty string.");
    }
    if (!isValidDate(manifest.lastActivity.at)) {
      addError("lastActivity.at", "lastActivity.at must be a valid date.");
    }
  }

  for (const field of ["createdAt", "updatedAt"]) {
    if (!isValidDate(manifest[field])) {
      addError(field, `${field} must be a valid date.`);
    }
  }

  if (manifest.status === "rejected") {
    if (!isObject(manifest.rejection)) {
      addError("rejection", "Rejected problems require rejection details.");
    } else {
      if (!REJECTION_KINDS.includes(manifest.rejection.kind)) {
        addError("rejection.kind", "rejection.kind must be automatic or human.");
      }
      if (!isNonEmptyString(manifest.rejection.reason)) {
        addError("rejection.reason", "rejection.reason must be a non-empty string.");
      }
    }
  } else if ("rejection" in manifest) {
    addError("rejection", "rejection is allowed only when status is rejected.");
  }

  if ("sourceBinding" in manifest) {
    const sourceBinding = validateSourceBinding(manifest.sourceBinding);
    if (!sourceBinding.ok) {
      for (const error of sourceBinding.errors) {
        addError(`sourceBinding.${error.field}`, error.message);
      }
    }
  }

  if (isAcceptedOrLater(manifest.status)) {
    const markdown = context.problemMdText;
    if (typeof markdown !== "string") {
      addError("problem.md", "Accepted and later statuses require problem.md.");
    } else {
      for (const heading of REQUIRED_PROBLEM_MD_HEADINGS) {
        if (!markdownHasHeading(markdown, heading)) {
          addError("problem.md", `problem.md is missing the heading: ${heading}.`);
        }
      }
    }
  }

  return errors.length === 0 ? { ok: true, value: manifest } : { ok: false, errors };
}
