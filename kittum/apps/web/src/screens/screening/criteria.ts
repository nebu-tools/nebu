// Criteria as the screening screens name them: a short label, with the full text on demand.
import type { Criterion } from "../../data/schema.ts";

const LENGTH = 22;

/** The protocol's short label, or the start of the criterion's text cut at a word. */
export const shortLabel = (criterion: Criterion): string => {
  const own = criterion.short_label?.trim();
  if (own) return own;
  const text = criterion.text_en.trim();
  if (text.length <= LENGTH) return text;
  // "Adults (18 years or older) who smoke" reads best as "Adults".
  const head = /^[^(:;,]{4,}?(?=\s*[(:;,])/.exec(text)?.[0];
  if (head && head.length <= LENGTH) return head;
  const cut = text.slice(0, LENGTH + 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > 8 ? cut.slice(0, word) : text.slice(0, LENGTH)).replace(/[\s,:;(]+$/, "")}…`;
};

/** "2 Pretreated" for a criterion ID, or the ID itself if the stage has no such criterion. */
export const numbered = (criteria: ReadonlyArray<Criterion>, id: string | null | undefined) => {
  if (!id) return "";
  const index = criteria.findIndex((c) => c.id === id);
  const criterion = criteria[index];
  return criterion ? `${index + 1} ${shortLabel(criterion)}` : id;
};
