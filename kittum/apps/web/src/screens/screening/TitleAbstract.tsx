// The title and abstract queue (DESIGN.md, "Reviewer workbench"): one record, the criteria strip,
// and nothing from the AI until the reviewer has decided.
import { useRouteContext, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { Criterion, Decision, QueueItem, Reveal, ScopeStatus } from "../../data/schema.ts";
import { run } from "../../data/workbench.ts";
import { codePointIndex } from "../../lib/codepoints.ts";
import { Key, KeyHint } from "../../ui/Key.tsx";
import { useKeys } from "../../ui/keys.ts";
import { Mark, OUTCOMES, Status } from "../../ui/Status.tsx";
import { useProject } from "../project.tsx";
import { AiReading } from "./AiReading.tsx";
import { shortLabel } from "./criteria.ts";
import { Marked, orderSections, placeQuote } from "./RecordText.tsx";
import { AiBefore, AskSecondOpinion, beforeQuote, SecondOpinionAsked } from "./Targeted.tsx";
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
  const [fullCriteria, setFullCriteria] = useState(false);
  // Working topics: the prompt the AI reads the record with, one key away (p).
  const [promptOpen, setPromptOpen] = useState(false);
  const working = stage?.documentation === "working";
  // Mode S, key f: the next decision asks a colleague, with this comment.
  const [asking, setAsking] = useState<{ comment: string; typing: boolean } | null>(null);
  const ask = asking && !asking.typing ? { comment: asking.comment } : null;
  const [status, setStatus] = useState<ScopeStatus | null>(null);
  const [poll, setPoll] = useState(0);
  const { current } = queue;
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

  useKeys((event) => {
    if (event.repeat) return true;
    const key = event.key;
    if (!current) {
      // Nothing on screen (finished, or waiting for the AI): the last decision can still reopen.
      if (key !== "Backspace") return false;
      queue.undo();
      return true;
    }
    if (armed) {
      setArmed(false);
      if (/^[1-9]$/.test(key)) {
        const criterion = criteria[Number(key) - 1];
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
      case "c":
        setFullCriteria((on) => !on);
        return true;
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
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto]">
      <QueueBar scopeLabel={`${labels.scope} ${scopeLabel(scopeId)}`} status={status} />
      <div className="overflow-y-auto bg-sheet" data-testid="record-scroll">
        {current ? (
          <RecordView
            key={current.item.assignment_id}
            item={current.item}
            reveal={current.reveal ?? beforeQuote(current.item)}
            criteria={criteria}
            labels={labels}
          />
        ) : waiting ? (
          <p className="px-10 py-10 text-ink-2" data-testid="queue-waiting">
            The AI judge has not read {status?.remaining} of your records yet. Each record appears
            here once the judge has read it.
          </p>
        ) : queue.finished && status !== null ? (
          // Finished only once the counts say nothing is left, not before they arrive.
          <Finished stats={queue.stats} />
        ) : queue.error ? null : (
          <p className="px-10 py-10 text-ink-3">Loading the queue.</p>
        )}
      </div>
      <footer className="border-t border-rule-strong bg-sheet-2">
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
            marked={beforeQuote(current.item)?.criterion_id ?? null}
          />
        ) : null}
        {current && working && stage ? (
          <ShowPrompt
            caller={caller}
            stageId={stage.stage_id}
            assignmentId={current.item.assignment_id}
            open={promptOpen}
            onToggle={() => setPromptOpen((on) => !on)}
          />
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
        <CriteriaStrip
          criteria={criteria}
          armed={armed}
          full={armed || fullCriteria}
          decision={current?.decision ?? null}
          revealed={current?.reveal?.criterion_id ?? null}
        />
        <div className="flex h-10 items-center gap-5 border-t border-rule px-4 text-sm">
          <KeyHint keys={["i"]}>{OUTCOMES.include.label}</KeyHint>
          <span className="text-exclude">
            <KeyHint keys={["e"]} on={armed}>
              {armed
                ? `Now press 1 to ${criteria.length} for the criterion`
                : `${OUTCOMES.exclude.label} on a criterion`}
            </KeyHint>
          </span>
          <KeyHint keys={["u"]}>{OUTCOMES.unclear.label}</KeyHint>
          {stage?.mode === "S" ? (
            <KeyHint keys={["f"]} on={Boolean(asking)}>
              {asking ? "Asking for a second opinion" : "Second opinion"}
            </KeyHint>
          ) : null}
          <KeyHint keys={["Backspace"]}>Undo</KeyHint>
          <KeyHint keys={[" "]}>
            {current?.reveal && !current.settled ? "Keep and next" : "Next"}
          </KeyHint>
          <KeyHint keys={["c"]} muted>
            {fullCriteria ? "Short criteria" : "Full criteria"}
          </KeyHint>
          <span className="ml-auto flex min-w-0 items-center gap-3" aria-live="polite">
            {queue.error ? (
              <span role="alert" className="text-exclude">
                {queue.error}
              </span>
            ) : queue.notice ? (
              <span className="truncate text-ink-2">{queue.notice}</span>
            ) : null}
            {current?.decision ? (
              <DecisionNote label="Your decision" decision={current.decision} criteria={criteria} />
            ) : queue.previous?.decision && !queue.notice ? (
              <DecisionNote
                label="Previous record"
                decision={queue.previous.decision}
                criteria={criteria}
                muted
              />
            ) : null}
          </span>
        </div>
      </footer>
    </div>
  );
}

function QueueBar({ scopeLabel, status }: { scopeLabel: string; status: ScopeStatus | null }) {
  return (
    <div className="flex h-9 items-center gap-4 border-b border-rule bg-paper px-4 text-xs">
      <span className="truncate text-ink-2" title={scopeLabel}>
        {scopeLabel}
      </span>
      <span className="ml-auto whitespace-nowrap text-ink-3">
        {status ? `${status.screened} screened, ${status.remaining} left` : ""}
      </span>
    </div>
  );
}

function RecordView({
  item,
  reveal,
  criteria,
  labels,
}: {
  item: QueueItem;
  reveal: Reveal | null;
  criteria: ReadonlyArray<Criterion>;
  labels: Record<string, string>;
}) {
  const { record } = item;
  const quote = placeQuote(item.title, item.text, reveal?.quote_span);
  // Once the AI's reading is shown, bring its quote into view.
  const marked = Boolean(reveal?.quote_span);
  useEffect(() => {
    if (!marked) return;
    document.querySelector("[data-reveal-quote]")?.scrollIntoView({ block: "nearest" });
  }, [marked]);
  const at = useMemo(() => codePointIndex(item.text), [item.text]);
  const describe = (id: string) => {
    const index = criteria.findIndex((c) => c.id === id);
    const criterion = criteria[index];
    return criterion
      ? `Protocol term for ${index + 1}, ${labels[criterion.slot] ?? criterion.slot}`
      : "Protocol term";
  };
  const sections = orderSections(record.sections);
  // One muted line: where and when it appeared, what it is, and its identifiers.
  const meta = [
    record.journal,
    record.year,
    publicationTypes(record.publication_types),
    ...record.registry_ids,
    record.pmid ? `PMID ${record.pmid}` : record.doi ? `DOI ${record.doi}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <article className="mx-auto max-w-[900px] px-10 pt-7 pb-10" aria-label="Record">
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
          describe={describe}
        />
      </h1>
      {sections.length === 0 || item.text === "" ? (
        <p className="mt-6 text-md text-ink-3">
          This record has no abstract. Decide on the title, or mark it unclear.
        </p>
      ) : (
        <div className="mt-5 grid grid-cols-[8.5rem_minmax(0,72ch)] gap-x-6 gap-y-3.5">
          {sections.map((section) => (
            <section key={section.start} className="contents">
              <h2
                className={`narrow pt-[3px] text-right text-xs font-semibold ${section.trailing ? "text-ink-3" : "text-ink-2"}`}
              >
                {section.label}
              </h2>
              <p className={`text-md ${section.trailing ? "text-ink-3" : ""}`}>
                <Marked
                  text={item.text}
                  from={at(section.start)}
                  to={at(section.end)}
                  highlights={item.highlights}
                  quote={quote.text}
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

function CriteriaStrip({
  criteria,
  armed,
  full,
  decision,
  revealed,
}: {
  criteria: ReadonlyArray<Criterion>;
  armed: boolean;
  /** The full wording of every criterion, on demand (c) or while choosing one to exclude on. */
  full: boolean;
  decision: Decision | null;
  revealed: string | null;
}) {
  return (
    <ol
      aria-label="Criteria"
      className={
        full ? "grid" : "flex h-8 items-center gap-x-4 overflow-hidden px-4 text-xs text-ink-2"
      }
      style={full ? { gridTemplateColumns: `repeat(${criteria.length}, minmax(0, 1fr))` } : {}}
    >
      {criteria.map((criterion, index) => {
        const chosen =
          decision?.outcome === "exclude" && decision.reason_criterion_id === criterion.id;
        return (
          <li
            key={criterion.id}
            data-revealed={revealed === criterion.id || undefined}
            title={`${criterion.text_en}\n${criterion.text_de}`}
            className={
              full
                ? `border-r border-rule px-3 pt-2 pb-2.5 last:border-r-0 ${
                    revealed === criterion.id ? "evidence-item" : ""
                  } ${armed ? "shadow-[inset_0_2px_0_var(--exclude)]" : ""}`
                : `flex items-center gap-1.5 whitespace-nowrap ${
                    revealed === criterion.id ? "evidence-item px-1" : ""
                  }`
            }
          >
            <span className={`flex items-center gap-1.5 ${armed ? "text-exclude" : ""}`}>
              <Key k={String(index + 1)} on={armed} />
              <span className={full ? "text-2xs text-ink-3" : ""}>{shortLabel(criterion)}</span>
              {chosen ? <Mark term={OUTCOMES.exclude} title="Your exclusion reason" /> : null}
            </span>
            {full ? (
              <p className={`narrow mt-1 text-xs ${armed ? "text-ink" : "text-ink-2"}`}>
                {criterion.text_en}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
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
            number: criterion ? index + 1 : null,
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
        {index >= 0 ? ` on ${index + 1}` : ""}
      </Status>
    </span>
  );
}

function Finished({ stats }: { stats: SessionStats }) {
  return (
    <div className="mx-auto max-w-[640px] px-10 py-16">
      <h1 className="text-xl font-semibold">Queue finished</h1>
      <p className="mt-2 text-md text-ink-2">
        You have decided every record assigned to you at title and abstract. Only you see these
        figures for your session.
      </p>
      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-8 gap-y-2 text-md">
        <dt className="text-ink-2">Records decided</dt>
        <dd>{stats.decided}</dd>
        <dt className="text-ink-2">Median time per record</dt>
        <dd>{stats.medianSeconds === null ? "None" : `${Math.round(stats.medianSeconds)} s`}</dd>
        <dt className="text-ink-2">AI disagreements shown</dt>
        <dd>{stats.revealsShown}</dd>
        <dt className="text-ink-2">Decisions you changed after one</dt>
        <dd>{stats.revealsFollowed}</dd>
      </dl>
    </div>
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
  /^(Journal Article|Research Support|Comparative Study|Multicenter Study|English Abstract)/;
const publicationTypes = (types: ReadonlyArray<string>) =>
  types.filter((t) => !NOISE.test(t)).join(", ") || "Journal article";
