// Criteria as the screening screens name them: a short label, with the full text on demand.
import type { Criterion } from "../../data/schema.ts";
import { keyWords } from "../../lib/labels.ts";

const LENGTH = 22;

/** The protocol's short label, else the criterion's slot in words ("Study type"): with the
 * criterion's number beside it, that tells criteria apart better than the start of a sentence.
 * The full text goes in a hover. */
export const shortLabel = (criterion: Criterion): string => {
  const own = criterion.short_label?.trim();
  if (own) return own;
  // Two criteria on one slot (an inclusion and an exclusion) stay apart by their polarity.
  if (criterion.slot)
    return `${keyWords(criterion.slot)}${criterion.polarity === "exclude" ? " (exclusion)" : ""}`;
  const text = criterion.text_en.trim();
  if (text.length <= LENGTH) return text;
  const cut = text.slice(0, LENGTH + 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > 8 ? cut.slice(0, word) : text.slice(0, LENGTH)).replace(/[\s,:;(]+$/, "")}…`;
};

/** A criterion with its permanent number: its place in the protocol's search topic, from 1. A
 * stage shows only some criteria, but each keeps its number on every screen and export. */
export type NumberedCriterion = Criterion & { readonly number?: number };

/** A criterion's permanent number, or its place in the list if it came without one. */
export const numberOf = (
  criteria: ReadonlyArray<NumberedCriterion>,
  id: string | null | undefined,
): number | null => {
  const index = criteria.findIndex((c) => c.id === id);
  const criterion = criteria[index];
  return criterion ? (criterion.number ?? index + 1) : null;
};

// The keys 1 to 9 pick a criterion by its number; a stage with a number above 9 falls back to
// the criteria's places on screen, so every criterion keeps a key.
const keyed = (criteria: ReadonlyArray<NumberedCriterion>) =>
  criteria.every((c, i) => (c.number ?? i + 1) <= 9);

/** The key that picks a criterion (after e): its number, or its place when numbers run past 9. */
export const keyOf = (criteria: ReadonlyArray<NumberedCriterion>, id: string): string => {
  const index = criteria.findIndex((c) => c.id === id);
  return String(keyed(criteria) ? (numberOf(criteria, id) ?? index + 1) : index + 1);
};

/** The criterion a digit key picks, or undefined. */
export const byKey = <C extends NumberedCriterion>(
  criteria: ReadonlyArray<C>,
  key: string,
): C | undefined =>
  keyed(criteria)
    ? criteria.find((c, i) => String(c.number ?? i + 1) === key)
    : criteria[Number(key) - 1];

/** "2 Pretreated" for a criterion ID, or the ID itself if the stage has no such criterion. */
export const numbered = (
  criteria: ReadonlyArray<NumberedCriterion>,
  id: string | null | undefined,
) => {
  if (!id) return "";
  const criterion = criteria.find((c) => c.id === id);
  return criterion ? `${numberOf(criteria, id)} ${shortLabel(criterion)}` : id;
};
