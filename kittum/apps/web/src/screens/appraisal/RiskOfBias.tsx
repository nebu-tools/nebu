// Risk of bias (DESIGN.md, "Appraisal"): RoB 2 for randomized trials, one result of one included
// report at a time. The list shows each report's appraisals as a row of domain judgements. An
// appraisal opens beside its PDF: the signalling questions of one domain at a time, the active
// one in full with the instrument's words found in the report, and the quotes adopted for it as
// on the full-text screen. `1` to `5` answer; the algorithm's judgement of each domain follows
// every answer. `o` judges the domain against the algorithm, with a reason; `O` the result.
import { Link, useRouteContext } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  Anchor,
  Answer,
  AppraisableReport,
  Appraisal,
  AppraisalQuestion,
  AppraisalScreen as Screen,
  Judgement,
} from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/Empty.tsx";
import { failure, Field, FormDialog, TextInput } from "../../ui/Form.tsx";
import { Key, KeyHint } from "../../ui/Key.tsx";
import { formatDateTime } from "../../lib/format.ts";
import { useKeys } from "../../ui/keys.ts";
import { Page } from "../../ui/Page.tsx";
import { Panel } from "../../ui/Panel.tsx";
import { JUDGEMENTS, Mark, NOT_DONE, Status, WAITS } from "../../ui/Status.tsx";
import type { Term } from "../../ui/Status.tsx";
import { PdfViewer } from "../pdf/PdfViewer.tsx";
import { plural, useProject } from "../project.tsx";
import { Mentions, useEvidence } from "../screening/evidence.tsx";
import type { CriterionState } from "../screening/evidence.tsx";
import { rankMentions, sectionAt, sections } from "./rank.ts";
import { journalName, studyName, useStudyNames } from "./studyNames.ts";

/** The answers in key order, `1` to `5`. */
const ANSWERS: ReadonlyArray<readonly [Answer, string, string]> = [
  ["yes", "Y", "Yes"],
  ["probably_yes", "PY", "Probably yes"],
  ["probably_no", "PN", "Probably no"],
  ["no", "N", "No"],
  ["no_information", "NI", "No information"],
];
const LONG = Object.fromEntries(ANSWERS.map(([a, , l]) => [a, l])) as Record<Answer, string>;
/** In an override, `1` to `3` pick the judgement (`h` and `g` belong to the layout). */
const JUDGEMENT_KEYS: Record<string, Judgement> = { "1": "low", "2": "some_concerns", "3": "high" };
const QUEUEABLE = /^(?:[1-5jk.,oOa]|ArrowDown|ArrowUp|Enter|Escape)$/;

const ids = (list: ReadonlyArray<{ readonly id: string }>) =>
  list
    .map((x) => x.id)
    .toSorted()
    .join(",");

export function RiskOfBiasScreen() {
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <AppraisalLoader key={open} appraisalId={open} onBack={() => setOpen(null)} />;
  return <AppraisalList onOpen={setOpen} />;
}

/** A row that j and k move through: a result's appraisal, or a report not yet appraised. */
type Row =
  | {
      readonly kind: "appraisal";
      readonly report: AppraisableReport;
      readonly appraisal: AppraisableReport["appraisals"][number];
    }
  /** An included report with no result appraised yet: the work still to do. */
  | { readonly kind: "pending"; readonly report: AppraisableReport };

/** RoB 2's five domains, for the column heads before any appraisal names them. */
const ROB2_DOMAINS: ReadonlyArray<{ readonly id: string; readonly title: string }> = [
  { id: "D1", title: "Bias arising from the randomization process" },
  { id: "D2", title: "Bias due to deviations from intended interventions" },
  { id: "D3", title: "Bias due to missing outcome data" },
  { id: "D4", title: "Bias in measurement of the outcome" },
  { id: "D5", title: "Bias in selection of the reported result" },
];
/** Two words per RoB 2 domain, for the column heads. */
const DOMAIN_WORDS: Record<string, string> = {
  D1: "Randomization",
  D2: "Deviations",
  D3: "Missing data",
  D4: "Measurement",
  D5: "Reporting",
};
/** "Randomization process" for "Bias arising from the randomization process". */
const domainName = (title: string) => {
  const short = title.replace(/^Bias (arising from|due to|in) (the )?/i, "");
  return short.charAt(0).toUpperCase() + short.slice(1);
};

/** Not done, in the shared glyph set: an open circle. */
const NOT_JUDGED: Term = { ...NOT_DONE, label: "Not judged yet" };
const NOT_STARTED: Term = { ...NOT_DONE, label: "Not started" };
const IN_PROGRESS: Term = { ...NOT_DONE, label: "In progress" };

/** Result, five domains, overall, action. */
const COLUMNS = "grid grid-cols-[minmax(0,1fr)_repeat(5,6.5rem)_13rem_11rem] items-center gap-x-3";

function AppraisalList({ onOpen }: { onOpen: (appraisalId: string) => void }) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, labels } = useProject();
  const caller = useMemo(() => ({ projectId: project.id, as: me.actor_id }), [project, me]);
  const [reports, setReports] = useState<ReadonlyArray<AppraisableReport> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [starting, setStarting] = useState<AppraisableReport | null>(null);
  const names = useStudyNames();

  useEffect(() => {
    let live = true;
    run(workbench.appraisableReports(caller)).then(
      (found) => live && setReports(found),
      (e: unknown) => live && setError(failure(e, "Kittum could not load the reports.")),
    );
    return () => {
      live = false;
    };
  }, [workbench, caller]);

  const rows = useMemo(
    (): Row[] =>
      (reports ?? []).flatMap((report): Row[] =>
        report.appraisals.length
          ? report.appraisals.map((appraisal) => ({ kind: "appraisal", report, appraisal }))
          : [{ kind: "pending", report }],
      ),
    [reports],
  );
  const row = rows[selected];
  const domains = useMemo(
    () =>
      (reports ?? []).flatMap((r) => r.appraisals).find((a) => a.domains.length)?.domains ??
      ROB2_DOMAINS,
    [reports],
  );

  const activate = (r: Row | undefined) => {
    if (r?.kind === "appraisal") onOpen(r.appraisal.id);
    else if (r) setStarting(r.report);
  };

  useKeys((event) => {
    if (starting || rows.length === 0) return false;
    switch (event.key) {
      case "j":
      case "ArrowDown":
        setSelected((s) => Math.min(s + 1, rows.length - 1));
        return true;
      case "k":
      case "ArrowUp":
        setSelected((s) => Math.max(s - 1, 0));
        return true;
      case "Enter":
        activate(row);
        return true;
      case "n":
        if (row) setStarting(row.report);
        return true;
      default:
        return false;
    }
  });

  const params = { projectId: project.id };
  if (reports !== null && rows.length === 0) {
    return (
      <EmptyState
        title="Nothing to appraise yet"
        figures={[["Included at full text with a PDF", 0]]}
        actions={
          <>
            <Link
              to="/p/$projectId/retrieval"
              params={params}
              className="rounded-[4px] border border-petrol bg-petrol px-3 py-1.5 text-sm text-petrol-ink hover:brightness-110"
            >
              Open retrieval
            </Link>
            <Link
              to="/p/$projectId/progress"
              params={params}
              className="rounded-[4px] px-3 py-1.5 text-sm text-petrol hover:bg-petrol-wash"
            >
              See the review&rsquo;s progress
            </Link>
          </>
        }
      >
        No {plural(labels.report).toLowerCase()} to appraise yet. A {labels.report.toLowerCase()}{" "}
        comes here once it is included at full text and has its PDF.
      </EmptyState>
    );
  }

  const appraisals = (reports ?? []).flatMap((r) => r.appraisals);
  const notStarted = (reports ?? []).filter((r) => r.appraisals.length === 0).length;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  /** The overall judgements: "judged some concerns (D1, D4)" for one result, counts for more. */
  const judgedAs = (() => {
    const done = appraisals.filter((a) => a.judgement);
    const open = appraisals.length - done.length;
    if (appraisals.length === 1 && done[0]?.judgement) {
      const flagged = done[0].domains.filter((d) => d.judgement && d.judgement !== "low");
      return `judged ${JUDGEMENTS[done[0].judgement].label.toLowerCase()}${flagged.length ? ` (${flagged.map((d) => d.id).join(", ")})` : ""}`;
    }
    const byJudgement = (["low", "some_concerns", "high"] as const)
      .map((j) => [j, done.filter((a) => a.judgement === j).length] as const)
      .filter(([, n]) => n > 0)
      .map(([j, n]) => `${n} ${JUDGEMENTS[j].label.toLowerCase()}`);
    return [...byJudgement, open ? `${open} in progress` : ""].filter(Boolean).join(", ");
  })();
  const summary =
    reports === null
      ? "RoB 2 for randomized trials, one result at a time."
      : [
          `${count(reports.length, `included ${labels.report.toLowerCase()}`, `included ${plural(labels.report).toLowerCase()}`)}`,
          appraisals.length
            ? `${count(appraisals.length, "result", "results")} appraised${judgedAs ? `, ${judgedAs}` : ""}`
            : "",
          notStarted
            ? `${count(notStarted, labels.report.toLowerCase(), plural(labels.report).toLowerCase())} not started`
            : "",
        ]
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(". ") + ".";

  // Where each report's rows start in the list j and k move through.
  const starts = (reports ?? []).map((r) => rows.findIndex((x) => x.report === r));
  return (
    <>
      <Page kind="data" title="Risk of bias" summary={summary}>
        {error ? (
          <p role="alert" className="mb-4 border-l-2 border-exclude pl-3 text-sm text-exclude">
            {error}
          </p>
        ) : null}
        {reports === null ? (
          error ? null : (
            <p className="text-ink-2">Loading the {plural(labels.report).toLowerCase()}.</p>
          )
        ) : (
          <div>
            <Panel className="pt-1">
              <div
                className={`${COLUMNS} border-b border-rule-strong pr-4 pb-2 pl-8 text-xs font-medium text-ink-2`}
                aria-hidden="true"
              >
                <span>Result</span>
                {domains.map((d) => (
                  <span
                    key={d.id}
                    className="text-center leading-tight"
                    title={`${d.id}: ${d.title}`}
                  >
                    <span className="block text-ink">{d.id}</span>
                    <span className="block font-normal">
                      {DOMAIN_WORDS[d.id] ?? domainName(d.title)}
                    </span>
                  </span>
                ))}
                <span>Overall</span>
                <span />
              </div>
              <ol aria-label="Appraisals">
                {(reports ?? []).map((report, n) => {
                  const own = rows.filter((r) => r.report === report);
                  const first = starts[n] ?? 0;
                  const holdsSelection = selected >= first && selected < first + own.length;
                  const name = studyName(names, report.report_id, report.title);
                  const known = name !== report.title;
                  const meta = [
                    known ? name : null,
                    journalName(report.journal),
                    known ? null : report.year,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <li key={report.report_id} className="mt-4 first:mt-2">
                      <div
                        data-testid="rob-report"
                        className="flex items-end gap-4 border-b border-rule pt-1 pr-4 pb-2"
                      >
                        <div className="min-w-0">
                          <h2 className="truncate text-md" title={report.title}>
                            {report.title}
                          </h2>
                          <p
                            className="truncate text-sm text-ink-2"
                            title={[report.journal, report.study_label].filter(Boolean).join(" · ")}
                          >
                            {meta}
                          </p>
                        </div>
                      </div>
                      <ol>
                        {own.map((r, k) => {
                          const at = first + k;
                          return (
                            <ListRow
                              key={
                                r.kind === "appraisal"
                                  ? r.appraisal.id
                                  : `pending-${report.report_id}`
                              }
                              row={r}
                              current={rows.length > 1 && at === selected}
                              onActivate={() => {
                                setSelected(at);
                                activate(r);
                              }}
                            />
                          );
                        })}
                      </ol>
                      {report.appraisals.length ? (
                        <div className="py-1.5 pl-6">
                          <Button
                            size="sm"
                            kind="quiet"
                            keys={holdsSelection ? ["n"] : []}
                            onClick={() => {
                              setSelected(first);
                              setStarting(report);
                            }}
                          >
                            + Add a result
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </Panel>
            <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-2 px-1">
              <Legend />
              {rows.length > 1 ? (
                <span className="text-sm">
                  <KeyHint keys={["j", "k"]}>Move between results</KeyHint>
                </span>
              ) : null}
            </div>
          </div>
        )}
      </Page>
      {starting ? (
        <StartDialog
          report={starting}
          onClose={() => setStarting(null)}
          onStarted={(a) => onOpen(a.id)}
        />
      ) : null}
    </>
  );
}

function Legend() {
  return (
    <ul
      className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ink-2"
      aria-label="Legend"
    >
      {(["low", "some_concerns", "high"] as const).map((j) => (
        <li key={j}>
          <Status term={JUDGEMENTS[j]} />
        </li>
      ))}
      <li>
        <Status term={NOT_JUDGED} />
      </li>
    </ul>
  );
}

function ListRow({
  row: r,
  current,
  onActivate,
}: {
  row: Row;
  current: boolean;
  onActivate: () => void;
}) {
  const mark = current ? "bg-petrol-wash shadow-[inset_3px_0_0_var(--petrol)]" : "hover:bg-sheet-2";
  if (r.kind === "pending") {
    return (
      <li
        aria-current={current || undefined}
        data-testid="rob-pending"
        onClick={onActivate}
        className={`${COLUMNS} cursor-pointer border-b border-rule py-2.5 pr-4 pl-8 text-md ${mark}`}
      >
        <span className="text-ink-2">No result appraised yet</span>
        {ROB2_DOMAINS.map((d) => (
          <span
            key={d.id}
            className="flex justify-center [&>.mark]:h-[22px]! [&>.mark]:w-[22px]! [&>.mark]:text-[14px]!"
          >
            <Mark term={NOT_JUDGED} title={`${d.id}: not judged yet`} />
          </span>
        ))}
        <span>
          <Status term={NOT_STARTED} />
        </span>
        <span className="flex justify-end">
          <Button size="sm" kind="quiet" keys={current ? ["Enter"] : []} tabIndex={-1}>
            Start
          </Button>
        </span>
      </li>
    );
  }
  const a = r.appraisal;
  return (
    <li
      aria-current={current || undefined}
      data-testid="rob-appraisal"
      onClick={onActivate}
      className={`${COLUMNS} cursor-pointer border-b border-rule py-2.5 pr-4 pl-8 text-md ${mark}`}
    >
      <span className="truncate font-medium" title={a.result}>
        {a.result}
      </span>
      {a.domains.map((d) => (
        <span
          key={d.id}
          className="flex justify-center [&>.mark]:h-[22px]! [&>.mark]:w-[22px]! [&>.mark]:text-[14px]!"
        >
          <Mark
            term={d.judgement ? JUDGEMENTS[d.judgement] : NOT_JUDGED}
            title={`${d.id} ${domainName(d.title)}: ${d.judgement ? JUDGEMENTS[d.judgement].label : "not judged yet"}${d.overridden ? ", judged by the reviewer" : ""}`}
          />
        </span>
      ))}
      <span data-testid="rob-overall">
        {a.judgement ? (
          <Status term={JUDGEMENTS[a.judgement]}>
            {JUDGEMENTS[a.judgement].label}
            {a.overridden ? <span className="text-ink-2"> (yours)</span> : null}
          </Status>
        ) : (
          <Status term={IN_PROGRESS}>
            In progress, {a.open} {a.open === 1 ? "question" : "questions"} open
          </Status>
        )}
      </span>
      <span className="flex justify-end">
        <Button size="sm" kind="quiet" keys={current ? ["Enter"] : []} tabIndex={-1}>
          Open appraisal
        </Button>
      </span>
    </li>
  );
}

function StartDialog({
  report,
  onClose,
  onStarted,
}: {
  report: AppraisableReport;
  onClose: () => void;
  onStarted: (appraisal: Appraisal) => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (!result.trim()) {
      setError("Name the result you appraise.");
      return;
    }
    setBusy(true);
    try {
      onStarted(
        await run(
          workbench.startAppraisal({
            projectId: project.id,
            as: me.actor_id,
            reportId: report.report_id,
            result: result.trim(),
          }),
        ),
      );
    } catch (e) {
      setError(failure(e, "Kittum could not start the appraisal."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Appraise a result with RoB 2"
      description={`${report.study_label}: ${report.title}`}
      submit="Start the appraisal"
      busy={busy}
      error={error}
      onSubmit={() => void start()}
    >
      <Field
        label="Result"
        hint="The outcome, time point, and analysis, as the report gives the number."
      >
        <TextInput
          autoFocus
          value={result}
          maxLength={500}
          onChange={(event) => setResult(event.target.value)}
          placeholder="For example, HbA1c at 12 months, primary analysis set"
        />
      </Field>
    </FormDialog>
  );
}

function AppraisalLoader({ appraisalId, onBack }: { appraisalId: string; onBack: () => void }) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const [screen, setScreen] = useState<Screen | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    run(workbench.appraisal({ projectId: project.id, as: me.actor_id, appraisalId })).then(
      (found) => live && setScreen(found),
      (e: unknown) => live && setError(failure(e, "Kittum could not load the appraisal.")),
    );
    return () => {
      live = false;
    };
  }, [workbench, project.id, me.actor_id, appraisalId]);
  useKeys((event) => {
    if (screen || event.key !== "Escape") return false;
    onBack();
    return true;
  });
  if (error) {
    return (
      <div className="mx-auto max-w-[640px] px-10 py-16">
        <p role="alert" className="text-md text-ink-2">
          {error}
        </p>
        <button type="button" onClick={onBack} className="mt-3 text-petrol hover:underline">
          Back to the list
        </button>
      </div>
    );
  }
  if (!screen) return <p className="px-10 py-16 text-ink-3">Loading the appraisal.</p>;
  return <AppraisalView screen={screen} onBack={onBack} />;
}

/** The override being written: which judgement, then the reason. */
interface Overriding {
  readonly target: string;
  readonly name: string;
  readonly judgement: Judgement | null;
  readonly current: Judgement | null;
  readonly overridden: boolean;
}

function AppraisalView({ screen, onBack }: { screen: Screen; onBack: () => void }) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const [appraisal, setAppraisal] = useState<Appraisal>(screen.appraisal);
  const [busy, setBusy] = useState(false);
  const [overriding, setOverriding] = useState<Overriding | null>(null);
  const questions = useMemo(
    () => appraisal.domains.flatMap((d) => d.questions),
    [appraisal.domains],
  );
  // Each question's mentions in reading order: methods first, the title and references last.
  const headings = useMemo(() => sections(screen.layer.text), [screen.layer.text]);
  const mentions = useMemo(() => {
    return new Map(
      screen.mentions.map(([id, list]) => [id, rankMentions(screen.layer.text, headings, list)]),
    );
  }, [screen.mentions, screen.layer.text, headings]);
  // The quotes saved with each answer, keyed like the mention they came from where there is one.
  const initial = useMemo(() => {
    const out: Record<string, CriterionState> = {};
    for (const q of screen.appraisal.domains.flatMap((d) => d.questions)) {
      const own = mentions.get(q.id) ?? [];
      out[q.id] = {
        verdict: null,
        cursor: -1,
        evidence: q.evidence.map((a) => ({
          id: a.id,
          key:
            own.find((m) => m.start === a.start && m.end === a.end)?.id ??
            `selection-${a.start}-${a.end}`,
          quote: a.quote.exact,
          boxes: a.boxes,
        })),
      };
    }
    return out;
  }, [screen.appraisal, mentions]);
  const {
    active,
    setActive,
    stateOf,
    update,
    currentMention,
    selection,
    setSelection,
    notice,
    setNotice,
    busy: adopting,
    highlights,
    jump,
    adopt,
  } = useEvidence<AppraisalQuestion>({
    workbench,
    layerId: screen.layer.id,
    criteria: questions,
    mentions,
    nameOf: (q) => q.id,
    initial,
  });
  const question = questions[active];
  const domain = appraisal.domains.find((d) => d.questions.some((q) => q.id === question?.id));
  const caller = { projectId: project.id, as: me.actor_id, appraisalId: appraisal.id };

  const send = useCallback(
    async (q: AppraisalQuestion, answer: Answer, advance: boolean) => {
      setBusy(true);
      try {
        const next = await run(
          workbench.answerQuestion({
            projectId: project.id,
            as: me.actor_id,
            appraisalId: appraisal.id,
            questionId: q.id,
            answer,
            anchorIds: stateOf(q.id).evidence.map((e) => e.id),
          }),
        );
        setAppraisal(next);
        setNotice(null);
        if (advance) {
          // On to the next question that applies and has no answer, in this domain or after.
          const all = next.domains.flatMap((d) => d.questions);
          const from = all.findIndex((x) => x.id === q.id);
          const open = all.findIndex((x, i) => i > from && x.applies === "yes" && !x.answer);
          if (open >= 0) setActive(open);
        }
      } catch (e) {
        setNotice(
          e instanceof WorkbenchError ? e.message : "Kittum did not record the answer. Try again.",
        );
      } finally {
        setBusy(false);
      }
    },
    [workbench, project.id, me.actor_id, appraisal.id, stateOf, setActive, setNotice],
  );

  // Quotes adopted or removed after the answer go with the answer: it is sent again.
  const localQuotes = question ? ids(stateOf(question.id).evidence) : "";
  const savedQuotes = question ? ids(question.evidence) : "";
  // Each set of quotes is sent once: a refusal stays on screen rather than being retried.
  const sentQuotes = useRef<string | null>(null);
  useEffect(() => {
    if (!question?.answer || localQuotes === savedQuotes || busy) return;
    const attempt = `${question.id}:${localQuotes}`;
    if (sentQuotes.current === attempt) return;
    sentQuotes.current = attempt;
    void send(question, question.answer, false);
  }, [question, localQuotes, savedQuotes, busy, send]);

  const answer = (index: number) => {
    const option = ANSWERS[index]?.[0];
    if (!question || !option) return;
    if (question.applies === "no") {
      setNotice(`${question.id} does not apply given the answers above. RoB 2 counts it as NA.`);
      return;
    }
    if (question.applies === "pending") {
      const needs = question.condition?.questions.join(" and ") ?? "the questions above";
      setNotice(`Answer ${needs} first: they decide whether ${question.id} applies.`);
      return;
    }
    if (!question.options.includes(option)) {
      setNotice(`${question.id} has no answer “${LONG[option]}” in RoB 2.`);
      return;
    }
    void send(question, option, true);
  };

  const startOverride = (target: string) => {
    const d = appraisal.domains.find((x) => x.id === target);
    setOverriding({
      target,
      name: d ? `${d.id} ${d.title}` : "the overall judgement",
      judgement: null,
      current: d ? d.judgement : appraisal.judgement,
      overridden: d ? d.override !== null : appraisal.override !== null,
    });
    setNotice(null);
  };

  const saveOverride = async (judgement: Judgement | null, reason: string | null) => {
    if (!overriding) return;
    setBusy(true);
    try {
      setAppraisal(
        await run(
          workbench.overrideJudgement({ ...caller, target: overriding.target, judgement, reason }),
        ),
      );
      setOverriding(null);
      setNotice(
        judgement
          ? `Judged ${overriding.name} ${JUDGEMENTS[judgement].label.toLowerCase()}.`
          : `${overriding.name} follows the algorithm again.`,
      );
    } catch (e) {
      setNotice(e instanceof WorkbenchError ? e.message : "Kittum did not record it. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const handle = (key: string): boolean => {
    if (overriding) {
      if (key === "Escape") {
        setOverriding(null);
        return true;
      }
      if (overriding.judgement) return false;
      const chosen = JUDGEMENT_KEYS[key];
      if (chosen) {
        setOverriding({ ...overriding, judgement: chosen });
        return true;
      }
      if (key === "a" && overriding.overridden) {
        void saveOverride(null, null);
        return true;
      }
      return false;
    }
    if (/^[1-5]$/.test(key)) {
      answer(Number(key) - 1);
      return true;
    }
    switch (key) {
      case "ArrowDown":
      case "j":
        setActive((a) => Math.min(a + 1, questions.length - 1));
        return true;
      case "ArrowUp":
      case "k":
        setActive((a) => Math.max(a - 1, 0));
        return true;
      case ".":
      case ",":
        jump(key === "." ? 1 : -1);
        return true;
      case "Enter":
        void adopt();
        return true;
      case "o":
        if (domain) startOverride(domain.id);
        return true;
      case "O":
        startOverride("overall");
        return true;
      case "Escape":
        onBack();
        return true;
      default:
        return false;
    }
  };

  // Keys pressed while an answer or a quote is on its way wait their turn, in order: a fast
  // reviewer's next answer must neither be lost nor overtake the one before.
  const [queued, setQueued] = useState<ReadonlyArray<string>>([]);
  useKeys((event) => {
    const key = event.key;
    if (event.repeat && /^[1-5]$/.test(key)) return true;
    if (busy || adopting || queued.length > 0) {
      if (!QUEUEABLE.test(key) || (overriding?.judgement && key !== "Escape")) return false;
      setQueued((q) => [...q, key]);
      return true;
    }
    return handle(key);
  });
  useEffect(() => {
    if (busy || adopting || queued.length === 0) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    if (next) handle(next);
    // `handle` reads the latest state; the queue moves on whenever a request settles.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, adopting, queued]);

  const box = currentMention?.boxes[0];
  const target = currentMention && box ? { key: currentMention.id, box } : null;
  const concerns = appraisal.domains.filter((d) => d.judgement === "some_concerns").length;
  const flagged = appraisal.domains
    .filter((d) => d.proposed && d.proposed !== "low")
    .map((d) => d.id);
  const evidence = question ? stateOf(question.id).evidence : [];
  const remove = (id: string) => {
    if (!question) return;
    update(question.id, (s) => ({ ...s, evidence: s.evidence.filter((e) => e.id !== id) }));
    setNotice("Removed from the evidence.");
  };
  const goTo = (id: string) => {
    const at = questions.findIndex((q) => q.id === id);
    if (at >= 0) setActive(at);
  };
  const names = useStudyNames();
  const name = studyName(names, appraisal.report_id, appraisal.report_title);
  const people = new Map(project.members.map((m) => [m.actor_id, m.display_name]));
  const answeredAt = questions
    .map((q) => q.answered_at)
    .filter((t): t is string => Boolean(t))
    .toSorted()
    .at(-1);
  const yours = appraisal.domains.filter((d) => d.override && d.judgement);
  // Evidence from the title block or the references only: it names the design, not how the
  // trial carried it out. Offer the best mention from the body instead.
  const questionMentions = question ? (mentions.get(question.id) ?? []) : [];
  const startOf = (key: string) =>
    questionMentions.find((m) => m.id === key)?.start ??
    Number(/^selection-(\d+)-/.exec(key)?.[1] ?? Number.NaN);
  const weakOnly =
    evidence.length > 0 &&
    evidence.every((e) => {
      const start = startOf(e.key);
      if (Number.isNaN(start)) return false;
      const section = sectionAt(headings, start);
      return section === "front" || section === "references";
    });
  const adoptedKeys = new Set(evidence.map((e) => e.key));
  const better = weakOnly
    ? questionMentions.findIndex((m) => {
        const section = sectionAt(headings, m.start);
        return section !== "front" && section !== "references" && !adoptedKeys.has(m.id);
      })
    : -1;
  const betterMention = better >= 0 ? questionMentions[better] : undefined;
  const weakNote = question?.id.startsWith("1.")
    ? `${question.answer ? `“${LONG[question.answer]}” rests on` : "The evidence is"} the title only, which does not say how the allocation sequence was made.`
    : `${question?.answer ? `“${LONG[question.answer]}” rests on` : "The evidence is"} the title or the references only; the methods say what the trial did.`;
  /** Adopts the current mention and drops the title-only quotes it replaces. */
  const replaceWeak = async () => {
    if (!question) return;
    const weak = new Set(evidence.map((e) => e.key));
    const replacing = currentMention?.id;
    await adopt();
    // Only once the new quote is in: a refused adoption keeps the old evidence.
    update(question.id, (s) =>
      s.evidence.some((e) => e.key === replacing)
        ? { ...s, evidence: s.evidence.filter((e) => !weak.has(e.key)) }
        : s,
    );
  };
  const showMention = (index: number) => {
    if (!question) return;
    update(question.id, (s) => ({ ...s, cursor: index }));
    setNotice(null);
  };

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(420px,36%)] bg-paper">
      <PdfViewer
        workbench={workbench}
        layer={screen.layer}
        highlights={highlights}
        target={target}
        onSelection={setSelection}
        label={name}
        targetLabel="Show the current passage"
      />
      <aside
        className="my-3 mr-3 flex min-h-0 flex-col overflow-hidden rounded-[6px] bg-raised shadow-raised"
        aria-label="Signalling questions"
      >
        <header className="px-5 pt-3 pb-2">
          <div className="flex items-center gap-3">
            <Button size="sm" kind="quiet" keys={["Escape"]} onClick={onBack} className="-ml-2.5">
              All appraisals
            </Button>
            <p
              className="min-w-0 truncate text-sm text-ink-2"
              title={`${appraisal.report_title} (${appraisal.study_label}). Started by ${people.get(appraisal.created_by) ?? "a reviewer"}, ${formatDateTime(appraisal.created_at)}${answeredAt ? `; last answer ${formatDateTime(answeredAt)}` : ""}.`}
            >
              {name}, RoB 2
            </p>
          </div>
          <div className="mt-1.5 flex items-baseline gap-3">
            <h1 className="min-w-0 truncate text-md font-semibold" title={appraisal.result}>
              {appraisal.result}
            </h1>
            <span className="ml-auto shrink-0 text-sm" data-testid="rob-overall">
              <Judged
                judgement={appraisal.judgement}
                proposed={appraisal.proposed}
                reason={appraisal.override?.reason ?? null}
              />
            </span>
          </div>
          {appraisal.proposed ? (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
              <dt className="text-ink-2">Algorithm</dt>
              <dd>
                {JUDGEMENTS[appraisal.proposed].label}
                {flagged.length ? ` (${flagged.join(", ")})` : ""}
              </dd>
              {yours.length ? (
                <>
                  <dt className="text-ink-2">Your change</dt>
                  <dd>
                    {yours
                      .map((d) => `${d.id} ${JUDGEMENTS[d.judgement!].label.toLowerCase()}`)
                      .join(", ")}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}
          {concerns > 1 && appraisal.judgement === "some_concerns" ? (
            <p className="mt-1 text-sm text-ink-2">
              Some concerns in {concerns} domains can justify High overall.
            </p>
          ) : null}
        </header>
        <ol className="py-1" data-testid="rob-domains" aria-label="Domains">
          {appraisal.domains.map((d) => {
            const open = d.id === domain?.id;
            const applicable = d.questions.filter((q) => q.applies !== "no");
            const done = applicable.filter((q) => q.answer).length;
            return (
              <li
                key={d.id}
                data-testid="rob-domain"
                aria-current={open || undefined}
                className={`grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-2 px-5 py-1.5 ${open ? "bg-petrol-wash/50 shadow-[inset_3px_0_0_var(--petrol)]" : ""}`}
              >
                <button
                  type="button"
                  className="pt-0.5 text-left text-sm font-semibold"
                  onClick={() => d.questions[0] && goTo(d.questions[0].id)}
                >
                  {d.id}
                </button>
                <div className="min-w-0">
                  <p className="truncate text-sm" title={d.title}>
                    {domainName(d.title)}
                    <span className="ml-2 text-ink-2">
                      {done} of {applicable.length} answered
                    </span>
                  </p>
                  {open ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {d.questions.map((q) => (
                        <QuestionChip
                          key={q.id}
                          question={q}
                          current={q.id === question?.id}
                          onClick={() => goTo(q.id)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
                <span className="pt-0.5 text-sm" data-testid={`rob-${d.id}`}>
                  <Judged
                    judgement={d.judgement}
                    proposed={d.proposed}
                    reason={d.override?.reason ?? null}
                  />
                </span>
              </li>
            );
          })}
        </ol>
        {question && domain ? (
          <section
            key={question.id}
            className="min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-4"
            data-testid="rob-question"
            data-applies={question.applies}
            aria-current="true"
            aria-label={`Question ${question.id}`}
          >
            <p className="text-sm text-ink-2">
              {domain.id} {domainName(domain.title)}, question {question.id}
            </p>
            <h2 className="mt-1 text-md">{question.text}</h2>
            {question.applies === "yes" ? (
              <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Answers">
                {ANSWERS.map(([a, , long], i) => {
                  const chosen = question.answer === a;
                  const offered = question.options.includes(a);
                  return (
                    <button
                      key={a}
                      type="button"
                      disabled={!offered}
                      aria-pressed={chosen}
                      onClick={() => {
                        if (!busy && !adopting) answer(i);
                      }}
                      title={
                        chosen && weakOnly
                          ? "Chosen, but the only evidence is from the title"
                          : offered
                            ? undefined
                            : "RoB 2 offers no such answer here"
                      }
                      className={`inline-flex h-8 items-center gap-1.5 rounded-[4px] border px-2.5 text-sm disabled:cursor-not-allowed disabled:line-through disabled:opacity-45 ${
                        chosen
                          ? "border-petrol bg-petrol font-medium text-petrol-ink"
                          : "border-rule-strong bg-sheet text-ink hover:bg-sheet-2"
                      }`}
                    >
                      <Key k={String(i + 1)} className="key-on-button" />
                      {long}
                    </button>
                  );
                })}
                {weakOnly && question.answer ? (
                  <p className="mt-1 basis-full text-sm" data-testid="rob-weak-answer">
                    <Status term={WAITS}>{weakNote}</Status>
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-sm text-ink-2">
                {question.applies === "no"
                  ? "Does not apply given the answers above. RoB 2 counts it as NA."
                  : `Answer ${question.condition?.questions.join(" and ") ?? "the questions above"} first: they decide whether this applies.`}
              </p>
            )}
            <div className="mt-6" data-testid="rob-evidence">
              <div className="flex items-center gap-3">
                <h3 className="text-sm font-semibold">Evidence for {question.id}</h3>
                {selection || (currentMention && !adoptedKeys.has(currentMention.id)) ? (
                  <Button
                    size="sm"
                    keys={["Enter"]}
                    className="ml-auto"
                    disabled={adopting}
                    onClick={() => void adopt()}
                  >
                    {selection
                      ? "Attach the selected passage"
                      : `Adopt the p. ${currentMention?.boxes[0]?.page ?? "–"} mention`}
                  </Button>
                ) : null}
              </div>
              {evidence.length === 0 ? (
                <p className="mt-1 text-sm text-ink-2">
                  None yet. Adopt a mention below, or select a passage on the page.
                </p>
              ) : (
                <ul className="mt-1.5">
                  {evidence.map((e) => (
                    <li key={e.id} className="flex items-start gap-3 py-1.5">
                      <span className="w-10 shrink-0 text-sm text-ink-2">
                        p. {e.boxes[0]?.page ?? "–"}
                      </span>
                      <span className="min-w-0 flex-1 text-sm">
                        &ldquo;{e.quote.replace(/\s+/g, " ")}&rdquo;
                      </span>
                      <Button size="sm" kind="quiet" onClick={() => remove(e.id)}>
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {weakOnly ? (
                <div
                  className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm"
                  data-testid="rob-weak-evidence"
                >
                  {question.answer ? null : <Status term={WAITS}>{weakNote}</Status>}
                  {betterMention && currentMention?.id === betterMention.id ? (
                    <Button
                      size="sm"
                      kind="primary"
                      disabled={adopting}
                      onClick={() => void replaceWeak()}
                    >
                      Use &ldquo;{passageName(betterMention)}&rdquo; instead of the title quote
                    </Button>
                  ) : betterMention ? (
                    <Button size="sm" onClick={() => showMention(better)}>
                      Show &ldquo;{passageName(betterMention)}&rdquo; on p.{" "}
                      {betterMention.boxes[0]?.page ?? "–"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <h3
              className="mt-6 text-sm font-semibold"
              title="Methods passages first, then results; the title and the references last."
            >
              Where the report mentions it
            </h3>
            <Mentions
              mentions={mentions.get(question.id) ?? []}
              cursor={stateOf(question.id).cursor}
              adopted={new Set(evidence.map((e) => e.key))}
              selections={[]}
              limit={3}
              label="Mentions, methods first"
              onSelect={showMention}
              onAdopt={(index) => {
                const mention = questionMentions[index];
                if (!mention) return;
                showMention(index);
                void adopt(mention);
              }}
              footer={
                <span className="flex items-center gap-1.5">
                  <Button size="sm" kind="quiet" keys={[","]} onClick={() => jump(-1)}>
                    Previous
                  </Button>
                  <Button size="sm" kind="quiet" keys={["."]} onClick={() => jump(1)}>
                    Next
                  </Button>
                </span>
              }
            />
          </section>
        ) : (
          <div className="flex-1" />
        )}
        {overriding ? (
          <OverrideForm
            overriding={overriding}
            busy={busy}
            onCancel={() => setOverriding(null)}
            onSave={(reason) => void saveOverride(overriding.judgement, reason)}
          />
        ) : (
          <footer className="px-5 pt-2 pb-4 text-sm">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" keys={["o"]} onClick={() => domain && startOverride(domain.id)}>
                Judge {domain?.id ?? "the domain"} yourself
              </Button>
              <Button size="sm" keys={["Shift", "O"]} onClick={() => startOverride("overall")}>
                Judge the result yourself
              </Button>
            </div>
            <p
              className="mt-2 min-h-5 text-sm text-ink-2"
              aria-live="polite"
              data-testid="rob-notice"
            >
              {notice}
            </p>
          </footer>
        )}
      </aside>
    </div>
  );
}

/** A judgement with its source: the algorithm's, or the reviewer's against it. */
function Judged({
  judgement,
  proposed,
  reason,
}: {
  judgement: Judgement | null;
  proposed: Judgement | null;
  reason: string | null;
}) {
  if (!judgement) return <span className="text-ink-3">Not yet</span>;
  return (
    <span title={reason ? `Yours: ${reason}` : "Proposed by the RoB 2 algorithm"}>
      <Status term={JUDGEMENTS[judgement]}>
        {JUDGEMENTS[judgement].label}
        {reason ? (
          <span className="text-ink-3">
            {" "}
            (yours{proposed ? `, algorithm ${JUDGEMENTS[proposed].label.toLowerCase()}` : ""})
          </span>
        ) : null}
      </Status>
    </span>
  );
}

/** A mention named by its own words: "computer-generated randomization list". */
const passageName = (mention: Anchor) => {
  const after = (mention.quote.suffix ?? "").replace(/\s+/g, " ");
  const words: string[] = [];
  // Up to three following words, stopping at a bracket or the end of a clause.
  if (/^[\s-]*[a-z]/i.test(after)) {
    for (const word of after.trim().split(" ")) {
      if (words.length === 3 || word.startsWith("(")) break;
      words.push(word.replace(/[,.;:)]+$/, ""));
      if (/[,.;:)]$/.test(word)) break;
    }
  }
  // "randomized in blocks", not "randomized in blocks of".
  while (words.length && /^(of|to|a|an|the|and|or|in|on|at|by|for|with|from)$/i.test(words.at(-1)!))
    words.pop();
  const joined = /^\s/.test(after) ? ` ${words.join(" ")}` : words.join(" ");
  return `${mention.quote.exact.replace(/\s+/g, " ")}${words.length ? joined : ""}`.trim();
};

/** A question in the stepper: its number and the answer given, or NA. */
function QuestionChip({
  question: q,
  current,
  onClick,
}: {
  question: AppraisalQuestion;
  current: boolean;
  onClick: () => void;
}) {
  // In words: "Yes", "No info"; RoB 2's codes (Y, NI) mean nothing to an occasional appraiser.
  const answer =
    q.applies === "no"
      ? "Not applicable"
      : q.answer
        ? q.answer === "no_information"
          ? "No info"
          : LONG[q.answer]
        : "";
  const state = current
    ? "border-petrol bg-petrol-wash text-ink"
    : q.applies === "no"
      ? "border-dashed border-rule-strong text-ink-2"
      : q.answer
        ? "border-rule-strong bg-sheet text-ink"
        : "border-dashed border-rule-strong text-ink-2";
  return (
    <button
      type="button"
      aria-current={current || undefined}
      title={`${q.id} ${q.label}: ${q.applies === "no" ? "not applicable" : q.answer ? LONG[q.answer] : "not answered"}`}
      onClick={onClick}
      className={`inline-flex h-6 items-center gap-1 rounded-[3px] border px-1.5 text-xs tabular-nums ${state}`}
    >
      <span>{q.id}</span>
      <span className="font-semibold" data-testid={`rob-answer-${q.id}`}>
        {answer}
      </span>
    </button>
  );
}

function OverrideForm({
  overriding,
  busy,
  onCancel,
  onSave,
}: {
  overriding: Overriding;
  busy: boolean;
  onCancel: () => void;
  onSave: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (overriding.judgement) field.current?.focus();
  }, [overriding.judgement]);
  return (
    <form
      className="bg-sheet-2 px-5 py-3 text-sm"
      aria-label="Override"
      data-testid="rob-override"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && reason.trim()) onSave(reason.trim());
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <p className="font-semibold">Judge {overriding.name} yourself</p>
      {overriding.judgement ? (
        <>
          <p className="mt-1 text-xs text-ink-2">
            <Status term={JUDGEMENTS[overriding.judgement]} />, against the algorithm&rsquo;s{" "}
            {overriding.current ? JUDGEMENTS[overriding.current].label.toLowerCase() : "pending"}{" "}
            judgement.
          </p>
          <label className="mt-2 block text-xs text-ink-2" htmlFor="rob-override-reason">
            Why? The reason goes into the ledger and the report.
          </label>
          <input
            id="rob-override-reason"
            ref={field}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="mt-1 w-full rounded-[3px] border border-rule-strong bg-sheet px-2 py-1 text-sm"
            maxLength={2000}
          />
          <p className="mt-2 flex gap-4 text-xs">
            <KeyHint keys={["Enter"]}>Save</KeyHint>
            <KeyHint keys={["Escape"]}>Cancel</KeyHint>
          </p>
        </>
      ) : (
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <KeyHint keys={["1"]}>Low</KeyHint>
          <KeyHint keys={["2"]}>Some concerns</KeyHint>
          <KeyHint keys={["3"]}>High</KeyHint>
          {overriding.overridden ? <KeyHint keys={["a"]}>Back to the algorithm</KeyHint> : null}
          <KeyHint keys={["Escape"]}>Cancel</KeyHint>
        </p>
      )}
    </form>
  );
}
