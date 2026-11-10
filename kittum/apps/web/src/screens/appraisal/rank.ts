// The order an appraiser reads a signalling question's mentions in: where a trial reports how it
// was done first (methods, then results), the specific passage before the study-type label, and
// the title, the introduction, and the references last. The protocol terms find every
// "randomized"; this puts "a computer-generated randomization list" above "a randomized trial".
import type { Anchor } from "../../data/schema.ts";

export type Section =
  | "methods"
  | "results"
  | "abstract"
  | "body"
  | "discussion"
  | "introduction"
  | "front"
  | "references";

/** Lower is read first. */
const WEIGHT: Record<Section, number> = {
  methods: 0,
  results: 1,
  abstract: 2,
  body: 3,
  discussion: 4,
  introduction: 4,
  front: 5,
  references: 6,
};

const HEADING =
  /^(?:\d+(?:\.\d+)*\.?\s+)?(abstract|introduction|background|(?:(?:materials|patients|participants|subjects)\s+and\s+)?methods?|methodology|study design|trial design|results|discussion|conclusions?|references|bibliography|acknowledge?ments?|funding)\s*:?$/i;

const sectionOf = (word: string): Section => {
  const w = word.toLowerCase();
  if (w === "abstract") return "abstract";
  if (w === "introduction" || w === "background") return "introduction";
  if (w.includes("method") || w.includes("design")) return "methods";
  if (w === "results") return "results";
  if (w === "discussion" || w.startsWith("conclusion")) return "discussion";
  if (w === "references" || w === "bibliography") return "references";
  // Acknowledgements and funding sit with the back matter.
  return "references";
};

/** The headings of a layer's text, in order: where each section starts. */
export function sections(text: string): ReadonlyArray<readonly [number, Section]> {
  const found: Array<readonly [number, Section]> = [];
  const lines = /[^\r\n]+/g;
  for (let m = lines.exec(text); m; m = lines.exec(text)) {
    const line = m[0].trim();
    if (line.length > 60) continue;
    const heading = HEADING.exec(line);
    if (heading?.[1]) found.push([m.index, sectionOf(heading[1])]);
  }
  return found;
}

/** A study-type label ("randomized controlled trial") names the design, not how it was done. */
const LABEL =
  /^[\s-]*(?:controlled|clinical|cluster|pragmatic|parallel|pilot)?[\s-]*(?:trials?|stud(?:y|ies)|design)\b/i;
/** Words that describe the method itself; a passage with more of them says more. */
const SPECIFIC = [
  /computer/i,
  /generat/i,
  /block/i,
  /stratif/i,
  /allocat/i,
  /conceal/i,
  /envelope/i,
  /sequence/i,
  /\blist\b/i,
  /software/i,
  /random number/i,
  /minimi[sz]/i,
  /blind/i,
  /mask/i,
  /lost to follow/i,
  /withdr/i,
  /missing/i,
  /imput/i,
  /intention/i,
  /per.protocol/i,
  /pre.?registered/i,
  /protocol/i,
  /analysis plan/i,
];
/** A citation's tell-tales, for texts without a "References" heading. */
const CITATION = /et al\.|doi:|\b(?:19|20)\d{2}[;,.]\s*\d|\bJ(?:ournal)?\s+[A-Z]/;

/** The section a text offset falls in: "front" before the first heading (the title block). */
export function sectionAt(
  headings: ReadonlyArray<readonly [number, Section]>,
  start: number,
): Section {
  let current: Section = headings.length ? "front" : "body";
  for (const [at, section] of headings) {
    if (at > start) break;
    current = section;
  }
  return current;
}

/** Mentions closer than this many characters are one passage. */
const NEAR = 60;

/**
 * The mentions in reading order: best first, document order among equals. Mentions of one
 * passage ("randomized in blocks" found for "randomized" and again for "blocks") count once, as
 * the best of them.
 */
export function rankMentions(
  text: string,
  headings: ReadonlyArray<readonly [number, Section]>,
  mentions: ReadonlyArray<Anchor>,
): ReadonlyArray<Anchor> {
  const score = (m: Anchor) => {
    let section = sectionAt(headings, m.start);
    const context = `${m.quote.prefix ?? ""} ${m.quote.exact} ${m.quote.suffix ?? ""}`;
    if ((section === "body" || section === "discussion") && CITATION.test(context))
      section = "references";
    const label = LABEL.test(m.quote.suffix || text.slice(m.end, m.end + 40));
    const specific = Math.min(3, SPECIFIC.filter((word) => word.test(context)).length);
    return WEIGHT[section] * 8 + (label ? 3 : 0) + (3 - specific);
  };
  const scored = mentions.map((m, i) => ({ m, i, s: score(m) }));
  // One per passage: walk in document order, keep the best of each cluster of near mentions.
  const passages: Array<(typeof scored)[number]> = [];
  let last: (typeof scored)[number] | null = null;
  let end = -Infinity;
  for (const x of scored.toSorted((a, b) => a.m.start - b.m.start)) {
    if (last && x.m.start - end < NEAR) {
      if (x.s < last.s) passages[passages.length - 1] = last = x;
      end = Math.max(end, x.m.end);
      continue;
    }
    passages.push((last = x));
    end = x.m.end;
  }
  return passages.toSorted((a, b) => a.s - b.s || a.i - b.i).map((x) => x.m);
}
