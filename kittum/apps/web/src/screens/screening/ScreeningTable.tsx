// The screening table (DESIGN.md, "Reviewer workbench"): a stage as a spreadsheet. A reviewer
// sees their own records only, decided ones included, and an AI reading only where their own
// decision revealed it; the server leaves out everything else. The methods lead sees the whole
// stage. Filters, sort, and the quick search change what is on screen, never the queue order.
// A reviewer decides the selected row with the queue's keys, or opens it in the queue with Enter.
import { Popover } from "@base-ui/react/popover";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type {
  Criterion,
  Decision,
  Outcome,
  ScreeningTable,
  StageInfo,
  TableDecision,
  TableRow,
} from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import type { Caller, Workbench } from "../../data/workbench.ts";
import { Key, KeyHint } from "../../ui/Key.tsx";
import { useKeys } from "../../ui/keys.ts";
import { OUTCOMES, Status, VERDICTS } from "../../ui/Status.tsx";
import { useProject } from "../project.tsx";
import { AiReading } from "./AiReading.tsx";
import { AiBefore, AskSecondOpinion, SecondOpinionAsked } from "./Targeted.tsx";
import { numbered, shortLabel } from "./criteria.ts";
import { haystack, matcher } from "./table/fuzzy.ts";
import type { Haystack } from "./table/fuzzy.ts";
import { describe, view } from "./table/grid.ts";
import type { Column, ViewState } from "./table/grid.ts";
import { Grid } from "./table/Grid.tsx";
import { loadViews, storeViews } from "./table/views.ts";
import type { SavedViews } from "./table/views.ts";

const PAGE = 20;

const STAGE_WORDS = { title_abstract: "Title and abstract", full_text: "Full text" } as const;

const own = (row: TableRow): TableDecision | undefined => row.decisions[0];

const decisionText = (d: TableDecision | undefined, criteria: ReadonlyArray<Criterion>) => {
  if (!d || !d.outcome) return "Not decided";
  const reason = d.reason_criterion_id ? ` on ${numbered(criteria, d.reason_criterion_id)}` : "";
  const waiting = d.state === "awaiting_final" ? ", AI shown" : "";
  const asked = d.second_opinion ? ", second opinion asked" : "";
  return `${OUTCOMES[d.outcome].label}${reason}${waiting}${asked}`;
};

const people = (row: TableRow, criteria: ReadonlyArray<Criterion>) =>
  row.decisions
    .map(
      (d) =>
        `${d.name ?? "?"}${d.role === "second_opinion" ? " (second opinion)" : ""}: ${
          d.outcome ? decisionText(d, criteria) : "not decided"
        }`,
    )
    .join("; ");

const OUTCOME_WORDS = { include: "Include", exclude: "Exclude", conflict: "Conflict" } as const;

function columnsFor(
  kind: ScreeningTable["view"],
  criteria: ReadonlyArray<Criterion>,
): ReadonlyArray<Column<TableRow>> {
  const common: Column<TableRow>[] = [
    { id: "title", header: "Title", width: 440, text: (r) => r.title },
    {
      id: "authors",
      header: "Authors",
      width: 170,
      text: (r) => r.authors.join("; "),
      values: (r) => r.authors,
    },
    { id: "journal", header: "Journal", width: 150, text: (r) => r.journal ?? "" },
    {
      id: "year",
      header: "Year",
      width: 52,
      align: "right",
      text: (r) => (r.year ? String(r.year) : ""),
      sortBy: (r) => r.year ?? null,
    },
    {
      id: "publication_types",
      header: "Publication types",
      width: 170,
      text: (r) => r.publication_types.join("; "),
      values: (r) => r.publication_types,
    },
    { id: "pmid", header: "PMID", width: 80, text: (r) => r.pmid ?? "" },
    { id: "doi", header: "DOI", width: 160, text: (r) => r.doi ?? "" },
    {
      id: "registry_ids",
      header: "Registry IDs",
      width: 110,
      text: (r) => r.registry_ids.join("; "),
      values: (r) => r.registry_ids,
    },
    { id: "abstract", header: "Abstract", width: 360, text: (r) => r.abstract },
    { id: "ref", header: "Ref", width: 120, text: (r) => r.ref },
  ];
  if (kind === "reviewer") {
    return [
      {
        id: "position",
        header: "#",
        width: 48,
        align: "right",
        text: (r) => String(r.position ?? ""),
        sortBy: (r) => r.position ?? null,
      },
      ...common,
      {
        id: "decision",
        header: "Decision",
        width: 150,
        text: (r) => decisionText(own(r), criteria),
        values: (r) => [
          own(r)?.outcome ? OUTCOMES[own(r)?.outcome as Outcome].label : "Not decided",
        ],
        render: (r) => <DecisionCell decision={own(r)} criteria={criteria} />,
      },
      {
        id: "reason",
        header: "Reason",
        width: 110,
        text: (r) => numbered(criteria, own(r)?.reason_criterion_id),
      },
      { id: "comment", header: "Comment", width: 140, text: (r) => own(r)?.comment ?? "" },
      {
        id: "decided_at",
        header: "Decided at",
        width: 140,
        text: (r) => (own(r)?.decided_at ?? "").replace("T", " ").slice(0, 16),
      },
      {
        id: "ai",
        header: "AI reading",
        width: 150,
        text: (r) => {
          if (r.reveal)
            return `${VERDICTS[r.reveal.status].label} on ${numbered(criteria, r.reveal.criterion_id)}`;
          // A stage that reveals `before` (mode S) shows the reading before the decision.
          const notMet = r.ai?.criteria.filter((c) => c.status === "not_met") ?? [];
          if (!r.ai) return "";
          return notMet.length
            ? `Not met on ${notMet.map((c) => numbered(criteria, c.criterion_id)).join(", ")}`
            : "Nothing not met";
        },
      },
      {
        id: "second_opinion",
        header: "Second opinion",
        width: 130,
        text: (r) =>
          r.second_opinion
            ? `Asked of you on ${OUTCOMES[r.second_opinion.outcome].label}`
            : own(r)?.second_opinion
              ? "You asked for one"
              : "",
      },
    ];
  }
  return [
    ...common,
    {
      id: "outcome",
      header: "Outcome",
      width: 90,
      text: (r) => (r.outcome ? OUTCOME_WORDS[r.outcome] : ""),
    },
    {
      id: "outcome_reason",
      header: "Reason",
      width: 110,
      text: (r) =>
        (r.outcome_reason ?? "")
          .split(", ")
          .map((id) => numbered(criteria, id))
          .join(", "),
    },
    {
      id: "decisions",
      header: "Decisions",
      width: 260,
      text: (r) => people(r, criteria),
    },
    {
      id: "ai_excludes",
      header: "AI excludes",
      width: 80,
      text: (r) =>
        r.ai_excludes === null || r.ai_excludes === undefined ? "" : r.ai_excludes ? "Yes" : "No",
    },
    {
      id: "ai_not_met",
      header: "AI not met",
      width: 110,
      text: (r) => (r.ai_not_met ?? []).map((id) => numbered(criteria, id)).join(", "),
      values: (r) => (r.ai_not_met ?? []).map((id) => numbered(criteria, id)),
    },
    {
      id: "flags",
      header: "Flags",
      width: 90,
      text: (r) => (r.flags ?? []).join(", "),
      values: (r) => r.flags ?? [],
    },
  ];
}

const DEFAULT_COLUMNS = {
  reviewer: [
    "position",
    "title",
    "authors",
    "journal",
    "year",
    "publication_types",
    "decision",
    "ai",
  ],
  lead: ["title", "year", "outcome", "outcome_reason", "decisions", "flags"],
} as const;

const initial = (kind: "reviewer" | "lead"): ViewState => ({
  columns: [...DEFAULT_COLUMNS[kind]],
  widths: {},
  sort: [],
  filters: {},
  query: "",
});

/** A stored view, without columns this table does not have. */
const fit = (state: ViewState, columns: ReadonlyArray<Column<TableRow>>): ViewState => {
  const ids = new Set(columns.map((c) => c.id));
  return {
    ...state,
    columns: state.columns.filter((id) => ids.has(id)),
    sort: state.sort.filter((s) => ids.has(s.id)),
    filters: Object.fromEntries(Object.entries(state.filters).filter(([id]) => ids.has(id))),
  };
};

const stageKey = (s: StageInfo) => s.stage_id;

export function ScreeningTableScreen() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, criteriaFor, scopeLabel, seesLeadData, labels } = useProject();
  const stages = useMemo(
    () =>
      project.stages.filter(
        (s) => seesLeadData || s.screeners.includes(me.actor_id) || s.auditor_id === me.actor_id,
      ),
    [project.stages, seesLeadData, me.actor_id],
  );
  const [chosen, setChosen] = useState<string | null>(() =>
    stages[0] ? stageKey(stages[0]) : null,
  );
  const stage = stages.find((s) => stageKey(s) === chosen) ?? stages[0] ?? null;

  const caller = useMemo(
    () => ({ projectId: project.id, as: me.actor_id }),
    [project.id, me.actor_id],
  );
  const criteria = useMemo(
    () => (stage ? criteriaFor(stage.stage, stage.scope_id) : []),
    [criteriaFor, stage],
  );
  if (!stage) {
    return (
      <div className="mx-auto max-w-[640px] px-10 py-16">
        <h1 className="text-xl font-semibold">No records to list</h1>
        <p className="mt-2 text-md text-ink-2">
          The table lists the records of a screening stage: a reviewer's own, or every record for
          the methods lead. No stage is open for you yet.
        </p>
      </div>
    );
  }
  return (
    <StageTable
      key={stageKey(stage)}
      stage={stage}
      stages={stages}
      onStage={setChosen}
      workbench={workbench}
      caller={caller}
      criteria={criteria}
      labels={labels}
      scopeName={`${labels.scope} ${scopeLabel(stage.scope_id)}`}
      describeStage={(s) => `${scopeLabel(s.scope_id)} · ${STAGE_WORDS[s.stage]}`}
    />
  );
}

function StageTable({
  stage,
  stages,
  onStage,
  workbench,
  caller,
  criteria,
  labels,
  scopeName,
  describeStage,
}: {
  stage: StageInfo;
  stages: ReadonlyArray<StageInfo>;
  onStage: (key: string) => void;
  workbench: Workbench;
  caller: Caller;
  criteria: ReadonlyArray<Criterion>;
  labels: Record<string, string>;
  scopeName: string;
  describeStage: (s: StageInfo) => string;
}) {
  const navigate = useNavigate();
  const [table, setTable] = useState<ScreeningTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  // Mode S, key f: the next decision on this row asks a colleague, with this comment.
  const [asking, setAsking] = useState<{
    ref: string;
    comment: string;
    typing: boolean;
  } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const shown = useRef<{
    ref: string | null;
    at: string;
    firstKey: string | null;
    reveal: string | null;
  }>({ ref: null, at: "", firstKey: null, reveal: null });

  useEffect(() => {
    let live = true;
    run(workbench.screeningTable({ ...caller, scopeId: stage.scope_id, stage: stage.stage }))
      .then((t) => live && setTable(t))
      .catch(
        (e: unknown) =>
          live && setError(e instanceof WorkbenchError ? e.message : "The table could not load."),
      );
    return () => {
      live = false;
    };
  }, [workbench, caller, stage.scope_id, stage.stage]);

  const kind = table?.view ?? "reviewer";
  const loaded = table !== null;
  const columns = useMemo(
    () => (loaded ? columnsFor(kind, criteria) : []),
    [loaded, kind, criteria],
  );

  // Views are kept per reviewer and stage, in this browser.
  const [views, setViews] = useState<SavedViews>(() =>
    loadViews(caller.projectId, caller.as, stage.stage_id),
  );
  // The view the table opens with: where the reviewer left it, until they change it.
  const [edited, setState] = useState<ViewState | null>(null);
  const [lastView] = useState(() => views.last);
  const opening = useMemo(
    () => (loaded ? (lastView ? fit(lastView, columns) : initial(kind)) : null),
    [loaded, lastView, columns, kind],
  );
  const state = edited ?? opening;
  useEffect(() => {
    if (state) storeViews(caller.projectId, caller.as, stage.stage_id, { ...views, last: state });
  }, [state, views, caller.projectId, caller.as, stage.stage_id]);
  const [viewName, setViewName] = useState<string | null>(null);
  const onState = useCallback(
    (update: (s: ViewState) => ViewState) => {
      setState((s) => {
        const current = s ?? opening;
        return current ? update(current) : s;
      });
      setViewName(null);
    },
    [opening],
  );

  const query = useDeferredValue(state?.query ?? "");
  // Titles and abstracts never change under a row, so each is prepared once.
  const [hays] = useState(() => new Map<string, Haystack>());
  const hay = useCallback(
    (row: TableRow) => {
      let h = hays.get(row.ref);
      if (!h) {
        h = haystack([row.title, row.authors.join(" "), row.journal ?? ""], row.abstract);
        hays.set(row.ref, h);
      }
      return h;
    },
    [hays],
  );
  const filters = state?.filters;
  const sort = state?.sort;
  // A decision the AI's reading interrupted stays on screen until it is kept or changed, even
  // if the filters no longer match it.
  const held =
    table?.rows.find((r) => r.ref === selectedRef && own(r)?.state === "awaiting_final")?.ref ??
    null;
  const rows = useMemo(
    () =>
      table && filters && sort
        ? view(
            table.rows,
            columns,
            { columns: [], widths: {}, filters, sort, query },
            { match: matcher(query), hay, keep: (r) => r.ref === held },
          )
        : [],
    [table, columns, filters, sort, query, hay, held],
  );
  const selected = useMemo(() => {
    const index = rows.findIndex((r) => r.ref === selectedRef);
    return index >= 0 ? index : null;
  }, [rows, selectedRef]);
  const row = selected === null ? null : (rows[selected] ?? null);

  const select = useCallback(
    (index: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, index))];
      if (!next) return;
      setSelectedRef(next.ref);
      setArmed(false);
      if (shown.current.ref !== next.ref)
        shown.current = {
          ref: next.ref,
          at: new Date().toISOString(),
          firstKey: null,
          reveal: next.reveal ? new Date().toISOString() : null,
        };
    },
    [rows],
  );

  const canDecide = kind === "reviewer" && stage.stage === "title_abstract";

  const patch = (ref: string, change: (r: TableRow) => TableRow) =>
    setTable((t) => (t ? { ...t, rows: t.rows.map((r) => (r.ref === ref ? change(r) : r)) } : t));

  const decide = async (target: TableRow, outcome: Outcome, reason: string | null = null) => {
    if (!canDecide || busy || !target.assignment_id || !target.etag) return;
    const current = own(target);
    // Mode S: a decision after f asks a colleague, with what the reviewer is unsure about.
    const ask = asking?.ref === target.ref && !asking.typing ? asking : null;
    if (ask) setAsking(null);
    const decision: Decision = {
      outcome,
      reason_criterion_id: outcome === "exclude" ? reason : null,
      evidence_anchor_ids: [],
      comment: ask ? ask.comment.trim() || null : (current?.comment ?? null),
      ...(ask ? { second_opinion: true } : {}),
    };
    const now = new Date().toISOString();
    const timing = shown.current.ref === target.ref ? shown.current : null;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      let etag = target.etag;
      let phase: "provisional" | "final" =
        current?.state === "awaiting_final" ? "final" : "provisional";
      if (current?.state === "decided") {
        // A decided row: take the decision back first, as the queue does with a reopened record.
        etag = (
          await run(
            workbench.undo({ ...caller, assignmentId: target.assignment_id, expectedEtag: etag }),
          )
        ).etag;
        phase = "provisional";
        // The take-back stands even if the new decision fails: the row is pending again.
        const pending = etag;
        patch(target.ref, (r) => ({ ...r, etag: pending, decisions: [{ state: "pending" }] }));
      }
      const result = await run(
        workbench.decide({
          ...caller,
          assignmentId: target.assignment_id,
          decision,
          phase,
          expectedEtag: etag,
          timing: {
            shown_at: timing?.at ?? now,
            first_key_at: timing?.firstKey ?? now,
            decided_at: now,
            reveal_shown_at: phase === "final" ? (timing?.reveal ?? now) : null,
          },
        }),
      );
      const revealed = result.phase === "provisional" && result.reveal;
      patch(target.ref, (r) => ({
        ...r,
        etag: result.etag,
        reveal: result.reveal ?? r.reveal ?? null,
        decisions: [
          {
            state: revealed ? "awaiting_final" : "decided",
            outcome: decision.outcome,
            reason_criterion_id: decision.reason_criterion_id,
            comment: decision.comment,
            decided_at: now,
            second_opinion: decision.second_opinion ?? false,
          },
        ],
      }));
      if (revealed) {
        shown.current = { ...shown.current, reveal: new Date().toISOString() };
        setNotice("The AI reads this record differently. Keep yours with Space, or change it.");
      } else if (selected !== null && selected + 1 < rows.length) {
        select(selected + 1);
      }
    } catch (e) {
      setError(
        e instanceof WorkbenchError ? e.message : "The decision was not recorded. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const takeBack = async (target: TableRow) => {
    const current = own(target);
    if (!canDecide || busy || !target.assignment_id || !target.etag || !current) return;
    if (current.state !== "decided") {
      setNotice(
        current.state === "awaiting_final"
          ? "The AI's reading is already shown. Keep your decision with Space, or change it."
          : "This record has no decision to take back.",
      );
      return;
    }
    setBusy(true);
    try {
      const { etag } = await run(
        workbench.undo({
          ...caller,
          assignmentId: target.assignment_id,
          expectedEtag: target.etag,
        }),
      );
      patch(target.ref, (r) => ({ ...r, etag, decisions: [{ state: "pending" }] }));
      setNotice("Decision taken back. The record is in your queue again.");
    } catch (e) {
      setError(e instanceof WorkbenchError ? e.message : "The decision was not taken back.");
    } finally {
      setBusy(false);
    }
  };

  /** Enter: the record in the keyboard queue, which starts there and keeps its own order. */
  const open = (target: TableRow) => {
    if (kind !== "reviewer") {
      setNotice("The queue is for the stage's reviewers. The methods lead reads the table.");
      return;
    }
    if (own(target)?.state === "decided") {
      setNotice("You decided this record. Change the decision here with i, e, or u.");
      return;
    }
    if (stage.stage !== "title_abstract") {
      setNotice("The full-text screen opens your next full text; it cannot open this one yet.");
      return;
    }
    const before = table?.rows.find((r) => r.position === (target.position ?? 0) - 1);
    void navigate({
      to: "/p/$projectId/screening/title-abstract",
      params: { projectId: caller.projectId },
      search: {
        scope: stage.scope_id,
        ...(before?.assignment_id ? { after: before.assignment_id } : {}),
      },
    });
  };

  const [exporting, setExporting] = useState<"view" | "stage" | null>(null);
  const exportRows = async (which: "view" | "stage") => {
    if (!table || !state) return;
    setExporting(which);
    setError(null);
    try {
      const bytes = await run(
        workbench.workingExport({
          ...caller,
          scopeId: stage.scope_id,
          stage: stage.stage,
          view:
            which === "view"
              ? {
                  refs: rows.map((r) => r.ref),
                  columns: [...state.columns],
                  description: describe(
                    columns,
                    { ...state, query },
                    kind === "reviewer" ? "All rows, in queue order" : "All rows",
                  ),
                }
              : null,
        }),
      );
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `kittum-working-${stage.scope_id}-${stage.stage}${which === "view" ? "-view" : ""}.xlsx`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice(
        `Exported ${which === "view" ? `${rows.length} rows in view` : "the stage"}. The ledger records the export.`,
      );
    } catch (e) {
      setError(e instanceof WorkbenchError ? e.message : "The export failed.");
    } finally {
      setExporting(null);
    }
  };

  useKeys((event) => {
    if (!table || !state) return false;
    const key = event.key;
    // A held key repeats: it may move the selection, never decide record after record.
    if (event.repeat && !/^(Arrow|Page)/.test(key)) return true;
    if (shown.current.ref === row?.ref && !shown.current.firstKey && /^[iue1-9 ]$/.test(key))
      shown.current = { ...shown.current, firstKey: new Date().toISOString() };
    if (armed) {
      setArmed(false);
      if (/^[1-9]$/.test(key) && row) {
        const criterion = criteria[Number(key) - 1];
        if (criterion) void decide(row, "exclude", criterion.id);
        else setNotice(`There is no criterion ${key}. Press e, then 1 to ${criteria.length}.`);
        return true;
      }
      if (key === "Escape" || key === "e") return true;
    }
    switch (key) {
      case "ArrowDown":
      case "j":
        select(selected === null ? 0 : selected + 1);
        return true;
      case "ArrowUp":
      case "k":
        select(selected === null ? 0 : selected - 1);
        return true;
      case "PageDown":
        select((selected ?? 0) + PAGE);
        return true;
      case "PageUp":
        select((selected ?? 0) - PAGE);
        return true;
      case "Home":
        select(0);
        return true;
      case "End":
        select(rows.length - 1);
        return true;
      case "/":
        search.current?.focus();
        search.current?.select();
        return true;
      case "Enter":
        if (row) open(row);
        return true;
      case "Escape":
        setNotice(null);
        setAsking(null);
        return true;
    }
    if (!canDecide || !row) return false;
    switch (key) {
      case "i":
        void decide(row, "include");
        return true;
      case "u":
        void decide(row, "unclear");
        return true;
      case "e":
        setArmed(true);
        return true;
      case "f":
        if (stage.mode !== "S") return false;
        if (row.second_opinion)
          setNotice("This is a second opinion. Your decision settles the record.");
        else setAsking({ ref: row.ref, comment: asking?.comment ?? "", typing: true });
        return true;
      case " ": {
        const d = own(row);
        if (d?.state === "awaiting_final" && d.outcome)
          void decide(row, d.outcome, d.reason_criterion_id ?? null);
        else if (selected !== null) select(selected + 1);
        return true;
      }
      case "Backspace":
        void takeBack(row);
        return true;
      default:
        if (/^[1-9]$/.test(key)) {
          setNotice("To exclude, press e first, then the criterion number.");
          return true;
        }
        return false;
    }
  });

  if (error && !table) {
    return (
      <p role="alert" className="px-10 py-10 text-exclude">
        {error}
      </p>
    );
  }
  if (!table || !state) return <p className="px-10 py-10 text-ink-3">Loading the table.</p>;

  const decided = table.rows.filter((r) =>
    kind === "reviewer" ? own(r)?.state === "decided" : r.outcome,
  ).length;

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto]" data-testid="screening-table">
      <div className="flex h-9 items-center gap-3 border-b border-rule bg-paper px-3 text-xs">
        {stages.length > 1 ? (
          <select
            aria-label="Stage"
            className="h-6 rounded-[2px] border border-rule-strong bg-sheet px-1"
            value={stage.stage_id}
            onChange={(e) => onStage(e.currentTarget.value)}
          >
            {stages.map((s) => (
              <option key={s.stage_id} value={s.stage_id}>
                {describeStage(s)}
              </option>
            ))}
          </select>
        ) : (
          <span className="truncate text-ink-2">
            {scopeName} · {STAGE_WORDS[stage.stage]}
          </span>
        )}
        <label className="flex items-center gap-1.5">
          <Key k="/" />
          <input
            ref={search}
            type="search"
            placeholder="Search title, authors, journal, abstract"
            aria-label="Quick search"
            className="h-6 w-[280px] rounded-[2px] border border-rule-strong bg-sheet px-1.5 outline-none focus:border-petrol"
            value={state.query}
            onChange={(e) => {
              const q = e.currentTarget.value;
              onState((s) => ({ ...s, query: q }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" || e.key === "Enter") {
                e.currentTarget.blur();
                if (e.key === "Enter" && selected === null) select(0);
              }
            }}
          />
        </label>
        <span className="whitespace-nowrap text-ink-3" data-testid="row-count">
          {rows.length === table.rows.length
            ? `${table.rows.length} records`
            : `${rows.length} of ${table.rows.length} records`}
          {" · "}
          {kind === "reviewer" ? `${decided} decided` : `${decided} with an outcome`}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <ColumnChooser columns={columns} state={state} onState={onState} />
          <ViewMenu
            views={views}
            current={viewName}
            onLoad={(name) => {
              const saved = views.named[name];
              if (!saved) return;
              setState(fit(saved, columns));
              setViewName(name);
            }}
            onSave={(name) => {
              const next = { ...views, named: { ...views.named, [name]: state } };
              setViews(next);
              storeViews(caller.projectId, caller.as, stage.stage_id, next);
              setViewName(name);
            }}
            onDelete={(name) => {
              const named = { ...views.named };
              delete named[name];
              const next = { ...views, named };
              setViews(next);
              storeViews(caller.projectId, caller.as, stage.stage_id, next);
              setViewName(null);
            }}
            onReset={() => {
              setState(initial(kind));
              setViewName(null);
            }}
          />
          <ToolButton onClick={() => void exportRows("view")} disabled={exporting !== null}>
            {exporting === "view" ? "Exporting…" : "Export view"}
          </ToolButton>
          <ToolButton onClick={() => void exportRows("stage")} disabled={exporting !== null}>
            {exporting === "stage" ? "Exporting…" : "Export stage"}
          </ToolButton>
        </span>
      </div>
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_400px]">
        <Grid
          rows={rows}
          all={table.rows}
          columns={columns}
          state={state}
          onState={onState}
          selected={selected}
          onSelect={select}
          onOpen={(i) => {
            const target = rows[i];
            if (target) open(target);
          }}
          rowKey={(r) => r.ref}
          rowTone={(r) => (kind === "reviewer" && own(r)?.state === "decided" ? "text-ink-2" : "")}
          label={`${scopeName}, ${STAGE_WORDS[stage.stage]}`}
        />
        <aside
          className="min-h-0 overflow-y-auto border-l border-rule-strong bg-sheet"
          aria-label="Selected record"
          data-testid="row-pane"
        >
          {row ? (
            <RowPane row={row} kind={kind} criteria={criteria} labels={labels}>
              {asking?.ref === row.ref ? (
                <AskSecondOpinion
                  comment={asking.comment}
                  onComment={(comment) => setAsking({ ref: row.ref, comment, typing: true })}
                  onDone={() => setAsking((a) => a && { ...a, typing: false })}
                  onCancel={() => setAsking(null)}
                />
              ) : null}
            </RowPane>
          ) : (
            <p className="px-4 py-4 text-xs text-ink-3">
              Select a record with <Key k="ArrowUp" /> <Key k="ArrowDown" /> or the mouse to read
              its abstract.
            </p>
          )}
        </aside>
      </div>
      <footer className="border-t border-rule-strong bg-sheet-2 text-xs">
        {canDecide ? (
          <ol
            aria-label="Criteria"
            className="flex h-7 items-center gap-4 overflow-hidden border-b border-rule px-3"
          >
            {criteria.map((c, i) => (
              <li
                key={c.id}
                className={`flex items-center gap-1 whitespace-nowrap ${armed ? "text-exclude" : "text-ink-2"}`}
                title={c.text_en}
              >
                <Key k={String(i + 1)} on={armed} />
                {shortLabel(c)}
              </li>
            ))}
          </ol>
        ) : null}
        <div className="flex h-9 items-center gap-4 px-3">
          <KeyHint keys={["ArrowUp", "ArrowDown"]}>Select</KeyHint>
          {canDecide ? <KeyHint keys={["Enter"]}>Open in the queue</KeyHint> : null}
          {canDecide ? (
            <>
              <KeyHint keys={["i"]}>{OUTCOMES.include.label}</KeyHint>
              <span className="text-exclude">
                <KeyHint keys={["e"]} on={armed}>
                  {armed
                    ? `Now 1 to ${criteria.length}`
                    : `${OUTCOMES.exclude.label} on a criterion`}
                </KeyHint>
              </span>
              <KeyHint keys={["u"]}>{OUTCOMES.unclear.label}</KeyHint>
              {stage.mode === "S" ? <KeyHint keys={["f"]}>Second opinion</KeyHint> : null}
              <KeyHint keys={[" "]}>
                {row?.decisions[0]?.state === "awaiting_final" ? "Keep" : "Next"}
              </KeyHint>
              <KeyHint keys={["Backspace"]}>Take back</KeyHint>
            </>
          ) : null}
          <span className="ml-auto min-w-0 truncate" aria-live="polite">
            {error ? (
              <span role="alert" className="text-exclude">
                {error}
              </span>
            ) : notice ? (
              <span className="text-ink-2">{notice}</span>
            ) : null}
          </span>
        </div>
      </footer>
    </div>
  );
}

function DecisionCell({
  decision,
  criteria,
}: {
  decision: TableDecision | undefined;
  criteria: ReadonlyArray<Criterion>;
}) {
  if (!decision?.outcome) return <span className="text-ink-3">Not decided</span>;
  const term = OUTCOMES[decision.outcome];
  const index = criteria.findIndex((c) => c.id === decision.reason_criterion_id);
  return (
    <Status term={term}>
      {term.label}
      {index >= 0 ? ` ${index + 1}` : ""}
      {decision.state === "awaiting_final" ? ", AI shown" : ""}
    </Status>
  );
}

function RowPane({
  row,
  kind,
  criteria,
  labels,
  children,
}: {
  row: TableRow;
  kind: "reviewer" | "lead";
  criteria: ReadonlyArray<Criterion>;
  labels: Record<string, string>;
  /** The second-opinion prompt, while the reviewer writes it. */
  children?: ReactNode;
}) {
  const authors =
    row.authors.length > 3
      ? `${row.authors.slice(0, 3).join(", ")} et al.`
      : row.authors.join(", ");
  const meta = [authors, row.journal, row.year, row.pmid ? `PMID ${row.pmid}` : row.doi]
    .filter(Boolean)
    .join(" · ");
  const d = own(row);
  const revealIndex = row.reveal
    ? criteria.findIndex((c) => c.id === row.reveal?.criterion_id)
    : -1;
  const revealed = row.reveal ? criteria[revealIndex] : undefined;
  return (
    <article className="px-4 pt-3 pb-6" data-testid="row-detail">
      <h2 className="text-sm font-semibold text-balance">{row.title}</h2>
      <p className="mt-1 truncate text-2xs text-ink-3" title={meta}>
        {meta}
      </p>
      {kind === "reviewer" ? (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-ink-3">Your decision</span>
          <DecisionCell decision={d} criteria={criteria} />
        </div>
      ) : (
        <ul className="mt-2 grid gap-0.5 text-xs">
          {row.decisions.map((x) => (
            <li key={`${x.reviewer_id}`} className="flex gap-2">
              <span className="w-28 truncate text-ink-3">
                {x.name}{" "}
                {x.role === "auditor"
                  ? "(auditor)"
                  : x.role === "second_opinion"
                    ? "(second opinion)"
                    : ""}
              </span>
              <DecisionCell decision={x} criteria={criteria} />
              {x.comment ? <span className="truncate text-ink-2">{x.comment}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {row.second_opinion || children || (row.ai && !row.reveal) ? (
        <div className="mt-3 -mx-4 border-t border-rule">
          {row.second_opinion ? (
            <SecondOpinionAsked asked={row.second_opinion} criteria={criteria} labels={labels} />
          ) : null}
          {children}
          {row.ai && !row.reveal ? (
            <AiBefore ai={row.ai} criteria={criteria} labels={labels} marked={null} />
          ) : null}
        </div>
      ) : null}
      {row.reveal ? (
        <section
          className="evidence-item mt-3 border-y border-rule px-2 py-2"
          aria-label="AI judge"
        >
          <AiReading
            compact
            criterion={{
              number: revealed ? revealIndex + 1 : null,
              label: revealed ? shortLabel(revealed) : row.reveal.criterion_id,
              text: revealed?.text_en ?? null,
            }}
            status={row.reveal.status}
            downgradedFrom={row.reveal.downgraded_from}
            rationale={row.reveal.rationale}
            quote={row.reveal.quote || null}
            verified={row.reveal.quote_verified ?? false}
            markedAt={null}
            marked={false}
          />
        </section>
      ) : null}
      <p className="mt-3 text-xs leading-[19px] whitespace-pre-line text-ink">
        {row.abstract || <span className="text-ink-3">This record has no abstract.</span>}
      </p>
    </article>
  );
}

function ToolButton({
  onClick,
  disabled,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="h-6 flex-none rounded-[2px] border border-rule-strong bg-sheet px-2 whitespace-nowrap hover:bg-sheet-2 disabled:text-ink-3"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

const POPUP =
  "rounded-[3px] border border-rule-strong bg-sheet text-xs shadow-[0_8px_24px_rgb(0_0_0/0.16)] outline-none";

function ColumnChooser({
  columns,
  state,
  onState,
}: {
  columns: ReadonlyArray<Column<TableRow>>;
  state: ViewState;
  onState: (update: (s: ViewState) => ViewState) => void;
}) {
  const shown = new Set(state.columns);
  return (
    <Popover.Root>
      <Popover.Trigger className="h-6 flex-none rounded-[2px] border border-rule-strong bg-sheet px-2 hover:bg-sheet-2">
        Columns
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={2} align="end" className="z-30">
          <Popover.Popup className={`${POPUP} w-[220px] py-1`} data-testid="column-chooser">
            {columns.map((c) => (
              <label
                key={c.id}
                className="flex h-[22px] items-center gap-1.5 px-2 hover:bg-sheet-2"
              >
                <input
                  type="checkbox"
                  checked={shown.has(c.id)}
                  onChange={() =>
                    onState((s) => {
                      if (s.columns.includes(c.id)) {
                        if (s.columns.length === 1) return s;
                        return { ...s, columns: s.columns.filter((id) => id !== c.id) };
                      }
                      // Back in the place it has among all columns.
                      const order = columns.map((x) => x.id);
                      const next = [...s.columns, c.id].sort(
                        (a, b) => order.indexOf(a) - order.indexOf(b),
                      );
                      return { ...s, columns: next };
                    })
                  }
                />
                {c.header}
              </label>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ViewMenu({
  views,
  current,
  onLoad,
  onSave,
  onDelete,
  onReset,
}: {
  views: SavedViews;
  current: string | null;
  onLoad: (name: string) => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const names = Object.keys(views.named).sort((a, b) => a.localeCompare(b));
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="h-6 max-w-[180px] flex-none truncate rounded-[2px] border border-rule-strong bg-sheet px-2 hover:bg-sheet-2">
        {current ? `View: ${current}` : "Views"}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={2} align="end" className="z-30">
          <Popover.Popup className={`${POPUP} w-[260px] py-1`} data-testid="view-menu">
            {names.length === 0 ? (
              <p className="px-2 py-1 text-ink-3">No saved views yet.</p>
            ) : (
              <ul>
                {names.map((n) => (
                  <li key={n} className="flex h-[24px] items-center hover:bg-sheet-2">
                    <button
                      type="button"
                      className={`min-w-0 flex-1 truncate px-2 text-left ${n === current ? "font-semibold text-petrol" : ""}`}
                      onClick={() => {
                        onLoad(n);
                        setOpen(false);
                      }}
                    >
                      {n}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete the view ${n}`}
                      className="px-2 text-ink-3 hover:text-exclude"
                      onClick={() => onDelete(n)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="mt-1 flex gap-1 border-t border-rule px-2 pt-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = name.trim();
                if (!trimmed) return;
                onSave(trimmed);
                setName("");
                setOpen(false);
              }}
            >
              <input
                className="h-6 min-w-0 flex-1 rounded-[2px] border border-rule-strong bg-sheet px-1.5 outline-none focus:border-petrol"
                placeholder="Name this view"
                aria-label="View name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
              />
              <button type="submit" className="px-1.5 text-petrol hover:underline">
                Save
              </button>
            </form>
            <button
              type="button"
              className="mt-1 w-full px-2 py-1 text-left text-ink-2 hover:bg-sheet-2"
              onClick={() => {
                onReset();
                setOpen(false);
              }}
            >
              Reset to the default view
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
