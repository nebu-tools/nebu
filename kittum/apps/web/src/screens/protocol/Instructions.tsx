// A search topic's screening instructions in the protocol editor (DESIGN.md, "Screening and the
// AI judge"): the judge's strictness and the team's guidance, shown inside the full prompt with
// everything else greyed out, because it is fixed (the statuses, the quote rules, the rules that
// the record is data, the record's tag, the schema). The test bench runs the draft's
// instructions on the topic's known includes and records people have settled, and lists what
// would flip, known includes first. Publishing the draft and re-judging the stage from its table
// makes the instructions count.
import { useRouteContext } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import type { BenchResult, PromptTemplate, ProtocolSource, StageInfo } from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { usePoll } from "../../ui/poll.ts";
import { useProject } from "../project.tsx";
import type { Topic } from "./document.ts";

export type Strictness = "conservative" | "decisive";

const STRICTNESS: Record<Strictness, { label: string; summary: string }> = {
  conservative: {
    label: "Conservative",
    summary: "Excludes only what a record certainly fails. When in doubt, unclear.",
  },
  decisive: {
    label: "Decisive",
    summary: "Also excludes what a record makes improbable, not only impossible.",
  },
};

const STAGES = { title_abstract: "Title and abstract", full_text: "Full text" } as const;

/** The topic's instructions, with the defaults left out as the server leaves them out. */
const judgeOf = (topic: Topic) => ({
  strictness: (topic.judge?.strictness as Strictness | undefined) ?? "conservative",
  guidance: topic.judge?.guidance ?? "",
});

export function Instructions({
  topic,
  disabled,
  source,
  onChange,
}: {
  topic: Topic;
  disabled: boolean;
  /** The draft as the server compiles it, for the bench. */
  source: () => ProtocolSource;
  onChange: (judge: { strictness: Strictness; guidance: string }) => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const [template, setTemplate] = useState<PromptTemplate | null>(null);
  const [shownStage, setShownStage] = useState<keyof typeof STAGES>("title_abstract");
  const [open, setOpen] = useState(false);
  const judge = judgeOf(topic);

  useEffect(() => {
    let live = true;
    run(workbench.promptTemplate()).then(
      (t) => live && setTemplate(t),
      () => live && setTemplate(null),
    );
    return () => {
      live = false;
    };
  }, [workbench]);

  const rules = template?.stage_rules;
  const [frameHead, frameTail] = (template?.guidance_frame ?? "{guidance}").split("{guidance}");
  return (
    <section className="mt-6" data-testid="instructions" aria-label="Screening instructions">
      <h3 className="text-md font-semibold">Screening instructions for the AI</h3>
      <p className="mt-1 text-sm text-ink-2">
        How strictly the AI reads this topic's records, and guidance in your own words. Either way
        it must quote the record to answer not met, and people decide every record.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Strictness">
        {(Object.keys(STRICTNESS) as Strictness[]).map((value) => (
          <label
            key={value}
            className={`grid cursor-pointer gap-0.5 rounded-[3px] border px-2.5 py-1.5 text-sm ${judge.strictness === value ? "border-petrol bg-petrol-wash" : "border-rule-strong"}`}
          >
            <span className="flex items-center gap-1.5 font-semibold">
              <input
                type="radio"
                name={`strictness-${topic.id}`}
                value={value}
                checked={judge.strictness === value}
                disabled={disabled}
                onChange={() => onChange({ ...judge, strictness: value })}
              />
              {STRICTNESS[value].label}
            </span>
            <span className="text-xs text-ink-2">{STRICTNESS[value].summary}</span>
          </label>
        ))}
      </div>
      <label className="mt-3 grid gap-1">
        <span className="text-xs font-semibold text-ink-2">Guidance for the AI (optional)</span>
        <textarea
          aria-label="Guidance for the AI"
          className="min-h-[64px] w-full rounded-[3px] border border-rule-strong bg-sheet px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-3 focus-visible:border-petrol focus-visible:outline-none disabled:opacity-60"
          placeholder="Count e-cigarettes with nicotine as nicotine replacement."
          value={judge.guidance}
          disabled={disabled}
          maxLength={4000}
          onChange={(e) => onChange({ ...judge, guidance: e.currentTarget.value })}
        />
      </label>
      <button
        type="button"
        className="mt-2 text-sm text-petrol hover:underline"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? "Hide the full prompt" : "Show the full prompt"}
      </button>
      {open ? (
        <div className="mt-2 rounded-[3px] border border-rule bg-sheet-2" data-testid="full-prompt">
          <div className="flex items-center gap-2 border-b border-rule px-2.5 py-1 text-xs">
            <span className="text-ink-3">At</span>
            {(Object.keys(STAGES) as (keyof typeof STAGES)[]).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={shownStage === s}
                className={
                  shownStage === s ? "font-semibold text-ink" : "text-ink-2 hover:text-ink"
                }
                onClick={() => setShownStage(s)}
              >
                {STAGES[s]}
              </button>
            ))}
            <span className="ml-auto text-ink-3">
              Grey parts are fixed.{" "}
              {template ? `${template.prompt_version}, ${template.instructions_version}` : ""}
            </span>
          </div>
          {template && rules ? (
            <div className="grid gap-0 px-2.5 py-2 font-mono text-2xs leading-[16px] whitespace-pre-wrap">
              <Fixed text={template.system_before} />
              <div
                className="my-1 rounded-[2px] border-l-2 border-petrol bg-sheet px-2 py-1 text-ink"
                data-testid="prompt-stage-rule"
              >
                <span className="mb-0.5 block font-sans text-2xs font-semibold text-petrol">
                  Stage rule: {STRICTNESS[judge.strictness].label.toLowerCase()} (chosen above)
                </span>
                {rules[judge.strictness]?.[shownStage]}
              </div>
              {judge.guidance.trim() ? (
                <div className="my-1">
                  <Fixed text={frameHead ?? ""} />
                  <div className="rounded-[2px] border-l-2 border-petrol bg-sheet px-2 py-1 text-ink">
                    {judge.guidance.trim()}
                  </div>
                  <Fixed text={frameTail ?? ""} />
                </div>
              ) : null}
              <Fixed text={template.system_after} />
              <span className="mt-2 block font-sans text-2xs font-semibold text-ink-3">
                User message, filled in per record
              </span>
              <Fixed text={template.user_template} />
            </div>
          ) : (
            <p className="px-2.5 py-2 text-xs text-ink-3">The prompt is not available.</p>
          )}
        </div>
      ) : null}
      <Bench topicId={topic.id} source={source} />
    </section>
  );
}

function Fixed({ text }: { text: string }) {
  return <span className="text-ink-3">{text}</span>;
}

const proposal = (p: BenchResult["rows"][number]["draft"]) =>
  !p
    ? "Not read"
    : p.outcome === "include"
      ? "Include"
      : `Exclude on ${p.reason_criterion_id ?? "?"}${p.verified === false ? ", unverified" : ""}`;

function Bench({ topicId, source }: { topicId: string; source: () => ProtocolSource }) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, seesLeadData, scopeLabel } = useProject();
  const stages = project.stages.filter((s: StageInfo) => s.topic_id === topicId);
  const [stageId, setStageId] = useState<string>(() => stages[0]?.stage_id ?? "");
  const [result, setResult] = useState<BenchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const caller = { projectId: project.id, as: me.actor_id };
  const running = result?.state === "running";

  const benchId = result?.bench_id ?? null;
  const tick = useCallback(() => {
    if (!benchId) return;
    run(workbench.bench({ projectId: project.id, as: me.actor_id, benchId })).then(
      setResult,
      () => undefined, // the next tick tries again
    );
  }, [workbench, project.id, me.actor_id, benchId]);
  usePoll(running, tick, 2000);

  if (!seesLeadData) return null;
  if (stages.length === 0) {
    return (
      <p className="mt-3 text-sm text-ink-3" data-testid="bench">
        Test bench: open a screening stage for this topic first. The bench tries the instructions on
        its known includes and on records people have decided.
      </p>
    );
  }
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await run(workbench.runBench({ ...caller, stageId, source: source() })));
    } catch (e) {
      setError(e instanceof WorkbenchError ? e.message : "The bench did not start.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 rounded-[3px] border border-rule px-3 py-2" data-testid="bench">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">Test bench</span>
        <select
          aria-label="Stage for the bench"
          className="h-7 rounded-[2px] border border-rule-strong bg-sheet px-1 text-xs"
          value={stageId}
          onChange={(e) => setStageId(e.currentTarget.value)}
        >
          {stages.map((s) => (
            <option key={s.stage_id} value={s.stage_id}>
              {scopeLabel(s.scope_id)} · {STAGES[s.stage]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded-[3px] border border-rule-strong bg-sheet px-2 py-0.5 text-xs hover:bg-sheet-2 disabled:opacity-50"
          disabled={busy || running}
          onClick={() => void start()}
        >
          {running ? "Reading…" : "Run the draft's instructions"}
        </button>
        <span className="text-xs text-ink-3">
          On the topic's known includes and up to 50 records people have decided. The readings stay
          on the bench.
        </span>
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-exclude">
          {error}
        </p>
      ) : null}
      {result ? <BenchTable result={result} /> : null}
    </div>
  );
}

function BenchTable({ result }: { result: BenchResult }) {
  if (result.state === "failed") {
    return (
      <p role="alert" className="mt-2 text-xs text-exclude">
        The bench failed: {result.error ?? "the judge gave no answer"}.
      </p>
    );
  }
  return (
    <div className="mt-2 text-xs" data-testid="bench-result">
      <p className={result.known_proposed_exclude ? "text-exclude" : "text-ink-2"}>
        {result.state === "running"
          ? `The AI reads ${result.records} records with the draft…`
          : `${result.records} records read: ${result.flips} would flip against the current reading, ${result.against_human} against people's decisions.`}
        {result.known
          ? ` The draft proposes to exclude ${result.known_proposed_exclude} of ${result.known} known includes.`
          : " The topic has no known include among the records."}
      </p>
      <table className="mt-1 w-full border-collapse">
        <thead>
          <tr className="border-b border-rule-strong text-left text-ink-3">
            <th className="py-0.5 pr-2 font-normal">Record</th>
            <th className="pr-2 font-normal">People</th>
            <th className="pr-2 font-normal">Now</th>
            <th className="pr-2 font-normal">With the draft</th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr
              key={r.item_ref}
              className={`border-b border-rule ${r.flip || r.against_human ? "" : "text-ink-3"}`}
              data-flip={r.flip || undefined}
            >
              <td className="max-w-[360px] truncate py-0.5 pr-2" title={r.title}>
                {r.known_include ? <b className="mr-1 text-petrol">Known include</b> : null}
                {r.title}
              </td>
              <td className="pr-2">{r.human ?? "Not settled"}</td>
              <td className="pr-2">{proposal(r.current)}</td>
              <td className={`pr-2 ${r.flip ? "font-semibold" : ""}`}>
                {proposal(r.draft)}
                {r.flip ? " · flips" : ""}
                {r.against_human ? " · against people" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
