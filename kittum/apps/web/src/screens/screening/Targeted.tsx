// What a targeted search (mode S, working documentation) adds to a screening screen: the AI's
// reading before the decision when the stage reveals `before`, the decision a second opinion is
// asked on, and the prompt for asking one (key f). Complete topics never show any of these: the
// server sends no AI reading before the decision and refuses a second opinion there.
import { useEffect, useRef } from "react";

import type { Criterion, QueueItem, Reveal } from "../../data/schema.ts";
import { KeyHint } from "../../ui/Key.tsx";
import { OUTCOMES, Status } from "../../ui/Status.tsx";
import { AiReading } from "./AiReading.tsx";

type Ai = NonNullable<QueueItem["ai"]>;
type Asked = NonNullable<QueueItem["second_opinion"]>;

const criterionName = (
  id: string,
  criteria: ReadonlyArray<Criterion>,
  labels: Record<string, string>,
) => {
  const index = criteria.findIndex((c) => c.id === id);
  const criterion = criteria[index];
  return {
    number: criterion ? index + 1 : null,
    label: criterion ? (labels[criterion.slot] ?? criterion.slot) : id,
    text: criterion?.text_en ?? null,
  };
};

/** The criterion whose verified quote the record marks before the decision: the first one the
 * AI reads as not met, else none. Shaped as a reveal so the record view marks it as it marks one. */
export function beforeQuote(item: QueueItem): Reveal | null {
  const ai = item.ai;
  if (!ai) return null;
  const c = ai.criteria.find((x) => x.status === "not_met" && ai.quote_spans[x.criterion_id]);
  if (!c) return null;
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

/** The AI's reading of every criterion, shown before the decision in a stage that reveals
 * `before`. */
export function AiBefore({
  ai,
  criteria,
  labels,
  marked,
}: {
  ai: Ai;
  criteria: ReadonlyArray<Criterion>;
  labels: Record<string, string>;
  /** The criterion whose quote the record marks. */
  marked: string | null;
}) {
  return (
    <section
      aria-label="AI judge"
      data-testid="ai-before"
      className="evidence-item max-h-[30vh] overflow-y-auto border-b border-rule px-4 pt-2 pb-2.5"
    >
      <h2 className="text-sm font-semibold">
        {ai.excludes ? "The AI judge reads it as excluded" : "The AI judge proposes no exclusion"}
        <span className="ml-2 font-normal text-ink-3">
          Shown before you decide, as this targeted search allows.
        </span>
      </h2>
      <div className="mt-1 grid gap-1.5">
        {ai.criteria.map((c) => (
          <AiReading
            key={c.criterion_id}
            compact
            criterion={criterionName(c.criterion_id, criteria, labels)}
            status={c.status}
            downgradedFrom={c.downgraded_from}
            rationale={c.rationale}
            quote={c.quote || null}
            verified={c.quote_verified}
            marked={marked === c.criterion_id}
            markedAt={
              marked === c.criterion_id
                ? "Marked in the record."
                : ai.quote_spans[c.criterion_id]
                  ? "In the record."
                  : null
            }
          />
        ))}
      </div>
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
