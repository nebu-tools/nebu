// The status vocabulary. One glyph set for every status: a check for include, met, low risk, and
// accepted; a cross for exclude, not met, and high risk; a question mark for unclear; a minus for
// some concerns, as the RoB 2 tool draws it; a circle for missing or not done. A status shows as a round mark in its colour, with
// a word beside it wherever there is room. Colour never carries the meaning alone.
import type { ReactNode } from "react";

import type { CriterionStatus, Judgement, Outcome, ProposalStatus } from "../data/schema.ts";

// The colour rule: green passes or includes; red fails or excludes; purple is unclear; orange is
// some concerns, a finished judgement between low and high; amber waits for a person (to verify, a disagreement, outdated); neutral ink marks
// importance (critical) and missing.
type Tone =
  | "include"
  | "exclude"
  | "unclear"
  | "concern"
  | "insufficient"
  | "neutral"
  | "petrol"
  | "waits";

const TONES: Record<Tone, string> = {
  include: "bg-include-wash text-include",
  exclude: "bg-exclude-wash text-exclude",
  unclear: "bg-unclear-wash text-unclear",
  concern: "bg-concern-wash text-concern",
  insufficient: "bg-insufficient-wash text-insufficient",
  neutral: "bg-sheet-2 text-ink-2 shadow-[inset_0_0_0_1px_var(--rule-strong)]",
  petrol: "bg-petrol-wash text-petrol",
  waits: "bg-marker-soft text-marker-edge shadow-[inset_0_0_0_1px_var(--marker-edge)]",
};

const TONE_TEXT: Record<Tone, string> = {
  include: "text-include",
  exclude: "text-exclude",
  unclear: "text-unclear",
  concern: "text-concern",
  insufficient: "text-insufficient",
  neutral: "text-ink-2",
  petrol: "text-petrol",
  waits: "text-marker-edge",
};

export interface Term {
  readonly glyph: ReactNode;
  readonly label: string;
  readonly tone: Tone;
}

export const PROPOSAL_STATUS: Record<ProposalStatus, Term> = {
  extracted: { glyph: "·", label: "Extracted", tone: "neutral" },
  missing: { glyph: "○", label: "Missing", tone: "insufficient" },
  ambiguous: { glyph: "?", label: "Ambiguous", tone: "unclear" },
  invalid: { glyph: "!", label: "Invalid", tone: "exclude" },
  error: { glyph: "!", label: "Error", tone: "exclude" },
};

// Plex has no check mark, so it is drawn.
const check = (
  <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true">
    <path
      d="M1 4.2l2.6 2.4L9 1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const VERDICTS: Record<CriterionStatus, Term> = {
  met: { glyph: check, label: "Met", tone: "include" },
  not_met: { glyph: "×", label: "Not met", tone: "exclude" },
  unclear: { glyph: "?", label: "Unclear", tone: "unclear" },
};

export const OUTCOMES: Record<Outcome, Term & { readonly past: string }> = {
  include: { glyph: check, label: "Include", past: "Included", tone: "include" },
  exclude: { glyph: "×", label: "Exclude", past: "Excluded", tone: "exclude" },
  unclear: { glyph: "?", label: "Unclear", past: "Marked unclear", tone: "unclear" },
  insufficient_information: {
    glyph: "○",
    label: "Insufficient information",
    past: "Marked insufficient information",
    tone: "insufficient",
  },
};

/** Risk-of-bias judgements: low as a check, some concerns as a minus in orange (never the "?" of
 * unclear), high as a cross. */
export const JUDGEMENTS: Record<Judgement, Term> = {
  low: { glyph: check, label: "Low", tone: "include" },
  some_concerns: { glyph: "\u2212", label: "Some concerns", tone: "concern" },
  high: { glyph: "×", label: "High", tone: "exclude" },
};

/** Something that waits for a person: a value to verify, a disagreement to look at. */
export const WAITS: Term = { glyph: "!", label: "Waits for you", tone: "waits" };
/** Not done yet, or missing. */
export const NOT_DONE: Term = { glyph: "○", label: "Not done", tone: "neutral" };

export const ADOPTED: Term = { glyph: check, label: "Adopted as evidence", tone: "petrol" };
export const ACCEPTED: Term = { glyph: check, label: "Accepted", tone: "include" };

export function Mark({ term, title }: { term: Term; title?: string }) {
  return (
    <span className={`mark ${TONES[term.tone]}`} title={title ?? term.label} aria-hidden="true">
      {term.glyph}
    </span>
  );
}

/** A mark with its word, for places with room. */
export function Status({ term, children }: { term: Term; children?: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${TONE_TEXT[term.tone]}`}>
      <Mark term={term} />
      <span>{children ?? term.label}</span>
    </span>
  );
}
