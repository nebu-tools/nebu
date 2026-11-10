// Title and abstract with protocol terms, entities, the AI's main quoted span (the marker), and
// its other verified quotes, tinted by what they show: met in the include colour, not met in the
// exclude colour.
import { Fragment } from "react";
import type { ReactNode } from "react";

import type { Highlight, QuoteSpan } from "../../data/schema.ts";
import { codePointIndex } from "../../lib/codepoints.ts";

interface Run {
  readonly start: number;
  readonly end: number;
  readonly criteria: ReadonlyArray<string>;
  readonly entities: ReadonlyArray<string>;
  readonly quote: boolean;
  /** Another verified AI quote over this run, if any. */
  readonly other: OtherQuote | null;
}

/** A verified AI quote besides the main one, as a UTF-16 range of the same text. */
export interface OtherQuote {
  readonly range: readonly [number, number];
  readonly kind: "met" | "not_met";
  readonly title: string;
  /** The criterion's ID, so its row in the rail can light the quote up. */
  readonly id?: string;
  /** The criterion's number, set after the quote. */
  readonly label?: string;
}

/**
 * Splits `text[from, to)` (UTF-16) at every highlight boundary. Highlights arrive in code points
 * and are converted here; `quote` is a UTF-16 range.
 */
const runs = (
  text: string,
  from: number,
  to: number,
  highlights: ReadonlyArray<Highlight>,
  quote: readonly [number, number] | null,
  others: ReadonlyArray<OtherQuote> = [],
): Run[] => {
  const at = codePointIndex(text);
  const marks = highlights
    .map(([s, e, label]) => [at(s), at(e), label] as const)
    .filter(([s, e]) => s < to && e > from);
  const cuts = new Set([from, to]);
  for (const [s, e] of marks) {
    cuts.add(Math.max(s, from));
    cuts.add(Math.min(e, to));
  }
  for (const q of [quote, ...others.map((o) => o.range)]) {
    if (q && q[0] < to && q[1] > from) {
      cuts.add(Math.max(q[0], from));
      cuts.add(Math.min(q[1], to));
    }
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Run[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i] ?? 0;
    const end = points[i + 1] ?? 0;
    const covering = marks.filter(([s, e]) => s <= start && e >= end).map(([, , label]) => label);
    out.push({
      start,
      end,
      criteria: covering.filter((l) => l.startsWith("protocol:")).map((l) => l.slice(9)),
      entities: covering.filter((l) => l.startsWith("entity:")).map((l) => l.slice(7)),
      quote: quote !== null && quote[0] <= start && quote[1] >= end,
      other: others.find((o) => o.range[0] <= start && o.range[1] >= end) ?? null,
    });
  }
  return out;
};

export function Marked({
  text,
  from = 0,
  to = text.length,
  highlights,
  quote,
  others = [],
  quoteLabel,
  quoteId,
  lit,
  describe,
}: {
  text: string;
  from?: number;
  to?: number;
  highlights: ReadonlyArray<Highlight>;
  quote: readonly [number, number] | null;
  /** The AI's other verified quotes, tinted rather than marked. */
  others?: ReadonlyArray<OtherQuote>;
  /** The main quote's criterion number, set after it, and its criterion's ID. */
  quoteLabel?: string | undefined;
  quoteId?: string | undefined;
  /** The criterion whose quote is lit up now (its rail row is hovered). */
  lit?: string | null;
  describe: (criterionId: string) => string;
}) {
  const nodes: ReactNode[] = [];
  let quoted: ReactNode[] = [];
  const flush = () => {
    if (quoted.length === 0) return;
    // One mark for the whole quote, however many terms it crosses.
    nodes.push(
      <mark
        key={`q${nodes.length}`}
        className={`evidence ${lit && lit === quoteId ? "ai-lit" : ""}`}
        data-reveal-quote=""
        title="The AI judge's quote"
      >
        {quoted}
      </mark>,
    );
    // The criterion's number after the quote, outside it, so the quote's text stays the record's.
    if (quoteLabel)
      nodes.push(
        <sup key={`qn${nodes.length}`} className="ai-num" data-kind="main" aria-hidden="true">
          {quoteLabel}
        </sup>,
      );
    quoted = [];
  };
  for (const run of runs(text, from, to, highlights, quote, others)) {
    const slice = text.slice(run.start, run.end);
    const classes = [run.criteria.length ? "term" : "", run.entities.length ? "entity" : ""].filter(
      Boolean,
    );
    const title = [...run.criteria.map(describe), ...run.entities.map((e) => `Entity: ${e}`)].join(
      "\n",
    );
    const plain: ReactNode = classes.length ? (
      <span key={`s${run.start}`} className={classes.join(" ")} title={title}>
        {slice}
      </span>
    ) : (
      slice
    );
    const tint: ReactNode =
      run.other && !run.quote ? (
        <mark
          key={`o${run.start}`}
          className={`${run.other.kind === "met" ? "ai-met" : "ai-not-met"} ${
            lit && lit === run.other.id ? "ai-lit" : ""
          }`}
          title={run.other.title}
        >
          {plain}
        </mark>
      ) : (
        plain
      );
    const node: ReactNode =
      run.other && !run.quote && run.other.label && run.end === run.other.range[1] ? (
        <Fragment key={`of${run.start}`}>
          {tint}
          <sup className="ai-num" data-kind={run.other.kind} aria-hidden="true">
            {run.other.label}
          </sup>
        </Fragment>
      ) : (
        tint
      );
    if (run.quote) {
      quoted.push(node);
    } else {
      flush();
      nodes.push(node);
    }
  }
  flush();
  return <>{nodes}</>;
}

/**
 * The AI's verified quote as UTF-16 ranges of the title or the text, from the server's code-point
 * span. An unverified quote has no span and is never marked.
 */
export const placeQuote = (title: string, text: string, span: QuoteSpan | null | undefined) => {
  if (!span) return { title: null, text: null };
  const at = codePointIndex(span.part === "title" ? title : text);
  const range = [at(span.start), at(span.end)] as const;
  return span.part === "title" ? { title: range, text: null } : { title: null, text: range };
};

const METHODS = /method|design|participants|patients and/i;
const TRAILING = /funding|registration|translation|impact and/i;

/** Structured-abstract sections in reading order for screening: methods first, funding last. */
export const orderSections = (sections: ReadonlyArray<readonly [string, number, number]>) => {
  const rank = (label: string) => (METHODS.test(label) ? 0 : TRAILING.test(label) ? 2 : 1);
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => rank(a.section[0]) - rank(b.section[0]) || a.index - b.index)
    .map(({ section }) => ({
      label: section[0],
      start: section[1],
      end: section[2],
      trailing: rank(section[0]) === 2,
    }));
};
