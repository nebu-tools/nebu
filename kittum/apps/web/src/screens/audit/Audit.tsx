// Audit (DESIGN.md, "The ledger"): the hash-chained ledger as an assessor questions it. Trace a
// PRISMA count to its records and a record to every event about it, each event first in words and
// then its hashes with the content behind them; check the chain and see which event fails which
// check; look at the review as it was at an earlier event. The ledger contains every reviewer's
// decisions, so the server answers the methods lead only.
import { useRouteContext, useSearch } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import type {
  AsOf,
  ChainAudit,
  Finding,
  Milestone,
  PrismaFlow,
  RecordTrace,
  RenderedReport,
  TracedEvent,
} from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { formatDateTime, formatTime } from "../../lib/format.ts";
import { keyWords, modeLabel, revealLabel, sourceLabel } from "../../lib/labels.ts";
import { Button } from "../../ui/Button.tsx";
import { Key, KeyHint } from "../../ui/Key.tsx";
import { useKeys } from "../../ui/keys.ts";
import { LEAD_ONLY, useProject } from "../project.tsx";
import { numberOf, shortLabel } from "../screening/criteria.ts";
import type { NumberedCriterion } from "../screening/criteria.ts";
import { ArtifactToggle, EventHashes, ModelCalls, short } from "./Evidence.tsx";
import type { Caller } from "./Evidence.tsx";

type View = "trace" | "integrity" | "cutoff";

const VIEWS: ReadonlyArray<readonly [View, string, string]> = [
  ["trace", "1", "Trace a count"],
  ["integrity", "2", "Check the chain"],
  ["cutoff", "3", "Look back to an event"],
];

const AI_INVOLVED =
  "Excluded where the AI proposed the exclusion, its reading was shown before the final decision, or it sent the record to an extra screen.";

/** A PRISMA count a lead can open, with the `members` key behind it; exits are its children. */
interface Box {
  readonly key: string;
  readonly label: string;
  readonly help?: string;
  readonly children?: ReadonlyArray<Box>;
}

/** The PRISMA counts in flow order: the main steps, and under each the records that leave. */
const TREE: ReadonlyArray<Box> = [
  { key: "records_identified", label: "Records identified" },
  { key: "unique_records", label: "Records after duplicates removed" },
  {
    key: "records_screened",
    label: "Records screened",
    children: [
      {
        key: "records_excluded",
        label: "Excluded",
        children: [
          {
            key: "title_abstract:excluded_with_ai_involvement",
            label: "With the AI involved",
            help: AI_INVOLVED,
          },
        ],
      },
      { key: "records_awaiting_screening", label: "Not yet screened" },
      { key: "records_unresolved", label: "In conflict" },
    ],
  },
  {
    key: "reports_sought",
    label: "Reports sought for retrieval",
    children: [{ key: "reports_not_retrieved", label: "Not retrieved" }],
  },
  {
    key: "reports_assessed",
    label: "Reports assessed for eligibility",
    children: [
      {
        key: "reports_excluded",
        label: "Excluded",
        children: [
          {
            key: "full_text:excluded_with_ai_involvement",
            label: "With the AI involved",
            help: AI_INVOLVED,
          },
        ],
      },
      { key: "reports_awaiting_classification", label: "Insufficient information" },
    ],
  },
  { key: "reports_included", label: "Reports included" },
  { key: "studies_included", label: "Studies included" },
];

/** The tree in reading order, for stepping with `,` and `.`. */
const flatten = (boxes: ReadonlyArray<Box>): Box[] =>
  boxes.flatMap((b) => [b, ...flatten(b.children ?? [])]);
const BOXES = flatten(TREE);

const FLOW_ROWS: ReadonlyArray<readonly [keyof PrismaFlow & string, string]> = [
  ["records_identified", "Records identified"],
  ["duplicates_removed", "Duplicates removed"],
  ["records_screened", "Records screened"],
  ["records_excluded", "Records excluded"],
  ["records_awaiting_screening", "Records not yet screened"],
  ["records_unresolved", "Records in conflict"],
  ["reports_sought", "Reports sought for retrieval"],
  ["reports_not_retrieved", "Reports not retrieved"],
  ["reports_assessed", "Reports assessed for eligibility"],
  ["reports_excluded", "Reports excluded"],
  ["reports_included", "Reports included"],
  ["studies_included", "Studies included"],
];

const CHECKS: Record<Finding["check"], string> = {
  seq: "Sequence",
  payload_hash: "Payload hash",
  prev_hash: "Link to the event before",
  event_hash: "Event hash",
  checkpoint: "Signed checkpoint",
};

/** What a failed check means, in words a reader of the audit can act on. */
const MEANS: Record<Finding["check"], string> = {
  seq: "An event is missing or out of order.",
  payload_hash: "Its content was changed after Kittum recorded it.",
  prev_hash:
    "It no longer links to the event before it, so events were removed, added, or rewritten.",
  event_hash: "The event itself was changed after Kittum recorded it.",
  checkpoint: "The chain no longer matches what a signed checkpoint recorded.",
};

const STAGES: Record<string, string> = {
  title_abstract: "Title and abstract",
  full_text: "Full text",
};

const REPORT_NAMES: Record<string, string> = {
  prisma: "PRISMA flow",
  ai_disclosure: "AI disclosure",
};

/** A server reason as a sentence of its own. */
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

const seconds = (from: string, to: string) =>
  Math.round((new Date(to).getTime() - new Date(from).getTime()) / 100) / 10;

/** Where the chain breaks: the first event after the verified run, if the chain has one. */
const breakOf = (audit: ChainAudit | null) =>
  audit && !audit.ok && audit.verified_through_seq < audit.head_seq
    ? audit.verified_through_seq + 1
    : null;

/** Checks whose failure has no single event to open: a gap in the sequence, a checkpoint. */
const NOT_AN_EVENT: ReadonlySet<Finding["check"]> = new Set(["seq", "checkpoint"]);

export function AuditScreen() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, seesLeadData, scopeLabel, criteriaFor } = useProject();
  const words = useMemo(() => {
    const all = [...criteriaFor("title_abstract", null), ...criteriaFor("full_text", null)];
    return wordsFor(all.filter((c, i) => all.findIndex((x) => x.id === c.id) === i));
  }, [criteriaFor]);
  const caller = useMemo(() => ({ projectId: project.id, as: me.actor_id }), [project.id, me]);
  // From Progress: a PRISMA count to open.
  const search = useSearch({ strict: false }) as { count?: string; scope?: string };
  const [view, setView] = useState<View>("trace");
  const [head, setHead] = useState<AsOf | null>(null);
  // The review at the last verified event, when the chain breaks: counts that differ rest on
  // events that cannot be verified.
  const [verifiedThen, setVerifiedThen] = useState<AsOf | null>(null);
  const [exporting, setExporting] = useState(false);
  const [audit, setAudit] = useState<ChainAudit | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [milestones, setMilestones] = useState<ReadonlyArray<Milestone>>([]);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<RecordTrace | null>(null);
  const [cutoff, setCutoff] = useState<number | null>(null);
  // An event read as stored, on the integrity view.
  const [shown, setShown] = useState<TracedEvent | null>(null);
  // The newest trace asked for wins, whichever answer comes back last.
  const asked = useRef(0);

  const fail = (e: unknown, what: string) =>
    setError(e instanceof WorkbenchError ? e.message : `${what} failed.`);

  const verify = useCallback(async () => {
    setVerifying(true);
    try {
      setAudit(await run(workbench.auditLedger(caller)));
      setCheckedAt(new Date());
      setError(null);
    } catch (e) {
      fail(e, "Verifying the ledger");
    } finally {
      setVerifying(false);
    }
  }, [workbench, caller]);

  const showEvent = useCallback(
    async (seq: number) => {
      setView("integrity");
      try {
        const page = await run(workbench.ledgerEvents({ ...caller, afterSeq: seq - 1, limit: 1 }));
        setShown(page.events[0]?.seq === seq ? page.events[0] : null);
        // The event opens inside its failed check: bring that row into view.
        requestAnimationFrame(() => {
          const row = document.querySelector<HTMLElement>(
            `[data-testid="finding"][data-seq="${seq}"]`,
          );
          row?.scrollIntoView({ block: "start", behavior: "smooth" });
        });
      } catch (e) {
        fail(e, "Reading the event");
      }
    },
    [workbench, caller],
  );

  useEffect(() => {
    if (!seesLeadData || !workbench.live) return;
    let live = true;
    Promise.all([
      run(workbench.asOf({ ...caller, cutoffSeq: null })),
      run(workbench.milestones(caller)),
      run(workbench.auditLedger(caller)),
    ]).then(
      ([now, named, checked]) => {
        if (!live) return;
        setHead(now);
        setMilestones(named);
        setAudit(checked);
        setCheckedAt(new Date());
        // A broken chain opens on the event that fails, unless a count was asked for.
        const at = breakOf(checked);
        const failing = checked.findings.find((f) => f.seq === at);
        if (at !== null && !search.count && failing && !NOT_AN_EVENT.has(failing.check)) {
          void showEvent(at);
        }
      },
      (e: unknown) => live && fail(e, "Loading the ledger"),
    );
    return () => {
      live = false;
    };
    // Once per project and person; the search only picks the first view.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [workbench, caller, seesLeadData]);

  useEffect(() => {
    if (!audit || audit.ok || audit.verified_through_seq < 1) {
      setVerifiedThen(null);
      return;
    }
    let live = true;
    run(workbench.asOf({ ...caller, cutoffSeq: audit.verified_through_seq })).then(
      (a) => live && setVerifiedThen(a),
      () => live && setVerifiedThen(null),
    );
    return () => {
      live = false;
    };
  }, [workbench, caller, audit]);

  /** Every event as the server reads it back, with the verification, as one JSON file. */
  const exportLedger = async () => {
    setExporting(true);
    try {
      const events: TracedEvent[] = [];
      let after = 0;
      for (;;) {
        const page = await run(workbench.ledgerEvents({ ...caller, afterSeq: after, limit: 500 }));
        events.push(...page.events);
        if (page.next_after_seq == null || page.events.length === 0) break;
        after = page.next_after_seq;
      }
      const file = JSON.stringify(
        {
          project_id: project.id,
          exported_at: new Date().toISOString(),
          verification: audit,
          events,
        },
        null,
        2,
      );
      const url = URL.createObjectURL(new Blob([file], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `kittum-ledger-${project.id}-event-${events.at(-1)?.seq ?? 0}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (e) {
      fail(e, "Exporting the ledger");
    } finally {
      setExporting(false);
    }
  };

  const openTrace = useCallback(
    async (ref: string, switchView = true) => {
      const ask = ++asked.current;
      try {
        const traced = await run(workbench.trace({ ...caller, ref }));
        if (ask !== asked.current) return;
        setTrace(traced);
        if (switchView) setView("trace");
      } catch (e) {
        if (ask === asked.current) fail(e, "Tracing the record");
      }
    },
    [workbench, caller],
  );

  useKeys((event) => {
    const picked = VIEWS.find(([, key]) => key === event.key);
    if (picked) {
      setView(picked[0]);
      return true;
    }
    if (event.key === "v" && seesLeadData && !verifying) {
      setView("integrity");
      void verify();
      return true;
    }
    return false;
  });

  if (!seesLeadData) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold tracking-[-0.01em]">Audit</h1>
        <p className="mt-4 max-w-[60ch] text-md text-ink-2">
          The ledger contains every reviewer&rsquo;s decisions and the AI&rsquo;s readings.{" "}
          {LEAD_ONLY}
        </p>
      </Shell>
    );
  }

  const highlight = new Set(view === "trace" ? (trace?.events.map((e) => e.seq) ?? []) : []);
  const findingAt = new Map<number, Finding>();
  for (const f of audit?.findings ?? []) if (!findingAt.has(f.seq)) findingAt.set(f.seq, f);
  const signed = audit?.checkpoints.length ?? 0;

  return (
    <CriterionWords.Provider value={words}>
      <RecordTitles.Provider value={head?.items ?? NO_ITEMS}>
        <div className="flex h-full flex-col bg-paper">
          <header className="flex flex-none flex-wrap items-start gap-x-6 gap-y-2 px-8 pt-6">
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold">Audit</h1>
              <p className="mt-1 text-sm text-ink-2 tabular-nums">
                {audit
                  ? `${audit.events} events in the ledger, ${signed} signed ${signed === 1 ? "checkpoint" : "checkpoints"}${checkedAt ? `. Checked at ${formatTime(checkedAt)}` : ""}.`
                  : verifying || !error
                    ? "Checking the ledger."
                    : ""}
              </p>
            </div>
            {audit && !audit.ok ? null : (
              <Button kind="secondary" disabled={exporting} onClick={() => void exportLedger()}>
                {exporting ? "Exporting the ledger" : "Export the ledger"}
              </Button>
            )}
            <Button
              keys={["v"]}
              disabled={verifying}
              onClick={() => {
                setView("integrity");
                void verify();
              }}
            >
              {verifying ? "Checking every event" : "Verify the chain again"}
            </Button>
          </header>
          {audit && !audit.ok ? (
            <BreakAlert
              audit={audit}
              checkedAt={checkedAt}
              onOpen={(seq) => void showEvent(seq)}
              opened={view === "integrity" ? (shown?.seq ?? null) : null}
              onExport={() => void exportLedger()}
              exporting={exporting}
            />
          ) : null}
          <ChainStrip
            head={audit?.head_seq ?? head?.head_seq ?? 0}
            audit={audit}
            highlight={highlight}
            cutoff={view === "cutoff" ? cutoff : null}
            onPick={view === "cutoff" ? setCutoff : null}
            verifying={verifying}
          />
          {error ? (
            <p role="alert" className="flex-none px-8 pt-2 text-sm text-exclude">
              {error}
            </p>
          ) : null}
          <div role="tablist" aria-label="Audit views" className="flex flex-none gap-1 px-8 pt-3">
            {VIEWS.map(([id, key, label]) => {
              const on = view === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setView(id)}
                  className={`-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-md ${
                    on
                      ? "border-petrol font-medium text-ink"
                      : "border-transparent text-ink-2 hover:text-ink"
                  }`}
                >
                  <span>{label}</span>{" "}
                  <span aria-hidden="true" className="opacity-70">
                    <Key k={key} className="key-on-button" />
                  </span>
                </button>
              );
            })}
          </div>
          <div role="tabpanel" className="min-h-0 flex-1 border-t border-rule bg-paper">
            {view === "trace" ? (
              <TraceView
                head={head}
                then={verifiedThen}
                verifiedThrough={audit && !audit.ok ? audit.verified_through_seq : null}
                initialCount={search.count ?? null}
                initialScope={search.scope ?? null}
                trace={trace}
                findings={findingAt}
                onOpen={openTrace}
                scopeLabel={scopeLabel}
                caller={caller}
              />
            ) : view === "integrity" ? (
              <IntegrityView
                audit={audit}
                verifying={verifying}
                shown={shown}
                onShow={(seq) => void showEvent(seq)}
                onTrace={openTrace}
                onSigned={() => void verify()}
                caller={caller}
              />
            ) : (
              <CutoffView
                head={head}
                milestones={milestones}
                cutoff={cutoff}
                onCutoff={setCutoff}
                scopeLabel={scopeLabel}
                caller={caller}
              />
            )}
          </div>
        </div>
      </RecordTitles.Provider>
    </CriterionWords.Provider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[1680px] px-8 pt-8 pb-16">{children}</div>
    </div>
  );
}

/**
 * The most serious state the review can be in: the ledger no longer matches its hashes. Says
 * where it breaks, what that means, and opens the event.
 */
function BreakAlert({
  audit,
  checkedAt,
  onOpen,
  opened,
  onExport,
  exporting,
}: {
  audit: ChainAudit;
  checkedAt: Date | null;
  onOpen: (seq: number) => void;
  /** The event open below the alert, if any: its button would open it again. */
  opened: number | null;
  onExport: () => void;
  exporting: boolean;
}) {
  const at = breakOf(audit);
  const finding =
    audit.findings.find((f) => f.seq === at && f.check !== "checkpoint") ??
    audit.findings.find((f) => f.check !== "checkpoint") ??
    audit.findings[0] ??
    null;
  const seq = at ?? finding?.seq ?? null;
  const others = audit.findings.length - (finding ? 1 : 0);
  return (
    <div
      role="alert"
      data-testid="chain-alert"
      className="mx-8 mt-4 flex flex-none flex-wrap items-start gap-x-8 gap-y-3 rounded-[6px] border border-exclude/50 border-l-[6px] border-l-exclude bg-exclude-wash px-6 py-4"
    >
      <div className="min-w-0 flex-1">
        <p className="text-lg font-semibold text-exclude">
          {at !== null
            ? `The chain breaks at event ${at}.`
            : "A signed checkpoint does not match the ledger."}{" "}
          {finding ? (
            <span className="font-normal text-ink">
              {MEANS[finding.check]}{" "}
              <span className="text-ink-2">({CHECKS[finding.check].toLowerCase()} check)</span>
            </span>
          ) : null}
        </p>
        <p
          className="mt-1 max-w-[110ch] text-md text-ink"
          title={checkedAt ? `Checked at ${formatDateTime(checkedAt)}` : undefined}
        >
          {at !== null
            ? "Every later event, and every count and report that rests on one, cannot be verified until this is explained."
            : "Someone may have rewritten the chain after the checkpoint was signed."}
          {others > 0 ? ` ${others} more failed ${others === 1 ? "check" : "checks"}.` : ""}
        </p>
      </div>
      <div className="flex max-w-[26rem] flex-none flex-wrap items-center justify-end gap-x-2 gap-y-1">
        <p className="w-full text-right text-sm text-ink-2">
          Keep the database as it is and give the export to the person who runs the server.
        </p>
        {seq !== null && seq !== opened && finding && !NOT_AN_EVENT.has(finding.check) ? (
          <Button kind="danger" onClick={() => onOpen(seq)}>
            Open event {seq}
          </Button>
        ) : null}
        <Button kind="secondary" disabled={exporting} onClick={onExport}>
          {exporting ? "Exporting the ledger" : "Export the ledger"}
        </Button>
      </div>
    </div>
  );
}

/**
 * The whole chain as one bar: the verified run, the event where it breaks, and what comes after
 * and cannot be verified. Above the bar, a mark per event of the traced record and a notch per
 * signed checkpoint. In the cutoff view a click picks the event, and what came after it fades.
 */
function ChainStrip({
  head,
  audit,
  highlight,
  cutoff,
  onPick,
  verifying,
}: {
  head: number;
  audit: ChainAudit | null;
  highlight: ReadonlySet<number>;
  cutoff: number | null;
  onPick: ((seq: number) => void) | null;
  verifying: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (head === 0) return <div className="h-[72px] flex-none" />;
  const x = (seq: number) => `${((seq - 0.5) / head) * 100}%`;
  const bad = new Set(
    (audit?.findings ?? []).filter((f) => f.check !== "checkpoint").map((f) => f.seq),
  );
  const at = breakOf(audit);
  const lit: string[] = [];
  for (const seq of highlight) lit.push(`M${seq - 0.5} 0V10`);
  const seqAt = (clientX: number, rect: DOMRect) =>
    Math.min(head, Math.max(1, Math.ceil(((clientX - rect.left) / rect.width) * head)));
  // A break is announced in the alert above; under the bar only the legend names it.
  const status = verifying
    ? "Checking every event."
    : audit?.ok
      ? `Every event up to ${audit.verified_through_seq} of ${audit.head_seq} matches its hashes.`
      : "";
  // The verified share of the bar, up to the event before the break.
  const verified = audit ? (at !== null ? at - 1 : audit.verified_through_seq) : 0;
  const hatch = {
    background:
      "repeating-linear-gradient(135deg, var(--exclude-wash) 0 5px, color-mix(in oklab, var(--exclude) 22%, transparent) 5px 7px)",
  };
  return (
    <section aria-label="The ledger chain" className="flex-none px-8 pt-4 pb-1">
      <div
        className={`relative h-8 ${onPick ? "cursor-crosshair" : ""}`}
        data-testid="chain-strip"
        onMouseMove={(e) => setHover(seqAt(e.clientX, e.currentTarget.getBoundingClientRect()))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => onPick?.(seqAt(e.clientX, e.currentTarget.getBoundingClientRect()))}
      >
        {/* The traced record's events, above the bar. */}
        <svg
          className="absolute inset-x-0 top-0 h-2.5 w-full"
          viewBox={`0 0 ${head} 10`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            d={lit.join("")}
            stroke="var(--petrol)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div
          className="absolute inset-x-0 top-3 h-3 overflow-hidden rounded-full bg-sheet-2 shadow-[inset_0_0_0_1px_var(--rule-strong)]"
          aria-hidden="true"
        >
          {audit ? (
            <>
              <div
                className="absolute inset-y-0 left-0 bg-include/75"
                style={{ width: `${(verified / head) * 100}%` }}
              />
              {at !== null && at < head ? (
                <div
                  className="absolute inset-y-0 right-0"
                  style={{ left: `${(at / head) * 100}%`, ...hatch }}
                />
              ) : null}
            </>
          ) : null}
          {cutoff !== null ? (
            <div
              className="absolute inset-y-0 right-0 bg-paper/75"
              style={{ left: `${(cutoff / head) * 100}%` }}
            />
          ) : null}
        </div>
        {(audit?.checkpoints ?? []).map((c) => (
          <span
            key={c.checkpoint.id}
            title={`Checkpoint through event ${c.checkpoint.seq}, signed by key ${short(c.checkpoint.key_id)}`}
            className={`absolute top-1.5 h-6 w-[3px] -translate-x-1/2 rounded-[1px] ${
              c.signature === "valid" && c.head_matches !== false ? "bg-petrol" : "bg-exclude"
            }`}
            style={{ left: x(c.checkpoint.seq) }}
          />
        ))}
        {[...bad].map((seq) => (
          <span
            key={seq}
            data-testid="strip-break"
            title={`Event ${seq} fails a check`}
            className="absolute top-0 h-8 w-1 -translate-x-1/2 rounded-[1px] bg-exclude"
            style={{ left: x(seq) }}
          />
        ))}
        {cutoff !== null ? (
          <span
            className="absolute -top-1 h-10 w-[2px] -translate-x-1/2 bg-ink"
            style={{ left: x(cutoff) }}
          />
        ) : null}
        {hover !== null ? (
          <span
            className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded-[3px] bg-ink px-1.5 py-0.5 text-xs whitespace-nowrap text-sheet tabular-nums"
            style={{ left: x(hover) }}
          >
            Event {hover}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm tabular-nums">
        <span
          className="flex flex-wrap items-center gap-x-5 gap-y-1"
          data-testid="chain-status"
          aria-live="polite"
        >
          {status ? <span className="font-medium text-ink">{status}</span> : null}
          {audit ? (
            <span className="flex flex-wrap items-center gap-x-5 text-ink-2">
              <Legend swatch={<span className="block h-2.5 w-4 rounded-full bg-include/75" />}>
                {verified > 0 ? `Events 1 to ${verified} verified` : "No event verified"}
              </Legend>
              {at !== null ? (
                <Legend swatch={<span className="block h-3.5 w-1 bg-exclude" />}>
                  Fails its check
                </Legend>
              ) : null}
              {at !== null && at < head ? (
                <Legend swatch={<span className="block h-2.5 w-4 rounded-full" style={hatch} />}>
                  Events {at + 1} to {head} not verified
                </Legend>
              ) : null}
              {highlight.size > 0 ? (
                <Legend swatch={<span className="block h-2.5 w-[2px] bg-petrol" />}>
                  Events of the record you traced
                </Legend>
              ) : null}
              {audit.checkpoints.length > 0 ? (
                <Legend swatch={<span className="block h-3.5 w-[3px] bg-petrol" />}>
                  Signed checkpoints
                </Legend>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="ml-auto text-ink-2">Event {head} is the newest</span>
      </div>
    </section>
  );
}

function Legend({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true">{swatch}</span>
      {children}
    </span>
  );
}

// Trace a number.

/** The count a lead most likely wants first: the included reports, else the furthest one. */
const DEFAULT_BOXES = ["reports_included", "reports_assessed", "records_screened"];

function TraceView({
  head,
  then,
  verifiedThrough,
  initialCount,
  initialScope,
  trace,
  findings,
  onOpen,
  scopeLabel,
  caller,
}: {
  head: AsOf | null;
  /** The review at the last verified event, when the chain breaks. */
  then: AsOf | null;
  verifiedThrough: number | null;
  initialCount: string | null;
  initialScope: string | null;
  trace: RecordTrace | null;
  findings: ReadonlyMap<number, Finding>;
  onOpen: (ref: string, switchView?: boolean) => Promise<void>;
  scopeLabel: (scope: string) => string;
  caller: Caller;
}) {
  const flows = head?.flows.filter((f) => f.records_identified > 0) ?? [];
  const [scope, setScope] = useState<string | null>(initialScope);
  const flow = flows.find((f) => f.scope_id === scope) ?? flows[0] ?? null;
  const [picked, setPicked] = useState<string | null>(initialCount);
  const [index, setIndex] = useState(0);
  const box =
    picked ??
    DEFAULT_BOXES.find((k) => (flow?.members[k]?.length ?? 0) > 0) ??
    "records_identified";
  const members = flow?.members[box] ?? [];
  const boxes = flow ? BOXES.filter(({ key }) => key in flow.members) : [];
  const label = BOXES.find((b) => b.key === box)?.label ?? "";
  const before = flow
    ? (then?.flows.find((f) => f.scope_id === flow.scope_id && f.topic_id === flow.topic_id) ??
      null)
    : null;
  /** A count whose records changed after the last verified event rests on unverified events. */
  const unverified = (key: string) => {
    if (verifiedThrough === null || !flow || !then) return false;
    const now = flow.members[key] ?? [];
    const was = new Set(before?.members[key] ?? []);
    return now.length !== was.size || now.some((ref) => !was.has(ref));
  };

  const pick = (i: number, switchView = true) => {
    const ref = members[i];
    if (ref === undefined) return;
    setIndex(i);
    const target = head?.items[ref]?.trace_ref;
    if (target) void onOpen(target, switchView);
  };
  const choose = (key: string) => {
    setPicked(key);
    setIndex(0);
  };

  // The history pane is never empty: the first record of the count opens by itself.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || trace !== null || !head || !flow) return;
    const first = members.findIndex((ref) => head.items[ref]?.trace_ref);
    if (first < 0) return;
    opened.current = true;
    pick(first, false);
    // Once, when the review has loaded.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [head, flow, trace]);

  useKeys((event) => {
    if (event.key === "j" || event.key === "k") {
      const next = Math.min(members.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)));
      pick(next);
      return true;
    }
    if (event.key === "." || event.key === ",") {
      const at = boxes.findIndex(({ key }) => key === box);
      const next =
        boxes[Math.min(boxes.length - 1, Math.max(0, at + (event.key === "." ? 1 : -1)))];
      if (next) choose(next.key);
      return true;
    }
    return false;
  });

  if (!head) return <p className="px-8 pt-6 text-md text-ink-2">Loading the review.</p>;
  if (!flow) return <p className="px-8 pt-6 text-md text-ink-2">No searches are recorded yet.</p>;

  const renderBoxes = (list: ReadonlyArray<Box>, depth: number): ReactNode => (
    <ul className={depth > 0 ? "ml-3 border-l border-rule-strong pl-3" : ""}>
      {list
        .filter(({ key }) => key in flow.members)
        .map((b) => {
          const n = flow.members[b.key]?.length ?? 0;
          const active = b.key === box;
          return (
            <li
              key={b.key}
              className={
                depth > 0
                  ? "relative before:absolute before:top-[1.05rem] before:-left-3 before:w-2.5 before:border-t before:border-rule-strong"
                  : ""
              }
            >
              <button
                type="button"
                data-testid={`box-${b.key}`}
                aria-pressed={active}
                onClick={() => choose(b.key)}
                className={`flex w-full items-baseline gap-3 rounded-[4px] px-2 py-1.5 text-left ${
                  active ? "bg-petrol-wash text-ink" : "hover:bg-sheet-2"
                }`}
              >
                <span
                  className={`min-w-0 flex-1 ${depth === 0 ? "text-md" : "text-sm text-ink-2"} ${active ? "font-medium text-ink" : ""}`}
                >
                  {b.help ? (
                    <span
                      className="cursor-help underline decoration-ink-3 decoration-dotted underline-offset-2"
                      title={b.help}
                    >
                      {b.label}
                    </span>
                  ) : (
                    b.label
                  )}
                </span>
                {unverified(b.key) ? " " : null}
                {unverified(b.key) ? (
                  <span
                    className="self-center rounded-full bg-exclude-wash px-1.5 text-2xs font-medium text-exclude"
                    title={`Its records changed after event ${verifiedThrough}, the last one that verifies, so this count rests on events that cannot be verified.`}
                    data-testid={`unverified-${b.key}`}
                  >
                    Unverified
                  </span>
                ) : null}
                <span
                  className={`tabular-nums ${depth === 0 ? "text-md font-semibold" : "text-sm"} ${n === 0 ? "text-ink-3" : ""}`}
                >
                  {n}
                </span>
              </button>
              {b.children ? renderBoxes(b.children, depth + 1) : null}
            </li>
          );
        })}
    </ul>
  );

  return (
    <div className="grid h-full grid-cols-[22rem_20rem_minmax(0,1fr)]">
      <section aria-label="PRISMA flow" className="overflow-y-auto border-r border-rule px-4 py-4">
        {flows.length > 1 ? (
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {flows.map((f) => (
              <button
                key={f.scope_id}
                type="button"
                aria-pressed={f.scope_id === flow.scope_id}
                onClick={() => setScope(f.scope_id)}
                className={`rounded-[4px] border px-2 py-0.5 ${f.scope_id === flow.scope_id ? "border-petrol bg-petrol-wash text-petrol" : "border-rule-strong text-ink-2"}`}
              >
                {scopeLabel(f.scope_id)}
              </button>
            ))}
          </div>
        ) : null}
        <h2 className="px-2 text-sm font-semibold">PRISMA counts</h2>
        <div className="mt-3">{renderBoxes(TREE, 0)}</div>
        <p className="mt-4 px-2 text-xs">
          <KeyHint keys={[",", "."]}>Previous or next count</KeyHint>
        </p>
      </section>
      <section
        aria-label="Records behind the count"
        className="overflow-y-auto border-r border-rule py-4"
      >
        <div className="px-4">
          <h2 className="text-md font-semibold">{label}</h2>
          <p className="mt-0.5 flex items-center gap-3 text-sm text-ink-2">
            <span className="tabular-nums">
              {members.length} {members.length === 1 ? "record" : "records"}
            </span>
            {members.length > 1 ? (
              <span className="text-xs">
                <KeyHint keys={["j", "k"]}>Next, previous</KeyHint>
              </span>
            ) : null}
          </p>
        </div>
        {members.length === 0 ? (
          <p className="mt-3 px-4 text-sm text-ink-2">No record is in this count yet.</p>
        ) : null}
        <ol className="mt-2">
          {members.map((ref, i) => {
            const item = head.items[ref];
            const open =
              trace !== null && (trace.ref === item?.trace_ref || trace.report_id === ref);
            return (
              <li key={ref}>
                <button
                  type="button"
                  data-testid="member"
                  disabled={!item?.trace_ref}
                  onClick={() => pick(i)}
                  className={`block w-full border-l-[3px] px-4 py-2 text-left text-sm ${
                    open
                      ? "border-petrol bg-petrol-wash text-ink"
                      : "border-transparent text-ink hover:bg-sheet-2"
                  }`}
                >
                  <span className="line-clamp-2">{item?.title ?? ref}</span>
                  {!item?.trace_ref ? (
                    <span className="text-sm text-ink-2">
                      A sentinel. It has no history of its own.
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      </section>
      <section aria-label="Record history" className="overflow-y-auto px-6 py-4">
        {trace ? (
          // The record under inspection is the raised surface; the counts and the list stay flat.
          <div className="rounded-[6px] bg-raised px-6 py-5 shadow-raised">
            <Timeline trace={trace} findings={findings} caller={caller} />
          </div>
        ) : (
          <p className="max-w-[60ch] text-md text-ink-2">
            {members.length === 0
              ? "Pick a count with records to see their history."
              : "Pick a record to see every ledger event about it, from the searches that found it to the values taken from its full text."}
          </p>
        )}
      </section>
    </div>
  );
}

function Timeline({
  trace,
  findings,
  caller,
}: {
  trace: RecordTrace;
  findings: ReadonlyMap<number, Finding>;
  caller: Caller;
}) {
  const { protocol } = useProject();
  const names = new Map(
    (protocol?.protocol.topics ?? []).flatMap((t) => t.sources.map((s) => [s.id, s.name])),
  );
  const sourceName = (id: string) => names.get(id) ?? sourceLabel(id);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const toggle = (seq: number) =>
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  return (
    <article data-testid="timeline">
      <h2 className="max-w-[70ch] text-lg font-semibold" data-testid="trace-title">
        {trace.title}
      </h2>
      <p
        className="mt-1 text-sm text-ink-2"
        title={
          trace.report_id
            ? `Report ${trace.report_id}${trace.study_id ? `, study ${trace.study_id}` : ""}`
            : undefined
        }
      >
        {trace.report_id
          ? `A report in the corpus${trace.study_id ? ", linked to a study" : ""}.`
          : "A search result that is not in the corpus yet. No identity revision includes it."}
      </p>
      <section className="mt-4" aria-label="Found by">
        <h3 className="text-sm font-semibold text-ink-2">
          Found {trace.occurrences.length === 1 ? "once" : `${trace.occurrences.length} times`}
        </h3>
        <ul className="mt-1.5 grid gap-1 text-sm">
          {trace.occurrences.map((o) => (
            <li key={o.occurrence_id} className="flex flex-wrap items-baseline gap-x-3">
              <span title={`Source ID: ${o.source}`}>{sourceName(o.source)}</span>
              <span className="text-ink-2">record {o.provider_record_id}</span>
              {o.search_seq !== null ? (
                <span className="text-ink-2">search at event {o.search_seq}</span>
              ) : null}
              <ArtifactToggle caller={caller} sha256={o.raw_hash} label="Raw response" />
            </li>
          ))}
        </ul>
      </section>
      {trace.reveals.map((r) => (
        <p
          key={r.decision_seq}
          className="mt-4 max-w-[72ch] border-l-2 border-petrol pl-3 text-sm"
          data-testid="reveal"
        >
          {r.reviewer} decided blind at event {r.decision_seq} ({STAGES[r.stage] ?? r.stage}).
          Kittum showed the AI&rsquo;s reading only after that decision
          {r.shown_at && r.decided_at ? `, ${seconds(r.decided_at, r.shown_at)} s later` : ""}.{" "}
          {r.final_seq !== null
            ? `${r.kept ? "They kept their decision" : "They changed it"} at event ${r.final_seq}.`
            : "Their final decision is still open."}
        </p>
      ))}
      <ol className="mt-6" aria-label="Events">
        {trace.events.map((e, i) => {
          const before = trace.events[i - 1];
          const gap = before ? e.seq - before.seq - 1 : 0;
          return (
            <li key={e.seq}>
              {gap > 0 ? (
                <div className="grid grid-cols-[4rem_1.25rem_minmax(0,1fr)] text-xs text-ink-3">
                  <span />
                  <span className="mx-auto h-5 w-px border-l border-dashed border-rule-strong" />
                  <span className="self-center pl-3">
                    {gap} other {gap === 1 ? "event" : "events"}
                  </span>
                </div>
              ) : null}
              <EventRow
                event={e}
                finding={findings.get(e.seq) ?? null}
                expanded={open.has(e.seq)}
                onToggle={() => toggle(e.seq)}
                caller={caller}
              />
            </li>
          );
        })}
      </ol>
    </article>
  );
}

/** A timestamp as the server stores it: ISO 8601 with a time. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * One fact of an event: a timestamp in the workbench's format, the stored value in its hover; a
 * long value (a search query, a prompt) cut to two lines until it is opened.
 */
function FactValue({ label, value }: { label: string; value: string }) {
  const [open, setOpen] = useState(false);
  const words = useContext(CriterionWords);
  const text = value.trim();
  if (ISO_TIME.test(text) && !Number.isNaN(Date.parse(text))) {
    return <span title={text}>{formatDateTime(text)}</span>;
  }
  // Quotes, comments, and queries are someone's own words: no criterion names go into them.
  const shown = /evidence|quote|comment|query|strategy|record/i.test(label)
    ? value
    : words(value, label === "Criterion" ? "bare" : "text");
  if (text.length <= 180 && text.split("\n").length <= 2) return <>{shown}</>;
  return (
    <>
      <span className={open ? "block" : "line-clamp-2 block"}>{shown}</span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-sm text-petrol underline decoration-petrol/40 underline-offset-2"
      >
        {open ? "Show less" : /query|strategy/i.test(label) ? "Show full query" : "Show all"}
      </button>
    </>
  );
}

/** Fact labels the ledger writes in its own terms, in the reader's. */
const FACT_LABELS: Record<string, string> = { Decision: "How it was decided" };

/** An event that fails its check is read as what is stored now, not as what was decided. */
const STORED_LABELS: Readonly<Record<string, string>> = {
  Criterion: "Stored criterion reference",
};

/** A hash, readable and copyable. */
function Hash({ value }: { value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span>Nothing</span>;
  return (
    <span className="flex items-baseline gap-3">
      <span className="min-w-0 font-mono text-sm break-all">{value}</span>
      <button
        type="button"
        className="flex-none text-sm text-petrol hover:underline"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

/** Values the ledger writes as keys ("second_opinion"), in words. */
const WORDED = new Set(["Role"]);

/** An event's facts: a criterion's ID becomes its permanent number and short name, its wording
 * in the hover. */
function Facts({
  facts,
  testId,
  labels,
}: {
  facts: TracedEvent["facts"];
  testId?: string;
  /** Labels to read the facts under instead of the usual ones. */
  labels?: Readonly<Record<string, string>> | undefined;
}) {
  const words = useContext(CriterionWords);
  if (facts.length === 0) return null;
  return (
    <dl
      className="mt-1.5 grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-sm"
      data-testid={testId}
    >
      {facts.map((f, i) => (
        <div key={`${f.label}-${i}`} className="contents">
          <dt className="max-w-[16rem] text-ink-2">
            {labels?.[f.label] ?? FACT_LABELS[f.label] ?? words(f.label, "label")}
          </dt>
          <dd className="min-w-0 break-words whitespace-pre-wrap">
            {WORDED.has(f.label) ? (
              keyWords(f.value)
            ) : (
              <FactValue label={f.label} value={f.value} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The ledger names criteria by their IDs ("crit-inc-rct"). On screen each is "criterion 6
 * (Randomised trial)", by its permanent number; the ID stays in the hover. A label that is an ID
 * and the criterion's wording ("POP. Adults who smoke") keeps only the name.
 */
const wordsFor = (criteria: ReadonlyArray<NumberedCriterion>) => {
  if (criteria.length === 0) return (text: string) => text as ReactNode;
  const ids = [...new Set(criteria.map((c) => c.id))].sort((a, b) => b.length - a.length);
  const escape = (id: string) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\w-])(${ids.map(escape).join("|")})(?![\\w-])`, "g");
  const name = (id: string, bare = false) => {
    const c = criteria.find((x) => x.id === id);
    if (!c) return id;
    return bare
      ? `${numberOf(criteria, id)} ${shortLabel(c)}`
      : `criterion ${numberOf(criteria, id)} (${shortLabel(c)})`;
  };
  const included = new RegExp(
    `^(.* included the record) on (${ids.map(escape).join("|")})(?![\\w-])`,
  );
  return (raw: string, mode: WordsMode = "text"): ReactNode => {
    const label = mode === "label";
    // An inclusion is not "on" a criterion: the criterion an include carries is shown as its own
    // fact, so the summary only says what was decided.
    const text = mode === "summary" ? raw.replace(included, "$1") : raw;
    if (label) {
      const whole = criteria.find((c) => text === c.id || text.startsWith(`${c.id}. `));
      if (whole) {
        return <span title={`${whole.id}: ${whole.text_en}`}>{keyWords(name(whole.id))}</span>;
      }
    }
    const parts = text.split(pattern);
    if (parts.length === 1) return text;
    return parts.map((part, i) =>
      i % 2 === 1 ? (
        <span key={i} title={`Criterion ID ${part}`}>
          {name(part, mode === "bare")}
        </span>
      ) : (
        part
      ),
    );
  };
};

const NO_ITEMS: AsOf["items"] = {};

/** Every record's title by its reference, from the review at its head. */
const RecordTitles = createContext<AsOf["items"]>(NO_ITEMS);

/** An event type ("screening.decided") in words ("screening decided"); the type stays in the
 * hover. */
const typeWords = (type: string) => {
  const [family = "", verb = ""] = type.split(".");
  const noun = EVENT_NOUNS[verb];
  return noun ? `${family.replace(/_/g, " ")} ${noun}` : type.replace(/[._]+/g, " ");
};

/** The past tense an event type ends in, as the noun a reader expects. */
const EVENT_NOUNS: Record<string, string> = {
  decided: "decision",
  adjudicated: "adjudication",
  undone: "undo",
  attached: "attachment",
  opened: "opening",
  closed: "closing",
  published: "publication",
  signed: "signature",
};

/** How a text names criteria: in running text, a summary, a fact's label, or a value whose label
 * already says "Criterion". */
type WordsMode = "text" | "summary" | "label" | "bare";

const CriterionWords = createContext<(text: string, mode?: WordsMode) => ReactNode>((text) => text);

const KIND_LABEL: Record<TracedEvent["kind"], string> = {
  search: "Search",
  identity: "Identity",
  stage: "Stage",
  ai: "AI judge",
  decision: "Decision",
  conflict: "Conflict",
  adjudication: "Adjudication",
  full_text: "Full text",
  extraction: "Extraction",
  appraisal: "Risk of bias",
  report: "Report",
  ledger: "Ledger",
  project: "Project",
};

function EventRow({
  event: e,
  finding,
  expanded,
  onToggle,
  caller,
}: {
  event: TracedEvent;
  finding: Finding | null;
  expanded: boolean;
  onToggle: () => void;
  caller: Caller;
}) {
  const broken = finding !== null;
  const words = useContext(CriterionWords);
  return (
    <div
      className="grid grid-cols-[4rem_1.25rem_minmax(0,1fr)]"
      data-testid="trace-event"
      data-seq={e.seq}
      data-kind={e.kind}
      data-broken={broken || undefined}
    >
      <span
        className={`pt-2.5 pr-3 text-right text-md font-semibold tabular-nums ${broken ? "text-exclude" : ""}`}
      >
        {e.seq}
      </span>
      <span className="relative flex justify-center" aria-hidden="true">
        <span className={`absolute inset-y-0 w-0.5 ${broken ? "bg-exclude" : "bg-petrol-wash"}`} />
        <span
          className={`relative mt-3.5 size-2.5 rounded-full border-2 ${
            broken ? "border-exclude bg-exclude-wash" : "border-petrol bg-sheet"
          }`}
        />
      </span>
      <div className={`mb-1 ml-2 rounded-[3px] px-3 py-2 ${broken ? "bg-exclude-wash" : ""}`}>
        <div className="flex items-baseline gap-3">
          <span className="w-[5.5rem] flex-none text-xs text-ink-3">
            {KIND_LABEL[e.kind]}
            {e.stage ? <span className="block">{STAGES[e.stage] ?? e.stage}</span> : null}
          </span>
          <span className="min-w-0">
            <span className="block text-md leading-snug" data-testid="event-summary">
              {words(e.summary, "summary")}
            </span>
            <span className="mt-0.5 flex flex-wrap gap-x-4 text-xs text-ink-2">
              <span>{e.actor}</span>
              <span className="tabular-nums">{formatDateTime(e.recorded_at)}</span>
            </span>
          </span>
        </div>
        <div className="ml-[6.25rem]">
          {broken ? (
            <p className="mt-1.5 text-sm font-medium text-exclude" data-testid="event-finding">
              Fails the {CHECKS[finding.check].toLowerCase()} check. {sentence(finding.reason)}
            </p>
          ) : null}
          <Facts facts={e.facts} testId="event-facts" />
          {e.artifacts.length > 0 ? (
            <div className="mt-1.5 grid gap-1">
              {e.artifacts.map((a) => (
                <ArtifactToggle
                  key={`${a.sha256}-${a.label}`}
                  caller={caller}
                  sha256={a.sha256}
                  label={a.label}
                  stored={a.stored}
                />
              ))}
            </div>
          ) : null}
          {e.model_calls && e.model_calls.length > 0 ? (
            <ModelCalls calls={e.model_calls} caller={caller} />
          ) : null}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="mt-1.5 text-xs text-ink-2 hover:text-ink"
          >
            {expanded ? "Hide the hashes" : "Show the hashes and what they cover"}{" "}
            <span className="text-ink-3 tabular-nums">{short(e.event_hash, 8)}</span>
          </button>
          {expanded ? <EventHashes event={e} /> : null}
        </div>
      </div>
    </div>
  );
}

// Integrity.

function IntegrityView({
  audit,
  verifying,
  shown,
  onShow,
  onTrace,
  onSigned,
  caller,
}: {
  audit: ChainAudit | null;
  verifying: boolean;
  shown: TracedEvent | null;
  onShow: (seq: number) => void;
  onTrace: (ref: string) => Promise<void>;
  onSigned: () => void;
  caller: Caller;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const [notice, setNotice] = useState<string | null>(null);

  const sign = async () => {
    try {
      const signed = await run(workbench.signCheckpoint(caller));
      setNotice(`Signed a checkpoint through event ${signed.checkpoint.seq}.`);
      onSigned();
    } catch (e) {
      setNotice(e instanceof WorkbenchError ? e.message : "Signing failed.");
    }
  };

  useKeys((event) => {
    if (event.key === "c") {
      void sign();
      return true;
    }
    return false;
  });

  if (!audit)
    return (
      <p className="px-8 pt-6 text-md text-ink-2">{verifying ? "Checking every event." : ""}</p>
    );
  const failed = audit.findings.length;
  const at = breakOf(audit);
  const shownApart = shown !== null && !audit.findings.some((f) => f.seq === shown.seq);
  return (
    <div className="h-full overflow-y-auto">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,38rem)] items-start gap-x-12 px-8 pt-6 pb-14">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold" data-testid="integrity-verdict">
            {audit.ok
              ? `Every one of ${audit.events} events matches its hashes and links.`
              : `${failed} failed ${failed === 1 ? "check" : "checks"}`}
          </h2>
          <p className="mt-1 text-sm text-ink-2">
            {verifying ? "Checking again now. " : ""}
            <span
              className="cursor-help underline decoration-dotted underline-offset-2"
              title="Kittum hashes each event's payload again, then the event, and checks the link to the event before. A chain rewritten from some event onwards still links up; only a signed checkpoint shows that, because its key is kept apart from the database."
            >
              How the check works
            </span>
          </p>
          {notice ? (
            <p className="mt-2 text-sm" aria-live="polite">
              {notice}
            </p>
          ) : null}

          {failed > 0 ? (
            <ol className="mt-4" aria-label="Failed checks">
              {audit.findings.map((f) => (
                <li
                  key={`${f.seq}-${f.check}`}
                  className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-5 py-3"
                  data-testid="finding"
                  data-seq={f.seq}
                  data-check={f.check}
                >
                  <span className="text-right text-[1.6rem] leading-none font-semibold text-exclude tabular-nums">
                    {f.seq}
                  </span>
                  <div className="min-w-0">
                    <p className="text-md">
                      <span className="font-semibold">{CHECKS[f.check]}</span>
                      {f.type ? (
                        <span className="text-ink-2" title={f.type}>
                          {" "}
                          check on {/^[aeiou]/i.test(typeWords(f.type)) ? "an" : "a"}{" "}
                          {typeWords(f.type)}
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-md">{sentence(f.reason)}</p>
                    {f.stored || f.expected ? (
                      <dl className="mt-2 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                        <dt className="text-ink-2">Stored</dt>
                        <dd className="min-w-0">
                          <Hash value={f.stored} />
                        </dd>
                        <dt className="text-ink-2">
                          {f.check === "checkpoint" ? "Signed" : "Recomputed"}
                        </dt>
                        <dd className="min-w-0">
                          <Hash value={f.expected} />
                        </dd>
                      </dl>
                    ) : null}
                    {shown?.seq === f.seq ? (
                      <ShownEvent event={shown} onTrace={onTrace} failing />
                    ) : !NOT_AN_EVENT.has(f.check) ? (
                      <Button
                        kind="secondary"
                        size="sm"
                        className="mt-2"
                        onClick={() => onShow(f.seq)}
                      >
                        Show event {f.seq} as stored
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
          {shown && shownApart ? (
            <ShownEvent event={shown} onTrace={onTrace} failing={false} />
          ) : null}
        </div>

        <section aria-label="Checkpoints" className="rounded-[4px] bg-sheet-2 px-5 py-4">
          <h3 className="text-md font-semibold">Signed checkpoints</h3>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {at !== null ? (
              <p className="text-sm text-ink-2">
                Signing records the current head. It repairs nothing.
              </p>
            ) : null}
            <Button kind="secondary" size="sm" keys={["c"]} onClick={() => void sign()}>
              Sign a checkpoint at the head
            </Button>
          </div>
          {audit.checkpoints.length === 0 ? (
            <p className="mt-2 text-md text-ink-2">
              No checkpoint is signed yet, so a chain rewritten from some event onwards would pass
              every check. Sign one now, or seal a bundle on Reports.
            </p>
          ) : (
            <>
              <table className="narrow mt-3 w-full text-sm tabular-nums" data-testid="checkpoints">
                <thead className="text-left text-ink-2">
                  <tr className="border-b border-rule">
                    <th className="py-1 font-normal">Through event</th>
                    <th className="py-1 font-normal">Signed</th>
                    <th className="py-1 font-normal">Signature</th>
                    <th className="py-1 font-normal">Stored head</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.checkpoints.map((c) => (
                    <tr key={c.checkpoint.id} className="border-b border-rule">
                      <td className="py-1.5 font-semibold">{c.checkpoint.seq}</td>
                      <td>{formatDateTime(c.checkpoint.created_at)}</td>
                      <td
                        title={`Key ${c.checkpoint.key_id}`}
                        className={
                          c.signature === "valid"
                            ? "text-include"
                            : c.signature === "invalid"
                              ? "text-exclude"
                              : "text-ink-2"
                        }
                      >
                        {
                          {
                            valid: "Valid",
                            invalid: "Does not verify",
                            unknown_key: "Signed by another key, not trusted",
                            unchecked: "No key to check",
                          }[c.signature]
                        }
                      </td>
                      <td
                        className={c.head_matches === false ? "text-exclude" : ""}
                        title={c.checkpoint.head_hash}
                      >
                        {c.head_matches === null
                          ? "That event is missing"
                          : c.head_matches
                            ? "Matches the signed head"
                            : "Differs from what was signed"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {at !== null &&
              audit.checkpoints.some((c) => c.head_matches && c.checkpoint.seq >= at) ? (
                <p className="mt-3 text-sm">
                  A checkpoint signs the hash of the newest event when it is signed. These still
                  match, so the links between events are as they were then. A change to one
                  event&rsquo;s content leaves the links in place, so a matching head does not clear
                  the failed check.
                </p>
              ) : null}
            </>
          )}
          <p className="mt-3 text-sm text-ink-2">
            {audit.trusted_key_id ? (
              <>
                Checked against the server&rsquo;s checkpoint key{" "}
                <span className="narrow tabular-nums" title={audit.trusted_key_id}>
                  {short(audit.trusted_key_id)}
                </span>
                .
              </>
            ) : (
              "The server has no checkpoint key, so Kittum cannot check signatures here."
            )}
          </p>
        </section>
      </div>
    </div>
  );
}

/** An event read back as the ledger stores it now. One that fails its check is labelled so: its
 * content may not be what was recorded. */
function ShownEvent({
  event,
  onTrace,
  failing,
}: {
  event: TracedEvent;
  onTrace: (ref: string) => Promise<void>;
  failing: boolean;
}) {
  const words = useContext(CriterionWords);
  const titles = useContext(RecordTitles);
  const ref = (event.payload["item_ref"] ?? event.payload["report_id"]) as string | undefined;
  const title = ref ? titles[ref]?.title : undefined;
  return (
    <section
      className={`mt-3 rounded-[6px] bg-raised px-5 py-4 shadow-raised ${failing ? "border-l-4 border-l-exclude" : ""}`}
      aria-label={`Event ${event.seq}`}
      data-testid="shown-event"
    >
      <p className="text-sm text-ink-2">
        {failing ? "Unverified: as stored now" : `Event ${event.seq} as stored`}
      </p>
      <h3 className="text-md font-semibold">{words(event.summary, "summary")}</h3>
      <p className="text-sm text-ink-2">
        {event.actor}, {formatDateTime(event.recorded_at)}
      </p>
      <Facts
        facts={[...(title ? [{ label: "Record", value: title }] : []), ...event.facts]}
        labels={failing ? STORED_LABELS : undefined}
      />
      {ref ? (
        <Button kind="secondary" className="mt-3" onClick={() => void onTrace(ref)}>
          Trace the record it concerns
        </Button>
      ) : null}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-petrol">Show the payload as stored</summary>
        <pre className="mt-1 max-h-80 overflow-auto rounded-[4px] bg-sheet-2 p-3 text-xs whitespace-pre-wrap">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </details>
    </section>
  );
}

// The review as of an event.

function CutoffView({
  head,
  milestones,
  cutoff,
  onCutoff,
  scopeLabel,
  caller,
}: {
  head: AsOf | null;
  milestones: ReadonlyArray<Milestone>;
  cutoff: number | null;
  onCutoff: (seq: number) => void;
  scopeLabel: (scope: string) => string;
  caller: Caller;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const [then, setThen] = useState<AsOf | null>(null);
  const [cursor, setCursor] = useState(0);
  const [typed, setTyped] = useState("");
  const [kept, setKept] = useState<{
    seq: number;
    reports: RenderedReport[];
    svg: string | null;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (cutoff === null) return;
    let live = true;
    run(workbench.asOf({ ...caller, cutoffSeq: cutoff })).then(
      (a) => {
        if (!live) return;
        setThen(a);
        setNotice(null);
      },
      (e: unknown) =>
        live &&
        setNotice(e instanceof WorkbenchError ? e.message : "Kittum could not read the review."),
    );
    return () => {
      live = false;
    };
  }, [workbench, caller, cutoff]);

  useEffect(
    () => () => {
      if (kept?.svg) URL.revokeObjectURL(kept.svg);
    },
    [kept],
  );

  const keep = async () => {
    if (!then) return;
    setNotice(`Rendering at event ${then.cutoff_seq}.`);
    try {
      const reports = await Promise.all(
        ["prisma", "ai_disclosure"].map((target) =>
          run(workbench.renderReport({ ...caller, target, cutoffSeq: then.cutoff_seq })),
        ),
      );
      const diagram = reports[0]?.artifact.files.find(
        (f) =>
          f.media_type === "image/svg+xml" &&
          f.path.includes(then.flows.find((x) => x.records_identified > 0)?.scope_id ?? ""),
      );
      const svg = diagram
        ? URL.createObjectURL(
            new Blob(
              [
                (await run(
                  workbench.reportFile({ ...caller, sha256: diagram.sha256 }),
                )) as BlobPart,
              ],
              {
                type: "image/svg+xml",
              },
            ),
          )
        : null;
      setKept({ seq: then.cutoff_seq, reports, svg });
      setNotice(null);
    } catch (e) {
      setNotice(e instanceof WorkbenchError ? e.message : "Rendering failed.");
    }
  };

  useKeys((event) => {
    if (event.key === "j" || event.key === "k") {
      setCursor((c) =>
        Math.min(milestones.length - 1, Math.max(0, c + (event.key === "j" ? 1 : -1))),
      );
      return true;
    }
    if (event.key === "Enter" && milestones[cursor]) {
      onCutoff(milestones[cursor].seq);
      return true;
    }
    if (event.key === "p" && then) {
      void keep();
      return true;
    }
    return false;
  });

  const named = new Map(milestones.map((m) => [m.seq, m.label]));
  return (
    <div className="grid h-full grid-cols-[24rem_minmax(0,1fr)]">
      <section
        aria-label="Pick an event"
        className="overflow-y-auto border-r border-rule px-5 py-4"
      >
        <form
          className="flex items-center gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(typed);
            if (Number.isInteger(n) && n >= 0) onCutoff(n);
          }}
        >
          <label htmlFor="cutoff-seq" className="text-ink-2">
            Event
          </label>
          <input
            id="cutoff-seq"
            inputMode="numeric"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="h-7 w-24 rounded-[4px] border border-rule-strong bg-paper px-2 tabular-nums"
          />
          <Button type="submit" kind="primary" size="sm">
            Look back
          </Button>
        </form>
        <p className="mt-2 text-sm text-ink-2">Or click the chain, or pick a named event.</p>
        <p className="mt-1 text-xs">
          <KeyHint keys={["j", "k"]}>Move</KeyHint> <KeyHint keys={["Enter"]}>Pick</KeyHint>
        </p>
        <ol className="mt-3" aria-label="Named events">
          {milestones.map((m, i) => (
            <li key={`${m.seq}-${m.label}`}>
              <button
                type="button"
                data-testid="milestone"
                aria-pressed={cutoff === m.seq}
                onClick={() => {
                  setCursor(i);
                  onCutoff(m.seq);
                }}
                className={`grid w-full grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 border-l-[3px] py-1.5 pr-2 text-left text-sm ${
                  cutoff === m.seq
                    ? "border-petrol bg-petrol-wash"
                    : i === cursor
                      ? "border-rule-strong bg-sheet-2"
                      : "border-transparent hover:bg-sheet-2"
                }`}
              >
                <span className="text-right font-semibold tabular-nums">{m.seq}</span>
                <span className={m.kind === "stage_closed" ? "font-medium" : "text-ink-2"}>
                  {m.label}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>
      <section aria-label="The review as of the event" className="overflow-y-auto px-8 py-5">
        {notice ? (
          <p className="mb-3 text-sm" role="status">
            {notice}
          </p>
        ) : null}
        {!then || !head ? (
          <p className="max-w-[60ch] text-md text-ink-2">
            Pick an event on the left, or click the chain above, to see the PRISMA flow and the AI
            disclosure at that event, next to how they look now.
          </p>
        ) : (
          <AsOfReport then={then} now={head} named={named} scopeLabel={scopeLabel} />
        )}
        {then ? (
          <div className="mt-6 border-t border-rule pt-4">
            <Button kind="primary" keys={["p"]} onClick={() => void keep()}>
              Render and keep the PRISMA flow and the AI disclosure at event {then.cutoff_seq}
            </Button>
            {kept ? (
              <div className="mt-3" data-testid="kept-report">
                <p className="text-sm">
                  Rendered at event {kept.seq} and recorded in the ledger:{" "}
                  {kept.reports.map((r) => (
                    <span key={r.sha256} className="mr-4">
                      {REPORT_NAMES[r.artifact.target] ?? r.artifact.target}{" "}
                      <span className="narrow text-xs text-ink-2 tabular-nums">
                        ({r.artifact.target}, {short(r.sha256, 8)})
                      </span>
                    </span>
                  ))}
                </p>
                {kept.svg ? (
                  <img
                    src={kept.svg}
                    alt={`PRISMA 2020 flow diagram at event ${kept.seq}`}
                    className="mt-3 max-w-[760px] bg-sheet"
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function AsOfReport({
  then,
  now,
  named,
  scopeLabel,
}: {
  then: AsOf;
  now: AsOf;
  named: ReadonlyMap<number, string>;
  scopeLabel: (scope: string) => string;
}) {
  const flows = then.flows.filter(
    (f) =>
      f.records_identified > 0 ||
      now.flows.some((n) => n.scope_id === f.scope_id && n.records_identified > 0),
  );
  return (
    <article data-testid="as-of" data-cutoff={then.cutoff_seq}>
      <h2 className="text-lg font-semibold">
        As of event {then.cutoff_seq}
        {named.get(then.cutoff_seq) ? `, ${named.get(then.cutoff_seq)}` : ""}
      </h2>
      <p className="text-sm text-ink-2">
        {then.cutoff_type
          ? `${then.cutoff_type}, recorded ${formatDateTime(then.cutoff_recorded_at ?? "")}. `
          : ""}
        {then.head_seq - then.cutoff_seq} events came after it.
      </p>
      {flows.map((flow) => {
        const latest = now.flows.find(
          (n) => n.scope_id === flow.scope_id && n.topic_id === flow.topic_id,
        );
        return (
          <section
            key={`${flow.topic_id}-${flow.scope_id}`}
            className="mt-5"
            data-scope={flow.scope_id}
            data-testid="asof-flow"
          >
            <h3 className="text-sm font-semibold text-ink-2">
              PRISMA flow, {scopeLabel(flow.scope_id)}
            </h3>
            <table className="mt-2 w-full max-w-[640px] text-sm tabular-nums">
              <thead className="text-left text-xs text-ink-3">
                <tr className="border-b border-rule">
                  <th className="py-1 font-normal" />
                  <th className="w-24 py-1 text-right font-normal">At event {then.cutoff_seq}</th>
                  <th className="w-24 py-1 text-right font-normal">Now</th>
                </tr>
              </thead>
              <tbody>
                {FLOW_ROWS.map(([key, label]) => {
                  const a = flow[key] as number;
                  const b = latest ? (latest[key] as number) : null;
                  return (
                    <tr key={key} className="border-b border-rule">
                      <td className="py-1.5 text-ink-2">{label}</td>
                      <td className="text-right font-semibold" data-testid={`asof-${key}`}>
                        {a}
                      </td>
                      <td
                        className={`text-right ${b !== a ? "text-petrol" : "text-ink-3"}`}
                        data-testid={`now-${key}`}
                      >
                        {b ?? ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {flow.checks.some((c) => !c.holds) ? (
              <p className="mt-2 text-sm text-exclude">
                Sums that do not add up:{" "}
                {flow.checks
                  .filter((c) => !c.holds)
                  .map((c) => c.name)
                  .join("; ")}
                .
              </p>
            ) : null}
          </section>
        );
      })}
      <section className="mt-6" aria-label="AI disclosure at the event">
        <h3 className="text-sm font-semibold text-ink-2">
          AI disclosure at event {then.cutoff_seq}
        </h3>
        {then.stages.length === 0 ? (
          <p className="mt-1 text-sm text-ink-2">
            No screening stage was open yet, so the AI had read nothing.
          </p>
        ) : (
          <table
            className="narrow mt-2 w-full max-w-[760px] text-sm tabular-nums"
            data-testid="asof-disclosure"
          >
            <thead className="text-left text-xs text-ink-3">
              <tr className="border-b border-rule">
                <th className="py-1 font-normal">Stage</th>
                <th className="py-1 font-normal">Records</th>
                <th className="py-1 font-normal">Read by the AI</th>
                <th className="py-1 font-normal">AI proposed to exclude</th>
                <th className="py-1 font-normal">AI readings shown</th>
                <th className="py-1 font-normal">Changed after one</th>
                <th className="py-1 font-normal">Extra screens</th>
              </tr>
            </thead>
            <tbody>
              {then.stages.map((s) => (
                <tr
                  key={`${s.stage}-${s.scope_id}`}
                  className="border-b border-rule"
                  data-stage={s.stage}
                >
                  <td className="py-1.5">
                    {STAGES[s.stage] ?? s.stage}, {scopeLabel(s.scope_id)}
                    <span className="block text-sm text-ink-2" title={`Mode ${s.mode}`}>
                      {modeLabel(s.mode)}
                      <span className="block">{revealLabel(s.reveal.replace(/^on_/, ""))}</span>
                    </span>
                  </td>
                  <td>{s.records}</td>
                  <td>{s.records_read_by_ai}</td>
                  <td>{s.ai_proposed_exclusions}</td>
                  <td>{s.reveals_shown}</td>
                  <td>{s.revised_after_reveal}</td>
                  <td>{s.rescreens_sent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="narrow mt-2 text-xs text-ink-3 tabular-nums">
          Disclosure record {short(then.disclosure_hash)}
          {then.disclosure_hash === now.disclosure_hash ? ", the same as now" : ", changed since"}
        </p>
      </section>
    </article>
  );
}
