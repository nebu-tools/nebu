// The small marks both extraction screens share: where a value came from, how much the two paths
// back it, what is still open, what each check policy asks of the reviewer, and what an estimate
// is (adjusted or not, its interval).
//
// The colour rule: amber (the shared `waits` tone) only for what waits for a person, a value to
// verify or a disagreement; green for an accepted value or two paths that agree; neutral ink for
// importance and for a single path.
import type { ExtractionReview, ReviewField } from "../../data/schema.ts";
import { codePointIndex } from "../../lib/codepoints.ts";
import { NOT_DONE, WAITS } from "../../ui/Status.tsx";

export type Path = "janus" | "llm";
export const PATH_NAME: Record<Path, string> = { janus: "Janus", llm: "LLM" };

type AnchorOf = ExtractionReview["anchors"][number];

/** What each check policy asks of the reviewer, for a hover or a legend. */
export const POLICY_HELP: Record<string, string> = {
  critical: "Critical: a reviewer checks this value alone against its highlighted source.",
  standard:
    "Standard: when both paths agree and the checks pass, a reviewer may accept it with others after reading the list.",
  descriptive: "Descriptive: a reviewer checks the value and its span once.",
};

/** How much a value matters, in plain words: Critical in ink, Standard quieter. Importance is
 * not a status, so it carries no mark and no colour. */
function PolicyText({ policy, small = false }: { policy: string; small?: boolean }) {
  const critical = policy === "critical";
  return (
    <span
      data-policy={policy}
      title={POLICY_HELP[policy]}
      className={`whitespace-nowrap ${small ? "text-xs" : "text-sm"} ${critical ? "font-semibold text-ink" : "text-ink-2"}`}
    >
      {policy ? policy[0]!.toUpperCase() + policy.slice(1) : policy}
    </span>
  );
}

/** Importance beside a quantity in a narrow row: only Critical shows; the rest is for readers. */
export function PolicyTag({ policy }: { policy: string }) {
  return policy === "critical" ? (
    <PolicyText policy={policy} small />
  ) : (
    <span data-policy={policy} className="sr-only">
      {policy ? policy[0]!.toUpperCase() + policy.slice(1) : policy}
    </span>
  );
}

// Two paths joined, drawn, for "both paths read the same value": a connector, not a check, so
// agreement never looks like acceptance (the only green check).
const twoPaths = (
  <svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
    <circle cx="3" cy="5" r="2.2" fill="currentColor" />
    <circle cx="13" cy="5" r="2.2" fill="currentColor" />
    <path d="M5 5H11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

// One path: a line from a dot, drawn, for "only one path read this".
const onePath = (
  <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
    <circle cx="3" cy="5" r="2.2" fill="currentColor" />
    <path d="M5.5 5H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const BACKING: Record<
  ReviewField["agreement"],
  { readonly label: string; readonly word: string | null; readonly help: string }
> = {
  agree: {
    label: "Both agree",
    word: "Both agree",
    help: "Janus + LLM agree: both paths read the same value.",
  },
  janus_only: {
    label: "Janus only",
    word: "Janus only",
    help: "Janus only: only the deterministic table reader found a value.",
  },
  llm_only: {
    label: "LLM only",
    word: "LLM only",
    help: "LLM only: only the LLM path found a value. Nothing deterministic backs it; check it with care.",
  },
  neither: { label: "Neither path", word: "None", help: "Neither path found a value." },
  disagree: {
    label: "The paths disagree",
    word: "Differ",
    help: "The paths disagree: Janus and the LLM path read different values. Take one after checking both sources.",
  },
};

/** How much the paths back a value, as compact as a column allows; the full words in a hover. */
export function Backing({ agreement }: { agreement: ReviewField["agreement"] }) {
  const b = BACKING[agreement];
  const mark =
    agreement === "agree" ? (
      <span className="inline-flex w-[18px] justify-center text-ink-2">{twoPaths}</span>
    ) : agreement === "disagree" ? (
      <span
        aria-hidden="true"
        className="mark bg-marker-soft text-marker-edge shadow-[inset_0_0_0_1px_var(--marker-edge)]"
      >
        {WAITS.glyph}
      </span>
    ) : agreement === "neither" ? (
      <span aria-hidden="true" className="mark bg-sheet-2 text-ink-2">
        {NOT_DONE.glyph}
      </span>
    ) : (
      <span className="inline-flex w-[18px] justify-center text-ink-2">{onePath}</span>
    );
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap ${agreement === "disagree" ? "text-marker-edge" : agreement === "agree" ? "text-ink-2" : "text-ink"}`}
      title={b.help}
    >
      {mark}
      {b.word ? <span>{b.word}</span> : <span className="sr-only">{b.label}</span>}
    </span>
  );
}

const BASELINE = /^(baseline|bl|t0|m0|w0|week_?0|day_?0|randomi[sz]ation)$/i;

/** A field's quantity in words. A count at baseline is a characteristic of the participants, not
 * an event: "Women, n" (the characteristic is the endpoint), not "Participants with event". */
export const quantityLabel = (field: Pick<ReviewField, "key" | "spec" | "labels">) => {
  if (BASELINE.test(field.key.timepoint)) {
    if (field.spec.quantity === "events") return `${field.labels.endpoint}, n`;
    if (field.spec.quantity === "percent") return `${field.labels.endpoint}, %`;
  }
  return field.spec.description;
};

/** Where an accepted value came from, in the same words as the paths: "Both agree", "LLM only",
 * "Janus only", "Edited by hand"; a value taken from two different readings names its path. */
export const sourceWord = (
  field: Pick<ReviewField, "agreement">,
  acceptance: { readonly edited: boolean; readonly path: Path } | null,
) =>
  acceptance?.edited
    ? "Edited by hand"
    : field.agreement === "disagree"
      ? acceptance
        ? `${PATH_NAME[acceptance.path]}, paths differed`
        : "Paths differ"
      : field.agreement === "agree"
        ? "Janus + LLM agree"
        : BACKING[field.agreement].label;

/** A unit worth showing beside the value: "ratio" says nothing next to "Odds ratio", and a count
 * ("Women, n") is a number of people already. */
export const unitBeside = (unit: string | null | undefined, quantity: string) =>
  unit && !(unit === "ratio" && /ratio$/i.test(quantity)) && !quantity.endsWith(", n")
    ? unit
    : null;

/** No space before a percent sign: "6.5%". */
export const unitGap = (unit: string | null | undefined) => (unit === "%" ? "" : " ");

const ESTIMATES = new Set([
  "risk_ratio",
  "odds_ratio",
  "hazard_ratio",
  "mean_difference",
  "risk_difference",
  "standardized_mean_difference",
  "smd",
]);

export const isEstimate = (field: Pick<ReviewField, "spec">) => ESTIMATES.has(field.spec.quantity);

const sameCell = (a: ReviewField, b: ReviewField) =>
  (["endpoint", "arm", "timepoint", "analysis_set", "subpopulation", "data_cut"] as const).every(
    (k) => a.key[k] === b.key[k],
  );

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NUMBER = String.raw`[-−–]?\d+(?:[.,·]\d+)?`;
const DATA_CELL = /^[-−–]?[\d.,·]+(\s*[([].*[)\]])?$/;

// Code-point maps of the few layers on screen, so a long text is scanned once.
const maps = new Map<string, (offset: number) => number>();
const mapOf = (text: string) => {
  let at = maps.get(text);
  if (!at) {
    if (maps.size > 6) maps.clear();
    maps.set(text, (at = codePointIndex(text)));
  }
  return at;
};

/** Where a span sits in the layer's text. In a table (the layer writes a table's cells with tabs
 * between them, one row per line) that is its cell and the headers above it in the same column,
 * such as "AOdds Ratio" over "0.76 (0.47; 1.24)"; elsewhere the text right after it. */
const sourceContext = (text: string, start: number, end: number) => {
  const at = mapOf(text);
  const s = at(start);
  const e = at(end);
  const lineStart = text.lastIndexOf("\n", s - 1) + 1;
  let lineEnd = text.indexOf("\n", e);
  if (lineEnd < 0) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  if (!line.includes("\t"))
    return { cell: text.slice(s, Math.min(lineEnd, e + 40)), headers: [], ci95: false };
  const column = text.slice(lineStart, s).split("\t").length - 1;
  const headers: string[] = [];
  let ci95 = false;
  let end_ = lineStart - 1;
  for (let n = 0; n < 16 && end_ > 0; n++) {
    const begin = text.lastIndexOf("\n", end_ - 1) + 1;
    const above = text.slice(begin, end_);
    end_ = begin - 1;
    if (!above.includes("\t")) break; // the table starts below this line
    if (/95\s*%/.test(above)) ci95 = true;
    const cell = above.split("\t")[column]?.trim();
    if (cell && !DATA_CELL.test(cell) && !cell.startsWith("%")) headers.unshift(cell);
  }
  return { cell: line.split("\t")[column] ?? "", headers, ci95 };
};

/** What an estimate is, from what the run has: the schema's description, the interval fields,
 * and the value's own source (Janus's table headers, the column header above the value in the
 * layer, the quotes). Each fact says where it comes from; what nothing records stays unknown. */
export interface EstimateFacts {
  /** The quantity, with "Adjusted" or "Unadjusted" where a source says so. */
  readonly label: string;
  readonly adjustment: "adjusted" | "unadjusted" | null;
  /** Where the adjustment was read: the schema, or the source's header or quote. */
  readonly adjustmentFrom: string | null;
  readonly interval: string | null;
  readonly intervalFrom: "fields" | "source" | null;
}

const readAdjustment = (text: string) =>
  /\b(unadjusted|crude)\b/i.test(text)
    ? ("unadjusted" as const)
    : /\b(AOR|aOR|AOdds|aHR|AHR|aRR|ARR)\b/.test(text) || /\badjusted\b/i.test(text)
      ? ("adjusted" as const)
      : null;

export const estimateFacts = ({
  field,
  fields,
  anchors,
  valueOf,
  text,
  acceptanceAnchor,
  extraQuotes = [],
}: {
  field: ReviewField;
  fields: ReadonlyArray<ReviewField>;
  anchors: ReadonlyMap<string, AnchorOf>;
  valueOf: (f: ReviewField) => string | null;
  /** The layer's text, to read the value's table column. */
  text?: string | undefined;
  /** The anchor the accepted value came from: its source decides. */
  acceptanceAnchor?: string | null | undefined;
  /** Spans not anchored yet, such as an edit in progress. */
  extraQuotes?: ReadonlyArray<string>;
}): EstimateFacts => {
  const base = quantityLabel(field);
  const none = {
    label: base,
    adjustment: null,
    adjustmentFrom: null,
    interval: null,
    intervalFrom: null,
  };
  if (!ESTIMATES.has(field.spec.quantity)) return none;
  const value = valueOf(field);
  // The value's own sources only: what the accepted value came from, else the readings of the
  // same value. Another path's reading may sit in another column (the unadjusted estimate).
  const primary = [
    ...(acceptanceAnchor ? [acceptanceAnchor] : []),
    ...field.proposals.filter((p) => !value || p.value === value).flatMap((p) => p.anchor_ids),
  ]
    .map((id) => anchors.get(id))
    .filter((a): a is AnchorOf => a !== undefined);
  const spans: string[] = [...extraQuotes];
  let ci95 = false;
  for (const p of field.proposals) if (!value || p.value === value) spans.push(p.quote ?? "");
  for (const anchor of primary) {
    spans.push(anchor.quote.exact, ...(anchor.cells ?? []).flatMap((c) => c.header_path ?? []));
    if (text) {
      const context = sourceContext(text, anchor.start, anchor.end);
      spans.push(...context.headers, context.cell);
      ci95 ||= context.ci95;
    }
  }
  const sources = spans.filter(Boolean);

  let adjustment = readAdjustment(field.spec.description);
  let adjustmentFrom: string | null = adjustment ? "the extraction schema" : null;
  if (!adjustment) {
    const span = sources.find((x) => readAdjustment(x));
    if (span) {
      adjustment = readAdjustment(span);
      adjustmentFrom = `the source: “${span.trim()}”`;
    }
  }
  const label =
    adjustment && !/adjusted|crude/i.test(base)
      ? `${adjustment === "adjusted" ? "Adjusted" : "Unadjusted"} ${base[0]!.toLowerCase()}${base.slice(1)}`
      : base;

  // The interval: its own fields where the schema has them, else the brackets right after the
  // value in its source.
  const sibling = (quantity: string) =>
    fields.find((f) => f.spec.quantity === quantity && sameCell(f, field));
  const lower = sibling("ci_lower");
  const upper = sibling("ci_upper");
  if (lower || upper) {
    const lo = lower ? valueOf(lower) : null;
    const hi = upper ? valueOf(upper) : null;
    return {
      label,
      adjustment,
      adjustmentFrom,
      interval: `95% CI ${lo ?? "–"} to ${hi ?? "–"}`,
      intervalFrom: "fields",
    };
  }
  if (value) {
    const pattern = new RegExp(
      `${escape(value)}\\s*[(\\[]\\s*(${NUMBER})\\s*(?:[;,–—]|to|-)\\s*(${NUMBER})\\s*[)\\]]`,
    );
    for (const span of sources) {
      const m = pattern.exec(span);
      if (m) {
        const named = ci95 || sources.some((x) => /95\s*%/.test(x));
        return {
          label,
          adjustment,
          adjustmentFrom,
          interval: `${named ? "95% CI" : "Interval"} ${m[1]} to ${m[2]}`,
          intervalFrom: "source",
        };
      }
    }
  }
  return { ...none, label, adjustment, adjustmentFrom };
};

/** The surname on the article's running head ("López-Durán et al." at the top of its pages), for
 * a study name where the report carries no authors. */
const runningHead = (text: string) => {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(
    /^[ \t]*(\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+)?) et al\.?[ \t]*$/gmu,
  ))
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/** A report's year: the last year its citation names. */
const yearOf = (citation: string) => citation.match(/\b(19|20)\d{2}\b(?!.*\b(19|20)\d{2}\b)/)?.[0];

/** The journal of a citation, without its year or the subtitle after " : ". */
export const journalOf = (citation: string) =>
  citation
    .replace(/\s*\b(19|20)\d{2}\s*$/, "")
    .split(" : ")[0]!
    .trim();

/** "López-Durán 2025": the corpus name where the lead may read it, else the running head of the
 * PDF with the citation's year, else the title cut short (`fallback`). */
export const studyFromText = (
  known: string | undefined,
  text: string | undefined,
  citation: string,
  fallback: string,
) => {
  if (known) return known;
  const surname = text ? runningHead(text) : null;
  const year = yearOf(citation);
  return surname && year ? `${surname} ${year}` : fallback;
};

/** Work that is still open: the shared amber of things that wait for a person, with its word. */
export function ToVerify({ children = "To verify" }: { children?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-marker-soft px-2 py-px text-xs font-medium whitespace-nowrap text-marker-edge shadow-[inset_0_0_0_1px_var(--marker-edge)]">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-marker-edge" />
      {children}
    </span>
  );
}

/** A thin bar of the accepted share. */
export function AcceptedBar({ accepted, total }: { accepted: number; total: number }) {
  return (
    <span
      className="block h-1.5 w-28 flex-none overflow-hidden rounded-full bg-rule"
      role="progressbar"
      aria-label="Values accepted"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={accepted}
    >
      <span
        className="block h-full bg-petrol"
        style={{ width: `${total ? (accepted / total) * 100 : 0}%` }}
      />
    </span>
  );
}
