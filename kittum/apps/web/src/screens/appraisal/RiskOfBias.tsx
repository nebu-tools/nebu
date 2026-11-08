// Risk of bias (DESIGN.md, "Appraisal"): RoB 2 for randomized trials, one result of one included
// report at a time. The list shows each report's appraisals as a row of domain judgements. An
// appraisal opens beside its PDF: the signalling questions of one domain at a time, the active
// one in full with the instrument's words found in the report, and the quotes adopted for it as
// on the full-text screen. `1` to `5` answer; the algorithm's judgement of each domain follows
// every answer. `o` judges the domain against the algorithm, with a reason; `O` the result.
import { useRouteContext } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type {
  Answer,
  AppraisableReport,
  Appraisal,
  AppraisalQuestion,
  AppraisalScreen as Screen,
  Judgement,
} from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { failure, Field, FormDialog, TextInput } from "../../ui/Form.tsx";
import { Key, KeyHint } from "../../ui/Key.tsx";
import { useKeys } from "../../ui/keys.ts";
import { JUDGEMENTS, Mark, Status } from "../../ui/Status.tsx";
import { PdfViewer } from "../pdf/PdfViewer.tsx";
import { plural, useProject } from "../project.tsx";
import { Mentions, useEvidence } from "../screening/evidence.tsx";
import type { CriterionState } from "../screening/evidence.tsx";

/** The answers in key order, `1` to `5`. */
const ANSWERS: ReadonlyArray<readonly [Answer, string, string]> = [
  ["yes", "Y", "Yes"],
  ["probably_yes", "PY", "Probably yes"],
  ["probably_no", "PN", "Probably no"],
  ["no", "N", "No"],
  ["no_information", "NI", "No information"],
];
const SHORT = Object.fromEntries(ANSWERS.map(([a, s]) => [a, s])) as Record<Answer, string>;
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

type Row =
  | { readonly kind: "report"; readonly report: AppraisableReport }
  | {
      readonly kind: "appraisal";
      readonly report: AppraisableReport;
      readonly appraisal: AppraisableReport["appraisals"][number];
    };

function AppraisalList({ onOpen }: { onOpen: (appraisalId: string) => void }) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, labels } = useProject();
  const caller = useMemo(() => ({ projectId: project.id, as: me.actor_id }), [project, me]);
  const [reports, setReports] = useState<ReadonlyArray<AppraisableReport> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [starting, setStarting] = useState<AppraisableReport | null>(null);

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
      (reports ?? []).flatMap((report) => [
        { kind: "report" as const, report },
        ...report.appraisals.map((appraisal) => ({
          kind: "appraisal" as const,
          report,
          appraisal,
        })),
      ]),
    [reports],
  );
  const row = rows[selected];

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
        if (row?.kind === "appraisal") onOpen(row.appraisal.id);
        else if (row) setStarting(row.report);
        return true;
      case "n":
        if (row) setStarting(row.report);
        return true;
      default:
        return false;
    }
  });

  return (
    <section className="h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[1080px] px-10 pt-10 pb-16">
        <div className="flex items-baseline gap-6">
          <h1 className="text-xl font-semibold tracking-[-0.01em]">Risk of bias</h1>
          {rows.length ? (
            <span className="ml-auto flex gap-5 text-sm">
              <KeyHint keys={["j", "k"]}>Move</KeyHint>
              <KeyHint keys={["Enter"]}>Open</KeyHint>
              <KeyHint keys={["n"]}>Appraise a result</KeyHint>
            </span>
          ) : null}
        </div>
        <p className="mt-2 max-w-[70ch] text-sm text-ink-2">
          RoB 2 for randomized trials, one result at a time, on the {labels.report.toLowerCase()}
          &rsquo;s full text.
        </p>
        {error ? (
          <p role="alert" className="mt-3 border-l-2 border-exclude pl-3 text-sm text-exclude">
            {error}
          </p>
        ) : null}
        {reports === null ? (
          error ? null : (
            <p className="mt-4 text-ink-3">Loading the {plural(labels.report).toLowerCase()}.</p>
          )
        ) : rows.length === 0 ? (
          <p className="mt-4 max-w-[64ch] text-md text-ink-2">
            No {plural(labels.report).toLowerCase()} to appraise yet. A{" "}
            {labels.report.toLowerCase()} comes here once it is included at full text and has its
            PDF.
          </p>
        ) : (
          <ol className="mt-6 border-t border-rule-strong" aria-label="Appraisals">
            {rows.map((r, index) => {
              const current = index === selected;
              const mark = current ? "bg-sheet shadow-[inset_3px_0_0_var(--petrol)]" : "";
              if (r.kind === "report") {
                return (
                  <li
                    key={r.report.report_id}
                    aria-current={current || undefined}
                    data-testid="rob-report"
                    onClick={() => setSelected(index)}
                    className={`flex items-baseline gap-3 border-b border-rule pt-3 pr-4 pb-1.5 pl-5 ${mark}`}
                  >
                    <span className="shrink-0 text-xs text-ink-3">{r.report.study_label}</span>
                    <h2 className="min-w-0 truncate font-semibold" title={r.report.title}>
                      {r.report.title}
                    </h2>
                    {current ? (
                      <span className="ml-auto shrink-0 text-xs">
                        <KeyHint keys={["n"]}>Appraise a result</KeyHint>
                      </span>
                    ) : null}
                  </li>
                );
              }
              const a = r.appraisal;
              return (
                <li
                  key={a.id}
                  aria-current={current || undefined}
                  data-testid="rob-appraisal"
                  onClick={() => setSelected(index)}
                  onDoubleClick={() => onOpen(a.id)}
                  className={`grid grid-cols-[minmax(0,1fr)_auto_9rem] items-center gap-x-5 border-b border-rule py-1.5 pr-4 pl-9 text-sm ${mark}`}
                >
                  <span className="truncate">{a.result}</span>
                  <span className="flex gap-1" aria-label="Domain judgements">
                    {a.domains.map((d) =>
                      d.judgement ? (
                        <Mark
                          key={d.id}
                          term={JUDGEMENTS[d.judgement]}
                          title={`${d.id} ${d.title}: ${JUDGEMENTS[d.judgement].label}${d.overridden ? ", overridden" : ""}`}
                        />
                      ) : (
                        <span key={d.id} className="mark text-ink-3" title={`${d.id} not yet`}>
                          –
                        </span>
                      ),
                    )}
                  </span>
                  <span data-testid="rob-overall">
                    {a.judgement ? (
                      <Status term={JUDGEMENTS[a.judgement]} />
                    ) : (
                      <span className="text-ink-3">{a.open} open</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {starting ? (
        <StartDialog
          report={starting}
          onClose={() => setStarting(null)}
          onStarted={(a) => onOpen(a.id)}
        />
      ) : null}
    </section>
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
  const mentions = useMemo(() => new Map(screen.mentions), [screen.mentions]);
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

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(380px,34%)]">
      <PdfViewer
        workbench={workbench}
        layer={screen.layer}
        highlights={highlights}
        target={target}
        onSelection={setSelection}
        label={`${appraisal.study_label}, ${appraisal.report_title}`}
      />
      <aside
        className="flex min-h-0 flex-col border-l border-rule-strong bg-sheet"
        aria-label="Signalling questions"
      >
        <header className="border-b border-rule px-5 pt-4 pb-3">
          <p className="truncate text-xs text-ink-3" title={appraisal.report_title}>
            {appraisal.study_label}, RoB 2
          </p>
          <div className="mt-1 flex items-baseline gap-3">
            <h1 className="min-w-0 truncate text-sm font-semibold" title={appraisal.result}>
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
          {concerns > 1 && appraisal.judgement === "some_concerns" ? (
            <p className="mt-1 text-xs text-ink-3">
              Some concerns in {concerns} domains may lower confidence enough to judge it high.{" "}
              <Key k="⇧" />
              <Key k="o" /> to judge it yourself.
            </p>
          ) : null}
        </header>
        <ol className="min-h-0 flex-1 overflow-y-auto" data-testid="rob-domains">
          {appraisal.domains.map((d) => {
            const open = d.id === domain?.id;
            return (
              <li key={d.id} className="border-b border-rule" data-testid="rob-domain">
                <div
                  className={`flex items-baseline gap-2 px-5 py-2 text-sm ${open ? "font-semibold" : "text-ink-2"}`}
                  onClick={() => setActive(questions.findIndex((q) => q.id === d.questions[0]?.id))}
                >
                  <span className="text-xs text-ink-3">{d.id}</span>
                  <span className="min-w-0 truncate">{d.title}</span>
                  <span className="ml-auto shrink-0 font-normal" data-testid={`rob-${d.id}`}>
                    <Judged
                      judgement={d.judgement}
                      proposed={d.proposed}
                      reason={d.override?.reason ?? null}
                    />
                  </span>
                </div>
                {open ? (
                  <ol className="pb-1.5">
                    {d.questions.map((q) => (
                      <QuestionRow
                        key={q.id}
                        question={q}
                        active={q.id === question?.id}
                        quotes={stateOf(q.id).evidence.length}
                        onClick={() => setActive(questions.findIndex((x) => x.id === q.id))}
                      >
                        {q.id === question?.id ? (
                          <Mentions
                            mentions={mentions.get(q.id) ?? []}
                            cursor={stateOf(q.id).cursor}
                            adopted={new Set(stateOf(q.id).evidence.map((e) => e.key))}
                            selections={stateOf(q.id).evidence.filter((e) =>
                              e.key.startsWith("selection-"),
                            )}
                          />
                        ) : null}
                      </QuestionRow>
                    ))}
                  </ol>
                ) : null}
              </li>
            );
          })}
        </ol>
        {overriding ? (
          <OverrideForm
            overriding={overriding}
            busy={busy}
            onCancel={() => setOverriding(null)}
            onSave={(reason) => void saveOverride(overriding.judgement, reason)}
          />
        ) : (
          <footer className="border-t border-rule-strong bg-sheet-2 px-5 py-3 text-sm">
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <KeyHint keys={["1", "5"]}>Y PY PN N NI</KeyHint>
              <KeyHint keys={["ArrowUp", "ArrowDown"]}>Question</KeyHint>
              <KeyHint keys={[",", "."]}>Mentions</KeyHint>
              <KeyHint keys={["Enter"]}>{selection ? "Adopt selection" : "Adopt quote"}</KeyHint>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-rule pt-2">
              <KeyHint keys={["o"]}>Judge the domain yourself</KeyHint>
              <KeyHint keys={["⇧", "o"]}>The result</KeyHint>
              <KeyHint keys={["Escape"]}>Back</KeyHint>
            </div>
            <p
              className="mt-2 min-h-5 text-xs text-ink-2"
              aria-live="polite"
              data-testid="rob-notice"
            >
              {notice ?? "Answer as the report supports it; adopt the quotes that do."}
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

function QuestionRow({
  question: q,
  active,
  quotes,
  onClick,
  children,
}: {
  question: AppraisalQuestion;
  active: boolean;
  quotes: number;
  onClick: () => void;
  children: ReactNode;
}) {
  const answer =
    q.applies === "no" ? (
      <span className="text-ink-3" title="Not applicable">
        NA
      </span>
    ) : q.answer ? (
      <span className="font-semibold" title={LONG[q.answer]}>
        {SHORT[q.answer]}
      </span>
    ) : (
      <span className="text-ink-3">{q.applies === "pending" ? "…" : "–"}</span>
    );
  return (
    <li
      aria-current={active || undefined}
      data-testid="rob-question"
      data-applies={q.applies}
      onClick={onClick}
      className={`px-5 py-1 text-sm ${active ? "bg-sheet-2 py-2 shadow-[inset_3px_0_0_var(--petrol)]" : ""} ${q.applies === "no" ? "text-ink-3" : ""}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="w-6 shrink-0 text-xs text-ink-3">{q.id}</span>
        <span className={`min-w-0 ${active ? "" : "truncate"}`}>{active ? q.text : q.label}</span>
        <span className="ml-auto flex shrink-0 items-baseline gap-2 text-xs">
          {quotes > 0 ? <span className="text-ink-3">{quotes} q.</span> : null}
          <span data-testid={`rob-answer-${q.id}`}>{answer}</span>
        </span>
      </div>
      {active && q.applies === "yes" ? (
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 pl-8 text-xs">
          {ANSWERS.map(([a, short], i) => (
            <span
              key={a}
              className={`inline-flex items-center gap-1 ${q.options.includes(a) ? "text-ink-2" : "text-ink-3 line-through"}`}
            >
              <Key k={String(i + 1)} on={q.answer === a} />
              {short}
            </span>
          ))}
        </p>
      ) : null}
      {active ? <div className="pl-8">{children}</div> : null}
    </li>
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
      className="border-t border-rule-strong bg-sheet-2 px-5 py-3 text-sm"
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
