// The title and abstract queue (DESIGN.md, "Reviewer workbench"): the record on the left, and on
// the right what a screener decides with: the AI's proposal where the stage shows it before the
// decision (one motivating reading, the rest one click away), a second opinion asked, and the
// criteria as number keys. Nothing from the AI before the decision in a complete topic.
import { Link, useRouteContext, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { Criterion, Decision, QueueItem, Reveal, ScopeStatus } from "../../data/schema.ts";
import { run } from "../../data/workbench.ts";
import { codePointIndex } from "../../lib/codepoints.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/Empty.tsx";
import { Key, KeyHint } from "../../ui/Key.tsx";
import { useKeys } from "../../ui/keys.ts";
import { Mark, OUTCOMES, Status, VERDICTS } from "../../ui/Status.tsx";
import { useProject } from "../project.tsx";
import { AiReading } from "./AiReading.tsx";
import { byKey, keyOf, numberOf, shortLabel } from "./criteria.ts";
import { Marked, orderSections, placeQuote } from "./RecordText.tsx";
import {
  AiBefore,
  AskSecondOpinion,
  beforeQuote,
  otherQuotes,
  SecondOpinionAsked,
} from "./Targeted.tsx";
import { ShowPrompt } from "./Prompt.tsx";
import { useQueue } from "./useQueue.ts";
import type { SessionStats } from "./useQueue.ts";

export function TitleAbstractQueue() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, labels, criteriaFor, screeningStage, scopeLabel, has } = useProject();
  const { scope, after } = useSearch({ from: "/p/$projectId/screening/title-abstract" });
  const stage = screeningStage("title_abstract", scope);
  const scopeId = stage?.scope_id ?? null;
  const criteria = useMemo(() => criteriaFor("title_abstract", scopeId), [criteriaFor, scopeId]);
  const caller = useMemo(
    () => ({ projectId: project.id, as: me.actor_id }),
    [project.id, me.actor_id],
  );
  const queue = useQueue(
    workbench,
    caller,
    scopeId,
    "title_abstract",
    stage?.reveal === "before",
    after ?? null,
  );
  const [armed, setArmed] = useState(false);
  // The criterion whose AI quote is lit up in the record (its rail row is hovered).
  const [lit, setLit] = useState<string | null>(null);
  // Working topics: the prompt the AI reads the record with, one key away (p). It belongs to the
  // record it was opened on, so a decision brings the next record up on its abstract.
  const [promptFor, setPromptFor] = useState<string | null>(null);
  const working = stage?.documentation === "working";
  // Mode S, key f: the next decision asks a colleague, with this comment.
  const [asking, setAsking] = useState<{ comment: string; typing: boolean } | null>(null);
  const ask = asking && !asking.typing ? { comment: asking.comment } : null;
  const [status, setStatus] = useState<ScopeStatus | null>(null);
  const [poll, setPoll] = useState(0);
  const { current } = queue;
  const promptOpen = !!current && promptFor === current.item.assignment_id;
  const setPromptOpen = (open: boolean | ((on: boolean) => boolean)) => {
    const next = typeof open === "function" ? open(promptOpen) : open;
    setPromptFor(next && current ? current.item.assignment_id : null);
  };
  // The queue ran dry but records remain: the AI judge has not read them yet, or they joined
  // behind the place the queue was read from. Ask again, from the start.
  const waiting = queue.finished && status !== null && status.remaining > 0;
  const { retry } = queue;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => {
      retry();
      setPoll((n) => n + 1);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [waiting, retry, poll]);

  useEffect(() => {
    if (!scopeId) return;
    let live = true;
    void run(workbench.status({ ...caller, scopeId, stage: "title_abstract" })).then(
      (s) => live && setStatus(s),
    );
    return () => {
      live = false;
    };
  }, [workbench, caller, scopeId, queue.stats.decided, current?.item.assignment_id, poll]);

  const decide = (outcome: "include" | "unclear") => {
    void queue.decide(outcome, null, ask);
    setAsking(null);
  };
  const excludeOn = (id: string) => {
    setArmed(false);
    const criterion = criteria.find((c) => c.id === id);
    if (!criterion) return;
    void queue.decide("exclude", criterion.id, ask);
    setAsking(null);
  };
  const secondOpinion = () => {
    if (!current) return;
    if (current.item.second_opinion)
      queue.setNotice("This is a second opinion. Your decision settles the record.");
    else setAsking({ comment: asking?.comment ?? "", typing: true });
  };

  useKeys((event) => {
    if (event.repeat) return true;
    const key = event.key;
    // While the prompt is open, p or Esc returns to the record; deciding still works, and the
    // next record opens on its abstract.
    if (promptOpen && current && !armed && (key === "p" || key === "Escape")) {
      setPromptOpen(false);
      return true;
    }
    if (!current) {
      // Nothing on screen (finished, or waiting for the AI): the last decision can still reopen.
      if (key !== "Backspace") return false;
      queue.undo();
      return true;
    }
    if (armed) {
      setArmed(false);
      if (/^[1-9]$/.test(key)) {
        const criterion = byKey(criteria, key);
        if (criterion) {
          void queue.decide("exclude", criterion.id, ask);
          setAsking(null);
        } else
          queue.setNotice(`There is no criterion ${key}. Press e, then 1 to ${criteria.length}.`);
        return true;
      }
      if (key === "Escape" || key === "Backspace" || key === "e") return true;
    }
    switch (key) {
      case "p":
        if (!working) return false;
        setPromptOpen((on) => !on);
        return true;
      case "i":
      case "u":
        void queue.decide(key === "i" ? "include" : "unclear", null, ask);
        setAsking(null);
        return true;
      case "f":
        if (stage?.mode !== "S") return false;
        if (current.item.second_opinion)
          queue.setNotice("This is a second opinion. Your decision settles the record.");
        else setAsking({ comment: asking?.comment ?? "", typing: true });
        return true;
      case "Escape":
        if (!asking) return false;
        setAsking(null);
        return true;
      case "e":
        queue.touch();
        setArmed(true);
        return true;
      case " ":
        void queue.keep();
        return true;
      case "Backspace":
        queue.undo();
        return true;
      default:
        if (/^[1-9]$/.test(key)) {
          queue.setNotice("To exclude, press e first, then the criterion number.");
          return true;
        }
        return false;
    }
  });

  if (!scopeId) {
    return (
      <Empty title="No records to screen">
        {has("reviewer") || has("auditor")
          ? `You have no ${labels.scope.toLowerCase()} to screen at title and abstract yet. The methods lead opens screening after publishing the protocol and running the searches.`
          : "Title and abstract screening is for the reviewers and the auditor. Choose another person or another stage."}
      </Empty>
    );
  }

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <QueueBar scopeLabel={`${labels.scope}: ${scopeLabel(scopeId)}`} status={status} />
      {/* The record on the left, everything to decide it with on the right. */}
      <div
        className={`grid min-h-0 ${
          current
            ? // The record and the rail side by side, centred, so the eye moves 800px, not 1300.
              "mx-auto w-full max-w-[1472px] grid-cols-[minmax(0,1fr)_minmax(420px,38rem)] gap-4 p-4"
            : "grid-cols-1"
        }`}
      >
        <div
          className={`relative min-h-0 ${current ? "overflow-hidden rounded-[6px] bg-raised shadow-raised" : ""}`}
        >
          {current && working && stage && promptOpen ? (
            // The prompt lies over the record, which stays where it was underneath.
            <div className="absolute inset-0 z-10 overflow-y-auto bg-raised">
              <div className="px-7 py-5">
                <ShowPrompt
                  caller={caller}
                  stageId={stage.stage_id}
                  assignmentId={current.item.assignment_id}
                  open
                  onToggle={() => setPromptOpen(false)}
                  criteria={criteria}
                />
              </div>
            </div>
          ) : null}
          <div
            className={`h-full overflow-y-auto ${current ? "bg-raised" : "bg-paper"}`}
            data-testid="record-scroll"
          >
            {current ? (
              <RecordView
                key={current.item.assignment_id}
                item={current.item}
                reveal={current.reveal ?? beforeQuote(current.item, criteria)}
                others={current.reveal ? [] : otherQuotes(current.item, criteria, labels)}
                lit={lit}
                criteria={criteria}
                labels={labels}
              />
            ) : waiting ? (
              <p className="px-10 py-10 text-ink-2" data-testid="queue-waiting">
                The AI judge has not read {status?.remaining} of your records yet. Each record
                appears here once the judge has read it.
              </p>
            ) : queue.finished && status !== null ? (
              // Finished only once the counts say nothing is left, not before they arrive.
              <Finished stats={queue.stats} status={status} />
            ) : queue.error ? null : (
              <p className="px-10 py-10 text-ink-3">Loading the queue.</p>
            )}
          </div>
        </div>
        <aside
          hidden={!current}
          aria-label="Decide"
          className="flex min-h-0 flex-col overflow-y-auto rounded-[6px] bg-raised shadow-raised"
        >
          {current && promptOpen ? (
            <div className="flex items-center gap-3 px-5 pt-4 text-sm text-ink-2">
              <span>Reading the AI&rsquo;s prompt for this record.</span>
              <span className="ml-auto">
                <Button
                  kind="secondary"
                  size="sm"
                  keys={["p"]}
                  onClick={() => setPromptOpen(false)}
                >
                  Back to the record
                </Button>
              </span>
            </div>
          ) : null}
          {current?.item.second_opinion ? (
            <SecondOpinionAsked
              asked={current.item.second_opinion}
              criteria={criteria}
              labels={labels}
            />
          ) : null}
          {current?.item.ai && !current.reveal ? (
            <AiBefore
              ai={current.item.ai}
              criteria={criteria}
              labels={labels}
              marked={beforeQuote(current.item, criteria)?.criterion_id ?? null}
              others={false}
            />
          ) : null}
          {current && !current.reveal ? (
            <div className="px-5 pt-4 pb-2">
              <h2 className="flex items-center text-xs font-semibold text-ink-2">
                Your decision
                <span className="ml-auto tracking-normal normal-case">
                  <Button kind="quiet" size="sm" keys={["Backspace"]} onClick={() => queue.undo()}>
                    Undo
                  </Button>
                </span>
              </h2>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button kind="secondary" keys={["i"]} onClick={() => decide("include")}>
                  {OUTCOMES.include.label}
                </Button>
                <Button
                  kind={armed ? "danger" : "secondary"}
                  keys={["e"]}
                  aria-pressed={armed}
                  onClick={() => {
                    queue.touch();
                    setArmed((on) => !on);
                  }}
                >
                  {armed ? "Exclude on which criterion?" : "Exclude on a criterion"}
                </Button>
                <Button kind="secondary" keys={["u"]} onClick={() => decide("unclear")}>
                  {OUTCOMES.unclear.label}
                </Button>
                {stage?.mode === "S" ? (
                  <Button kind="quiet" keys={["f"]} onClick={secondOpinion}>
                    Second opinion
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {current ? (
            <div
              className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 px-5 py-1 text-sm empty:hidden"
              aria-live="polite"
            >
              {queue.error ? (
                <span role="alert" className="text-exclude">
                  {queue.error}
                </span>
              ) : queue.notice ? (
                <span className="text-ink-2">{queue.notice}</span>
              ) : null}
              {current.decision ? (
                <DecisionNote
                  label="Your decision"
                  decision={current.decision}
                  criteria={criteria}
                />
              ) : queue.previous?.decision && !queue.notice ? (
                <DecisionNote
                  label="Previous record"
                  decision={queue.previous.decision}
                  criteria={criteria}
                  muted
                />
              ) : null}
            </div>
          ) : null}
          {current && asking ? (
            <AskSecondOpinion
              comment={asking.comment}
              onComment={(comment) => setAsking({ comment, typing: true })}
              onDone={() => setAsking((a) => a && { ...a, typing: false })}
              onCancel={() => setAsking(null)}
            />
          ) : null}
          {current?.reveal ? (
            <RevealBanner
              key={`${current.item.assignment_id}-${current.revealedAt}`}
              reveal={current.reveal}
              decision={current.decision}
              criteria={criteria}
              labels={labels}
              settled={current.settled}
            />
          ) : null}
          {current ? (
            <CriteriaList
              criteria={criteria}
              labels={labels}
              ai={current.reveal ? null : (current.item.ai ?? null)}
              onLit={setLit}
              onExclude={excludeOn}
              armed={armed}
              decision={current.decision ?? null}
              revealed={current.reveal?.criterion_id ?? null}
            />
          ) : null}
          {current && working && stage && !promptOpen ? (
            <div className="mt-auto px-5 py-3 text-xs">
              <button
                type="button"
                className="text-petrol hover:underline"
                onClick={() => setPromptOpen((on) => !on)}
                aria-expanded={promptOpen}
              >
                Show the prompt the AI read this record with
              </button>
              <span className="ml-2 text-ink-3">(p)</span>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function QueueBar({ scopeLabel, status }: { scopeLabel: string; status: ScopeStatus | null }) {
  const total = status ? status.screened + status.remaining : 0;
  const done = total ? status!.screened / total : 0;
  return (
    <div className="flex h-9 items-center gap-4 border-b border-rule bg-paper px-4 text-xs">
      <span className="min-w-0 truncate text-ink-2" title={scopeLabel}>
        {scopeLabel}
      </span>
      {status ? (
        <span className="ml-auto flex flex-none items-center gap-2.5 text-ink-2">
          <span
            className="h-1.5 w-40 overflow-hidden rounded-full bg-rule"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={status.screened}
            aria-label="Records screened"
          >
            <span className="block h-full bg-petrol" style={{ width: `${done * 100}%` }} />
          </span>
          <span className="whitespace-nowrap tabular-nums">
            {status.screened} of {total} screened
          </span>
        </span>
      ) : null}
    </div>
  );
}

function RecordView({
  item,
  reveal,
  others,
  lit,
  criteria,
  labels,
}: {
  item: QueueItem;
  reveal: Reveal | null;
  lit: string | null;
  /** The AI's other verified quotes, tinted in the text. */
  others: ReturnType<typeof otherQuotes>;
  criteria: ReadonlyArray<Criterion>;
  labels: Record<string, string>;
}) {
  const { record } = item;
  const quote = placeQuote(item.title, item.text, reveal?.quote_span);
  const mainNumber = reveal ? numberOf(criteria, reveal.criterion_id) : null;
  const mainLabel = mainNumber !== null ? String(mainNumber) : undefined;
  const tints = others.map((o) => ({ placed: placeQuote(item.title, item.text, o.span), ...o }));
  const tintsIn = (part: "title" | "text") =>
    tints.flatMap((o) => {
      const range = o.placed[part];
      return range ? [{ range, kind: o.kind, title: o.title, id: o.id, label: o.label }] : [];
    });
  // Once the AI's reading is shown, bring its quote into view.
  const marked = Boolean(reveal?.quote_span);
  useEffect(() => {
    if (!marked) return;
    document.querySelector("[data-reveal-quote]")?.scrollIntoView({ block: "nearest" });
  }, [marked]);
  const at = useMemo(() => codePointIndex(item.text), [item.text]);
  const describe = (id: string) => {
    const criterion = criteria.find((c) => c.id === id);
    return criterion
      ? `Protocol term for ${numberOf(criteria, id)}, ${labels[criterion.slot] ?? criterion.slot}`
      : "Protocol term";
  };
  const sections = orderSections(record.sections);
  // One muted line: where and when it appeared, what it is, and its identifiers.
  const meta = [
    // "Nicotine & tobacco research : official journal of the Society…" reads as its title.
    record.journal?.split(" : ")[0],
    record.year,
    publicationTypes(record.publication_types),
    ...record.registry_ids,
    record.pmid ? `PMID ${record.pmid}` : record.doi ? `DOI ${record.doi}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <article className="max-w-[880px] px-14 pt-8 pb-12" aria-label="Record">
      <p className="truncate text-xs text-ink-3" title={meta} data-testid="record-meta">
        {meta}
      </p>
      <h1
        className="mt-2 max-w-[68ch] text-xl font-semibold tracking-[-0.01em] text-balance"
        data-testid="record-title"
      >
        <Marked
          text={item.title}
          highlights={record.title_highlights}
          quote={quote.title}
          quoteLabel={mainLabel}
          quoteId={reveal?.criterion_id}
          lit={lit}
          others={tintsIn("title")}
          describe={describe}
        />
      </h1>
      {sections.length === 0 || item.text === "" ? (
        <p className="mt-6 text-md text-ink-3">
          This record has no abstract. Decide on the title, or mark it unclear.
        </p>
      ) : (
        <div className="mt-5 grid max-w-[76ch] gap-y-4">
          {sections.map((section) => (
            <section key={section.start}>
              <h2
                className={`text-xs font-semibold ${section.trailing ? "text-ink-3" : "text-ink-2"}`}
              >
                {section.label}
              </h2>
              <p className={`mt-0.5 text-md ${section.trailing ? "text-ink-3" : ""}`}>
                <Marked
                  text={item.text}
                  from={at(section.start)}
                  to={at(section.end)}
                  highlights={item.highlights}
                  quote={quote.text}
                  quoteLabel={mainLabel}
                  quoteId={reveal?.criterion_id}
                  lit={lit}
                  others={tintsIn("text")}
                  describe={describe}
                />
              </p>
            </section>
          ))}
        </div>
      )}
    </article>
  );
}

/** The AI's reading as whether the record passes the criterion, for any polarity. */
const passes = (status: string) =>
  status === "met" ? "passes" : status === "not_met" ? "fails" : "unclear";

/** The criteria in the decision column: number keys, the short label, the wording, and the AI's
 * reading of each as a glyph. Hovering a criterion lights its quote up in the record; clicking it
 * shows the AI's reasoning, or, while excluding (after e), decides on it. */
function CriteriaList({
  criteria,
  labels,
  ai,
  onLit,
  onExclude,
  armed,
  decision,
  revealed,
}: {
  criteria: ReadonlyArray<Criterion>;
  labels: Record<string, string>;
  ai: QueueItem["ai"] | null;
  onLit: (criterionId: string | null) => void;
  onExclude: (criterionId: string) => void;
  armed: boolean;
  decision: Decision | null;
  revealed: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section aria-label="Criteria" className="px-5 py-4">
      <h2 className="flex items-baseline gap-2.5 text-xs font-semibold text-ink-2">
        {ai && !armed ? (
          <span
            className="w-6 cursor-help text-center underline decoration-dotted underline-offset-2"
            title="The AI's reading of each criterion: a grey check passes, a question mark is unclear, a cross fails. Hover a criterion to light up its quote; click it for the wording and the AI's reasoning."
          >
            AI
          </span>
        ) : null}
        <span>{armed ? "Exclude on which criterion?" : "Criteria"}</span>
      </h2>
      <ol className="mt-2 grid gap-1">
        {criteria.map((criterion) => {
          const chosen =
            decision?.outcome === "exclude" && decision.reason_criterion_id === criterion.id;
          const reading = ai?.criteria.find((c) => c.criterion_id === criterion.id) ?? null;
          const expanded = open === criterion.id && reading;
          return (
            <li key={criterion.id} data-revealed={revealed === criterion.id || undefined}>
              <button
                type="button"
                title={`${criterion.text_en}\n${criterion.text_de}`}
                onMouseEnter={() => onLit(criterion.id)}
                onMouseLeave={() => onLit(null)}
                onFocus={() => onLit(criterion.id)}
                onBlur={() => onLit(null)}
                onClick={() =>
                  armed
                    ? onExclude(criterion.id)
                    : setOpen((o) => (o === criterion.id ? null : criterion.id))
                }
                aria-expanded={reading ? Boolean(expanded) : undefined}
                className={`grid w-full grid-cols-[1.5rem_auto_minmax(0,1fr)] items-center gap-x-2.5 rounded-[3px] px-2 py-1.5 text-left hover:bg-sheet ${
                  armed ? "bg-exclude-wash/60 hover:bg-exclude-wash" : ""
                } ${revealed === criterion.id ? "evidence-item" : ""}`}
              >
                <span
                  className="flex justify-center"
                  title={reading ? `AI: ${passes(reading.status)}` : undefined}
                >
                  {reading ? (
                    reading.status === "met" ? (
                      // A pass is a quiet grey check, so the unclear or failed criterion stands out.
                      <span className="text-ink-3" aria-label="AI: passes">
                        <svg width="12" height="10" viewBox="0 0 10 8" aria-hidden="true">
                          <path
                            d="M1 4.2l2.6 2.4L9 1"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    ) : (
                      <Mark term={VERDICTS[reading.status]} />
                    )
                  ) : null}
                </span>
                <span className={armed ? "text-exclude" : ""}>
                  <Key k={keyOf(criteria, criterion.id)} on={armed} />
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-sm">
                  <span className="truncate">{shortLabel(criterion)}</span>
                  {criterion.polarity === "exclude" ? (
                    <span className="text-2xs text-ink-3">exclusion</span>
                  ) : null}
                  {chosen ? <Mark term={OUTCOMES.exclude} title="Your exclusion reason" /> : null}
                </span>
              </button>
              {open === criterion.id && !armed ? (
                <div className="mt-1 mb-1.5 ml-9 rounded-[3px] bg-sheet px-3 py-2 text-xs">
                  <p className="text-ink-2">{criterion.text_en}</p>
                </div>
              ) : null}
              {expanded ? (
                <div className="mt-1 mb-1.5 ml-9 rounded-[3px] bg-sheet px-3 py-2">
                  <AiReading
                    compact
                    criterion={{
                      number: numberOf(criteria, criterion.id),
                      label: labels[criterion.slot] ?? criterion.slot,
                      text: null,
                    }}
                    status={reading.status}
                    downgradedFrom={reading.downgraded_from}
                    rationale={reading.rationale}
                    quote={reading.quote || null}
                    verified={reading.quote_verified}
                    marked={false}
                    markedAt={ai?.quote_spans[criterion.id] ? "Highlighted in the record." : null}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function RevealBanner({
  reveal,
  decision,
  criteria,
  labels,
  settled,
}: {
  reveal: Reveal;
  decision: Decision | null;
  criteria: ReadonlyArray<Criterion>;
  labels: Record<string, string>;
  settled: boolean;
}) {
  const index = criteria.findIndex((c) => c.id === reveal.criterion_id);
  const criterion = criteria[index];
  // With `reveal: always` the judge can also agree; say which.
  const excludes = reveal.status === "not_met";
  const agrees = decision !== null && (decision.outcome === "exclude") === excludes;
  const span = reveal.quote_span;
  return (
    <section
      aria-label="AI judge"
      data-testid="ai-reveal"
      className="reveal-enter evidence-item max-h-[40vh] overflow-y-auto border-b border-rule px-4 pt-2 pb-2.5"
    >
      <div className="flex items-baseline gap-4">
        <h2 className="text-sm font-semibold">
          {agrees ? "The AI judge agrees" : "The AI judge disagrees"}
        </h2>
        {settled ? null : (
          <span className="ml-auto flex flex-none items-center gap-4 text-sm">
            <KeyHint keys={[" "]}>Keep yours</KeyHint>
            <KeyHint keys={["i", "e", "u"]}>Change it</KeyHint>
          </span>
        )}
      </div>
      <div className="mt-1">
        <AiReading
          criterion={{
            number: criterion ? numberOf(criteria, criterion.id) : null,
            label: criterion ? (labels[criterion.slot] ?? criterion.slot) : reveal.criterion_id,
            text: criterion?.text_en ?? null,
          }}
          status={reveal.status}
          downgradedFrom={reveal.downgraded_from}
          rationale={reveal.rationale}
          quote={reveal.quote || null}
          verified={reveal.quote_verified ?? false}
          markedAt={
            span
              ? span.part === "title"
                ? "Marked in the title."
                : "Marked in the abstract."
              : null
          }
        />
      </div>
    </section>
  );
}

function DecisionNote({
  label,
  decision,
  criteria,
  muted,
}: {
  label: string;
  decision: Decision;
  criteria: ReadonlyArray<Criterion>;
  muted?: boolean;
}) {
  const term = OUTCOMES[decision.outcome];
  const index = criteria.findIndex((c) => c.id === decision.reason_criterion_id);
  return (
    <span
      className={`flex items-center gap-2 ${muted ? "opacity-75" : ""}`}
      data-testid="decision-note"
    >
      <span className="text-ink-3">{label}</span>
      <Status term={term}>
        {term.past}
        {index >= 0 ? ` on ${numberOf(criteria, decision.reason_criterion_id)}` : ""}
      </Status>
    </span>
  );
}

function Finished({ stats, status }: { stats: SessionStats; status: ScopeStatus | null }) {
  const { project } = useProject();
  const params = { projectId: project.id };
  // Session figures only once the session has decided something.
  const session: ReadonlyArray<readonly [string, ReactNode]> = stats.decided
    ? [
        ["Decided in this session", stats.decided],
        [
          "Median time per record, this session",
          stats.medianSeconds === null ? "–" : `${Math.round(stats.medianSeconds)} s`,
        ],
        ["AI disagreements shown, this session", stats.revealsShown],
        ["Decisions changed after seeing an AI disagreement", stats.revealsFollowed],
      ]
    : [];
  return (
    <EmptyState
      title="Your title and abstract queue is done"
      testId="queue-finished"
      figures={[["Records you decided in this stage", status ? status.screened : "–"], ...session]}
      actions={
        <>
          <Link
            to="/p/$projectId/screening/table"
            params={params}
            className="rounded-[4px] bg-petrol px-3 py-1.5 text-sm font-medium text-petrol-ink hover:brightness-110"
          >
            Review your decisions in the table
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
      Every record assigned to you at title and abstract has a decision.
      {stats.decided ? " The session figures are only yours." : ""}
    </EmptyState>
  );
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[640px] px-10 py-16">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-md text-ink-2">{children}</p>
    </div>
  );
}

// MEDLINE adds funding and indexing types; the reviewer needs the design types.
const NOISE =
  /^(Journal Article|JOUR|Research Support|Comparative Study|Multicenter Study|English Abstract)/;
const publicationTypes = (types: ReadonlyArray<string>) =>
  types.filter((t) => !NOISE.test(t)).join(", ") || "Journal article";
