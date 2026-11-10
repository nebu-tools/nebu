// A value's history, the same on both extraction screens: what each path read (value, page,
// table cell, quote, checks), then who accepted or corrected it, when, and from where.
import type { ReactNode } from "react";

import type { Acceptance, ExtractionReview, Proposal, ReviewField } from "../../data/schema.ts";
import { formatDateTime } from "../../lib/format.ts";
import { keyWords } from "../../lib/labels.ts";
import { Button } from "../../ui/Button.tsx";
import { Mark, PROPOSAL_STATUS, Status, VERDICTS } from "../../ui/Status.tsx";
import { estimateFacts, isEstimate, PATH_NAME, POLICY_HELP, unitGap } from "./marks.tsx";
import type { Path } from "./marks.tsx";

type AnchorOf = ExtractionReview["anchors"][number];

/** What each of the server's checks tests, in words (extraction/validators.py). */
const CHECK_NAMES: Record<string, string> = {
  exact_value: "An exact number of the right kind, with the field's unit",
  events_at_most_n: "Events do not exceed the arm's number of participants",
  arms_sum_to_total: "The arms add up to the total",
  ci_brackets_estimate: "The interval brackets the estimate",
  percent_recomputes: "The percentage matches events divided by participants",
  ratio_log_symmetric: "The ratio sits in the middle of its interval on the log scale",
};

const shownValue = (f: ReviewField) => {
  const chosen = f.acceptance?.edited
    ? f.acceptance.value
    : f.proposals.find((p) => p.path === (f.acceptance?.path ?? f.accepted))?.value;
  return chosen ?? f.proposals.find((p) => p.status === "extracted")?.value ?? null;
};

export function ValueHistory({
  field,
  fields,
  acceptance,
  accepted,
  ownValue = null,
  edited = null,
  shown,
  anchors,
  names,
  run,
  text,
  onPick = null,
  actions,
}: {
  field: ReviewField;
  /** The run's fields, for the interval beside an estimate. */
  fields: ReadonlyArray<ReviewField>;
  acceptance: Acceptance | null;
  /** The accepted path, when the acceptance itself is not at hand. */
  accepted: Path | null;
  /** The reviewer's own value, accepted in this session. */
  ownValue?: string | null;
  /** The span an edit in this session came from. */
  edited?: { readonly quote: string; readonly page: number | null } | null;
  /** The proposal highlighted on the page. */
  shown?: Proposal | undefined;
  anchors: ReadonlyMap<string, AnchorOf>;
  names: ReadonlyMap<string, string>;
  run: ExtractionReview["run"];
  /** The layer's text, to read an estimate's table column. */
  text?: string | undefined;
  onPick?: ((path: Path) => void) | null;
  /** What the reviewer can do with the value now. */
  actions?: ReactNode;
}) {
  const acceptedAnchor = acceptance ? anchors.get(acceptance.anchor_id) : undefined;
  const editedPage = acceptedAnchor?.boxes[0]?.page ?? edited?.page ?? null;
  const editedQuote = acceptedAnchor?.quote.exact ?? edited?.quote ?? null;
  const who = acceptance ? (names.get(acceptance.reviewer_id) ?? "A reviewer") : "A reviewer";
  const facts = estimateFacts({
    field,
    fields,
    anchors,
    valueOf: (f) => (f === field && ownValue !== null ? ownValue : shownValue(f)),
    text,
    acceptanceAnchor: acceptance?.anchor_id,
    extraQuotes: edited ? [edited.quote] : [],
  });
  const estimate = isEstimate(field);
  const subgroup =
    field.key.subpopulation && field.key.subpopulation !== "all" ? field.key.subpopulation : null;
  // An edit replaces what its path read: name it beside the correction.
  const replaced = acceptance?.edited
    ? field.proposals.find((p) => p.path === acceptance.path)
    : undefined;
  const isEdited = acceptance?.edited ?? ownValue !== null;
  const seconds = acceptance ? (acceptance.source_viewed_ms / 1000).toFixed(1) : "";
  const read = (p: Proposal) =>
    p.status === "extracted" && p.value !== null
      ? `${p.value}${p.unit ? `${unitGap(p.unit)}${p.unit}` : ""}`
      : PROPOSAL_STATUS[p.status].label.toLowerCase();
  const pathName = (p: Proposal) =>
    p.path === "janus"
      ? `Janus${run.janus_version ? ` ${run.janus_version}` : ""}`
      : `LLM path${run.model_identity ? ` (${run.model_identity})` : ""}`;
  return (
    <div
      data-testid="field-history"
      aria-label="Value history"
      role="region"
      className="bg-sheet-2 px-6 py-3 text-sm"
    >
      {/* The essentials: one line per path and the acceptance. The rest is under Details. */}
      {subgroup || (estimate && !facts.adjustment) ? (
        <p className="mb-2 flex flex-wrap gap-x-3 text-ink-2">
          {subgroup ? (
            <span title={field.key.subpopulation}>Subgroup: {keyWords(subgroup)}</span>
          ) : null}
          {estimate && !facts.adjustment ? (
            <span>Adjusted or not: not recorded in the schema or the source</span>
          ) : null}
        </p>
      ) : null}
      <ol className="space-y-1.5 border-l border-rule-strong pl-4">
        {field.proposals.length === 0 ? (
          <li className="text-ink-2">Neither path proposed a value.</li>
        ) : null}
        {field.proposals.map((p, i) => {
          const anchor = p.anchor_ids.map((id) => anchors.get(id)).find(Boolean);
          const page = anchor?.boxes[0]?.page;
          const failed = (p.validators ?? []).filter((v) => !v.passed);
          return (
            <li key={p.path} className="relative" data-testid="history-path">
              <span
                aria-hidden="true"
                className={`absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-sheet-2 ${p.path === "llm" ? "bg-ink-2" : "bg-petrol"}`}
              />
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold">{pathName(p)}</span>
                <span>
                  {p.status === "extracted" && p.value !== null ? (
                    <>
                      read <span className="font-semibold tabular-nums">{p.value}</span>
                      {p.unit ? `${unitGap(p.unit)}${p.unit}` : ""}
                    </>
                  ) : (
                    <Status term={PROPOSAL_STATUS[p.status]} />
                  )}
                </span>
                {page ? <span className="text-ink-2">on page {page}</span> : null}
                {p === shown && anchor ? (
                  <span className="text-ink-2">(shown on the page)</span>
                ) : null}
                {failed.length ? (
                  <span className="inline-flex items-center gap-1 text-exclude">
                    <Mark term={PROPOSAL_STATUS.invalid} />
                    {failed.length === 1 ? "a check failed" : `${failed.length} checks failed`}
                  </span>
                ) : null}
                {onPick ? (
                  <Button
                    size="sm"
                    kind="secondary"
                    keys={[String(i + 1)]}
                    onClick={() => onPick(p.path)}
                  >
                    Take this value
                  </Button>
                ) : null}
              </p>
            </li>
          );
        })}
        <li className="relative" data-testid="history-acceptance">
          <span
            aria-hidden="true"
            className={`absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-sheet-2 ${accepted ? "bg-include" : "bg-marker"}`}
          />
          {acceptance ? (
            <p>
              <span className="font-semibold">{who}</span>{" "}
              {acceptance.edited ? (
                <>
                  corrected the value by hand to{" "}
                  <span className="font-semibold tabular-nums">{acceptance.value}</span>
                  {acceptance.unit ? `${unitGap(acceptance.unit)}${acceptance.unit}` : ""}
                  {estimate && (facts.adjustment || facts.interval)
                    ? ` (${[facts.adjustment ? facts.label.toLowerCase() : null, facts.interval]
                        .filter(Boolean)
                        .join(", ")})`
                    : ""}
                  {replaced
                    ? `, in place of what ${PATH_NAME[replaced.path]} read (${read(replaced)})`
                    : ""}
                  , and accepted it
                </>
              ) : (
                <>
                  accepted the {PATH_NAME[acceptance.path]} value
                  {acceptance.group ? " with other standard values where both paths agree" : ""}
                </>
              )}
              <span className="text-ink-2">, {formatDateTime(acceptance.accepted_at)}</span>
            </p>
          ) : accepted ? (
            <p>
              Accepted from the {PATH_NAME[accepted]} path
              {ownValue !== null ? `, corrected by hand to ${ownValue}` : ""}.
            </p>
          ) : (
            <p className="text-ink-2" title={POLICY_HELP[field.spec.policy]}>
              Not accepted yet.
            </p>
          )}
        </li>
      </ol>
      <details className="mt-2 text-ink-2">
        <summary className="cursor-pointer select-none hover:text-ink">Details</summary>
        <div className="mt-2 space-y-3 pl-4">
          {field.proposals.map((p) => {
            const anchor = p.anchor_ids.map((id) => anchors.get(id)).find(Boolean);
            const header = anchor?.cells?.[0]?.header_path?.filter(Boolean).join(" › ");
            const checks = p.validators ?? [];
            const quote = p.quote ?? anchor?.quote.exact;
            return (
              <div key={p.path} data-testid="history-details">
                <p className="font-semibold text-ink">{pathName(p)}</p>
                {quote ? (
                  <p className="line-clamp-3" title={quote}>
                    “{quote.trim()}”
                  </p>
                ) : null}
                {header ? <p>Table cell: {header}</p> : null}
                {p.message ? <p>{p.message}</p> : null}
                {checks.length === 0 ? (
                  <p>No checks ran.</p>
                ) : (
                  <ul className="mt-0.5 space-y-0.5">
                    {checks.map((v) => (
                      <li
                        key={v.validator}
                        className={`flex items-baseline gap-1.5 ${v.passed ? "" : "text-exclude"}`}
                      >
                        <Mark
                          term={v.passed ? VERDICTS.met : PROPOSAL_STATUS.invalid}
                          title={v.validator}
                        />
                        <span title={v.validator}>
                          {CHECK_NAMES[v.validator] ?? keyWords(v.validator)}
                          {v.passed ? ": passed" : `: ${v.message ?? "failed"}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          {acceptance ? (
            <p>
              {acceptance.edited && editedPage ? `From page ${editedPage}. ` : ""}
              {acceptance.group
                ? `${who} had the list on screen for ${seconds} s before accepting`
                : `${who} saw the source for ${seconds} s before accepting`}
              {acceptance.event_seq ? ` (ledger event ${acceptance.event_seq})` : ""}.
              {acceptance.recheck ? " Picked for a re-check." : ""}
            </p>
          ) : null}
          {isEdited && editedQuote ? (
            <p className="line-clamp-2" title={editedQuote}>
              The corrected value’s span: “{editedQuote.trim()}”
            </p>
          ) : null}
        </div>
      </details>
      {actions ? <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
