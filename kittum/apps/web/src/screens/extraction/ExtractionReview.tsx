// Extraction review (DESIGN.md, "Extraction"): one run's fields grouped by endpoint, arm, and
// timepoint beside the report. The selected field and its source region share the marker, and
// Enter accepts only once that region has been on screen. An edit needs a span: the reviewer
// selects the value on the page, confirms the number Kittum read from it, and accepts.
import { Link, useRouteContext } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Acceptance, ExtractionReview, Proposal, ReviewField } from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { formatDateTime } from "../../lib/format.ts";
import { keyWords } from "../../lib/labels.ts";
import { Help } from "../../ui/Help.tsx";
import { Button } from "../../ui/Button.tsx";
import { useKeys } from "../../ui/keys.ts";
import { ACCEPTED, Mark, PROPOSAL_STATUS, Status } from "../../ui/Status.tsx";
import { studyName, useStudyNames } from "../appraisal/studyNames.ts";
import { PdfViewer } from "../pdf/PdfViewer.tsx";
import type { PageHighlight, TextSelection } from "../pdf/PdfViewer.tsx";
import { useProject } from "../project.tsx";
import { ValueHistory } from "./History.tsx";
import {
  AcceptedBar,
  Backing,
  estimateFacts,
  journalOf,
  PolicyTag,
  studyFromText,
  quantityLabel,
  ToVerify,
  unitBeside,
  unitGap,
} from "./marks.tsx";
import type { EstimateFacts, Path } from "./marks.tsx";

/** How long the source must be on screen before Enter accepts; the server checks it too. */
export const VIEW_MS = 400;

interface FieldState {
  readonly picked: Path | null;
  readonly accepted: Path | null;
  /** The accepted value, when it is the reviewer's own. */
  readonly value: string | null;
  readonly edited: TextSelection | null;
  /** The acceptance as the server recorded it: who, when, from which path, how long they looked. */
  readonly acceptance: Acceptance | null;
}

/** An edit in progress: the selection and the value the reviewer confirms from it. */
interface Editing {
  readonly selection: TextSelection;
  readonly value: string;
}

const agreement = (field: ReviewField) =>
  field.agreement === "disagree" && field.proposals.length > 1
    ? ("differ" as const)
    : field.agreement === "agree"
      ? ("agree" as const)
      : ("single" as const);

/** The first number in a selection, as the value an edit proposes. */
const firstNumber = (text: string) => /[-−–]?\d+(?:[.,·]\d+)*/u.exec(text)?.[0] ?? text.trim();

const failedChecks = (p: Proposal | undefined) =>
  (p?.validators ?? []).filter((v) => !v.passed).map((v) => v.message ?? v.validator);

export function ExtractionScreen({ review }: { review: ExtractionReview }) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const studyNames = useStudyNames();
  const anchors = useMemo(() => new Map(review.anchors.map((a) => [a.id, a])), [review.anchors]);
  const [selected, setSelected] = useState(0);
  // All fields in the schema's order, or only those still to verify.
  const [filter, setFilter] = useState<"all" | "open">("all");
  const [fields, setFields] = useState<Record<string, FieldState>>(() =>
    Object.fromEntries(
      review.fields.map((f) => [
        f.id,
        {
          picked: null,
          accepted: f.accepted,
          value: f.acceptance?.edited ? f.acceptance.value : null,
          edited: null,
          acceptance: f.acceptance,
        },
      ]),
    ),
  );
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // On-screen time per source identity (field, path, and anchor or edited span), so time spent on
  // one source never counts for another.
  const viewed = useRef(new Map<string, number>());
  const visible = useRef<{ key: string; since: number } | null>(null);
  // On-screen time of each row that may be accepted as a group: only rows the reviewer has had
  // in view for the floor go into a group, with the time they were seen.
  const rowsSeen = useRef(new Map<string, { ms: number; since: number | null }>());
  const list = useRef<HTMLDivElement>(null);
  const [nudge, setNudge] = useState(0);
  const rows = useRef(new Map<string, HTMLElement>());

  const field = review.fields[selected];
  const state = field ? fields[field.id] : undefined;
  const status = field ? agreement(field) : "single";
  const proposal = (f: ReviewField, s: FieldState | undefined): Proposal | undefined => {
    const chosen = s?.accepted ?? s?.picked;
    return (
      f.proposals.find((p) => p.path === chosen) ??
      f.proposals.find((p) => p.anchor_ids.length > 0) ??
      f.proposals[0]
    );
  };
  const shown = field ? proposal(field, state) : undefined;
  const source = shown?.anchor_ids.map((id) => anchors.get(id)).find(Boolean);
  const other =
    field && status === "differ"
      ? field.proposals
          .find((p) => p !== shown)
          ?.anchor_ids.map((id) => anchors.get(id))
          .find(Boolean)
      : undefined;

  const edited = editing?.selection ?? state?.edited ?? null;
  const sourceBoxes = edited?.boxes ?? source?.boxes;
  const highlights = useMemo((): PageHighlight[] => {
    const out: PageHighlight[] = [];
    if (other && other.id !== source?.id) {
      out.push({
        id: `other-${other.id}`,
        boxes: other.boxes,
        kind: "adopted",
        label: "The other path's source",
      });
    }
    if (sourceBoxes)
      out.push({ id: `source-${field?.id}`, boxes: sourceBoxes, kind: "current", label: "Source" });
    return out;
  }, [other, source?.id, sourceBoxes, field?.id]);
  const firstBox = sourceBoxes?.[0];
  // A table cell is checked against its row and column headers: the jump lands higher on the
  // page, so the table's top (its caption and header rows) stays in view above the cell.
  const tableTop = useMemo(() => {
    const cell = edited ? undefined : source?.cells?.[0];
    const page = firstBox?.page;
    const size = page ? review.layer.pages[page - 1] : undefined;
    if (!cell || !firstBox || !size) return null;
    const tops = review.anchors
      .filter((a) => a.cells?.some((c) => c.table_id === cell.table_id))
      .flatMap((a) => a.boxes)
      .filter((b) => b.page === page)
      .map((b) => b.y0);
    const top = Math.min(firstBox.y0, ...tops) - size.height * 0.09;
    return Math.max(0, top, firstBox.y0 - size.height * 0.4);
  }, [edited, source, firstBox, review.anchors, review.layer.pages]);
  const target =
    field && firstBox
      ? {
          key: `${field.id}-${shown?.path}-${nudge}`,
          box: tableTop === null ? firstBox : { ...firstBox, y0: tableTop },
        }
      : null;

  const sourceKey = field
    ? `${field.id}|${shown?.path}|${edited ? `edit:${edited.start}-${edited.end}` : (source?.id ?? "none")}`
    : "";

  // Record how long the selected source is on screen. A new identity gets a new callback, so the
  // viewer re-observes and reports afresh; reports for an old identity are ignored. The time runs
  // only while the page is visible. On its return it waits for the viewer's fresh report (the
  // viewer forgets what it saw while the page was hidden), never resuming on what it last said.
  const onCurrentVisible = useCallback(
    (isVisible: boolean) => {
      const now = performance.now();
      const open = visible.current;
      if (isVisible) {
        if (open?.key !== sourceKey && !document.hidden)
          visible.current = { key: sourceKey, since: now };
      } else if (open?.key === sourceKey) {
        viewed.current.set(sourceKey, (viewed.current.get(sourceKey) ?? 0) + now - open.since);
        visible.current = null;
      }
    },
    [sourceKey],
  );
  useEffect(() => {
    const onVisibility = () => {
      const open = visible.current;
      if (!document.hidden || !open) return;
      viewed.current.set(
        open.key,
        (viewed.current.get(open.key) ?? 0) + performance.now() - open.since,
      );
      visible.current = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  // A new selection brings its row and the history under it into view, the row first if both do
  // not fit. The first field is in view on arrival, so nothing scrolls then: the reviewer's own
  // scrolling is never undone by the screen settling.
  const scrolledFor = useRef(field?.id);
  useEffect(() => {
    if (scrolledFor.current === field?.id) return;
    scrolledFor.current = field?.id;
    const row = rows.current.get(field?.id ?? "");
    row?.parentElement?.scrollIntoView({ block: "nearest" });
    row?.scrollIntoView({ block: "nearest" });
  }, [field?.id]);
  const viewedMs = () =>
    (viewed.current.get(sourceKey) ?? 0) +
    (visible.current?.key === sourceKey ? performance.now() - visible.current.since : 0);

  /** The fields the list shows: with the filter on, the open ones and the one in hand. */
  const listed = (at: number) =>
    review.fields
      .map((_, i) => i)
      .filter((i) => filter === "all" || i === at || !fields[review.fields[i]!.id]?.accepted);
  const move = (step: number) => {
    setSelected((s) => {
      const order = listed(s);
      const here = order.indexOf(s);
      return order[Math.max(0, Math.min(order.length - 1, here + step))] ?? s;
    });
    setEditing(null);
    setNotice(null);
  };
  /** The next value still to verify after the selected one, round to the start. */
  const nextOpen = () => {
    const n = review.fields.length;
    for (let step = 1; step <= n; step++) {
      const i = (selected + step) % n;
      if (!fields[review.fields[i]!.id]?.accepted) {
        setSelected(i);
        setEditing(null);
        setNotice(null);
        return;
      }
    }
  };
  const showOpen = (on: boolean) => {
    setFilter(on ? "open" : "all");
    if (on && fields[review.fields[selected]?.id ?? ""]?.accepted) {
      const next = review.fields.findIndex((f) => !fields[f.id]?.accepted);
      if (next >= 0) setSelected(next);
    }
    setEditing(null);
  };

  const accept = async ({ override = false }: { override?: boolean } = {}) => {
    if (!field || !shown || busy) return;
    if (state?.accepted) {
      setNotice("This value is accepted already.");
      return;
    }
    if (status === "differ" && !state?.picked && !editing) {
      setNotice("The paths disagree. Pick one with 1 or 2 after checking both sources.");
      return;
    }
    if (!sourceBoxes) {
      setNotice(
        "This value has no source on the page. Select the value on the page and press e to edit it with its span.",
      );
      return;
    }
    const failed = editing ? [] : failedChecks(shown);
    if (failed.length && !override) {
      setNotice(
        `A check failed. ${failed.join(" ")} Compare the value with the source. Press o to accept it anyway, or edit it.`,
      );
      return;
    }
    const ms = viewedMs();
    if (ms < VIEW_MS) {
      setNotice("Look at the highlighted source before accepting.");
      setNudge((n) => n + 1);
      return;
    }
    setBusy(true);
    try {
      const acceptance = await run(
        workbench.accept({
          projectId: project.id,
          as: me.actor_id,
          fieldId: field.id,
          path: shown.path,
          edit: editing
            ? {
                value: editing.value.trim(),
                start: editing.selection.start,
                end: editing.selection.end,
                quote: editing.selection.quote,
                boxes: editing.selection.boxes,
              }
            : null,
          sourceViewedMs: Math.round(ms),
          override,
        }),
      );
      setFields((all) => ({
        ...all,
        [field.id]: {
          ...all[field.id]!,
          accepted: acceptance.path,
          value: acceptance.edited ? acceptance.value : null,
          edited: editing?.selection ?? null,
          acceptance,
        },
      }));
      setEditing(null);
      setNotice(null);
      move(1);
    } catch (e) {
      setNotice(
        e instanceof WorkbenchError ? e.message : "Kittum did not accept the value. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  // Agreeing, validated standard fields may be accepted together, each once it was on screen.
  const groupable = review.fields.filter(
    (f) => f.gate === "group_accept" && !fields[f.id]?.accepted,
  );
  const groupKey = groupable.map((f) => f.id).join(",");
  useEffect(() => {
    const root = list.current;
    if (!root || !groupKey) return;
    const seen = rowsSeen.current;
    // A row's time runs only while the page is visible and a fresh report says it is wholly in
    // the list's view. On the page's return every row waits for a report computed after it: a
    // report from before (the rows may have scrolled away meanwhile) starts nothing.
    let shownSince = document.hidden ? Infinity : 0;
    const start = (id: string, now: number) => {
      const row = seen.get(id) ?? { ms: 0, since: null };
      if (row.since === null) seen.set(id, { ...row, since: now });
    };
    const stop = (id: string, now: number) => {
      const row = seen.get(id);
      if (row && row.since !== null) seen.set(id, { ms: row.ms + now - row.since, since: null });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const now = performance.now();
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset["fieldId"] ?? "";
          const whole = entry.isIntersecting && entry.intersectionRatio >= 0.99;
          if (!whole) stop(id, now);
          else if (!document.hidden && entry.time >= shownSince) start(id, now);
        }
      },
      { root, threshold: [0, 0.99, 1] },
    );
    const tracked = () =>
      groupKey
        .split(",")
        .map((id) => rows.current.get(id))
        .filter((el): el is HTMLElement => el !== undefined);
    const onVisibility = () => {
      const now = performance.now();
      if (document.hidden) {
        shownSince = Infinity;
        for (const id of groupKey.split(",")) stop(id, now);
        return;
      }
      // Observing afresh makes the observer report each row as it is now.
      shownSince = now;
      for (const el of tracked()) {
        observer.unobserve(el);
        observer.observe(el);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    for (const id of groupKey.split(",")) {
      const el = rows.current.get(id);
      if (el) observer.observe(el);
    }
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [groupKey]);
  const rowViewedMs = (id: string) => {
    const row = rowsSeen.current.get(id);
    if (!row) return 0;
    return row.ms + (row.since !== null ? performance.now() - row.since : 0);
  };
  const acceptGroup = async () => {
    if (!groupable.length || busy) return;
    const seen = groupable.filter((f) => rowViewedMs(f.id) >= VIEW_MS);
    if (!seen.length) {
      setNotice(
        "None of the standard values where both paths agree has been on screen long enough. Scroll to them and read them first.",
      );
      return;
    }
    const ms = Math.round(Math.min(...seen.map((f) => rowViewedMs(f.id))));
    const unseen = groupable.length - seen.length;
    setBusy(true);
    try {
      const accepted = await run(
        workbench.groupAccept({
          projectId: project.id,
          as: me.actor_id,
          runId: review.run.id,
          fieldIds: seen.map((f) => f.id),
          listViewedMs: ms,
        }),
      );
      setFields((all) => {
        const next = { ...all };
        for (const a of accepted)
          next[a.field_id] = { ...next[a.field_id]!, accepted: a.path, acceptance: a };
        return next;
      });
      setNotice(
        `Accepted ${accepted.length} standard ${accepted.length === 1 ? "value" : "values"} where both paths agree, as a group. A random tenth of them go to a re-check.${
          unseen ? ` ${unseen} more ${unseen === 1 ? "has" : "have"} not been on screen yet.` : ""
        }`,
      );
    } catch (e) {
      setNotice(e instanceof WorkbenchError ? e.message : "Kittum did not accept the group.");
    } finally {
      setBusy(false);
    }
  };

  const pick = (path: Path | null) => {
    if (!field) return;
    setFields((all) => ({ ...all, [field.id]: { ...all[field.id]!, picked: path } }));
    setNotice(null);
  };
  const startEdit = () => {
    if (state?.accepted) {
      setNotice("This value is accepted already.");
      return;
    }
    if (!selection) {
      setNotice("Select the value on the page first. An edit needs a source span.");
      return;
    }
    setEditing({ selection, value: firstNumber(selection.quote) });
    setNotice(`Edited to “${firstNumber(selection.quote)}”. Press Enter to accept.`);
  };
  // The batch names its fields before it applies: a first a (or the button) lists them, a second
  // accepts them.
  // While the list is open: the fields not on screen long enough yet, as of opening it.
  const [confirming, setConfirming] = useState<ReadonlySet<string> | null>(null);
  const openConfirm = () =>
    setConfirming(new Set(groupable.filter((f) => rowViewedMs(f.id) < VIEW_MS).map((f) => f.id)));
  const confirmGroup = () => {
    setConfirming(null);
    void acceptGroup();
  };

  useKeys((event) => {
    if (!field) return false;
    const key = event.key;
    if (confirming) {
      if (key === "a" || key === "Enter") {
        confirmGroup();
        return true;
      }
      setConfirming(null);
      if (key === "Escape") return true;
    }
    if (key === "Tab") {
      move(event.shiftKey ? -1 : 1);
      return true;
    }
    if (key === "ArrowDown" || key === "j") {
      move(1);
      return true;
    }
    if (key === "ArrowUp" || key === "k") {
      move(-1);
      return true;
    }
    if (key === "Enter") {
      void accept();
      return true;
    }
    if (key === "o") {
      void accept({ override: true });
      return true;
    }
    if (key === "a") {
      if (groupable.length) openConfirm();
      else setNotice("No standard value where both paths agree is open in this run.");
      return true;
    }
    if ((key === "1" || key === "2") && status === "differ") {
      pick(field.proposals[Number(key) - 1]?.path ?? null);
      return true;
    }
    if (key === "e") {
      startEdit();
      return true;
    }
    return false;
  });

  const shownIds = new Set(listed(selected).map((i) => review.fields[i]!.id));
  const groups: Array<{ endpoint: string; set: string; fields: ReviewField[] }> = [];
  for (const f of review.fields) {
    if (!shownIds.has(f.id)) continue;
    let group = groups.find(
      (g) => g.endpoint === f.labels.endpoint && g.set === f.key.analysis_set,
    );
    if (!group)
      groups.push((group = { endpoint: f.labels.endpoint, set: f.key.analysis_set, fields: [] }));
    group.fields.push(f);
  }

  const done = review.fields.filter((f) => fields[f.id]?.accepted).length;
  const open = review.fields.length - done;
  const names = new Map(project.members.map((m) => [m.actor_id, m.display_name]));
  const paths = review.run.model_identity
    ? `Janus and the LLM path (${review.run.model_identity})`
    : "the Janus path only";
  const dataCut = field?.key.data_cut ?? review.fields[0]?.key.data_cut;
  const valueNow = (f: ReviewField) => {
    const s = fields[f.id];
    const p = proposal(f, s);
    return s?.value ?? (p?.status === "extracted" ? p.value : null);
  };
  const failedNow = failedChecks(shown).length > 0;
  const study = studyFromText(
    studyNames.get(review.report.id),
    review.layer.text,
    review.report.citation,
    studyName(studyNames, review.report.id, review.report.title),
  );
  const ids = [review.report.study_label, review.report.citation].filter(Boolean).join(" · ");
  // The batch names its fields by endpoint: "Cigarettes per day: 2 values".
  const batchNames = [...new Set(groupable.map((f) => f.labels.endpoint))]
    .map((endpoint) => {
      const n = groupable.filter((f) => f.labels.endpoint === endpoint).length;
      return `${endpoint}: ${n} ${n === 1 ? "value" : "values"}`;
    })
    .join("\n");
  const groupLabel = (f: ReviewField) =>
    `${f.labels.endpoint}, ${f.labels.arm} · ${f.labels.timepoint.toLowerCase()}: ${quantityLabel(f)}`;

  return (
    <div className="grid h-full grid-cols-[minmax(760px,50%)_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col bg-paper" aria-label="Extracted fields">
        <header className="px-6 pt-3 pb-3">
          <Link
            to="/p/$projectId/extraction"
            params={{ projectId: project.id }}
            className="inline-flex items-center gap-1 text-sm text-petrol hover:underline"
          >
            <span aria-hidden="true">←</span>
            All runs
          </Link>
          <h1
            className="mt-1.5 truncate text-lg leading-snug font-semibold"
            title={[review.report.title, ids].filter(Boolean).join("\n")}
          >
            {study}
          </h1>
          {study !== review.report.title ? (
            <p className="line-clamp-2 text-sm text-ink-2" title={ids}>
              {review.report.title}
            </p>
          ) : null}
          <p className="mt-1 text-sm text-ink-2">
            Read by {paths}
            {review.run.completed_at ? ` on ${formatDateTime(review.run.completed_at)}` : ""}.
            {dataCut ? ` Data cut: ${keyWords(dataCut).toLowerCase()}.` : ""}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <AcceptedBar accepted={done} total={review.fields.length} />
            <span
              className="text-sm font-medium whitespace-nowrap tabular-nums"
              data-testid="accepted-count"
            >
              {done} of {review.fields.length} accepted
            </span>
            {open > 0 ? (
              <>
                <ToVerify>{`${open} to verify`}</ToVerify>
                <Button size="sm" kind="quiet" onClick={nextOpen}>
                  Next to verify
                </Button>
              </>
            ) : (
              <span className="text-sm">
                <Status term={ACCEPTED}>Every value accepted</Status>
              </span>
            )}
            <span
              className="ml-auto inline-flex overflow-hidden rounded-[4px] border border-rule-strong text-sm"
              role="group"
              aria-label="Show"
            >
              {(
                [
                  ["all", `All fields (${review.fields.length})`],
                  ["open", `To verify (${open})`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => showOpen(value === "open")}
                  className={`h-7 px-2.5 ${filter === value ? "bg-petrol-wash font-medium text-petrol" : "bg-sheet text-ink-2 hover:bg-sheet-2"}`}
                >
                  {label}
                </button>
              ))}
            </span>
            <span className="relative">
              <Button
                size="sm"
                keys={["a"]}
                disabled={!groupable.length || busy}
                aria-expanded={confirming !== null}
                title={batchNames}
                onClick={() => (confirming ? setConfirming(null) : openConfirm())}
              >
                {groupable.length
                  ? groupable.length === 1
                    ? "Accept the standard value where both paths agree"
                    : `Accept the ${groupable.length} standard values where both paths agree`
                  : "No standard values where both paths agree"}
              </Button>
              {confirming ? (
                <div
                  className="absolute top-full right-0 z-30 mt-1.5 w-[36rem] rounded-[4px] border border-rule-strong bg-sheet p-4 shadow-[0_8px_24px_rgb(0_0_0/0.12)]"
                  data-testid="group-confirm"
                >
                  <p className="text-sm font-semibold">
                    <Help text="Both paths read the same value, every check passed, and the value is standard, not critical. Only values that were on screen long enough go in. The checks test the numbers, not their clinical meaning.">
                      Accept these {groupable.length} values together?
                    </Help>
                  </p>
                  <ul className="mt-2.5 space-y-1 text-sm">
                    {groupable.map((f) => {
                      const v = valueNow(f);
                      const seen = !confirming.has(f.id);
                      return (
                        <li key={f.id} className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate" title={groupLabel(f)}>
                            {groupLabel(f)}
                          </span>
                          <span className="font-semibold tabular-nums">
                            {v ?? "–"}
                            {v && f.spec.unit ? ` ${f.spec.unit}` : ""}
                          </span>
                          {seen ? null : (
                            <span className="text-xs text-ink-2">not on screen yet</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <div className="mt-3 flex items-center gap-2">
                    <Button kind="primary" size="sm" keys={["a"]} onClick={confirmGroup}>
                      Accept {groupable.length === 1 ? "it" : `the ${groupable.length} values`}
                    </Button>
                    <Button
                      kind="quiet"
                      size="sm"
                      keys={["Esc"]}
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </span>
          </div>
        </header>
        {/* The working surface: the values, raised off the page. */}
        {/* The sheet ends at its last row; it scrolls only when the rows outgrow the screen. */}
        <div className="mx-4 flex min-h-0 flex-col overflow-hidden rounded-[6px] bg-raised shadow-raised">
          <div ref={list} className="min-h-0 overflow-y-auto" data-testid="fields">
            <div
              className={`sticky top-0 z-10 grid h-8 ${COLUMNS} items-center gap-3 border-b border-rule bg-raised px-6 text-xs font-semibold text-ink-2`}
            >
              <span>Arm · timepoint</span>
              <span>Quantity</span>
              <span className="text-right">Value</span>
              <span>Paths</span>
              <span>Review</span>
            </div>
            {groups.map((group) => (
              <section key={`${group.endpoint}-${group.set}`} className="pb-1">
                <h2 className="sticky top-8 z-[5] flex items-baseline gap-2 bg-raised px-6 pt-3 pb-1 text-md font-semibold">
                  {group.endpoint}
                  <span
                    className="rounded-full bg-sheet-2 px-2 text-xs font-normal text-ink-2"
                    title={group.set}
                  >
                    {keyWords(group.set)}
                  </span>
                </h2>
                {group.fields.map((f) => {
                  const isSelected = f.id === field?.id;
                  const s = fields[f.id];
                  return (
                    <div key={f.id} className="scroll-mt-[72px]">
                      <FieldRow
                        field={f}
                        state={s}
                        editing={isSelected ? editing : null}
                        shown={proposal(f, s)}
                        facts={estimateFacts({
                          field: f,
                          fields: review.fields,
                          anchors,
                          valueOf: valueNow,
                          text: review.layer.text,
                          acceptanceAnchor: s?.acceptance?.anchor_id,
                          extraQuotes: s?.edited ? [s.edited.quote] : [],
                        })}
                        selected={isSelected}
                        onSelect={() => {
                          setSelected(review.fields.indexOf(f));
                          setEditing(null);
                        }}
                        rowRef={(el) => {
                          if (el) rows.current.set(f.id, el);
                          else rows.current.delete(f.id);
                        }}
                      />
                      {isSelected ? (
                        <ValueHistory
                          field={f}
                          fields={review.fields}
                          acceptance={s?.acceptance ?? null}
                          accepted={s?.accepted ?? null}
                          ownValue={s?.acceptance ? null : (s?.value ?? null)}
                          edited={
                            s?.edited
                              ? { quote: s.edited.quote, page: s.edited.boxes[0]?.page ?? null }
                              : null
                          }
                          shown={shown}
                          anchors={anchors}
                          names={names}
                          run={review.run}
                          text={review.layer.text}
                          onPick={status === "differ" && !s?.accepted ? pick : null}
                          actions={
                            s?.accepted ? null : (
                              <>
                                <Button
                                  kind="primary"
                                  size="sm"
                                  keys={["Enter"]}
                                  disabled={busy}
                                  onClick={() => void accept()}
                                >
                                  {editing ? `Accept ${editing.value.trim()}` : "Accept"}
                                </Button>
                                <Button
                                  size="sm"
                                  keys={["e"]}
                                  disabled={!selection}
                                  title={
                                    selection
                                      ? undefined
                                      : "Select the value on the page first. An edit needs a source span."
                                  }
                                  onClick={startEdit}
                                >
                                  Edit from selection
                                </Button>
                                {failedNow ? (
                                  <Button
                                    kind="danger"
                                    size="sm"
                                    keys={["o"]}
                                    onClick={() => void accept({ override: true })}
                                  >
                                    Accept despite the failed check
                                  </Button>
                                ) : null}
                                {status === "differ" && !s?.picked ? (
                                  <span className="text-sm text-ink-2">
                                    The paths disagree: take one value above first.
                                  </span>
                                ) : null}
                              </>
                            )
                          }
                        />
                      ) : null}
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        </div>
        {/* Notices only: every action has its button, the keys are in the Keys sheet. */}
        <footer className="px-6 py-2 text-sm">
          {editing ? (
            <label className="mb-2 flex items-center gap-3">
              <span className="text-sm font-semibold text-ink-2">Value from your selection</span>
              <input
                autoFocus
                aria-label="Edited value"
                value={editing.value}
                onChange={(e) => setEditing({ ...editing, value: e.currentTarget.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void accept();
                  } else if (e.key === "Escape") {
                    setEditing(null);
                    setNotice("Edit dropped.");
                  }
                }}
                className="w-32 rounded-[3px] border border-petrol bg-sheet px-2 py-0.5 text-sm outline-none"
              />
              <span className="min-w-0 truncate text-sm text-ink-2" title={editing.selection.quote}>
                from “{editing.selection.quote.trim()}”
              </span>
            </label>
          ) : null}
          <p
            className="min-h-5 text-sm text-ink"
            aria-live="polite"
            data-testid="extraction-notice"
          >
            {notice ?? ""}
          </p>
        </footer>
      </section>
      <PdfViewer
        workbench={workbench}
        layer={review.layer}
        highlights={highlights}
        target={target}
        onSelection={setSelection}
        onCurrentVisible={onCurrentVisible}
        label={[study, journalOf(review.report.citation)].filter(Boolean).join(" · ")}
        targetLabel="Show this value on the page"
      />
    </div>
  );
}

// Arm and timepoint get the room: they tell two rows apart. Paths and the policy are icons.
const COLUMNS = "grid-cols-[minmax(10rem,18rem)_minmax(9rem,1fr)_8rem_7.5rem_6.5rem]";

function FieldRow({
  field,
  state,
  editing,
  shown,
  facts,
  selected,
  onSelect,
  rowRef,
}: {
  field: ReviewField;
  state: FieldState | undefined;
  editing: Editing | null;
  shown: Proposal | undefined;
  facts: EstimateFacts;
  selected: boolean;
  onSelect: () => void;
  rowRef: (el: HTMLElement | null) => void;
}) {
  const status = agreement(field);
  const failed = field.proposals.some((p) => failedChecks(p).length > 0);
  const own = editing?.value ?? state?.value ?? null;
  const value = own ?? (shown?.status === "extracted" ? shown.value : null);
  const unit = unitBeside(own ? field.spec.unit : shown?.unit, facts.label);
  const where = `${field.labels.arm} · ${field.labels.timepoint.toLowerCase()}`;
  // Two readings to choose from: both in the value cell, the taken one in ink.
  const choose = status === "differ" && !state?.accepted && !own;
  return (
    <div
      ref={rowRef}
      role="row"
      aria-selected={selected}
      data-testid="field-row"
      data-field-id={field.id}
      onClick={onSelect}
      className={`grid cursor-default scroll-mt-[72px] scroll-mb-1 ${COLUMNS} items-center gap-2.5 border-b border-rule/60 px-6 py-1.5 text-md ${selected ? "bg-petrol-wash shadow-[inset_3px_0_0_var(--petrol)]" : "hover:bg-sheet-2"}`}
    >
      <span className="break-words" title={`${where} (${field.key.arm} · ${field.key.timepoint})`}>
        {where}
      </span>{" "}
      <span
        className="min-w-0 break-words"
        title={[facts.label, facts.interval, field.key.quantity].filter(Boolean).join(" · ")}
      >
        {facts.label}{" "}
        <span className="block leading-4">
          <PolicyTag policy={field.spec.policy} />
        </span>
      </span>{" "}
      <span className="text-right">
        <span className="text-right whitespace-nowrap tabular-nums" data-testid="field-value">
          {choose ? (
            field.proposals.map((p, i) => (
              <span
                key={p.path}
                title={`${i + 1}: ${p.path === "janus" ? "Janus" : "LLM"} read ${p.value ?? PROPOSAL_STATUS[p.status].label}`}
                className={state?.picked === p.path ? "font-semibold text-ink" : "text-marker-edge"}
              >
                {i > 0 ? " / " : ""}
                {p.value ?? PROPOSAL_STATUS[p.status].label}
                {/* Same number, different unit: the unit is the disagreement. */}
                {field.proposals.some((q) => q.unit !== p.unit) && p.unit
                  ? `${unitGap(p.unit)}${p.unit}`
                  : ""}
              </span>
            ))
          ) : (
            <>
              {value ??
                (shown ? (
                  <Status term={PROPOSAL_STATUS[shown.status]} />
                ) : (
                  <span className="text-ink-3">Empty</span>
                ))}
              {value && unit ? (
                <>
                  {unitGap(unit)}
                  <span className="text-ink-2">{unit}</span>
                </>
              ) : null}
            </>
          )}
        </span>
        {facts.interval ? (
          <span className="block text-xs whitespace-nowrap text-ink-2">{facts.interval}</span>
        ) : null}
      </span>{" "}
      <span className="narrow flex items-center gap-1.5 text-sm">
        <Backing agreement={field.agreement} />
        {failed ? <Mark term={PROPOSAL_STATUS.invalid} title="A check failed" /> : null}
      </span>{" "}
      <span className="text-sm">
        {state?.accepted ? (
          <>
            {/* Editing is how the value came about, not a review state of its own. */}
            <span
              className="whitespace-nowrap"
              title={state.value !== null ? "Edited by hand, then accepted" : undefined}
            >
              <Status term={ACCEPTED}>
                {state.value !== null ? "Accepted, edited" : "Accepted"}
              </Status>
            </span>
          </>
        ) : (
          <ToVerify>{status === "differ" && !state?.picked ? "Pick a path" : "To verify"}</ToVerify>
        )}
      </span>
    </div>
  );
}
