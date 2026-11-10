// Enrichment from the open sources (DESIGN.md, "Enrichment and federation"): the run's progress
// per source, and one record as enrichment completed it, with the source of every field. The
// sources share one column order everywhere, so a source's row in the run lines up in the mind
// with its column in a record's provenance. A retraction is the one loud thing on the screen. A
// source that failed says so in plain words, and the lead retries it from here or Retrieval.
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import type {
  EnrichmentRun,
  EntityTag,
  RecordEnrichment,
  RecordFlag,
  SourceFailure,
  SourceProgress,
} from "../../data/schema.ts";
import { run as call } from "../../data/workbench.ts";
import { formatDateTime } from "../../lib/format.ts";
import { Button } from "../../ui/Button.tsx";
import { failure } from "../../ui/Form.tsx";

import { Mark, VERDICTS, WAITS } from "../../ui/Status.tsx";
import type { Term } from "../../ui/Status.tsx";
import { useProject } from "../project.tsx";
import { Panel } from "../../ui/Panel.tsx";

const SOURCES: ReadonlyArray<readonly [string, string]> = [
  ["openalex", "OpenAlex"],
  ["europepmc", "Europe PMC"],
  ["crossref", "Crossref"],
  ["unpaywall", "Unpaywall"],
  ["pubtator", "PubTator 3"],
];
// The full-text sources the waterfall asks one report at a time, after enrichment.
const SOURCE_NAMES = new Map([
  ...SOURCES,
  ["pmc", "PubMed Central"],
  ["biorxiv", "medRxiv or bioRxiv"],
  ["arxiv", "arXiv"],
  ["semanticscholar", "Semantic Scholar"],
  ["core", "CORE"],
]);
export const sourceName = (source: string) => SOURCE_NAMES.get(source) ?? source;

const TROUBLE: Record<number, string> = {
  503: "the service was down",
  502: "a server in front of it failed",
  504: "a server in front of it timed out",
  500: "it had an internal error",
  429: "it was asked too often",
};

/** A source's failure in plain words, optionally with what it failed for ("24 records"), and
 * what the source said about it, in its own words. */
export function failureLine(
  source: string,
  f: Pick<SourceFailure, "status" | "message"> & { readonly kind?: string },
  counts = "",
): string {
  const name = sourceName(source);
  const forWhat = counts ? ` for ${counts}` : "";
  let line: string;
  if (f.kind === "other_work") line = `${name} answered for another work${forWhat}.`;
  else if (f.kind === "budget") line = `${name} has no requests left today${forWhat}.`;
  else if (f.kind === "malformed") line = `${name} sent an answer Kittum cannot read${forWhat}.`;
  else if (f.status && f.status < 500 && f.status !== 429)
    line = `${name} refused the request (HTTP ${f.status})${forWhat}.`;
  else if (f.status) {
    const why = TROUBLE[f.status];
    line = `${name} did not answer (HTTP ${f.status}${why ? `, ${why}` : ""})${forWhat}.`;
  } else line = `Kittum could not reach ${name}${forWhat}.`;
  return f.message ? `${line} It said: "${f.message}"` : line;
}

const FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["doi", "DOI"],
  ["pmid", "PMID"],
  ["pmcid", "PMCID"],
  ["abstract", "Abstract"],
  ["retraction", "Retraction"],
  ["clinical_trial_numbers", "Trial numbers"],
  ["oa_locations", "Open-access locations"],
  ["entities", "Entity tags"],
];

const NOTICES: Record<string, string> = {
  retraction: "Retraction",
  correction: "Correction",
  erratum: "Erratum",
  expression_of_concern: "Expression of concern",
};
export const noticeName = (kind: string) => NOTICES[kind] ?? kind.replaceAll("_", " ");

// Entity tags are highlights from PubTator, never evidence: they keep off the marker yellow.
const ENTITY_COLOURS: Record<string, string> = {
  drug: "var(--petrol)",
  disease: "var(--unclear)",
  gene: "var(--insufficient)",
  mutation: "var(--insufficient)",
};
const ENTITY_NAMES: Record<string, string> = {
  drug: "Drug",
  disease: "Disease",
  gene: "Gene",
  mutation: "Mutation",
  species: "Species",
  cell_line: "Cell line",
  virus: "Virus",
};

const FORMATS: Record<string, string> = {
  pdf: "PDF",
  xml: "Full-text XML",
  landing: "Landing page",
};

const TRIGGER: Record<string, string> = {
  corpus_built: "after the corpus was built",
  requested: "at your request",
  retry: "again on a retry",
};

export const runActive = (run: { readonly status: string } | null | undefined) =>
  run?.status === "queued" || run?.status === "running";

const runLine = (run: EnrichmentRun) => {
  const records = `${run.records} ${run.records === 1 ? "record" : "records"}`;
  switch (run.status) {
    case "queued":
      return `Waiting for a worker to enrich ${records}.`;
    case "running":
      return `Enriched ${run.done} of ${records} so far.`;
    case "failed":
      return `Enrichment stopped after ${run.done} of ${records}. ${run.error ?? ""}`.trim();
    case "done":
      return `Enriched ${records} ${TRIGGER[run.trigger]}, finished ${run.finished_at ? formatDateTime(run.finished_at) : "at an unknown time"}.`;
  }
};

/** The enrichment run as context: folded to one line by default, its table one click away. What
 * needs the lead (a wrong match, a failed source) is `EnrichmentProblems`, on the sheet. */
export function EnrichmentPanel({
  run,
  busy,
  error,
  canEnrich,
  onEnrich,
}: {
  run: EnrichmentRun | null;
  busy: boolean;
  error: string | null;
  /** Whether the lead may start a run now. */
  canEnrich: boolean;
  onEnrich: () => void;
}) {
  const active = runActive(run);
  const troubled = run?.sources.filter((s) => s.failed > 0) ?? [];
  const mismatches = troubled.filter(wrongMatch).reduce((k, s) => k + s.failed, 0);
  const failures = troubled.filter((s) => !wrongMatch(s)).reduce((k, s) => k + s.failed, 0);
  const asked = Math.max(0, ...(run?.sources.map((s) => s.asked) ?? [0]));
  const showProblems = () => {
    const problems = document.getElementById(PROBLEMS_ID);
    problems?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    problems?.focus({ preventScroll: true });
  };
  return (
    <Panel
      level="recessed"
      fold="closed"
      testId="enrichment"
      title={
        <span
          className="cursor-help underline decoration-ink-3 decoration-dotted underline-offset-4"
          title="Kittum asks the open sources about every record for identifiers, abstracts, open-access files, retractions, and drug and disease tags."
        >
          Enrichment from the open sources
        </span>
      }
      summary={
        <>
          {run === null ? (
            "Not enriched yet."
          ) : (
            <span data-testid="enrichment-status" aria-live="polite">
              {runLine(run)}
              {settled(run) ? (
                <>
                  {" "}
                  {n(run.sources.length, "source")}, {n(asked, "record")} asked
                  {mismatches ? `, ${n(mismatches, "wrong match", "wrong matches")}` : ""}
                  {failures ? `, ${n(failures, "failure")}` : ""}.
                </>
              ) : null}
              {run.retracted > 0 ? (
                <>
                  {" "}
                  <strong className="font-semibold text-exclude">
                    {run.retracted} {run.retracted === 1 ? "record is" : "records are"} retracted.
                  </strong>
                </>
              ) : null}
            </span>
          )}
          {busy || error ? (
            <span
              role={error ? "alert" : "status"}
              className={`ml-2 ${error ? "text-exclude" : ""}`}
            >
              {error ?? "Starting the enrichment."}
            </span>
          ) : null}
        </>
      }
      actions={
        <Button
          size="sm"
          kind={run === null ? "primary" : "secondary"}
          keys={["r"]}
          disabled={!canEnrich || busy || active}
          onClick={onEnrich}
        >
          {run === null ? "Enrich the corpus" : "Enrich again"}
        </Button>
      }
    >
      {run === null ? null : <SourceTable sources={run.sources} onProblem={showProblems} />}
    </Panel>
  );
}

const settled = (run: EnrichmentRun) => !runActive(run) && run.status !== "failed";

/** Whether the run left something for the lead: a wrong match or a failed source. */
export const hasProblems = (run: EnrichmentRun | null) =>
  run !== null && !runActive(run) && run.sources.some((s) => s.failed > 0);

/** What the enrichment left for the lead, on the sheet: each wrong match and failed source with
 * the records it concerns and the way to repair it. */
export function EnrichmentProblems({
  run,
  records,
  flags,
  onOpenRecord,
}: {
  run: EnrichmentRun;
  /** Every record of the corpus, to find the ones a source failed for. */
  records: ReadonlyArray<RecordName>;
  flags: ReadonlyMap<string, RecordFlag>;
  /** Selects a record and opens its enrichment. */
  onOpenRecord: (occurrenceId: string) => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const [note, setNote] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const affected = useFailedRecords(run, flags, records);
  const retry = async () => {
    setRetrying(true);
    try {
      const plan = await call(
        workbench.retryFailedSources({ projectId: project.id, as: me.actor_id }),
      );
      setNote(
        `Asking ${plan.sources.map(sourceName).join(" and ")} again. Retrieval shows the progress.`,
      );
    } catch (e) {
      setNote(failure(e, "Kittum could not start the retry."));
    } finally {
      setRetrying(false);
    }
  };
  const troubled = run.sources.filter((s) => s.failed > 0);
  const failed = troubled.filter((s) => !wrongMatch(s));
  const mismatched = troubled.filter(wrongMatch);
  return (
    <section
      id={PROBLEMS_ID}
      tabIndex={-1}
      aria-label="Enrichment problems"
      className="min-w-0 outline-none"
    >
      <h2 className="text-md font-semibold">Enrichment to check</h2>
      <ul className="mt-3 grid gap-5 text-sm xl:grid-cols-2">
        {mismatched.map((s) => (
          <Problem
            key={s.source}
            term={WRONG_MATCH}
            heading={`${n(s.failed, "wrong match", "wrong matches")} from ${sourceName(s.source)}`}
            line={`${sourceName(s.source)} answered for another work. Check the record and correct its identifiers if they are wrong.`}
            records={affected?.get(s.source)}
            onOpenRecord={onOpenRecord}
          />
        ))}
        {failed.map((s) => (
          <Problem
            key={s.source}
            term={FAILED}
            heading={`${sourceName(s.source)} failed for ${n(s.failed, "record", "records")}`}
            line={failureLine(s.source, s.last_failure ?? {})}
            records={affected?.get(s.source)}
            onOpenRecord={onOpenRecord}
          />
        ))}
      </ul>
      {failed.length > 0 && !note ? (
        <Button
          size="sm"
          className="mt-3"
          disabled={retrying || runActive(run)}
          onClick={() => void retry()}
        >
          Retry the failed {failed.length === 1 ? "source" : "sources"}
        </Button>
      ) : null}
      {note ? (
        <p className="mt-2 text-sm text-ink-2" data-testid="enrichment-retry" aria-live="polite">
          {note}
        </p>
      ) : null}
    </section>
  );
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** A source that answered, but for another work: a wrong match for a person to check, not a
 * failed call. */
export const wrongMatch = (s: SourceProgress) => s.last_failure?.kind === "other_work";

const WRONG_MATCH: Term = { ...WAITS, label: "Wrong match" };
const FAILED: Term = { ...VERDICTS.not_met, label: "Failed" };

/** The id of the problems box, so the screen's summary can bring it into view. */
export const PROBLEMS_ID = "enrichment-problems";

export interface RecordName {
  readonly id: string;
  readonly title: string;
  /** The study's short name, "Free 2011", when the record has an author or a year. */
  readonly label: string | null;
}

interface Affected extends RecordName {
  readonly failure: SourceFailure;
}

// At most this many records are asked about to find the ones a source failed for.
const LOOKUPS = 60;

/** The records each failed source failed for, by source; null while Kittum looks. The run counts
 * failures per source only, so Kittum asks about the records the source did not answer for. */
function useFailedRecords(
  run: EnrichmentRun | null,
  flags: ReadonlyMap<string, RecordFlag>,
  records: ReadonlyArray<RecordName>,
) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const [found, setFound] = useState<{
    readonly key: string;
    readonly bySource: ReadonlyMap<string, ReadonlyArray<Affected>>;
  } | null>(null);
  const settled = run !== null && !runActive(run);
  const failing = settled ? run.sources.filter((s) => s.failed > 0).map((s) => s.source) : [];
  const key = `${run?.id ?? ""}|${failing.join(",")}`;

  useEffect(() => {
    const sources = key.split("|")[1]?.split(",").filter(Boolean) ?? [];
    if (!sources.length) return;
    let live = true;
    const candidates = records
      .filter((r) => {
        const flag = flags.get(r.id);
        return !flag || sources.some((s) => !flag.sources.includes(s));
      })
      .slice(0, LOOKUPS);
    void Promise.all(
      candidates.map((record) =>
        call(
          workbench.recordEnrichment({
            projectId: project.id,
            as: me.actor_id,
            occurrenceId: record.id,
          }),
        ).then(
          (enriched) => ({ record, failures: enriched?.failures ?? [] }),
          () => ({ record, failures: [] as ReadonlyArray<SourceFailure> }),
        ),
      ),
    ).then((results) => {
      if (!live) return;
      const bySource = new Map<string, Affected[]>();
      for (const { record, failures } of results) {
        for (const f of failures) {
          if (!sources.includes(f.source)) continue;
          bySource.set(f.source, [...(bySource.get(f.source) ?? []), { ...record, failure: f }]);
        }
      }
      setFound({ key, bySource });
    });
    return () => {
      live = false;
    };
  }, [workbench, project.id, me.actor_id, key, flags, records]);

  return found?.key === key ? found.bySource : null;
}

function Problem({
  term,
  heading,
  line,
  records,
  onOpenRecord,
}: {
  term: Term;
  heading: string;
  line: string;
  records: ReadonlyArray<Affected> | undefined | null;
  onOpenRecord: (occurrenceId: string) => void;
}) {
  return (
    <li>
      <h3 className="flex items-center gap-2 font-semibold">
        <Mark term={term} />
        {heading}
      </h3>
      <p className="mt-0.5 text-ink-2">{line}</p>
      {records === null ? (
        <p className="mt-1 text-ink-2">Finding the records.</p>
      ) : !records?.length ? (
        <p className="mt-1 text-ink-2">Kittum could not tell which records these were.</p>
      ) : (
        <ul className="mt-1 grid gap-1" aria-label="Records to check">
          {records.map((r) => (
            <li key={r.id}>
              <p className="leading-snug">
                {r.label ? <span className="font-medium">{r.label}</span> : null}
                {r.label ? " " : null}
                {r.title}
              </p>
              <Button size="sm" kind="quiet" className="-ml-2.5" onClick={() => onOpenRecord(r.id)}>
                Open the record
              </Button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// The parts of a source's bar, in its order, with the legend's words.
const FILLED = ["bg-include", "Filled a field"] as const;
const NONE = ["bg-rule-strong", "No record at the source"] as const;
const BROKE = ["bg-exclude", "Failed"] as const;
const MISMATCH = ["bg-marker-edge", "Wrong match"] as const;

function SourceTable({
  sources,
  onProblem,
}: {
  sources: ReadonlyArray<SourceProgress>;
  onProblem: () => void;
}) {
  const parts = [
    FILLED,
    NONE,
    ...(sources.some((s) => s.failed && !wrongMatch(s)) ? [BROKE] : []),
    ...(sources.some((s) => s.failed && wrongMatch(s)) ? [MISMATCH] : []),
  ];
  return (
    <div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-2" aria-label="Legend">
        {parts.map(([colour, label]) => (
          <li key={label} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`inline-block size-2.5 rounded-[2px] ${colour}`} />
            {label}
          </li>
        ))}
      </ul>
      <table aria-label="Enrichment by source" className="mt-2 w-full text-sm">
        <thead className="text-left text-xs text-ink-2">
          <tr className="border-b border-rule-strong">
            <th className="w-28 py-1.5 font-medium">Source</th>
            <th className="w-16 py-1.5 text-right font-medium">Asked</th>
            <th className="w-16 py-1.5 text-right font-medium">Filled</th>
            <th className="w-24 py-1.5 text-right font-medium">No record</th>
            <th className="w-20 py-1.5 text-right font-medium">Problems</th>
            <th className="py-1.5 pl-6 font-medium">Share of the records asked</th>
          </tr>
        </thead>
        <tbody>
          {SOURCES.map(([id, name]) => {
            const s = sources.find((x) => x.source === id);
            const asked = s?.asked ?? 0;
            const answered = s?.answered ?? 0;
            const failed = s?.failed ?? 0;
            const none = Math.max(asked - answered - failed, 0);
            const mismatch = s ? wrongMatch(s) : false;
            const problem = mismatch ? MISMATCH : BROKE;
            return (
              <tr
                key={id}
                data-testid="source-row"
                data-source={id}
                className="border-b border-rule last:border-b-0"
              >
                <th scope="row" className="py-1.5 text-left font-medium">
                  {name}
                </th>
                <td className="py-1.5 text-right tabular-nums">{asked}</td>
                <td className="py-1.5 text-right tabular-nums">{answered}</td>
                <td className="py-1.5 text-right tabular-nums">{none}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {failed ? (
                    <button
                      type="button"
                      onClick={onProblem}
                      title="Show the problem and its records"
                      aria-label={`${n(failed, mismatch ? "wrong match" : "failure", mismatch ? "wrong matches" : "failures")}. Show the problem and its records.`}
                      className={`font-semibold underline underline-offset-2 ${
                        mismatch
                          ? "text-marker-edge decoration-marker-edge/50"
                          : "text-exclude decoration-exclude/50"
                      }`}
                    >
                      {failed}
                    </button>
                  ) : (
                    failed
                  )}
                </td>
                <td className="py-1.5 pl-6">
                  {asked === 0 ? (
                    <span className="text-xs text-ink-2">No record to ask about</span>
                  ) : (
                    <span
                      className="flex h-2.5 w-full overflow-hidden rounded-[2px] bg-rule"
                      role="img"
                      aria-label={`${answered} filled, ${none} no record, ${failed} ${problem[1].toLowerCase()}, of ${asked}`}
                    >
                      {(
                        [
                          [answered, FILLED],
                          [none, NONE],
                          [failed, problem],
                        ] as const
                      ).map(([count, [colour, label]]) =>
                        count ? (
                          <span
                            key={label}
                            className={colour}
                            style={{ width: `${(count / asked) * 100}%` }}
                          />
                        ) : null,
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Text with PubTator's entities underlined in their label's colour. `offset` is where `text`
 * starts in the title-plus-abstract string the tags index into. */
function Tagged({
  text,
  offset,
  entities,
}: {
  text: string;
  offset: number;
  entities: ReadonlyArray<EntityTag>;
}) {
  const inside = entities
    .filter((e) => e.start >= offset && e.end <= offset + text.length)
    .toSorted((a, b) => a.start - b.start);
  const parts: ReactNode[] = [];
  let at = offset;
  for (const e of inside) {
    if (e.start < at) continue; // overlapping tags: the first wins
    parts.push(text.slice(at - offset, e.start - offset));
    parts.push(
      <mark
        key={`${e.start}-${e.label}`}
        data-testid="entity"
        data-label={e.label}
        title={[ENTITY_NAMES[e.label] ?? e.label, e.normalized_id].filter(Boolean).join(", ")}
        className="bg-transparent text-inherit underline decoration-2 underline-offset-[3px]"
        style={{ textDecorationColor: ENTITY_COLOURS[e.label] ?? "var(--ink-3)" }}
      >
        {text.slice(e.start - offset, e.end - offset)}
      </mark>,
    );
    at = e.end;
  }
  parts.push(text.slice(at - offset));
  return <>{parts}</>;
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function RecordDetail({
  record,
  searchSource,
}: {
  record: RecordEnrichment | null | undefined;
  searchSource: string;
}) {
  if (record === undefined) return <p className="text-sm text-ink-3">Loading the record.</p>;
  if (record === null) {
    return <p className="text-sm text-ink-2">This record is not enriched yet.</p>;
  }
  const notices = record.updates.filter(
    (u) =>
      u.direction === "updated_by" &&
      !(u.kind === "retraction" && u.doi === record.retraction_notice_doi),
  );
  const columns: ReadonlyArray<readonly [string, string]> = [
    [record.search_source, "The search"],
    ...SOURCES,
  ];
  const fromSource = new Set(record.field_sources.map((f) => `${f.field}|${f.source}`));
  const fields = FIELDS.filter(([field]) => record.field_sources.some((f) => f.field === field));
  const labels = [...new Set(record.entities.map((e) => e.label))];
  return (
    <article aria-label="Record enrichment" data-testid="record-enrichment" className="text-sm">
      {record.retracted ? (
        <section
          data-testid="retraction"
          className="-mx-6 mb-5 border-y-2 border-exclude bg-exclude-wash px-6 py-3 text-exclude"
        >
          <p className="text-md font-semibold">Retracted</p>
          <p className="mt-1 text-ink">
            {record.retraction_notice_doi
              ? `Crossref links the retraction notice ${record.retraction_notice_doi} to this article.`
              : "OpenAlex marks this article as retracted."}{" "}
            Check whether its study still belongs in the review.
          </p>
        </section>
      ) : null}
      <h3 className="text-md leading-snug font-semibold">
        <Tagged text={record.title} offset={0} entities={record.entities} />
      </h3>
      <p className="mt-1 text-xs text-ink-2">Found by {searchSource}</p>

      {notices.length > 0 ? (
        <ul className="mt-3 grid gap-1" aria-label="Notices">
          {notices.map((u) => (
            <li key={`${u.kind}-${u.doi}`} data-testid="notice" className="text-unclear">
              <span className="font-medium">{noticeName(u.kind)}</span>{" "}
              <span className="text-ink-2">{u.doi}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <dl className="mt-4 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1">
        {(
          [
            ["DOI", record.doi],
            ["PMID", record.pmid],
            ["PMCID", record.pmcid],
            ["Trial numbers", record.clinical_trial_numbers.join(", ") || null],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-3">{label}</dt>
            <dd className={value ? "" : "text-ink-3"}>{value ?? "Not found"}</dd>
          </div>
        ))}
      </dl>

      <h4 className="mt-6 text-sm font-semibold">Where each field came from</h4>
      <table aria-label="Where each field came from" className="mt-2 w-full text-xs">
        <thead>
          <tr>
            <th className="py-1 text-left font-normal text-ink-3">
              <span className="sr-only">Field</span>
            </th>
            {columns.map(([id, name]) => (
              <th
                key={id}
                scope="col"
                className="w-[4.2rem] px-1 py-1 text-center align-bottom font-normal text-ink-2"
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fields.map(([field, label]) => (
            <tr
              key={field}
              data-testid="provenance-row"
              data-field={field}
              className="border-t border-rule"
            >
              <th scope="row" className="py-1.5 pr-2 text-left font-medium">
                {label}
              </th>
              {columns.map(([id, name]) => {
                const supplied = fromSource.has(`${field}|${id}`);
                return (
                  <td
                    key={id}
                    className="px-1 py-1.5 text-center"
                    data-source={supplied ? id : undefined}
                  >
                    {supplied ? (
                      <>
                        <span
                          aria-hidden
                          className="inline-block size-2.5 rounded-[2px] bg-petrol"
                        />
                        <span className="sr-only">{name}</span>
                      </>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {record.failures.length > 0 ? (
        <ul className="mt-2 grid gap-0.5 text-xs text-exclude" data-testid="record-failures">
          {record.failures.map((f) => (
            <li key={f.source} title={f.reason}>
              {failureLine(f.source, f)}
            </li>
          ))}
        </ul>
      ) : null}

      <h4 className="mt-6 text-sm font-semibold">Abstract</h4>
      {record.abstract ? (
        <p className="mt-2 max-w-[68ch] text-md leading-relaxed" data-testid="enriched-abstract">
          <Tagged
            text={record.abstract}
            offset={record.title.length + 1}
            entities={record.entities}
          />
        </p>
      ) : (
        <p className="mt-2 text-ink-3">No source had an abstract.</p>
      )}
      {labels.length > 0 ? (
        <p className="mt-2 flex flex-wrap gap-x-4 text-xs text-ink-2" aria-label="Entity tags">
          {labels.map((label) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-0.5 w-4"
                style={{ background: ENTITY_COLOURS[label] ?? "var(--ink-3)" }}
              />
              {ENTITY_NAMES[label] ?? label},{" "}
              {record.entities.filter((e) => e.label === label).length} from PubTator 3
            </span>
          ))}
        </p>
      ) : null}

      <h4 className="mt-6 text-sm font-semibold">Open-access locations</h4>
      {record.oa_locations.length === 0 ? (
        <p className="mt-2 text-ink-3">No source has an open-access copy.</p>
      ) : (
        <table aria-label="Open-access locations" className="mt-2 w-full text-xs">
          <tbody>
            {record.oa_locations.map((o) => (
              <tr key={o.url} data-testid="oa-location" className="border-t border-rule">
                <td className="w-24 py-1.5 pr-2 text-ink-2">{sourceName(o.source ?? "")}</td>
                <td className="w-24 py-1.5 pr-2">{FORMATS[o.format ?? ""] ?? "Unknown"}</td>
                <td className="py-1.5 pr-2">
                  <a
                    href={o.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-petrol underline-offset-2 hover:underline"
                  >
                    {host(o.url)}
                  </a>
                </td>
                <td className="w-24 py-1.5 text-right text-ink-2">
                  {o.licence ?? "No licence stated"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
