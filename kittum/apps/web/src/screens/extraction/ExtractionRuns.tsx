// Extraction runs (DESIGN.md, "Extraction"): each run takes one report's full text through the
// Janus path, and the LLM path where a model server is set up, against an extraction schema. The
// methods lead requests them; a worker fills them; reviewers open one and accept its values. One
// table: each run's row (study, status, progress, Review), and under it the run's values, the
// accepted ones (the latest per semantic key, what the reports use) and those still to verify,
// each opening its history.
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import type {
  Assertion,
  ExtractionReview,
  ExtractionSchema,
  RetrievalItem,
  ReviewField,
  RunListing,
} from "../../data/schema.ts";
import { run } from "../../data/workbench.ts";
import { formatDate, formatDateTime } from "../../lib/format.ts";
import { keyWords } from "../../lib/labels.ts";
import { Help } from "../../ui/Help.tsx";
import { Button } from "../../ui/Button.tsx";
import { failure, Field, FileInput, FormDialog, Select, TextInput } from "../../ui/Form.tsx";
import { useKeys } from "../../ui/keys.ts";
import { Page } from "../../ui/Page.tsx";
import { Panel } from "../../ui/Panel.tsx";
import { ACCEPTED, Mark, Status, VERDICTS } from "../../ui/Status.tsx";
import { studyName, useStudyNames } from "../appraisal/studyNames.ts";
import { plural, useProject } from "../project.tsx";
import { ValueHistory } from "./History.tsx";
import {
  AcceptedBar,
  estimateFacts,
  POLICY_HELP,
  PolicyTag,
  sourceWord,
  studyFromText,
  ToVerify,
  unitBeside,
  unitGap,
} from "./marks.tsx";

const STATUS: Record<string, { readonly label: string; readonly tone: string }> = {
  queued: { label: "Waiting for a worker", tone: "bg-ink-3" },
  running: { label: "Running", tone: "bg-petrol" },
  succeeded: { label: "Ready to review", tone: "bg-marker-edge" },
  failed: { label: "Failed. Kittum retries it", tone: "bg-exclude" },
  dead: { label: "Failed for good", tone: "bg-exclude" },
};

const KEY_PARTS = [
  "endpoint",
  "arm",
  "timepoint",
  "quantity",
  "analysis_set",
  "subpopulation",
  "data_cut",
  "report_id",
] as const;
const sameKey = (a: Pick<Assertion, "key">, f: Pick<ReviewField, "key">) =>
  KEY_PARTS.every((k) => a.key[k] === f.key[k]);

/** One value in the table: accepted (an assertion) or still to verify (an open field). */
interface Row {
  readonly id: string;
  readonly assertion: Assertion | null;
  readonly field: ReviewField | null;
  readonly review: ExtractionReview | null;
}

/** A run and its values; accepted values of runs no longer listed come last, without a run. */
interface Block {
  readonly id: string;
  readonly listing: RunListing | null;
  readonly review: ExtractionReview | null;
  readonly rows: Row[];
}

type Filter = "open" | "all" | "accepted";

const valueOf = (f: ReviewField) =>
  f.acceptance?.value ??
  f.proposals.find((p) => p.path === f.accepted)?.value ??
  f.proposals.find((p) => p.status === "extracted")?.value ??
  null;

/** A run's values in its schema's order (endpoint, then arm, then timepoint), each endpoint's
 * first value carrying the endpoint's group row. */
const inOrder = (rows: ReadonlyArray<Row>) => {
  const place = (r: Row) => r.review?.fields.findIndex((f) => f.id === r.field?.id) ?? -1;
  const sorted = rows
    .map((row, i) => ({ row, i, at: place(row) }))
    .sort((a, b) => (a.at < 0 ? 1e9 : a.at) - (b.at < 0 ? 1e9 : b.at) || a.i - b.i);
  let last = "";
  return sorted.map(({ row }) => {
    const label = row.field?.labels.endpoint ?? keyWords(row.assertion?.key.endpoint ?? "");
    const set = row.field?.key.analysis_set ?? row.assertion?.key.analysis_set ?? "";
    const id = `${label}|${set}`;
    const endpoint = id === last ? null : { label, set };
    last = id;
    return { row, endpoint };
  });
};

export function ExtractionRunsScreen() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const navigate = useNavigate();
  const { project, me, has, seesLeadData, labels } = useProject();
  const studyNames = useStudyNames();
  const [runs, setRuns] = useState<ReadonlyArray<RunListing> | null>(null);
  const [assertions, setAssertions] = useState<ReadonlyArray<Assertion>>([]);
  const [reviews, setReviews] = useState<ReadonlyMap<string, ExtractionReview>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const canRequest = has("lead") && seesLeadData && workbench.live;

  const load = useCallback(
    () =>
      Promise.all([
        run(workbench.extractionRuns({ projectId: project.id, as: me.actor_id })),
        run(workbench.assertions({ projectId: project.id, as: me.actor_id })),
      ]).then(
        ([found, values]) => {
          setRuns(found);
          setAssertions(values);
        },
        (e: unknown) => setError(failure(e, "Kittum could not load the runs.")),
      ),
    [workbench, project.id, me.actor_id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // A run in the queue finishes on a worker: look again until none is waiting.
  const pending = (runs ?? []).some((r) => r.run.status === "queued" || r.run.status === "running");
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [pending, load]);

  // Every finished run's fields, for the values' labels, pages, reviewers, and the values still
  // to verify. A run that cannot be read leaves its accepted values with their keys.
  const runIds = useMemo(
    () =>
      [
        ...new Set([
          ...(runs ?? []).filter((r) => r.run.status === "succeeded").map((r) => r.run.id),
          ...assertions.map((a) => a.run_id),
        ]),
      ]
        .sort()
        .join(","),
    [runs, assertions],
  );
  const progress = (runs ?? []).map((r) => r.accepted).join(",");
  useEffect(() => {
    if (!runIds) return;
    let live = true;
    void Promise.all(
      runIds.split(",").map((runId) =>
        run(workbench.extraction({ projectId: project.id, as: me.actor_id, runId })).then(
          (review) => [runId, review] as const,
          () => null,
        ),
      ),
    ).then((found) => {
      if (live) setReviews(new Map(found.filter((r) => r !== null)));
    });
    return () => {
      live = false;
    };
  }, [runIds, progress, workbench, project.id, me.actor_id]);

  const names = useMemo(
    () => new Map(project.members.map((m) => [m.actor_id, m.display_name])),
    [project.members],
  );

  // Where the ledger's hash chain breaks, acceptances recorded after it cannot be verified. The
  // ledger summary is the lead's; for anyone else the call fails and nothing shows.
  const [breakAt, setBreakAt] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    run(workbench.ledger({ projectId: project.id, as: me.actor_id })).then(
      (l) => live && setBreakAt(l.ok ? null : (l.verify?.first_bad_seq ?? null)),
      () => live && setBreakAt(null),
    );
    return () => {
      live = false;
    };
  }, [workbench, project.id, me.actor_id]);

  // Per run: its accepted values in the server's order, then those still open.
  const blocks = useMemo(() => {
    const out: Block[] = (runs ?? []).map((listing) => ({
      id: listing.run.id,
      listing,
      review: reviews.get(listing.run.id) ?? null,
      rows: [],
    }));
    for (const a of assertions) {
      const review = reviews.get(a.run_id) ?? null;
      const field =
        review?.fields.find((f) => f.acceptance?.id === a.acceptance_id) ??
        review?.fields.find((f) => sameKey(a, f)) ??
        null;
      let block = out.find((b) => b.id === a.run_id) ?? out.find((b) => b.id === "other");
      if (!block) out.push((block = { id: "other", listing: null, review: null, rows: [] }));
      block.rows.push({ id: a.acceptance_id, assertion: a, field, review });
    }
    for (const block of out) {
      for (const f of block.review?.fields ?? []) {
        if (f.accepted || assertions.some((a) => sameKey(a, f))) continue;
        block.rows.push({ id: f.id, assertion: null, field: f, review: block.review });
      }
    }
    return out;
  }, [assertions, reviews, runs]);
  const all = blocks.flatMap((b) => b.rows);
  const unverified =
    breakAt === null
      ? 0
      : all.filter((r) => (r.field?.acceptance?.event_seq ?? 0) >= breakAt && r.assertion).length;
  const openCount = all.filter((r) => !r.assertion).length;
  const shown = (row: Row) =>
    filter === "all" || (filter === "open" ? !row.assertion : row.assertion !== null);

  const current = runs?.[Math.min(selected, runs.length - 1)];
  const open = (listing: RunListing | undefined) => {
    if (!listing) return;
    if (listing.run.status !== "succeeded") {
      setNotice("This run has no fields yet. You can open it once a worker has finished it.");
      return;
    }
    void navigate({
      to: "/p/$projectId/extraction/$runId",
      params: { projectId: project.id, runId: listing.run.id },
    });
  };

  useKeys((event) => {
    if (event.key === "n" && canRequest) {
      setRequesting(true);
      return true;
    }
    if (!runs?.length) return false;
    switch (event.key) {
      case "j":
      case "ArrowDown":
        setSelected((i) => Math.min(i + 1, runs.length - 1));
        return true;
      case "k":
      case "ArrowUp":
        setSelected((i) => Math.max(i - 1, 0));
        return true;
      case "Enter":
        open(current);
        return true;
      default:
        return false;
    }
  });

  const waiting = (runs ?? []).filter((r) => r.run.status !== "succeeded").length;
  const summary =
    runs === null
      ? "Loading the runs."
      : runs.length === 0
        ? "Nothing extracted yet."
        : `${runs.length} ${runs.length === 1 ? "run" : "runs"}${
            waiting ? `, ${waiting} not finished` : ""
          }. Open a value for its history.${workbench.live ? "" : " Example data: one recorded run."}`;

  return (
    <Page
      kind="data"
      title="Extraction"
      summary={<span data-testid="extraction-summary">{summary}</span>}
      actions={
        canRequest ? (
          <Button kind="primary" keys={["n"]} onClick={() => setRequesting(true)}>
            Request a run
          </Button>
        ) : null
      }
    >
      {notice || error ? (
        <p
          role={error ? "alert" : "status"}
          className={`mb-4 max-w-[90ch] border-l-2 pl-3 text-sm ${error ? "border-exclude text-exclude" : "border-petrol"}`}
          data-testid="extraction-runs-notice"
        >
          {error ?? notice}
        </p>
      ) : null}

      {runs === null ? null : runs.length === 0 ? (
        <p className="max-w-[80ch] rounded-[4px] border border-rule bg-sheet px-5 py-4 text-md text-ink-2">
          {canRequest
            ? `No runs yet. Request one on a ${labels.report.toLowerCase()} included at full text. The extraction schema names the arms, comparisons, endpoints, and quantities to take from it.`
            : `No runs yet. The methods lead requests them on included ${plural(labels.report).toLowerCase()}. A run shows here once it is ready to review.`}
        </p>
      ) : null}
      {runs !== null && runs.length === 0 && assertions.length === 0 ? (
        <p className="mt-4 text-md text-ink-2">
          None yet. A value shows here once a reviewer accepts it in a run.
        </p>
      ) : null}

      {blocks.length ? (
        <>
          {all.length ? (
            <div
              className="mb-4 inline-flex overflow-hidden rounded-[4px] border border-rule-strong text-sm"
              role="group"
              aria-label="Show values"
            >
              {(
                [
                  ["all", `All (${all.length})`],
                  ["open", `To verify (${openCount})`],
                  ["accepted", `Accepted (${all.length - openCount})`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={`h-8 px-3 ${filter === value ? "bg-petrol-wash font-medium text-petrol" : "bg-raised text-ink-2 hover:bg-sheet-2"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          {/* One sheet: the values. Each run's summary is a band recessed into it. */}
          <Panel>
            {unverified ? (
              <p
                className="mb-3 flex items-center gap-2 text-sm text-exclude"
                data-testid="extraction-ledger-note"
              >
                <Mark term={VERDICTS.not_met} />
                The ledger&rsquo;s hash chain breaks at event {breakAt}. {unverified} accepted{" "}
                {unverified === 1 ? "value was" : "values were"} recorded after it, so{" "}
                {unverified === 1 ? "its" : "their"} acceptance history cannot be verified.
              </p>
            ) : null}
            <div className="space-y-8">
              {blocks.map((block, index) => {
                const rows = inOrder(block.rows.filter(shown));
                return (
                  <div key={block.id} className="space-y-3" data-testid="value-group">
                    {block.listing ? (
                      <RunHeader
                        listing={block.listing}
                        name={studyFromText(
                          studyNames.get(block.listing.run.report_id),
                          block.review?.layer.text,
                          block.listing.report.citation ?? "",
                          studyName(
                            studyNames,
                            block.listing.run.report_id,
                            block.listing.report.title ?? "",
                          ),
                        )}
                        selected={index === selected}
                        marked={(runs?.length ?? 0) > 1 && index === selected}
                        onSelect={() => setSelected(index)}
                        onOpen={() => open(block.listing ?? undefined)}
                      />
                    ) : (
                      <h2 className="text-md font-semibold">
                        Accepted values of runs no longer listed
                      </h2>
                    )}
                    {rows.length ? (
                      <>
                        <table
                          className="w-full border-collapse text-sm"
                          aria-label="Extracted values"
                        >
                          <thead>
                            <tr className="border-b border-rule-strong text-left text-xs text-ink-2">
                              <th className="py-2 pr-4 font-semibold">Arm or comparison</th>
                              <th className="py-2 pr-4 font-semibold">Timepoint</th>
                              <th className="py-2 pr-4 font-semibold">Quantity</th>
                              <th className="py-2 pr-4 text-right font-semibold">Value</th>
                              <th className="py-2 pr-4 font-semibold">
                                <Help
                                  text={`${POLICY_HELP["critical"]} ${POLICY_HELP["standard"]}`}
                                >
                                  Importance
                                </Help>
                              </th>
                              <th className="py-2 pr-4 font-semibold">Source</th>
                              <th className="py-2 font-semibold">Accepted</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map(({ row, endpoint }) => (
                              <Fragment key={row.id}>
                                {endpoint ? (
                                  <tr data-testid="endpoint-group">
                                    <th
                                      colSpan={7}
                                      className="pt-4 pb-1 text-left text-md font-semibold"
                                    >
                                      {endpoint.label}
                                      {endpoint.set ? (
                                        <span
                                          className="ml-2 rounded-full bg-sheet-2 px-2 text-xs font-normal text-ink-2"
                                          title={endpoint.set}
                                        >
                                          {keyWords(endpoint.set)}
                                        </span>
                                      ) : null}
                                    </th>
                                  </tr>
                                ) : null}
                                <ValueRow
                                  row={row}
                                  names={names}
                                  open={expanded === row.id}
                                  onToggle={() =>
                                    setExpanded((id) => (id === row.id ? null : row.id))
                                  }
                                />
                                {expanded === row.id && row.field && row.review ? (
                                  <tr>
                                    <td colSpan={7} className="p-0">
                                      <ValueHistory
                                        field={row.field}
                                        fields={row.review.fields}
                                        acceptance={row.field.acceptance}
                                        accepted={row.field.accepted}
                                        anchors={new Map(row.review.anchors.map((x) => [x.id, x]))}
                                        names={names}
                                        run={row.review.run}
                                        text={row.review.layer.text}
                                        actions={
                                          <Link
                                            to="/p/$projectId/extraction/$runId"
                                            params={{
                                              projectId: project.id,
                                              runId: row.review.run.id,
                                            }}
                                            className="text-sm text-petrol hover:underline"
                                          >
                                            {row.assertion
                                              ? "Open the run beside the PDF"
                                              : "Verify it in the run"}
                                          </Link>
                                        }
                                      />
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
                            ))}
                          </tbody>
                        </table>
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Panel>
        </>
      ) : null}
      {canRequest ? (
        <RequestRun
          open={requesting}
          onOpenChange={setRequesting}
          onDone={(message) => {
            setRequesting(false);
            setNotice(message);
            setSelected(0);
            void load();
          }}
        />
      ) : null}
    </Page>
  );
}

/** The run's header band: its study, paths and date, its progress, and one Review button. */
function RunHeader({
  listing,
  name,
  selected,
  marked,
  onSelect,
  onOpen,
}: {
  listing: RunListing;
  name: string;
  selected: boolean;
  /** Several runs: the one j and k have reached is outlined. */
  marked: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const status = STATUS[listing.run.status];
  const done = listing.run.status === "succeeded";
  const left = listing.fields - listing.accepted;
  const title = listing.report.title ?? "";
  const ids = [listing.report.study_label, listing.report.citation].filter(Boolean).join(" · ");
  return (
    <div
      data-testid="extraction-run"
      aria-current={selected || undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={`flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[4px] bg-sheet-2 px-4 py-3 ${marked ? "shadow-[inset_3px_0_0_var(--petrol)]" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <h2 className="text-md font-semibold" title={[title, ids].filter(Boolean).join("\n")}>
          {name || "Untitled report"}
        </h2>
        <p className="text-sm text-ink-2">
          {listing.run.model_identity ? (
            <span title={`The LLM path ran on ${listing.run.model_identity}`}>
              Read by Janus and the LLM path
            </span>
          ) : (
            "Read by the Janus path"
          )}
          , requested {formatDateTime(listing.run.created_at)}.
        </p>
      </div>
      {done ? (
        <span className="flex items-center gap-3 text-sm">
          <AcceptedBar accepted={listing.accepted} total={listing.fields} />
          <span className="whitespace-nowrap tabular-nums" data-testid="run-progress">
            {`${listing.accepted} of ${listing.fields} accepted`}
          </span>
        </span>
      ) : (
        <span data-testid="run-progress" />
      )}
      {/* While values wait, the status is the work left, in amber; green only once every value
          is accepted. */}
      <span className="flex items-center gap-2 text-sm">
        {done && left > 0 ? (
          <span data-testid="run-status">
            <ToVerify>{`${left} to verify`}</ToVerify>
          </span>
        ) : done ? (
          <span data-testid="run-status">
            <Status term={ACCEPTED}>All accepted</Status>
          </span>
        ) : (
          <>
            <span
              aria-hidden="true"
              className={`size-2 flex-none rounded-full ${status?.tone ?? "bg-ink-3"}`}
            />
            <span data-testid="run-status">{status?.label ?? listing.run.status}</span>
          </>
        )}
      </span>
      {done ? (
        <Button
          size="sm"
          kind="primary"
          {...(selected ? { keys: ["Enter"] } : {})}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          Review
        </Button>
      ) : null}
    </div>
  );
}

function ValueRow({
  row,
  names,
  open,
  onToggle,
}: {
  row: Row;
  names: ReadonlyMap<string, string>;
  open: boolean;
  onToggle: () => void;
}) {
  const { assertion: a, field, review } = row;
  const key = a?.key ?? field!.key;
  const acceptance =
    field && a && field.acceptance?.id === a.acceptance_id ? field.acceptance : null;
  const proposal = field?.proposals.find((p) => p.status === "extracted") ?? field?.proposals[0];
  const anchors = useMemo(
    () => new Map((review?.anchors ?? []).map((x) => [x.id, x])),
    [review?.anchors],
  );
  const facts =
    field && review
      ? estimateFacts({
          field,
          fields: review.fields,
          anchors,
          valueOf,
          text: review.layer.text,
          acceptanceAnchor: acceptance?.anchor_id ?? a?.anchor_id,
        })
      : null;
  const quantity = facts?.label ?? keyWords(key.quantity);
  const value = a ? a.value : (proposal?.value ?? null);
  const unit = unitBeside(a ? a.unit : (proposal?.unit ?? null), quantity);
  const anchorId = a?.anchor_id ?? proposal?.anchor_ids[0];
  const page = (anchorId ? anchors.get(anchorId)?.boxes[0]?.page : undefined) ?? null;
  const edited = acceptance?.edited ?? false;
  // The same words as the run's Paths column.
  const from = field ? sourceWord(field, acceptance) : "";
  const source = [page !== null ? `p. ${page}` : null, from || null].filter(Boolean).join(" · ");
  const reviewer = acceptance ? names.get(acceptance.reviewer_id) : undefined;
  const policy = a?.policy ?? field?.spec.policy ?? "";
  return (
    <tr
      className={`border-b border-rule align-top ${open ? "bg-sheet" : "hover:bg-sheet/60"}`}
      data-testid={a ? "assertion" : "open-value"}
      onClick={field ? onToggle : undefined}
    >
      <td className="py-2 pr-4 pl-2" title={key.arm}>
        {field ? (
          <button
            type="button"
            aria-expanded={open}
            className="inline-flex items-baseline gap-1.5 text-left hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <span aria-hidden="true" className="w-4 flex-none text-base leading-none text-ink-2">
              {open ? "▾" : "▸"}
            </span>
            {field.labels.arm}
          </button>
        ) : (
          keyWords(key.arm)
        )}
      </td>
      <td className="py-2 pr-4" title={key.timepoint}>
        {field?.labels.timepoint ?? keyWords(key.timepoint)}
      </td>
      <td
        className="py-2 pr-4"
        title={
          facts?.adjustmentFrom
            ? `${key.quantity}; adjustment from ${facts.adjustmentFrom}`
            : key.quantity
        }
      >
        {quantity}
      </td>
      <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">
        <span className={a ? "font-semibold" : ""}>{value ?? "Not reported"}</span>
        {value && unit ? (
          <>
            {unitGap(unit)}
            <span className="font-normal text-ink-2">{unit}</span>
          </>
        ) : null}
        {facts?.interval ? (
          <span
            className="block text-xs text-ink-2"
            title={facts.intervalFrom === "source" ? "Read from the source span" : undefined}
          >
            {facts.interval}
          </span>
        ) : null}
      </td>
      <td className="py-2 pr-4">
        <PolicyTag policy={policy} />
      </td>
      <td className="py-2 pr-4 whitespace-nowrap text-ink-2">
        {edited && field ? (
          <button
            type="button"
            aria-expanded={open}
            title="What the paths read, the correction, and where it came from"
            className="underline decoration-rule-strong underline-offset-2 hover:text-ink hover:decoration-ink-2"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            {source}
          </button>
        ) : (
          source || "–"
        )}
      </td>
      <td className="py-2 whitespace-nowrap">
        {a ? (
          reviewer ? (
            <span title={acceptance ? formatDateTime(acceptance.accepted_at) : undefined}>
              {reviewer}
              <span className="text-ink-2">
                {acceptance ? `, ${formatDate(acceptance.accepted_at)}` : ""}
                {acceptance?.group ? " (group)" : ""}
              </span>
            </span>
          ) : (
            <span className="text-ink-2">–</span>
          )
        ) : (
          <ToVerify />
        )}
      </td>
    </tr>
  );
}

function RequestRun({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, labels } = useProject();
  const [reports, setReports] = useState<ReadonlyArray<RetrievalItem> | null>(null);
  const [models, setModels] = useState<ReadonlyArray<string>>([]);
  const [itemRef, setItemRef] = useState("");
  const [schema, setSchema] = useState<ExtractionSchema | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    run(workbench.fullTexts({ projectId: project.id, as: me.actor_id })).then(
      (found) => {
        if (!live) return;
        // Only a report included at full text in some scope, with its PDF, as the server asks.
        const ready = found.filter(
          (r) =>
            r.full_text &&
            Object.values(r.outcomes).some((stages) => stages["full_text"] === "include"),
        );
        setReports(ready);
        setItemRef((ref) => ref || (ready[0]?.item_ref ?? ""));
      },
      (e: unknown) => live && setError(failure(e, "Kittum could not load the reports.")),
    );
    run(workbench.extractionModels(project.id)).then(
      (found) => live && setModels(found),
      () => live && setModels([]),
    );
    return () => {
      live = false;
    };
  }, [open, workbench, project.id, me.actor_id]);

  const report = reports?.find((r) => r.item_ref === itemRef);
  const readSchema = async (file: File | null) => {
    setSchema(null);
    setSchemaError(null);
    if (!file) return;
    try {
      const text = await file.text();
      setSchema(
        await run(
          workbench.parseExtractionSchema({ projectId: project.id, as: me.actor_id, text }),
        ),
      );
    } catch (e) {
      setSchemaError(failure(e, "Kittum could not read the schema."));
    }
  };

  const submit = async () => {
    if (!report?.full_text || !schema) {
      setError(
        `Choose a ${labels.report.toLowerCase()} with a full text and an extraction schema.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await run(
        workbench.requestExtraction({
          projectId: project.id,
          as: me.actor_id,
          layerId: report.full_text.layer_id,
          studyId: report.study_id,
          reportId: report.report_id,
          schema,
          modelId: model || null,
          report: {
            study_label: label.trim() || report.registry_ids[0] || report.doi || "",
            title: report.title,
            citation: [report.journal, report.year].filter(Boolean).join(" "),
            licence: report.full_text.licence ?? "",
          },
        }),
      );
      setSchema(null);
      onDone(
        `Requested a run on “${report.title}”. A worker runs it, and you can review it once it is ready.`,
      );
    } catch (e) {
      setError(failure(e, "Kittum did not request the run."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title="Request an extraction run"
      description="Both paths read the report's full text. Janus finds the tables and labelled values. The LLM path quotes what it reads. Kittum checks every value against its source, and reviewers accept each one."
      submit="Request the run"
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
    >
      <Field
        label={labels.report}
        hint={
          reports && reports.length === 0
            ? "No report is included at full text yet. You can request a run once one is."
            : "Reports included at full text, with their PDF."
        }
      >
        <Select value={itemRef} onChange={(e) => setItemRef(e.currentTarget.value)}>
          {(reports ?? []).map((r) => (
            <option key={r.item_ref} value={r.item_ref}>
              {r.title}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Study label" hint="How the review names the study. Its registry ID by default.">
        <TextInput
          value={label}
          placeholder={report?.registry_ids[0] ?? report?.doi ?? ""}
          onChange={(e) => setLabel(e.currentTarget.value)}
        />
      </Field>
      <Field
        label="Extraction schema"
        hint="YAML or JSON: arms, comparisons, endpoints with their timepoints and quantities."
      >
        <FileInput
          label="Schema file"
          accept=".yaml,.yml,.json"
          onFile={(f) => void readSchema(f)}
        />
      </Field>
      {schemaError ? (
        <p role="alert" className="text-sm text-exclude">
          {schemaError}
        </p>
      ) : schema ? (
        <p className="text-sm text-ink-2" data-testid="schema-preview">
          {schema.name}: {schema.arms.length} arms, {schema.endpoints.length} endpoints (
          {schema.endpoints.map((e) => e.label).join(", ")}).
        </p>
      ) : null}
      <Field
        label="Paths"
        hint={
          models.length
            ? "The LLM path runs on the worker's model server."
            : "No model server is configured, so the run takes the Janus path only."
        }
      >
        <Select value={model} onChange={(e) => setModel(e.currentTarget.value)}>
          <option value="">Janus path only</option>
          {models.map((m) => (
            <option key={m} value={m}>
              Janus and the LLM path on {m}
            </option>
          ))}
        </Select>
      </Field>
    </FormDialog>
  );
}
