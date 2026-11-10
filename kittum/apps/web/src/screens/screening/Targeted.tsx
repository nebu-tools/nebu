// What a targeted search (mode S, working documentation) adds to a screening screen: the AI's
// reading before the decision when the stage reveals `before`, the decision a second opinion is
// asked on, and the prompt for asking one (key f). Complete topics never show any of these: the
// server sends no AI reading before the decision and refuses a second opinion there.
import { useEffect, useRef, useState } from "react";

import type { Criterion, QueueItem, Reveal } from "../../data/schema.ts";
import { KeyHint } from "../../ui/Key.tsx";
import { OUTCOMES, Status } from "../../ui/Status.tsx";
import { AiReading } from "./AiReading.tsx";
import { numberOf, shortLabel } from "./criteria.ts";

type Ai = NonNullable<QueueItem["ai"]>;
type Asked = NonNullable<QueueItem["second_opinion"]>;

const criterionName = (
  id: string,
  criteria: ReadonlyArray<Criterion>,
  _labels: Record<string, string>,
) => {
  const criterion = criteria.find((c) => c.id === id);
  return {
    number: criterion ? numberOf(criteria, id) : null,
    // The same short name the criteria list shows ("Adults"), not the slot ("Population").
    label: criterion ? shortLabel(criterion) : id,
    text: criterion?.text_en ?? null,
  };
};

// For an inclusion, the met criteria that say most about whether a record belongs: the design
// and the intervention before the population.
const INCLUDE_ORDER = ["study_type", "intervention", "comparator", "outcome", "population"];

/** The one criterion that motivates the AI's proposal. For an exclusion, the first criterion it
 * reads as not met (one with a verified quote first). For an inclusion, the first criterion it
 * reads as unclear, because that is what the screener must check; if every criterion is met, a
 * met one with a verified quote, the design and the intervention first. Null when there is none. */
function decisive(ai: Ai, criteria: ReadonlyArray<Criterion> = []) {
  const spanned = (x: Ai["criteria"][number]) => Boolean(ai.quote_spans[x.criterion_id]);
  if (ai.excludes)
    return (
      ai.criteria.find((x) => x.status === "not_met" && spanned(x)) ??
      ai.criteria.find((x) => x.status === "not_met") ??
      null
    );
  const unclear = ai.criteria.find((x) => x.status === "unclear");
  if (unclear) return unclear;
  const rank = (x: Ai["criteria"][number]) => {
    const slot = criteria.find((c) => c.id === x.criterion_id)?.slot ?? "";
    const at = INCLUDE_ORDER.indexOf(slot);
    return at < 0 ? INCLUDE_ORDER.length : at;
  };
  return (
    ai.criteria
      .filter((x) => x.status === "met" && spanned(x))
      .sort((a, b) => rank(a) - rank(b))[0] ?? null
  );
}

/** The decisive criterion's verified quote, shaped as a reveal so the record view marks it as it
 * marks one. */
export function beforeQuote(
  item: QueueItem,
  criteria: ReadonlyArray<Criterion> = [],
): Reveal | null {
  const ai = item.ai;
  if (!ai) return null;
  const c = decisive(ai, criteria);
  if (!c || !ai.quote_spans[c.criterion_id]) return null;
  return {
    criterion_id: c.criterion_id,
    status: c.status,
    quote: c.quote ?? "",
    rationale: c.rationale,
    quote_verified: c.quote_verified,
    quote_span: ai.quote_spans[c.criterion_id] ?? null,
    downgraded_from: c.downgraded_from ?? null,
  };
}

/** The AI's other verified quotes in the record: what each criterion it read as met or not met
 * quoted, except the decisive one, which carries the marker. */
export function otherQuotes(
  item: QueueItem,
  criteria: ReadonlyArray<Criterion>,
  labels: Record<string, string>,
) {
  const ai = item.ai;
  if (!ai) return [];
  const main = decisive(ai, criteria)?.criterion_id;
  return ai.criteria
    .filter(
      (c) => c.criterion_id !== main && c.status !== "unclear" && ai.quote_spans[c.criterion_id],
    )
    .map((c) => {
      const name = criterionName(c.criterion_id, criteria, labels);
      return {
        span: ai.quote_spans[c.criterion_id]!,
        kind: c.status as "met" | "not_met",
        title: `AI: ${name.number ?? ""} ${name.label}, ${c.status === "met" ? "met" : "not met"}`,
        id: c.criterion_id,
        label: name.number !== null ? String(name.number) : "",
      };
    });
}

/** The AI's proposal before the decision, in a stage that reveals `before`: the verdict and the
 * one reading that motivates it, with the other criteria one click away. */
export function AiBefore({
  ai,
  criteria,
  labels,
  marked,
  heading = "The AI\u2019s reading, shown before you decide",
  others = true,
}: {
  ai: Ai;
  criteria: ReadonlyArray<Criterion>;
  labels: Record<string, string>;
  /** The criterion whose quote the record marks. */
  marked: string | null;
  /** The small heading above the verdict. */
  heading?: string;
  /** The other criteria, one click away. Off where the screen lists them itself. */
  others?: boolean;
}) {
  const [all, setAll] = useState(false);
  const main = decisive(ai, criteria);
  const name = main ? criterionName(main.criterion_id, criteria, labels) : null;
  const rest = ai.criteria.filter((c) => c.criterion_id !== main?.criterion_id);
  const count = (status: string) => rest.filter((c) => c.status === status).length;
  const summary = [
    count("met") ? `${count("met")} met` : null,
    count("unclear") ? `${count("unclear")} unclear` : null,
    count("not_met") ? `${count("not_met")} not met` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <section
      aria-label="AI judge"
      data-testid="ai-before"
      className="mx-3 mt-3 rounded-[4px] bg-sheet-2 px-4 py-3"
    >
      <h2 className="text-xs font-semibold text-ink-2">{heading}</h2>
      {/* One finding, said once: the deciding criterion and its status, the AI's reason, its
          quote. The criteria that pass are the list below, not repeated here. */}
      <p className="mt-1.5 text-md font-semibold" data-testid="ai-verdict">
        <Status
          term={
            ai.excludes
              ? OUTCOMES.exclude
              : main?.status === "unclear"
                ? OUTCOMES.unclear
                : OUTCOMES.include
          }
        >
          {ai.excludes && name
            ? `Exclude on ${name.number ?? ""} ${name.label}`.replace("  ", " ")
            : main?.status === "unclear" && name
              ? `${name.number ?? ""} ${name.label}: unclear${
                  count("unclear") ? ` (and ${count("unclear")} more)` : ""
                }`.trim()
              : "Include: every criterion passes"}
        </Status>
      </p>
      {main && name ? (
        <div className="mt-1 grid gap-1">
          {name.text ? (
            <p className="text-xs text-ink-3" data-testid="ai-criterion-text">
              {name.text}
            </p>
          ) : null}
          <AiReading
            compact
            named={false}
            criterion={name}
            status={main.status}
            downgradedFrom={main.downgraded_from}
            rationale={main.rationale}
            quote={main.quote || null}
            verified={main.quote_verified}
            marked={marked === main.criterion_id}
            markedAt={
              marked === main.criterion_id
                ? "Marked in the record."
                : ai.quote_spans[main.criterion_id]
                  ? "In the record."
                  : null
            }
          />
          {!ai.excludes && main.status === "unclear" ? (
            <p className="text-xs text-ink-3">
              If you include it, an unclear record goes on to full text.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-1 text-sm text-ink-2">
          No criterion fails, and the record quotes nothing that clearly meets one.
        </p>
      )}
      {others && rest.length ? (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-xs text-ink-3">
          <span>Other criteria: {summary}.</span>
          <button
            type="button"
            className="text-petrol hover:underline"
            aria-expanded={all}
            onClick={() => setAll((on) => !on)}
          >
            {all ? "Hide them" : "Show each one"}
          </button>
        </p>
      ) : null}
      {others && all ? (
        <div className="mt-2 grid gap-2">
          {rest.map((c) => (
            <AiReading
              key={c.criterion_id}
              compact
              criterion={criterionName(c.criterion_id, criteria, labels)}
              status={c.status}
              downgradedFrom={c.downgraded_from}
              rationale={c.rationale}
              quote={c.quote || null}
              verified={c.quote_verified}
              marked={false}
              markedAt={ai.quote_spans[c.criterion_id] ? "Tinted in the record." : null}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** The decision a second opinion is asked on. Not blind: this is a consult. */
export function SecondOpinionAsked({
  asked,
  criteria,
  labels,
}: {
  asked: Asked;
  criteria: ReadonlyArray<Criterion>;
  labels: Record<string, string>;
}) {
  const term = OUTCOMES[asked.outcome];
  const reason = asked.reason_criterion_id
    ? criterionName(asked.reason_criterion_id, criteria, labels)
    : null;
  return (
    <section
      aria-label="Second opinion"
      data-testid="second-opinion"
      className="border-b border-rule bg-paper px-4 pt-2 pb-2.5 text-sm"
    >
      <h2 className="font-semibold">A colleague asks for your second opinion</h2>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className="text-ink-2">They decided</span>
        <Status term={term}>
          {term.past}
          {reason ? ` on ${reason.number ?? ""} ${reason.label}`.trimEnd() : ""}
        </Status>
        <span className="text-ink-2">and wrote:</span>
        <span data-testid="second-opinion-comment">
          {asked.comment ? `“${asked.comment}”` : "nothing"}
        </span>
      </p>
      <p className="mt-0.5 text-xs text-ink-3">Your decision settles the record.</p>
    </section>
  );
}

/** Key f: the comment that goes with a request for a second opinion. Enter keeps it and returns
 * to the decision keys; Escape drops the request. */
export function AskSecondOpinion({
  comment,
  onComment,
  onDone,
  onCancel,
}: {
  comment: string;
  onComment: (comment: string) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <section
      aria-label="Ask for a second opinion"
      data-testid="ask-second-opinion"
      className="flex items-center gap-3 border-b border-rule bg-paper px-4 py-2 text-sm"
    >
      <label htmlFor="second-opinion-comment" className="font-semibold whitespace-nowrap">
        Second opinion
      </label>
      <input
        ref={input}
        id="second-opinion-comment"
        value={comment}
        placeholder="What are you unsure about?"
        className="min-w-0 flex-1 rounded-[3px] border border-rule bg-sheet px-2 py-1"
        onChange={(e) => onComment(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onDone();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <span className="flex flex-none items-center gap-3 text-ink-2">
        <KeyHint keys={["Enter"]}>Then decide with i, e, u</KeyHint>
        <KeyHint keys={["Escape"]}>Cancel</KeyHint>
      </span>
    </section>
  );
}
