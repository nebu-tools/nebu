// A search topic's screening instructions in the protocol editor (DESIGN.md, "Screening and the
// AI judge"): the judge's strictness and the team's guidance, shown inside the full prompt. The
// team may also rewrite the whole prompt: the system message (where {stage_rule} takes the stage
// rule and the guidance) and the user message (which must keep {criteria} and {text}). The
// protocol's versions keep every wording, and Reset goes back to Kittum's. The answer schema and
// the quote check stay whatever the wording. The test bench runs the draft's
// instructions on the topic's known includes and records people have settled, and lists what
// would flip, known includes first. Publishing the draft and re-judging the stage from its table
// makes the instructions count.
import { useRouteContext } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import type { BenchResult, PromptTemplate, ProtocolSource, StageInfo } from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { keyWords } from "../../lib/labels.ts";
import { Button } from "../../ui/Button.tsx";
import { usePoll } from "../../ui/poll.ts";
import { Help } from "../../ui/Help.tsx";
import { useProject } from "../project.tsx";
import type { Topic } from "./document.ts";

type Strictness = "conservative" | "decisive";

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

export type Judge = {
  strictness: Strictness;
  guidance: string;
  /** The team's own system message, or null for Kittum's. */
  system_prompt: string | null;
  /** The team's own user message template, or null for Kittum's. */
  user_template: string | null;
};

/** The topic's instructions, with the defaults left out as the server leaves them out. */
const judgeOf = (topic: Topic): Judge => ({
  strictness: (topic.judge?.strictness as Strictness | undefined) ?? "conservative",
  guidance: topic.judge?.guidance ?? "",
  system_prompt: topic.judge?.system_prompt ?? null,
  user_template: topic.judge?.user_template ?? null,
});

const PROMPT_FIELD =
  "w-full rounded-[3px] border border-rule-strong bg-sheet px-2.5 py-1.5 font-mono text-2xs leading-[16px] text-ink focus-visible:border-petrol focus-visible:outline-none disabled:opacity-60";

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
  onChange: (judge: Judge) => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const [template, setTemplate] = useState<PromptTemplate | null>(null);
  const [shownStage, setShownStage] = useState<keyof typeof STAGES>("title_abstract");
  const judge = judgeOf(topic);
  const own = judge.system_prompt !== null || judge.user_template !== null;
  const [open, setOpen] = useState(own);
  const [editing, setEditing] = useState(own);

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
    <section
      id={`form-instructions-${topic.id}`}
      className="mt-7 scroll-mt-8"
      data-testid="instructions"
      aria-label="Screening instructions"
    >
      <h3 className="text-md font-semibold">
        <Help text="How strictly the AI reads this topic’s records. Either way it must quote the record to answer not met, and people decide every record.">
          Screening instructions for the AI
        </Help>
      </h3>
      <div className="mt-2.5 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Strictness">
        {(Object.keys(STRICTNESS) as Strictness[]).map((value) => (
          <label
            key={value}
            className={`grid cursor-pointer gap-0.5 rounded-[4px] border px-3 py-2 text-sm ${judge.strictness === value ? "border-petrol bg-petrol-wash" : "border-rule-strong hover:border-ink-3"}`}
          >
            <span className="flex items-center gap-2 font-semibold">
              <input
                type="radio"
                name={`strictness-${topic.id}`}
                value={value}
                checked={judge.strictness === value}
                disabled={disabled}
                onChange={() => onChange({ ...judge, strictness: value })}
                className="accent-[var(--petrol)]"
              />
              {STRICTNESS[value].label}
            </span>
            <span className="pl-[21px] text-sm text-ink-2">{STRICTNESS[value].summary}</span>
          </label>
        ))}
      </div>
      <label className="mt-4 grid gap-1">
        <span className="text-sm font-semibold text-ink-2">Guidance for the AI (optional)</span>
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
      {own && !open ? (
        <span className="ml-2 text-xs text-ink-2">This topic uses its own prompt wording.</span>
      ) : null}
      {open ? (
        <div className="mt-2 rounded-[3px] border border-rule bg-sheet-2" data-testid="full-prompt">
          <div className="flex flex-wrap items-center gap-2 border-b border-rule px-2.5 py-1 text-xs">
            {editing ? (
              <span className="font-semibold text-ink">
                {own ? "Your own wording" : "Kittum's wording, ready to edit"}
              </span>
            ) : (
              <>
                <span className="text-ink-3">At</span>
                {(Object.keys(STAGES) as (keyof typeof STAGES)[]).map((st) => (
                  <button
                    key={st}
                    type="button"
                    aria-pressed={shownStage === st}
                    className={
                      shownStage === st ? "font-semibold text-ink" : "text-ink-2 hover:text-ink"
                    }
                    onClick={() => setShownStage(st)}
                  >
                    {STAGES[st]}
                  </button>
                ))}
              </>
            )}
            <span className="ml-auto flex items-center gap-3">
              {!editing ? (
                <span className="text-ink-3">
                  Grey parts are Kittum's wording.{" "}
                  {template ? `${template.prompt_version}, ${template.instructions_version}` : ""}
                </span>
              ) : null}
              {own ? (
                <button
                  type="button"
                  className="text-petrol hover:underline disabled:opacity-50"
                  disabled={disabled}
                  onClick={() => {
                    onChange({ ...judge, system_prompt: null, user_template: null });
                    setEditing(false);
                  }}
                >
                  Reset to Kittum's prompt
                </button>
              ) : (
                <button
                  type="button"
                  className="text-petrol hover:underline disabled:opacity-50"
                  disabled={disabled || !template}
                  onClick={() => setEditing((e) => !e)}
                  aria-pressed={editing}
                >
                  {editing ? "Done" : "Edit the whole prompt"}
                </button>
              )}
            </span>
          </div>
          {template && rules && editing ? (
            <EditPrompt template={template} judge={judge} disabled={disabled} onChange={onChange} />
          ) : template && rules ? (
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
      <Bench topic={topic} source={source} />
    </section>
  );
}

/** The whole prompt as two text fields. A field equal to Kittum's wording is stored as null, so
 * a topic that edits nothing keeps Kittum's prompt and its content hash. */
function EditPrompt({
  template,
  judge,
  disabled,
  onChange,
}: {
  template: PromptTemplate;
  judge: Judge;
  disabled: boolean;
  onChange: (judge: Judge) => void;
}) {
  const kittumSystem = `${template.system_before}{stage_rule}${template.system_after}`;
  const system = judge.system_prompt ?? kittumSystem;
  const user = judge.user_template ?? template.user_template;
  const missing = ["{criteria}", "{text}"].filter((p) => !user.includes(p));
  return (
    <div className="grid gap-2 px-2.5 py-2">
      <p className="text-xs text-ink-2">
        <code>{"{stage_rule}"}</code> takes the stage rule and your guidance from above. The user
        message must keep <code>{"{criteria}"}</code> and <code>{"{text}"}</code>;{" "}
        <code>{"{stage}"}</code>, <code>{"{title}"}</code>, and <code>{"{tag}"}</code> are optional.
        Kittum still checks every quote and reads the answer in its fixed format. Each published
        version keeps its wording.
      </p>
      <label className="grid gap-1">
        <span className="text-xs font-semibold text-ink-2">System message</span>
        <textarea
          aria-label="System message"
          className={`${PROMPT_FIELD} min-h-[260px]`}
          value={system}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => {
            const v = e.currentTarget.value;
            onChange({ ...judge, system_prompt: v === kittumSystem || !v.trim() ? null : v });
          }}
        />
      </label>
      <label className="grid gap-1">
        <span className="text-xs font-semibold text-ink-2">User message, filled in per record</span>
        <textarea
          aria-label="User message"
          className={`${PROMPT_FIELD} min-h-[140px]`}
          value={user}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => {
            const v = e.currentTarget.value;
            onChange({
              ...judge,
              user_template: v === template.user_template || !v.trim() ? null : v,
            });
          }}
        />
      </label>
      {missing.length ? (
        <p className="text-xs text-exclude" role="alert">
          The user message needs {missing.join(" and ")}. Kittum puts the criteria and the record
          there.
        </p>
      ) : null}
    </div>
  );
}

function Fixed({ text }: { text: string }) {
  return <span className="text-ink-3">{text}</span>;
}

/** A proposal in words; a criterion by its number in the topic, its ID on hover. */
const proposal = (p: BenchResult["rows"][number]["draft"], criteria: ReadonlyArray<string>) => {
  if (!p) return "Not read";
  if (p.outcome === "include") return "Include";
  const n = p.reason_criterion_id ? criteria.indexOf(p.reason_criterion_id) + 1 : 0;
  return `Exclude on ${n ? `criterion ${n}` : (p.reason_criterion_id ?? "no criterion")}${p.verified === false ? ", unverified" : ""}`;
};

function Bench({ topic, source }: { topic: Topic; source: () => ProtocolSource }) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, seesLeadData, scopes } = useProject();
  const stages = project.stages.filter((s: StageInfo) => s.topic_id === topic.id);
  const [stageId, setStageId] = useState<string>(() => stages[0]?.stage_id ?? "");
  const [result, setResult] = useState<BenchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const caller = { projectId: project.id, as: me.actor_id };
  const running = result?.state === "running";
  const criteria = topic.criteria.map((c) => c.id);

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
      <p
        id={`bench-${topic.id}`}
        className="mt-4 scroll-mt-8 text-sm text-ink-2"
        data-testid="bench"
      >
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
  // A stage by its question's number, as the scope's label is often the whole question.
  const stageName = (s: StageInfo) => {
    const index = scopes.findIndex((x) => x.id === s.scope_id);
    return `${index >= 0 ? `Question ${index + 1}` : s.scope_id}, ${STAGES[s.stage].toLowerCase()}`;
  };
  return (
    <div
      id={`bench-${topic.id}`}
      className="mt-5 min-w-0 scroll-mt-8 rounded-[4px] bg-sheet-2 px-4 py-3"
      data-testid="bench"
    >
      <h4 className="text-sm font-semibold">
        <Help text="Runs the draft’s instructions on the topic’s known includes and up to 50 records people have decided. The readings stay on the bench and change nothing.">
          Test bench
        </Help>
      </h4>
      <div className="mt-2.5 flex min-w-0 items-center gap-2">
        <select
          aria-label="Stage for the bench"
          className="h-8 min-w-0 flex-1 truncate rounded-[3px] border border-rule-strong bg-sheet px-2 text-sm"
          value={stageId}
          title={(() => {
            const s = stages.find((x) => x.stage_id === stageId);
            return s
              ? `${scopes.find((x) => x.id === s.scope_id)?.label ?? s.scope_id}`
              : undefined;
          })()}
          onChange={(e) => setStageId(e.currentTarget.value)}
        >
          {stages.map((s) => (
            <option key={s.stage_id} value={s.stage_id}>
              {stageName(s)}
            </option>
          ))}
        </select>
        <Button disabled={busy || running} onClick={() => void start()}>
          {running ? "Reading…" : "Run the draft's instructions"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-sm text-exclude">
          {error}
        </p>
      ) : null}
      {result ? <BenchTable result={result} criteria={criteria} /> : null}
    </div>
  );
}

function BenchTable({
  result,
  criteria,
}: {
  result: BenchResult;
  criteria: ReadonlyArray<string>;
}) {
  if (result.state === "failed") {
    return (
      <p role="alert" className="mt-2 text-sm text-exclude">
        The bench failed: {result.error ?? "the judge gave no answer"}.
      </p>
    );
  }
  return (
    <div className="mt-3 text-sm" data-testid="bench-result">
      <p className={result.known_proposed_exclude ? "text-exclude" : "text-ink-2"}>
        {result.state === "running"
          ? `The AI reads ${result.records} records with the draft…`
          : `${result.records} records read: ${result.flips} would flip against the current reading, ${result.against_human} against people's decisions.`}
        {result.known
          ? ` The draft proposes to exclude ${result.known_proposed_exclude} of ${result.known} known includes.`
          : " The topic has no known include among the records."}
      </p>
      <table className="mt-2 w-full table-fixed border-collapse">
        <colgroup>
          <col />
          <col className="w-[7rem]" />
          <col className="w-[9.5rem]" />
          <col className="w-[12rem]" />
        </colgroup>
        <thead>
          <tr className="border-b border-rule-strong text-left text-ink-2">
            <th className="py-1 pr-3 font-medium">Record</th>
            <th className="py-1 pr-3 font-medium">People</th>
            <th className="py-1 pr-3 font-medium">Now</th>
            <th className="py-1 font-medium">With the draft</th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr
              key={r.item_ref}
              className={`border-b border-rule align-baseline ${r.flip || r.against_human ? "" : "text-ink-2"}`}
              data-flip={r.flip || undefined}
            >
              <td className="truncate py-1 pr-3" title={r.title}>
                {r.known_include ? (
                  <span className="mr-1.5 rounded-[3px] bg-include-wash px-1 text-xs font-semibold text-include">
                    Known include
                  </span>
                ) : null}
                {r.title}
              </td>
              <td className="py-1 pr-3">{r.human ? keyWords(r.human) : "Not settled"}</td>
              <td className="py-1 pr-3">{proposal(r.current, criteria)}</td>
              <td className={`py-1 ${r.flip ? "font-semibold" : ""}`}>
                {proposal(r.draft, criteria)}
                {r.flip ? ", flips" : ""}
                {r.against_human ? ", against people" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
