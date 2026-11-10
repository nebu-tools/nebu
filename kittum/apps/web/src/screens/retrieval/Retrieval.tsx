// Full-text retrieval (DESIGN.md, "Full text"). The methods lead sees one row per report with its
// final state (a PDF, none, or a registry record with no article yet) and its citation with the
// identifiers as links; has a worker walk the open-access waterfall for the reports sought (every attempt kept under the report's retrieval history), retries the sources that
// failed, uploads the PDFs open access did not give (one at a time or a folder at once), exports
// the reports still without a PDF for whoever can send them, and adds the full-text sentinels
// that full-text queues get unmarked. The list is the lead's alone: it names every record, and a
// reviewer who saw it could tell sentinels.
import { Menu } from "@base-ui/react/menu";
import { Link, useRouteContext } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type {
  AttemptView,
  EnrichmentRun,
  HeldUpload,
  MissingReport,
  OpenAccessRun,
  ReportRetrieval,
  RetrievalItem,
  RetryPreview,
} from "../../data/schema.ts";
import { run } from "../../data/workbench.ts";
import { formatDate, formatDateTime } from "../../lib/format.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/Empty.tsx";
import { failure, Field, FileInput, FormDialog, Select, TextInput } from "../../ui/Form.tsx";
import { Key, KeyHint } from "../../ui/Key.tsx";
import { useKeys } from "../../ui/keys.ts";
import { Page } from "../../ui/Page.tsx";
import { Help } from "../../ui/Help.tsx";
import { Panel } from "../../ui/Panel.tsx";
import { usePoll } from "../../ui/poll.ts";
import { ACCEPTED, Mark, NOT_DONE, WAITS } from "../../ui/Status.tsx";
import type { Term } from "../../ui/Status.tsx";
import { isRegistryOnly, registryUrl, studyLabel } from "../../lib/labels.ts";
import { useStudyNames } from "../appraisal/studyNames.ts";
import { LEAD_ONLY, plural, useProject } from "../project.tsx";
import { failureLine, runActive, sourceName } from "../studies/Enrichment.tsx";

const OUTCOME: Record<string, { label: string; className: string }> = {
  include: { label: "Included", className: "text-include" },
  exclude: { label: "Excluded", className: "text-exclude" },
  conflict: { label: "In conflict", className: "text-unclear" },
};

/** Sought for retrieval: included at title and abstract in at least one scope. */
const sought = (item: RetrievalItem) =>
  Object.values(item.outcomes).some((stages) => stages["title_abstract"] === "include");

/** "1 report", "3 reports". */
const count = (word: string, n: number) => `${n} ${n === 1 ? word : plural(word)}`;

/** "A", "A and B", "A, B and C". */
const andList = (words: ReadonlyArray<string>) =>
  words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

/** One spelling for Creative Commons licences: "cc by" and "cc-by-4.0" as "CC BY", "CC BY 4.0". */
const licenceLabel = (licence: string) => {
  const text = licence.trim();
  if (!/^cc[\s_-]?(by|0|zero)\b/i.test(text)) return text;
  return text
    .toUpperCase()
    .replace(/_/g, "-")
    .replace(/^CC[\s-]?(?=BY)/, "CC ")
    .replace(/-(\d)/, " $1")
    .replace(/\s+/g, " ");
};

const NO_FAILURES: RetryPreview = { occurrences: 0, reports: 0, sources: [] };

/** The tabs, and "untried": the reports open access has not tried, reached from the run line. */
type View = "articles" | "registry" | "has" | "all" | "untried";

const VIEWS: ReadonlyArray<{ id: View; label: string; hint: string }> = [
  {
    id: "articles",
    label: "Need a PDF",
    hint: "Articles without a PDF: fetch or upload them.",
  },
  {
    id: "registry",
    label: "Registry records",
    hint: "Trial registry records with no article yet. Upload one if the trial's results appear.",
  },
  { id: "has", label: "Has PDF", hint: "Reports with a PDF attached." },
  { id: "all", label: "All", hint: "Every report in the list." },
];

const viewOf = (item: RetrievalItem): "articles" | "registry" | "has" =>
  item.full_text ? "has" : isRegistryOnly(item) ? "registry" : "articles";

/** Without a PDF, and not in the latest open-access run (or there was none). */
const untried = (item: RetrievalItem, retrievals: ReadonlyMap<string, ReportRetrieval>) =>
  !item.full_text && !retrievals.has(item.report_id);

const inView = (
  view: View,
  item: RetrievalItem,
  retrievals: ReadonlyMap<string, ReportRetrieval>,
) => view === "all" || (view === "untried" ? untried(item, retrievals) : viewOf(item) === view);

/** When a report was last tried: the run's time, or null when the run was an earlier one. */
type Tried = { readonly at: string | null };

export function RetrievalScreen() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, seesLeadData, labels, scopes } = useProject();
  const studyNames = useStudyNames();
  const [items, setItems] = useState<ReadonlyArray<RetrievalItem> | null>(null);
  const [citations, setCitations] = useState<ReadonlyMap<string, MissingReport>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  // The work first: the articles still without a PDF.
  const [view, setView] = useState<View>("articles");
  const [selected, setSelected] = useState(0);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [uploadFor, setUploadFor] = useState<RetrievalItem | null>(null);
  const [uploadingMany, setUploadingMany] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [addingSentinel, setAddingSentinel] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [openAccess, setOpenAccess] = useState<OpenAccessRun | null>(null);
  const [enrichment, setEnrichment] = useState<EnrichmentRun | null>(null);
  const [failed, setFailed] = useState<RetryPreview>(NO_FAILURES);
  const [held, setHeld] = useState<ReadonlyArray<HeldUpload>>([]);
  const [busy, setBusy] = useState(false);

  const caller = useMemo(() => ({ projectId: project.id, as: me.actor_id }), [project.id, me]);
  const load = useCallback(
    () =>
      Promise.all([
        run(workbench.fullTexts(caller)),
        run(workbench.openAccess(caller)),
        run(workbench.enrichment(caller)),
        run(workbench.retryPreview(caller)),
        run(workbench.heldUploads(caller)),
        // Authors and PMIDs of the reports without a PDF, for the citation; the list works
        // without them.
        run(workbench.missingFullTexts(caller)).catch(() => [] as ReadonlyArray<MissingReport>),
      ]).then(
        ([found, latest, enriched, preview, waiting, missingReports]) => {
          setItems(found);
          setOpenAccess(latest);
          setEnrichment(enriched);
          setFailed(preview);
          setHeld(waiting);
          setCitations(new Map(missingReports.map((m) => [m.report_id, m])));
        },
        (e) => setError(failure(e, "Kittum could not load the reports.")),
      ),
    [workbench, caller],
  );
  useEffect(() => {
    if (seesLeadData && project.protocol) void load();
  }, [load, seesLeadData, project.protocol]);
  const working = runActive(openAccess) || runActive(enrichment);
  usePoll(seesLeadData && working, () => void load());

  const byReport = useMemo(
    () =>
      new Map(
        [...(openAccess?.earlier ?? []), ...(openAccess?.reports ?? [])].map((r) => [
          r.report_id,
          r,
        ]),
      ),
    [openAccess],
  );
  const tried = useMemo(() => {
    const at = openAccess ? (openAccess.finished_at ?? openAccess.requested_at) : null;
    return new Map<string, Tried>([
      ...(openAccess?.earlier ?? []).map((r) => [r.report_id, { at: null }] as const),
      ...(openAccess?.reports ?? [])
        .filter((r) => r.outcome)
        .map((r) => [r.report_id, { at }] as const),
    ]);
  }, [openAccess]);

  const act = async (what: () => Promise<string | null>, fallback: string) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      setNotice(await what());
      await load();
    } catch (e) {
      setError(failure(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const fetchOpenAccess = () =>
    act(async () => {
      setOpenAccess(await run(workbench.startOpenAccess(caller)));
      setAll(false);
      return null;
    }, "Kittum could not start fetching.");

  const retry = () =>
    act(async () => {
      const plan = await run(workbench.retryFailedSources(caller));
      const names = plan.sources.map(sourceName).join(" and ");
      return plan.enrichment_run_id
        ? `Retry started for ${names}. Kittum enriches ${count("record", plan.occurrences)} again, then fetches ${count("report", plan.reports)}.`
        : `Retry started for ${names}. Kittum fetches ${count("report", plan.reports)} again.`;
    }, "Kittum could not start the retry.");

  const screened = (items ?? []).some((i) => Object.keys(i.outcomes).length > 0);
  // The reports in question: those sought, or every report with f (or before any screening).
  const pool = useMemo(
    () => (items ?? []).filter((i) => all || !screened || sought(i)),
    [items, all, screened],
  );
  // Reports open access has not tried yet come first, right under the button that tries them;
  // the rest keep their order. j and k walk the rows in this order.
  const shown = useMemo(() => {
    const inThisView = pool.filter((i) => inView(view, i, byReport));
    return [
      ...inThisView.filter((i) => untried(i, byReport)),
      ...inThisView.filter((i) => !untried(i, byReport)),
    ];
  }, [pool, view, byReport]);
  const current = shown.length ? shown[Math.min(selected, shown.length - 1)] : undefined;
  const retrieved = pool.filter((i) => i.full_text).length;
  const viewCounts: Record<View, number> = {
    articles: 0,
    registry: 0,
    has: 0,
    all: pool.length,
    untried: pool.filter((i) => untried(i, byReport)).length,
  };
  for (const i of pool) viewCounts[viewOf(i)] += 1;
  const missing = (items ?? []).filter((i) => (screened ? sought(i) : true) && !i.full_text);
  // Reports without a PDF that the last open-access run did not check: added since, or skipped.
  const unchecked = openAccess ? viewCounts.untried : 0;
  const canFetch = screened && !busy && !working;
  const canRetry = failed.sources.length > 0 && !busy && !working;
  // The outcome at title and abstract earns a column only where it differs between rows: every
  // report sought is included by definition.
  const outcomeKey = (i: RetrievalItem) =>
    Object.entries(i.outcomes)
      .map(([scope, stages]) => `${scope}:${stages["title_abstract"] ?? ""}`)
      .sort()
      .join("|");
  const showOutcome = new Set(shown.map(outcomeKey)).size > 1;
  const columns = showOutcome ? COLUMNS_WITH_OUTCOME : COLUMNS;

  const chooseView = (next: View) => {
    setView(next);
    setSelected(0);
  };
  const toggleHistory = (ref: string) =>
    setOpened((now) => {
      const next = new Set(now);
      if (!next.delete(ref)) next.add(ref);
      return next;
    });
  const upload = (item: RetrievalItem) => {
    if (item.full_text) setNotice("This report has a PDF already.");
    else setUploadFor(item);
  };

  useEffect(() => {
    document
      .querySelector('[data-testid="retrieval-row"][aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, view, all]);

  useKeys((event) => {
    if (!items) return false;
    switch (event.key) {
      case "j":
      case "ArrowDown":
        setSelected((i) => Math.min(i + 1, shown.length - 1));
        return true;
      case "k":
      case "ArrowUp":
        setSelected((i) => Math.max(i - 1, 0));
        return true;
      case "Enter":
        // A focused button or link keeps its own Enter.
        if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement)
          return false;
        if (!current || !byReport.has(current.report_id)) return false;
        toggleHistory(current.item_ref);
        return true;
      case "u":
        if (!current) return false;
        upload(current);
        return true;
      case "b":
        setUploadingMany(true);
        return true;
      case "e":
        if (!screened || missing.length === 0) return false;
        setExporting(true);
        return true;
      case "s":
        setAddingSentinel(true);
        return true;
      case "o":
        if (!screened) return false;
        if (working) {
          setNotice("Kittum is still fetching. Each report keeps its attempts as they happen.");
          return true;
        }
        void fetchOpenAccess();
        return true;
      case "r":
        if (!canRetry) return false;
        void retry();
        return true;
      case "f":
        if (!screened) return false;
        setAll((a) => !a);
        setSelected(0);
        return true;
      default:
        return false;
    }
  });

  if (!seesLeadData) {
    return (
      <Page kind="data" title="Retrieval">
        <p className="max-w-[70ch] text-ink-2" data-testid="lead-only">
          {LEAD_ONLY}
        </p>
      </Page>
    );
  }

  const which = screened && !all ? "reports sought" : plural(labels.report).toLowerCase();
  const skipped = openAccess?.skipped ?? [];

  return (
    <Page
      kind="data"
      title="Retrieval"
      summary={
        !project.protocol ? (
          "Publish the protocol and build the corpus first."
        ) : items ? (
          <>
            <span
              data-testid="retrieval-counts"
              title={
                screened
                  ? "Reports sought are those included at title and abstract in at least one scope. Full-text screening opens on a report once it has a PDF."
                  : undefined
              }
            >
              {`${retrieved} of ${pool.length} ${which} have a PDF`}
            </span>
            {screened ? null : (
              <>
                {" "}
                <Help text="No stage is screened yet, so the list shows every report. A PDF attached now waits for title and abstract." />
              </>
            )}
          </>
        ) : null
      }
      actions={
        <>
          <Button keys={["b"]} onClick={() => setUploadingMany(true)}>
            Upload many PDFs
          </Button>
          <More onSentinel={() => setAddingSentinel(true)} />
        </>
      }
    >
      {screened ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button
            kind="primary"
            keys={["o"]}
            disabled={!canFetch}
            onClick={() => void fetchOpenAccess()}
          >
            {runActive(openAccess) ? "Fetching open-access PDFs" : "Fetch open-access PDFs"}
          </Button>
          <Help text="Fetch tries every report sought without a PDF, the new ones and those that failed before: Europe PMC, PubMed Central, Unpaywall, OpenAlex, the publisher, medRxiv and bioRxiv, arXiv, Semantic Scholar, and CORE, in that order." />
          <p className="text-sm text-ink-2">
            {openAccess ? (
              <span>
                {`${runActive(openAccess) ? "Open-access run, started" : "Last open-access run,"} ${formatDateTime(openAccess.finished_at ?? openAccess.requested_at)}:`}{" "}
              </span>
            ) : null}
            <span data-testid="open-access-status" aria-live="polite">
              {openAccess ? openAccessLine(openAccess) : "Open access not fetched yet."}
            </span>
          </p>
          {unchecked > 0 && !runActive(openAccess) ? (
            <button
              type="button"
              data-testid="unchecked-count"
              aria-pressed={view === "untried"}
              onClick={() => chooseView(view === "untried" ? "articles" : "untried")}
              className="text-sm font-medium text-petrol underline-offset-2 hover:underline"
            >
              {view === "untried"
                ? "Show every report that needs a PDF"
                : `Show the ${count("new report", unchecked)} not tried yet`}
            </button>
          ) : null}
          {skipped.length > 0 ? (
            <details className="text-sm text-ink-2">
              <summary className="cursor-pointer text-ink-2 hover:text-ink">
                Source diagnostics
              </summary>
              <p className="mt-1">
                <Skipped skipped={skipped} />
              </p>
            </details>
          ) : null}
        </div>
      ) : null}
      <Failures
        failed={failed}
        enrichment={enrichment}
        canRetry={canRetry}
        onRetry={() => void retry()}
      />
      {error || notice ? (
        <p
          role={error ? "alert" : "status"}
          className={`mt-3 text-sm ${error ? "text-exclude" : "text-ink"}`}
          data-testid="retrieval-notice"
        >
          {error ?? notice}
        </p>
      ) : null}
      {held.length > 0 ? (
        <Held
          held={held}
          items={items ?? []}
          onDone={(message) => {
            setNotice(message);
            void load();
          }}
          onError={(message) => setError(message)}
        />
      ) : null}
      <Panel className="mt-5">
        {items && pool.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div
              role="group"
              aria-label="Show"
              className="flex rounded-[4px] border border-rule-strong bg-sheet p-0.5"
            >
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  aria-pressed={view === v.id}
                  title={v.hint}
                  onClick={() => chooseView(v.id)}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-[3px] px-3 text-sm ${
                    view === v.id
                      ? "bg-petrol-wash font-medium text-petrol"
                      : "text-ink-2 hover:text-ink"
                  }`}
                >
                  {v.label}{" "}
                  <span
                    className="tabular-nums"
                    data-testid={
                      v.id === "articles"
                        ? "missing-count"
                        : v.id === "registry"
                          ? "registry-count"
                          : undefined
                    }
                  >
                    {viewCounts[v.id]}
                  </span>
                </button>
              ))}
            </div>
            {view === "untried" ? (
              <span className="inline-flex h-7 items-center gap-2 rounded-[3px] bg-petrol-wash px-3 text-sm font-medium text-petrol">
                {`Not tried yet ${viewCounts.untried}`}
                <button
                  type="button"
                  aria-label="Show every report that needs a PDF"
                  className="text-ink-2 hover:text-ink"
                  onClick={() => chooseView("articles")}
                >
                  ×
                </button>
              </span>
            ) : null}
            {screened ? (
              <Button
                kind="quiet"
                size="sm"
                keys={["f"]}
                onClick={() => {
                  setAll((a) => !a);
                  setSelected(0);
                }}
              >
                {all ? "Only reports sought" : "Include reports not sought"}
              </Button>
            ) : null}
            <span className="ml-auto flex items-center gap-4">
              {shown.length > 1 ? <KeyHint keys={["j", "k"]}>Move between reports</KeyHint> : null}
              {screened && missing.length > 0 ? (
                <Button size="sm" keys={["e"]} onClick={() => setExporting(true)}>
                  Export the reports without a PDF
                </Button>
              ) : null}
            </span>
          </div>
        ) : null}
        <section aria-label="Reports" className="mt-3">
          {items === null ? (
            <p className="pt-4 text-ink-2">{project.protocol ? "Loading the reports." : ""}</p>
          ) : pool.length === 0 ? (
            <EmptyState
              title={screened ? "No report is sought yet" : "The corpus has no reports yet"}
              testId="retrieval-view-empty"
              actions={
                screened ? (
                  <Button
                    kind="quiet"
                    keys={["f"]}
                    onClick={() => {
                      setAll(true);
                      setSelected(0);
                    }}
                  >
                    Show every report in the corpus
                  </Button>
                ) : null
              }
            >
              {screened
                ? "Kittum seeks the full text of a report once it is included at title and abstract."
                : "Build the corpus from the searches first."}
            </EmptyState>
          ) : shown.length === 0 ? (
            <EmptyState
              title={
                view === "articles"
                  ? `Every article among the ${which} has a PDF`
                  : view === "untried"
                    ? "Open access has tried every report"
                    : view === "registry"
                      ? "No registry record is waiting for an article"
                      : "No report has a PDF yet"
              }
              testId="retrieval-view-empty"
              figures={[
                ["With a PDF", viewCounts.has],
                ["Articles without one", viewCounts.articles],
                ["Registry records", viewCounts.registry],
              ]}
              actions={
                <>
                  {view !== "has" && screened ? (
                    <Link
                      to="/p/$projectId/screening/full-text"
                      params={{ projectId: project.id }}
                      className="rounded-[4px] border border-rule-strong bg-sheet px-3 py-1.5 text-sm hover:bg-sheet-2"
                    >
                      Go to full-text screening
                    </Link>
                  ) : null}
                  <Button kind="quiet" onClick={() => chooseView("all")}>
                    Show all {pool.length}
                  </Button>
                </>
              }
            >
              {view === "has"
                ? "Fetch open-access PDFs or upload them; they show here once attached."
                : "Nothing is left to fetch or upload in this list."}
            </EmptyState>
          ) : (
            <div>
              <div
                className={`${columns} border-y border-rule-strong bg-sheet-2 py-2 pr-3 pl-4 text-xs font-medium text-ink-2`}
                aria-hidden="true"
              >
                <span>{labels.report}</span>
                {showOutcome ? <span>Title and abstract</span> : null}
                <span>PDF status</span>
                <span>Last tried</span>
                <span />
              </div>
              {shown.map((item, index) => (
                <Row
                  key={item.item_ref}
                  item={item}
                  citation={citations.get(item.report_id)}
                  study={studyNames.get(item.report_id)}
                  brief={view === "articles" || view === "registry" || view === "untried"}
                  retrieval={byReport.get(item.report_id)}
                  tried={tried.get(item.report_id)}
                  selected={item.item_ref === current?.item_ref}
                  open={opened.has(item.item_ref)}
                  columns={columns}
                  showOutcome={showOutcome}
                  multipleScopes={scopes.length > 1}
                  onSelect={() => setSelected(index)}
                  onUpload={() => upload(item)}
                  onHistory={() => toggleHistory(item.item_ref)}
                />
              ))}
            </div>
          )}
        </section>
      </Panel>
      {uploadFor ? (
        <UploadFullText
          item={uploadFor}
          onClose={() => setUploadFor(null)}
          onDone={(message) => {
            setUploadFor(null);
            setNotice(message);
            void load();
          }}
        />
      ) : null}
      {uploadingMany ? (
        <UploadMany
          onClose={() => setUploadingMany(false)}
          onDone={(message) => {
            setUploadingMany(false);
            setNotice(message);
            void load();
          }}
        />
      ) : null}
      {exporting ? (
        <ExportMissing
          reports={missing.length}
          onClose={() => setExporting(false)}
          onDone={(message) => {
            setExporting(false);
            setNotice(message);
          }}
        />
      ) : null}
      <AddSentinel
        open={addingSentinel}
        onOpenChange={setAddingSentinel}
        onDone={(message) => {
          setAddingSentinel(false);
          setNotice(message);
        }}
      />
    </Page>
  );
}

/** The report, its full text, when it was last tried, and its actions; the outcome at title and
 * abstract only where it differs between rows. */
const COLUMNS = "grid grid-cols-[minmax(0,1fr)_15rem_7rem_17rem] items-start gap-x-5";
const COLUMNS_WITH_OUTCOME =
  "grid grid-cols-[minmax(0,1fr)_10rem_15rem_7rem_17rem] items-start gap-x-5";

/** A separator between facts on one line, with real spaces so the text reads right when copied. */
function Dot() {
  return (
    <span className="text-ink-3" aria-hidden="true">
      {" · "}
    </span>
  );
}

/** The rarer actions, each with a line on what it is for. */
function More({ onSentinel }: { onSentinel: () => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="More actions"
        className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-rule-strong bg-sheet px-3 text-sm font-medium hover:bg-sheet-2 data-[popup-open]:bg-sheet-2"
      >
        More
        <svg width="9" height="6" viewBox="0 0 9 6" aria-hidden="true">
          <path d="M1 1l3.5 3.5L8 1" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-20">
          <Menu.Popup className="w-[360px] rounded-[4px] border border-rule-strong bg-sheet py-1 shadow-[0_8px_24px_rgb(0_0_0/0.14)] outline-none">
            <Menu.Item
              onClick={onSentinel}
              className="block cursor-default px-3 py-2 data-[highlighted]:bg-sheet-2"
            >
              <span className="flex items-center justify-between gap-3 text-sm font-medium">
                Add a full-text sentinel
                <Key k="s" />
              </span>
              <span className="mt-0.5 block text-sm text-ink-2">
                A report whose outcome you know, put in every full-text queue to check the
                reviewers.
              </span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Sources the run passed over, with the remedy; the server settings that would enable them on
 * hover. */
function Skipped({ skipped }: { skipped: NonNullable<OpenAccessRun["skipped"]> }) {
  const noKey = skipped.filter((s) => /\bkey\b/i.test(s.reason));
  const other = skipped.filter((s) => !noKey.includes(s));
  const settings = skipped.flatMap((s) => /\(([A-Z][A-Z0-9_]+)\)/.exec(s.reason)?.[1] ?? []);
  const parts = [
    noKey.length
      ? `${andList(noKey.map((s) => sourceName(s.source)))} ${noKey.length === 1 ? "was" : "were"} skipped: no API key. Ask your server administrator to add ${noKey.length === 1 ? "it" : "the keys"}.`
      : null,
    ...other.map(
      (s) => `${sourceName(s.source)} was skipped: ${s.reason.replace(/\s*\([A-Z0-9_]+\)/g, "")}.`,
    ),
  ].filter(Boolean);
  return (
    <span
      data-testid="skipped-sources"
      title={
        settings.length
          ? `To use ${noKey.length === 1 ? "it" : "them"}, the server admin sets ${andList(settings)}.`
          : undefined
      }
    >
      {parts.join(" ")}
    </span>
  );
}

/** The sources that failed, in plain words, and the one action that mends an outage. */
function Failures({
  failed,
  enrichment,
  canRetry,
  onRetry,
}: {
  failed: RetryPreview;
  enrichment: EnrichmentRun | null;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const retrying = enrichment?.trigger === "retry" && runActive(enrichment);
  if (retrying) {
    return (
      <p className="mt-3 text-sm text-ink-2" data-testid="retry-status" aria-live="polite">
        {`Kittum is enriching ${count("record", enrichment.records)} again (${enrichment.done} done). Fetching follows.`}
      </p>
    );
  }
  if (failed.sources.length === 0) return null;
  const affected = [
    failed.occurrences ? count("record", failed.occurrences) : null,
    failed.reports ? count("report", failed.reports) : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const summary = affected
    ? `${affected[0]!.toUpperCase()}${affected.slice(1)} could not be read from ${failed.sources.length === 1 ? "it" : "them"}.`
    : "Open for the reasons.";
  return (
    <Panel
      level="recessed"
      className="mt-4"
      testId="retry"
      fold="closed"
      title={`${andList(failed.sources.map((f) => sourceName(f.source)))} failed`}
      summary={summary}
      actions={
        <Button size="sm" keys={["r"]} disabled={!canRetry} onClick={onRetry}>
          Retry failed sources
        </Button>
      }
    >
      <ul aria-label="Sources that failed" className="grid gap-1 text-sm">
        {failed.sources.map((s) => {
          const counts = [
            s.records ? count("record", s.records) : null,
            s.reports ? count("report", s.reports) : null,
          ]
            .filter(Boolean)
            .join(" and ");
          return (
            <li key={s.source} data-testid="retry-line" data-source={s.source}>
              {failureLine(s.source, s, counts)}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

const OUTCOME_LINE: Record<string, string> = {
  acquired: "Fetched from open access.",
  not_acquired: "No source gave a usable PDF. Upload it with u.",
  no_location: "No source has an open copy. Upload it with u.",
  had_full_text: "Uploaded by hand while the run waited.",
};

const serverTrouble = (status: number | null | undefined) =>
  status != null && (status >= 500 || status === 429);

const refused = (a: AttemptView) => a.outcome === "http_error" && !serverTrouble(a.status);

const ATTEMPT: Record<string, (a: AttemptView) => string> = {
  acquired: () => "Fetched",
  http_error: (a) => (serverTrouble(a.status) ? "No answer" : "Refused") + `, HTTP ${a.status}`,
  not_pdf: () => "Web page, not a PDF",
  unreadable_pdf: () => "PDF does not open",
  unavailable: (a) => (a.status ? `No answer, HTTP ${a.status}` : "No answer"),
  wrong_document: () => "Wrong document",
  found: (a) => `Named ${count("file", a.found ?? 0)}`,
  known: () => "Named a file already listed",
  none: () => "No open copy",
  other_work: () => "Answered for another work",
};

function openAccessLine(r: OpenAccessRun) {
  const tried = r.reports.filter((x) => x.outcome).length;
  const reports = count("report", r.reports.length);
  const again = r.trigger === "retry" ? "again " : "";
  if (r.status === "queued")
    return `Waiting for a worker to check ${reports} ${again}.`.replace(" .", ".");
  if (r.status === "running") return `Checked ${tried} of ${reports} ${again}so far.`;
  if (r.status === "failed") return `Stopped after ${tried} of ${reports}. ${r.error ?? ""}`.trim();
  const got = r.reports.filter((x) => x.outcome === "acquired").length;
  return `${reports} checked ${again}, ${got} fetched.`.replace(" ,", ",");
}

/** Why a report sought has no PDF, in a few words, for its row. */
function missingReason(retrieval: ReportRetrieval | undefined): {
  text: string;
  refused: boolean;
} {
  if (!retrieval) return { text: "Open access not tried", refused: false };
  if (!retrieval.outcome) return { text: "Waiting its turn", refused: false };
  const refusals = retrieval.attempts.filter(refused);
  if (retrieval.outcome === "not_acquired" && refusals.length > 0) {
    const by = andList([...new Set(refusals.map((a) => sourceName(a.source)))]);
    return { text: `Refused by ${by}`, refused: true };
  }
  if (retrieval.outcome === "no_location") return { text: "No open copy found", refused: false };
  return { text: "No source gave a usable PDF", refused: false };
}

function History({
  retrieval,
  open,
  id,
}: {
  retrieval: ReportRetrieval;
  open: boolean;
  id: string;
}) {
  return (
    <div
      id={id}
      hidden={!open}
      className="mb-3 ml-4 mr-3 rounded-[4px] bg-paper px-4 py-3"
      data-testid="open-access"
      data-outcome={retrieval.outcome ?? "pending"}
    >
      <p className={`text-sm ${retrieval.outcome === "acquired" ? "text-include" : "text-ink-2"}`}>
        {retrieval.outcome ? OUTCOME_LINE[retrieval.outcome] : "Waiting its turn."}
      </p>
      {retrieval.attempts.length > 0 ? (
        <table aria-label="Open-access attempts" className="mt-2 w-full max-w-[72rem] text-sm">
          <thead className="sr-only">
            <tr>
              <th>Step</th>
              <th>Source</th>
              <th>Address</th>
              <th>Result</th>
              <th>Licence</th>
            </tr>
          </thead>
          <tbody>
            {retrieval.attempts.map((a, i) => (
              <tr
                key={`${i}-${a.url}`}
                data-testid="attempt"
                data-kind={a.kind}
                className="border-t border-rule text-ink-2 first:border-t-0"
              >
                <td className="w-8 py-1 text-ink-3 tabular-nums">{i + 1}</td>
                <td className="w-40 py-1 text-ink">{sourceName(a.source)}</td>
                <td className="py-1">
                  <span title={a.url}>{a.kind === "lookup" ? `Asked ${a.host}` : a.host}</span>
                </td>
                <td
                  className={`w-56 py-1 ${
                    a.outcome === "acquired"
                      ? "font-medium text-include"
                      : a.outcome === "found" || a.outcome === "known" || a.outcome === "none"
                        ? "text-ink-2"
                        : "text-exclude"
                  }`}
                  title={[a.check, a.message, a.error].filter(Boolean).join(" ") || undefined}
                >
                  {(ATTEMPT[a.outcome] ?? (() => a.outcome))(a)}
                </td>
                <td className="w-40 py-1 text-right">
                  {a.kind === "lookup"
                    ? ""
                    : a.licence
                      ? licenceLabel(a.licence)
                      : "No licence stated"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {(retrieval.carried ?? []).length > 0 ? (
        <p className="mt-2 text-sm text-ink-2" data-testid="carried">
          {`Not asked again, because an earlier run settled it: ${(retrieval.carried ?? [])
            .map(
              (a) =>
                `${sourceName(a.source)} (${(ATTEMPT[a.outcome] ?? (() => a.outcome))(a).toLowerCase()})`,
            )
            .join(", ")}.`}
        </p>
      ) : null}
    </div>
  );
}

// No PDF is work not done yet: the neutral circle, whatever the reason.
// Not tried yet (or waiting its turn): the empty circle. Tried and failed: it waits for a person
// to upload the PDF, so the amber mark, with the reason in words beside it.
const NO_PDF: Term = { ...NOT_DONE, label: "No PDF" };
const OPEN_ACCESS_FAILED: Term = { ...WAITS, label: "Open access failed: upload the PDF" };
const REGISTRY_ENTRY: Term = { ...NOT_DONE, label: "Registry record, no article yet" };

/** A report's full-text state in words. */
function FullTextState({
  item,
  retrieval,
  brief,
}: {
  item: RetrievalItem;
  retrieval: ReportRetrieval | undefined;
  /** In a tab that already says the state (Article PDF needed, Registry only): only the reason. */
  brief: boolean;
}) {
  const registry = !item.full_text && isRegistryOnly(item);
  const reason = item.full_text || registry ? null : missingReason(retrieval);
  const term = item.full_text
    ? ACCEPTED
    : registry
      ? REGISTRY_ENTRY
      : retrieval?.outcome
        ? OPEN_ACCESS_FAILED
        : NO_PDF;
  if (brief && !item.full_text) {
    return (
      <div className="flex min-w-0 items-start gap-2 text-sm">
        <span className="mt-0.5">
          <Mark term={term} />
        </span>
        <p data-testid="full-text-status" className="min-w-0 text-ink-2">
          <span className="sr-only">{`${term.label}: `}</span>
          {reason ? reason.text : "No article yet"}
        </p>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-start gap-2 text-sm">
      <span className="mt-0.5">
        <Mark term={term} />
      </span>
      <div className="min-w-0">
        <p
          data-testid="full-text-status"
          className={item.full_text ? "text-include" : registry ? "text-ink-2" : "text-ink"}
        >
          {item.full_text ? (
            <>
              PDF, {item.full_text.page_count ?? "?"} pages
              <span className="block text-ink-2">
                {item.full_text.licence
                  ? licenceLabel(item.full_text.licence)
                  : "No licence recorded"}
                {retrieval?.outcome === "acquired" && retrieval.source
                  ? `, from ${sourceName(retrieval.source)}`
                  : ""}
              </span>
            </>
          ) : registry ? (
            "Registry record, no article yet"
          ) : (
            "No PDF"
          )}
        </p>
        {reason ? <p className="text-ink-2">{reason.text}</p> : null}
      </div>
    </div>
  );
}

// Identifiers are links, but quiet ones: they must not compete with the titles.
const link = "text-ink-2 underline-offset-2 hover:text-ink hover:underline";

/** A link out of Kittum that leaves the row's selection alone. */
function Out({ href, children, title }: { href: string; children: ReactNode; title?: string }) {
  return (
    <a
      className={link}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  );
}

/** The report's citation in one line: authors (where Kittum has them), journal and year, and
 * each identifier as a link to where it resolves. */
function CitationLine({
  item,
  citation,
  study,
}: {
  item: RetrievalItem;
  citation: MissingReport | undefined;
  /** The study's name from the corpus ("López-Durán 2025"), where it names the authors. */
  study: string | undefined;
}) {
  const name = study ?? studyLabel(citation?.authors, item.year) ?? null;
  // The journal without its subtitle ("Nicotine & tobacco research : official journal of …").
  const journal = item.journal?.split(/\s+:\s+/)[0]?.trim() || null;
  const pmid = citation?.pmid ?? null;
  const parts: ReactNode[] = [
    name ? (
      <span key="name" className="text-ink">
        {name}
      </span>
    ) : null,
    journal || (!name && item.year) ? (
      <span key="journal" title={item.journal ?? undefined}>
        {[journal, name ? null : item.year].filter(Boolean).join(" ")}
      </span>
    ) : null,
    item.doi ? (
      <span key="doi">
        DOI <Out href={`https://doi.org/${item.doi}`}>{item.doi}</Out>
      </span>
    ) : null,
    pmid ? (
      <span key="pmid">
        PubMed <Out href={`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`}>{pmid}</Out>
      </span>
    ) : null,
    ...item.registry_ids.map((id) => {
      const url = registryUrl(id);
      return url ? (
        <Out key={id} href={url} title="The trial's registry entry">
          {id}
        </Out>
      ) : (
        <span key={id} title="Another identifier the record gives">
          {id}
        </span>
      );
    }),
  ].filter(Boolean);
  return (
    <p className="narrow mt-0.5 text-sm text-ink-2">
      {parts.length
        ? parts.map((part, i) => (
            <span key={i}>
              {i > 0 ? <Dot /> : null}
              {part}
            </span>
          ))
        : "No journal or identifier recorded"}
    </p>
  );
}

function Row({
  item,
  citation,
  study,
  brief,
  retrieval,
  tried,
  selected,
  open,
  columns,
  showOutcome,
  multipleScopes,
  onSelect,
  onUpload,
  onHistory,
}: {
  item: RetrievalItem;
  citation: MissingReport | undefined;
  study: string | undefined;
  brief: boolean;
  retrieval: ReportRetrieval | undefined;
  tried: Tried | undefined;
  selected: boolean;
  open: boolean;
  columns: string;
  showOutcome: boolean;
  multipleScopes: boolean;
  onSelect: () => void;
  onUpload: () => void;
  onHistory: () => void;
}) {
  const { scopeLabel } = useProject();
  const registry = !item.full_text && isRegistryOnly(item);
  const historyId = `history-${item.item_ref}`;
  const tries = retrieval ? retrieval.attempts.length : 0;
  return (
    <article
      onClick={onSelect}
      aria-current={selected || undefined}
      data-testid="retrieval-row"
      className={`border-b border-rule ${
        selected ? "bg-petrol-wash/40 shadow-[inset_4px_0_0_var(--petrol)]" : "hover:bg-sheet/60"
      }`}
    >
      <div className={`${columns} py-2.5 pr-3 pl-4`}>
        <div className="min-w-0">
          <h2 className="line-clamp-2 font-medium" title={item.title}>
            {item.title}
          </h2>
          <CitationLine item={item} citation={citation} study={study} />
        </div>
        {showOutcome ? (
          <p className="min-w-0 text-sm">
            {Object.entries(item.outcomes).length === 0 ? (
              <span className="text-ink-2">Not screened yet</span>
            ) : (
              Object.entries(item.outcomes).map(([scope, stages]) => {
                const outcome = stages["title_abstract"];
                const shown = outcome ? OUTCOME[outcome] : null;
                return (
                  <span key={scope} className="block" title={scopeLabel(scope)}>
                    {multipleScopes ? (
                      <span className="text-ink-2">{`${scopeLabel(scope)}: `}</span>
                    ) : null}
                    <span className={shown?.className ?? "text-ink-2"}>
                      {shown?.label ?? "Being screened"}
                    </span>
                  </span>
                );
              })
            )}
          </p>
        ) : null}
        <FullTextState item={item} retrieval={retrieval} brief={brief} />
        <p
          className="text-sm text-ink-2 tabular-nums"
          data-testid="last-tried"
          title={tried?.at ? formatDateTime(tried.at) : undefined}
        >
          {tried ? (
            tried.at ? (
              formatDate(tried.at)
            ) : (
              "Earlier run"
            )
          ) : (
            // The status says "Open access not tried" already.
            <>
              <span aria-hidden="true">—</span>
              <span className="sr-only">Not tried</span>
            </>
          )}
        </p>
        <div className="flex items-center justify-end gap-1.5">
          {item.full_text ? null : (
            <Button
              size="sm"
              kind={registry ? "quiet" : "secondary"}
              keys={selected ? ["u"] : []}
              onClick={onUpload}
            >
              Upload PDF
            </Button>
          )}
          {/* The History slot keeps its width on every row, so the Upload buttons line up. */}
          <span className="flex w-[9.5rem] flex-none justify-start">
            {retrieval ? (
              <Button
                kind="quiet"
                size="sm"
                aria-expanded={open}
                aria-controls={historyId}
                aria-label={`${open ? "Hide" : "Show"} retrieval history`}
                keys={selected ? ["Enter"] : []}
                onClick={onHistory}
                title={`Retrieval history: ${count("attempt", tries)}`}
              >
                {open ? "Hide history" : "History"}
              </Button>
            ) : null}
          </span>
        </div>
      </div>
      {item.wrong_document ? (
        <p className="-mt-1 pr-3 pb-2.5 pl-4 text-sm text-unclear" data-testid="wrong-document">
          {`${item.wrong_document.reviewer} said the earlier PDF was the wrong document.`}
          {item.wrong_document.note ? (
            <span className="text-ink-2">{` Their note: "${item.wrong_document.note}"`}</span>
          ) : null}
        </p>
      ) : null}
      {retrieval ? <History retrieval={retrieval} open={open} id={historyId} /> : null}
    </article>
  );
}

/** Uploads waiting for the lead: each with why Kittum could not place it, and a report to pick. */
function Held({
  held,
  items,
  onDone,
  onError,
}: {
  held: ReadonlyArray<HeldUpload>;
  items: ReadonlyArray<RetrievalItem>;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  return (
    <Panel
      level="recessed"
      className="mt-4"
      testId="held-uploads"
      title={`${count("PDF", held.length)} to assign by hand`}
      summary="Kittum could not match these uploads to a report. Pick each one's report, or discard it."
    >
      <ul className="grid gap-1.5">
        {held.map((upload) => (
          <HeldRow
            key={upload.upload_id}
            upload={upload}
            items={items}
            onDone={onDone}
            onError={onError}
          />
        ))}
      </ul>
    </Panel>
  );
}

function HeldRow({
  upload,
  items,
  onDone,
  onError,
}: {
  upload: HeldUpload;
  items: ReadonlyArray<RetrievalItem>;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const candidates = upload.candidates.map((c) => c.report_id);
  const others = items.filter((i) => !i.full_text && !candidates.includes(i.report_id));
  const [report, setReport] = useState(candidates[0] ?? "");
  const [busy, setBusy] = useState(false);
  const caller = { projectId: project.id, as: me.actor_id, uploadId: upload.upload_id };
  const title = (id: string) =>
    upload.candidates.find((c) => c.report_id === id)?.title ??
    items.find((i) => i.report_id === id)?.title ??
    id;
  const go = async (assign: boolean) => {
    setBusy(true);
    try {
      if (assign) {
        await run(workbench.assignUpload({ ...caller, reportId: report }));
        onDone(`Attached ${upload.file_name} to "${title(report)}".`);
      } else {
        await run(workbench.discardUpload(caller));
        onDone(`Discarded ${upload.file_name}.`);
      }
    } catch (e) {
      onError(failure(e, `Kittum could not ${assign ? "attach" : "discard"} ${upload.file_name}.`));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      data-testid="held-upload"
      className="grid grid-cols-[minmax(0,1fr)_22rem_auto] items-center gap-x-4 border-b border-rule py-1.5 text-sm"
    >
      <div className="min-w-0">
        <p className="truncate font-medium" title={upload.file_name}>
          {upload.file_name}
          <span className="font-normal text-ink-3">
            {upload.page_count ? `, ${count("page", upload.page_count)}` : ""}
          </span>
        </p>
        <p className="text-xs text-ink-2">{upload.reason}</p>
      </div>
      <Select
        aria-label={`Report for ${upload.file_name}`}
        value={report}
        onChange={(e) => setReport(e.currentTarget.value)}
      >
        <option value="" disabled>
          Choose its report
        </option>
        {candidates.length > 0 ? (
          <optgroup label="Kittum suggests">
            {candidates.map((id) => (
              <option key={id} value={id}>
                {title(id)}
              </option>
            ))}
          </optgroup>
        ) : null}
        <optgroup label="Reports without a PDF">
          {others.map((i) => (
            <option key={i.report_id} value={i.report_id}>
              {i.title}
            </option>
          ))}
        </optgroup>
      </Select>
      <span className="flex gap-2">
        <Button disabled={busy || !report} onClick={() => void go(true)}>
          Attach
        </Button>
        <Button disabled={busy} onClick={() => void go(false)}>
          Discard
        </Button>
      </span>
    </li>
  );
}

const readPdf = async (file: File) => new Uint8Array(await file.arrayBuffer());

function UploadFullText({
  item,
  onClose,
  onDone,
}: {
  item: RetrievalItem;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const [file, setFile] = useState<File | null>(null);
  const [licence, setLicence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!file) {
      setError("Choose the PDF.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const attached = await run(
        workbench.attachFullText({
          projectId: project.id,
          as: me.actor_id,
          itemRef: item.item_ref,
          pdf: await readPdf(file),
          licence: licence.trim() || null,
        }),
      );
      onDone(`Attached a ${attached.page_count ?? "?"}-page PDF to "${item.title}".`);
    } catch (e) {
      setError(failure(e, "Kittum could not attach the PDF."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Upload the full text"
      description={item.title}
      submit="Attach the PDF"
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
    >
      <Field
        label="PDF"
        hint="Kittum stores the file and reads its text for screening and extraction."
      >
        <FileInput label="PDF file" accept="application/pdf,.pdf" onFile={setFile} />
      </Field>
      <Field
        label="Licence"
        hint="As the publisher states it, for example CC BY 4.0. Reports cite it."
      >
        <TextInput value={licence} onChange={(e) => setLicence(e.currentTarget.value)} />
      </Field>
    </FormDialog>
  );
}

function UploadMany({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const [files, setFiles] = useState<ReadonlyArray<File>>([]);
  const [licence, setLicence] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (files.length === 0) {
      setError("Choose the PDFs.");
      return;
    }
    setBusy(true);
    setError(null);
    let attached = 0;
    let waiting = 0;
    const refused: string[] = [];
    for (const [i, file] of files.entries()) {
      try {
        const result = await run(
          workbench.uploadFullText({
            projectId: project.id,
            as: me.actor_id,
            fileName: file.name,
            pdf: await readPdf(file),
            licence: licence.trim() || null,
          }),
        );
        if (result.status === "attached") attached += 1;
        else waiting += 1;
      } catch (e) {
        refused.push(`Kittum refused ${file.name}. ${failure(e, "It was not uploaded.")}`);
      }
      setDone(i + 1);
    }
    setBusy(false);
    const parts = [`Attached ${attached} of ${count("PDF", files.length)}.`];
    if (waiting) parts.push(`${waiting} ${waiting === 1 ? "waits" : "wait"} for you to assign.`);
    parts.push(...refused);
    onDone(parts.join(" "));
  };
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title="Upload many PDFs"
      description="Kittum matches each PDF to a report without one by the DOI or PMID in its file name, or by the DOI or title on its first pages. You assign the rest by hand."
      submit={files.length ? `Upload ${count("PDF", files.length)}` : "Upload"}
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
    >
      <Field
        label="PDFs"
        hint="A file named after its DOI (10.1186_s12916-026-04943-4.pdf) or PMID matches by name."
      >
        <input
          type="file"
          multiple
          aria-label="PDF files"
          accept="application/pdf,.pdf"
          onChange={(e) => setFiles([...(e.currentTarget.files ?? [])])}
          className="block w-full text-sm text-ink-2 file:mr-3 file:rounded-[3px] file:border file:border-rule-strong file:bg-sheet-2 file:px-2.5 file:py-1 file:text-sm file:text-ink hover:file:bg-sheet"
        />
      </Field>
      <Field
        label="Licence"
        hint="Applies to every PDF of this upload. Leave it empty if they differ."
      >
        <TextInput value={licence} onChange={(e) => setLicence(e.currentTarget.value)} />
      </Field>
      {busy ? (
        <p className="text-sm text-ink-2" aria-live="polite">
          {`Uploaded ${done} of ${files.length}.`}
        </p>
      ) : null}
    </FormDialog>
  );
}

function ExportMissing({
  reports,
  onClose,
  onDone,
}: {
  reports: number;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const [format, setFormat] = useState<"csv" | "ris">("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const bytes = await run(
        workbench.exportMissing({ projectId: project.id, as: me.actor_id, format }),
      );
      const name = `missing-full-texts.${format}`;
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], {
          type: format === "csv" ? "text/csv" : "application/x-research-info-systems",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      onDone(`Saved ${name} with ${count("report", reports)}.`);
    } catch (e) {
      setError(failure(e, "Kittum could not export the list."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Export the reports without a PDF"
      description={`The file lists ${count("report", reports)} with DOI, PMID, title, authors, journal, year, the sources Kittum tried, and why each attempt failed. It also gives each PDF a file name that Upload many matches.`}
      submit="Download"
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
    >
      <Field label="Format">
        <Select value={format} onChange={(e) => setFormat(e.currentTarget.value as "csv" | "ris")}>
          <option value="csv">CSV, for a spreadsheet</option>
          <option value="ris">RIS, for a reference manager</option>
        </Select>
      </Field>
    </FormDialog>
  );
}

function AddSentinel({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState<"include" | "exclude">("exclude");
  const [file, setFile] = useState<File | null>(null);
  const [licence, setLicence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!title.trim() || !file) {
      setError("Give the report's title and its PDF.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await run(
        workbench.attachSentinelFullText({
          projectId: project.id,
          as: me.actor_id,
          title: title.trim(),
          expectedOutcome: outcome,
          pdf: await readPdf(file),
          licence: licence.trim() || null,
        }),
      );
      setTitle("");
      setFile(null);
      onDone(
        `Added the sentinel "${title.trim()}". Every full-text stage you open from now on puts it in each queue.`,
      );
    } catch (e) {
      setError(failure(e, "Kittum could not add the sentinel."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a full-text sentinel"
      description="A report whose outcome you know. Every full-text queue gets it like any other report. A reviewer who decides it wrongly sets off the drift alarm. It does not show in this list."
      submit="Add the sentinel"
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
    >
      <Field label="Title">
        <TextInput value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
      </Field>
      <Field label="Expected outcome">
        <Select
          value={outcome}
          onChange={(e) => setOutcome(e.currentTarget.value as "include" | "exclude")}
        >
          <option value="exclude">Exclude</option>
          <option value="include">Include</option>
        </Select>
      </Field>
      <Field label="PDF">
        <FileInput label="Sentinel PDF" accept="application/pdf,.pdf" onFile={setFile} />
      </Field>
      <Field label="Licence">
        <TextInput value={licence} onChange={(e) => setLicence(e.currentTarget.value)} />
      </Field>
    </FormDialog>
  );
}
