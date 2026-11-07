/**
 * Pure dashboard selectors over persisted project metadata and artifact
 * listings. No IPC, no DOM, no side effects.
 *
 * Every count here answers "projects with confirmed output on disk":
 * a missing or failed artifact listing never counts toward a metric,
 * so the dashboard omits what it cannot prove instead of guessing.
 */

function isValidDocument(summary) {
  return (
    summary !== null &&
    typeof summary === "object" &&
    summary.present === true &&
    summary.invalid !== true
  );
}

function countOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/**
 * True when the listing confirms persisted analysis output: an
 * adaptive manifest, detected events, or stored observations.
 */
export function hasAnalysisOutput(listing) {
  if (listing === null || typeof listing !== "object") {
    return false;
  }
  if (isValidDocument(listing.manifest)) {
    return true;
  }
  if (isValidDocument(listing.events)) {
    return true;
  }
  return countOf(listing.observations?.count) > 0;
}

/**
 * True when the listing confirms persisted commentary output: rendered
 * commentary lines or a final script document.
 */
export function hasCommentaryOutput(listing) {
  if (listing === null || typeof listing !== "object") {
    return false;
  }
  if (
    isValidDocument(listing.commentary) &&
    countOf(listing.commentary.lines) > 0
  ) {
    return true;
  }
  return isValidDocument(listing.script);
}

/**
 * Aggregate dashboard counts. `listings` maps project ids to their
 * `listArtifacts` payload (a Map or a plain object); ids without a
 * listing contribute only to the project total.
 */
export function summarizeDashboard(projects, listings = null) {
  const list = Array.isArray(projects) ? projects : [];
  const resolve =
    listings instanceof Map
      ? (id) => listings.get(id) ?? null
      : listings !== null && typeof listings === "object"
        ? (id) =>
            Object.prototype.hasOwnProperty.call(listings, id)
              ? listings[id]
              : null
        : () => null;
  let analyses = 0;
  let commentaries = 0;
  for (const project of list) {
    if (project === null || typeof project !== "object") {
      continue;
    }
    const listing = resolve(project.id);
    if (hasAnalysisOutput(listing)) {
      analyses += 1;
    }
    if (hasCommentaryOutput(listing)) {
      commentaries += 1;
    }
  }
  return { projects: list.length, analyses, commentaries };
}

const FRAME_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * First extracted frame filename for a card thumbnail, or null when
 * the listing has no usable frame. The name feeds the audited
 * `project://` media scope, which revalidates main-side.
 */
export function firstFrameName(listing) {
  const items = listing?.frames?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  const name = items[0]?.name;
  return typeof name === "string" && FRAME_NAME_PATTERN.test(name)
    ? name
    : null;
}

/**
 * Compact artifact chips for a project card, derived only from
 * confirmed listing entries: `[{ key, label }]`. Empty when nothing
 * usable is persisted.
 */
export function describeArtifacts(listing) {
  if (listing === null || typeof listing !== "object") {
    return [];
  }
  const chips = [];
  const events = isValidDocument(listing.events)
    ? countOf(listing.events.count)
    : 0;
  if (events > 0) {
    chips.push({ key: "events", label: `${events} ${events === 1 ? "event" : "events"}` });
  }
  const lines = isValidDocument(listing.commentary)
    ? countOf(listing.commentary.lines)
    : 0;
  if (lines > 0) {
    chips.push({ key: "lines", label: `${lines} ${lines === 1 ? "line" : "lines"}` });
  }
  if (isValidDocument(listing.script)) {
    chips.push({ key: "script", label: "script" });
  }
  return chips;
}
