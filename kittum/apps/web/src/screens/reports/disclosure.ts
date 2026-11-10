// What the AI-use disclosure says about blinding, from each stage's reveal setting and the
// decisions the ledger recorded. Never a fixed sentence: a stage whose reveal setting is "before"
// shows people the AI's reading while they decide, and the summary must say so.

export interface Agreement {
  readonly kind: "human_human" | "human_ai" | "human_ai_verified";
  /** Pseudonyms as the published disclosure prints them ("Reviewer 1", "AI"). */
  readonly raters: readonly [string, string];
  readonly actor_ids?: readonly [string, string];
  readonly items: number;
  readonly agreed: number;
  readonly table: Record<
    "include_include" | "include_exclude" | "exclude_include" | "exclude_exclude",
    number
  >;
  readonly kappa: number | null;
  readonly pabak: number | null;
  /** Records of the pair where a person decided with the AI's reading on screen. */
  readonly ai_on_screen?: number;
}

export interface DisclosureStage {
  readonly scope_id: string;
  readonly stage: "title_abstract" | "full_text";
  readonly mode: string;
  readonly reveal: string;
  readonly records: number;
  readonly records_read_by_ai: number;
  /** Exclusions the AI's checked reading proposes: the model's quote was found in the record. */
  readonly ai_proposed_exclusions: number;
  /** Exclusions the AI's own reading proposes, before Kittum checks the quotes. */
  readonly ai_own_reading_exclusions?: number;
  readonly excluded: number;
  /** People's exclusions the AI's checked reading also proposed. */
  readonly excluded_with_ai_proposal?: number;
  /** People's exclusions where a person saw the AI's reading before the final decision. */
  readonly excluded_after_ai_seen?: number;
  /** People's exclusions after the AI's disagreement sent the record to a blind extra screen. */
  readonly excluded_after_ai_rescreen?: number;
  readonly reveals_shown: number;
  readonly revised_after_reveal: number;
  /** The screeners' first decisions on records, the ones agreement compares. */
  readonly first_decisions?: { readonly total: number; readonly ai_on_screen: number };
  readonly agreement: ReadonlyArray<Agreement>;
}

export const STAGES = { title_abstract: "Title and abstract", full_text: "Full text" } as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** First decisions made blind and with the AI's reading on screen; null when not recorded. */
export function split(stage: DisclosureStage) {
  const first = stage.first_decisions;
  if (!first) return null;
  return {
    total: first.total,
    onScreen: first.ai_on_screen,
    blind: first.total - first.ai_on_screen,
  };
}

/** One sentence on how people in a stage saw the AI's reading, from its setting and counts. */
export function exposureSentence(stage: DisclosureStage): string {
  const counts = split(stage);
  if (stage.reveal === "before") {
    if (!counts)
      return "People saw the AI’s reading before deciding, once the AI had read the record.";
    if (counts.total === 0)
      return "People see the AI’s reading before deciding. Nobody has decided a record yet.";
    if (counts.onScreen === 0)
      return `People see the AI’s reading before deciding, but all ${plural(counts.total, "first decision was", "first decisions were")} made blind, before the AI had read the record.`;
    return (
      `${counts.onScreen} of ${plural(counts.total, "first decision was", "first decisions were")} made with the AI’s reading on screen` +
      (counts.blind ? `; ${counts.blind} blind, before the AI had read the record.` : ".")
    );
  }
  const blind = !counts
    ? "People decided blind."
    : counts.total === 1
      ? "People made the one first decision blind."
      : `People made all ${counts.total} first decisions blind.`;
  if (stage.reveal === "never") return `${blind} Kittum never showed them the AI’s reading.`;
  const when = stage.reveal === "always" ? "after each decision" : "when it disagreed";
  return (
    `${blind} Kittum then showed the AI’s reading ${when}: ${plural(stage.reveals_shown, "time", "times")}, ` +
    `and ${plural(stage.revised_after_reveal, "decision", "decisions")} changed after it.`
  );
}

/** Whether any first decision in the stage was made with the AI's reading on screen. */
export const seenBefore = (stage: DisclosureStage) =>
  stage.reveal === "before" && (split(stage)?.onScreen ?? 1) > 0;

/** The disclosure's lead sentence for the whole review. */
export function exposureHeadline(stages: ReadonlyArray<DisclosureStage>): string {
  const always = "The AI never excludes a record on its own: a person makes every decision.";
  if (stages.length === 0) return `${always} No stage is open yet.`;
  const seen = stages.filter(seenBefore);
  if (seen.length === 0)
    return `${always} Every first decision was made blind, before Kittum showed any AI output.`;
  const where = [...new Set(seen.map((s) => STAGES[s.stage].toLowerCase()))].join(" and ");
  return `${always} In ${where} screening, people saw the AI’s reading while deciding, so their agreement with the AI there is not independent.`;
}

const AI_READING = {
  human_ai: "The AI’s raw reading",
  human_ai_verified: "The AI’s quote-checked reading",
} as const;

/** The two sides of a pair: people by name where the project knows them, else the pseudonym. */
export function pairSides(
  a: Agreement,
  names: ReadonlyMap<string, string>,
): readonly [string, string] {
  const person = (i: 0 | 1) => names.get(a.actor_ids?.[i] ?? "") ?? a.raters[i];
  return [person(0), a.kind === "human_human" ? person(1) : AI_READING[a.kind]];
}

/** Fewer records than this, and kappa says nothing worth printing. */
export const TOO_FEW = 10;

/** Kappa below 0.4 is weak agreement; below 0 is worse than chance (as Progress flags it). */
export const kappaFlag = (kappa: number | null) =>
  kappa === null || kappa >= 0.4 ? null : kappa < 0 ? ("below" as const) : ("low" as const);
