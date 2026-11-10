// Setting up a review (DESIGN.md, "The pipeline"): the methods lead's steps from the people to
// extraction, in the order the review needs them. Each step says what is done, from the server's
// own records, and what comes next; the work itself happens here or on the step's screen.
import { Checkbox } from "@base-ui/react/checkbox";
import { useNavigate, useRouteContext, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { Progress, Role, StageInfo } from "../../data/schema.ts";
import { run } from "../../data/workbench.ts";
import { formatDate } from "../../lib/format.ts";
import { Button } from "../../ui/Button.tsx";
import { Field, TextInput, failure } from "../../ui/Form.tsx";
import { Key } from "../../ui/Key.tsx";
import { Page } from "../../ui/Page.tsx";
import { useKeys } from "../../ui/keys.ts";
import { plural, ROLE_LABELS, useProject } from "../project.tsx";
import { BuildCorpus } from "./BuildCorpus.tsx";
import { OpenStage } from "./OpenStage.tsx";
import { QueueRows, useQueues } from "./queues.tsx";

type StepId =
  | "people"
  | "protocol"
  | "searches"
  | "corpus"
  | "screening"
  | "adjudication"
  | "retrieval"
  | "fulltext"
  | "extraction"
  | "riskofbias"
  | "reports";

/** The steps that set the review up, before the ones that run it. */
const SETUP_STEPS: ReadonlySet<StepId> = new Set(["people", "protocol", "searches", "corpus"]);

/** The rail's groups, in the order the review runs. */
const GROUPS: ReadonlyArray<readonly [string, ReadonlySet<StepId>]> = [
  ["Set up the review", SETUP_STEPS],
  ["Screen", new Set<StepId>(["screening", "adjudication", "retrieval", "fulltext"])],
  ["Appraise and report", new Set<StepId>(["extraction", "riskofbias", "reports"])],
];
const groupOf = (id: StepId) => GROUPS.findIndex(([, ids]) => ids.has(id));

type Screen =
  | "/p/$projectId/protocol"
  | "/p/$projectId/search"
  | "/p/$projectId/studies"
  | "/p/$projectId/retrieval"
  | "/p/$projectId/extraction"
  | "/p/$projectId/risk-of-bias"
  | "/p/$projectId/reports"
  | "/p/$projectId/screening/table"
  | "/p/$projectId/adjudication"
  | "/p/$projectId/progress";

interface Step {
  readonly id: StepId;
  /** Work that comes up only on a condition (adjudication, when screeners disagree): drawn as a
   * branch of the step above it, without a number, and never offered as next. */
  readonly branch?: boolean;
  /** The step's name, as the navigation names its screen. */
  readonly title: string;
  /** Finished: a check means nothing is left to do in this step. */
  readonly done: boolean;
  /** Under way but not finished, such as a screening stage that is open. */
  readonly active?: boolean;
  /** Its state in a few words, for the spine. */
  readonly summary: string;
  readonly screen?: { readonly to: Screen; readonly label: string };
}

const ROLES: ReadonlyArray<Role> = ["reviewer", "auditor", "adjudicator", "lead"];

export function SetupScreen() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const navigate = useNavigate();
  const { project, me, protocol, has, seesLeadData, labels } = useProject();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [chosen, setChosen] = useState<StepId | null>(null);

  useEffect(() => {
    if (!seesLeadData) return;
    let live = true;
    run(workbench.progress({ projectId: project.id, as: me.actor_id })).then(
      (p) => live && setProgress(p),
      () => live && setProgress(null),
    );
    return () => {
      live = false;
    };
  }, [workbench, project.id, me.actor_id, seesLeadData, tick, project.stages.length]);

  const topics = protocol?.protocol.topics ?? [];
  // Targeted searches (mode S) need reviewers only: no auditor and no adjudication.
  const targeted = topics.length > 0 && topics.every((t) => t.mode === "S");
  const needed = targeted
    ? 1
    : topics.some((t) => t.mode !== "M2" && t.mode !== "S") || topics.length === 0
      ? 2
      : 1;
  const count = (role: Role) => project.members.filter((m) => m.roles.includes(role)).length;
  const reviewers = count("reviewer");
  const leadName = project.members.find((m) => m.roles.includes("lead"))?.display_name ?? null;
  const peopleDone =
    reviewers >= needed && (targeted || (count("auditor") > 0 && count("adjudicator") > 0));
  const searches = progress?.searches ?? 0;
  const identified = progress?.identification;
  const taOpen = project.stages.filter((s) => s.stage === "title_abstract");
  const taProgress = (progress?.stages ?? []).filter((s) => s.stage.stage === "title_abstract");
  const decided = taProgress.reduce((n, s) => n + s.status.screened, 0);
  const assigned = taProgress.reduce((n, s) => n + s.status.screened + s.status.remaining, 0);
  const included = taProgress.reduce((n, s) => n + (s.outcomes?.["include"] ?? 0), 0);
  const conflicts = (progress?.stages ?? []).reduce((n, s) => n + (s.status.conflicts ?? 0), 0);
  // Every question open and, as far as the lead's figures show, every record decided.
  const scopesInProtocol = new Set(topics.flatMap((t) => t.scopes.map((x) => x.id))).size;
  const allOpen =
    taOpen.length > 0 && new Set(taOpen.map((x) => x.scope_id)).size >= scopesInProtocol;
  const taFinished = allOpen && taProgress.length > 0 && assigned > 0 && decided >= assigned;
  const fullTexts = progress?.full_texts ?? 0;
  const scopes = new Set(taOpen.map((s) => s.scope_id)).size;
  const ftOpen = project.stages.filter((s) => s.stage === "full_text");
  const ftProgress = (progress?.stages ?? []).filter((s) => s.stage.stage === "full_text");
  const ftDecided = ftProgress.reduce((n, s) => n + s.status.screened, 0);
  const ftAssigned = ftProgress.reduce((n, s) => n + s.status.screened + s.status.remaining, 0);
  const ftIncluded = ftProgress.reduce((n, s) => n + (s.outcomes?.["include"] ?? 0), 0);
  const retrievalDone = taFinished && included > 0 && fullTexts >= included;
  const ftFinished =
    retrievalDone && ftOpen.length > 0 && ftAssigned > 0 && ftDecided >= ftAssigned;
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

  // Each spine summary is a state, never the explanation the panel gives. No summary repeats
  // another step's name: the e2e tests find a step by the words in its row.
  const steps: Step[] = [
    {
      id: "people",
      title: "People",
      done: peopleDone,
      // Who leads, then the others by role: every person is counted once, under a role.
      summary: peopleDone
        ? [
            leadName ? `${leadName} (lead)` : null,
            n(reviewers, "reviewer", "reviewers"),
            count("auditor") ? n(count("auditor"), "auditor", "auditors") : null,
            count("adjudicator") ? n(count("adjudicator"), "adjudicator", "adjudicators") : null,
          ]
            .filter(Boolean)
            .join(", ")
        : targeted
          ? "Add the reviewers who share the records"
          : `Add ${needed === 2 ? "two reviewers" : "a reviewer"}, an auditor, and an adjudicator`,
    },
    {
      id: "protocol",
      title: "Protocol",
      done: protocol !== null,
      summary: protocol
        ? `Version ${protocol.protocol.version_label}` +
          (protocol.published_at ? `, published ${formatDate(protocol.published_at)}` : "")
        : "Not published yet",
      screen: {
        to: "/p/$projectId/protocol",
        label: protocol ? "Open the protocol" : "Write the protocol",
      },
    },
    {
      id: "searches",
      title: "Search",
      done: searches > 0,
      summary: searches > 0 ? n(searches, "search", "searches") : "No searches yet",
      screen: { to: "/p/$projectId/search", label: "Go to the searches" },
    },
    {
      id: "corpus",
      title: plural(labels.study),
      done: Boolean(progress?.identity_revision_id),
      summary: identified
        ? `${identified.total_records_identified} records identified, ${identified.duplicates_removed} duplicates removed so far`
        : "Not built yet",
      screen: { to: "/p/$projectId/studies", label: `Confirm links on ${plural(labels.study)}` },
    },
    {
      id: "screening",
      title: "Title and abstract",
      done: taFinished,
      active: taOpen.length > 0 && !taFinished,
      summary: taOpen.length
        ? taProgress.length
          ? taFinished
            ? `Finished, ${n(included, "record", "records")} included`
            : `In progress, ${decided} of ${assigned} decided`
          : `In progress for ${n(scopes, labels.scope.toLowerCase(), plural(labels.scope).toLowerCase())}`
        : "Not open yet",
      // While records wait, the table is where the lead looks at them; progress is one click on.
      screen:
        taOpen.length && !taFinished
          ? { to: "/p/$projectId/screening/table", label: "Open the screening table" }
          : { to: "/p/$projectId/progress", label: "Watch progress" },
    },
    // Adjudication branches off screening in documented reviews; a pool of screeners has none.
    ...(targeted
      ? []
      : [
          {
            id: "adjudication" as const,
            title: "Adjudication",
            branch: true,
            done: false,
            active: conflicts > 0,
            summary: !taOpen.length
              ? "When screeners disagree"
              : conflicts
                ? `${n(conflicts, "conflict", "conflicts")} to settle`
                : "No conflict open",
            screen: { to: "/p/$projectId/adjudication" as const, label: "Go to adjudication" },
          },
        ]),
    {
      id: "retrieval",
      title: "Retrieval",
      // Finished once every included record has a PDF; the count includes sentinels, so this is
      // the most the lead's figures can say.
      done: retrievalDone,
      active: fullTexts > 0 && !retrievalDone,
      summary:
        fullTexts > 0
          ? `${n(fullTexts, "PDF", "PDFs")} attached` +
            (included ? ` for ${n(included, "included record", "included records")}` : "")
          : included
            ? `${n(included, "included record waits", "included records wait")} for a PDF`
            : "Waits for included records",
      screen: { to: "/p/$projectId/retrieval", label: "Go to retrieval" },
    },
    {
      id: "fulltext",
      title: "Full text",
      done: ftFinished,
      active: ftOpen.length > 0 && !ftFinished,
      summary: ftOpen.length
        ? ftProgress.length
          ? ftFinished
            ? `Finished, ${n(ftIncluded, "report", "reports")} included`
            : `In progress, ${ftDecided} of ${ftAssigned} decided`
          : "In progress"
        : "Opens once the PDFs are in",
      screen: { to: "/p/$projectId/progress", label: "Watch progress" },
    },
    {
      id: "extraction",
      title: "Extraction",
      done: false,
      summary: "After full-text screening",
      screen: { to: "/p/$projectId/extraction", label: "Go to extraction" },
    },
    {
      id: "riskofbias",
      title: "Risk of bias",
      done: false,
      summary: "For each included study",
      screen: { to: "/p/$projectId/risk-of-bias", label: "Go to risk of bias" },
    },
    {
      id: "reports",
      title: "Reports",
      done: false,
      summary: "PRISMA flow, AI disclosure, handover",
      screen: { to: "/p/$projectId/reports", label: "Go to reports" },
    },
  ];
  // The next step is the first one not finished: an open stage is the work of the moment, so
  // nothing after it is offered as next.
  const next = steps.find((s) => !s.done && !s.branch) ?? steps.at(-1)!;
  // Steps are numbered in sequence; a branch has no number of its own.
  const numbers = new Map<StepId, number>();
  for (const step of steps) if (!step.branch) numbers.set(step.id, numbers.size + 1);
  const doneCount = steps.filter((s) => s.done).length;
  const setupDone = steps.filter((s) => s.done && SETUP_STEPS.has(s.id)).length;
  const current = steps.find((s) => s.id === chosen) ?? next;
  const index = steps.indexOf(current);

  useKeys((event) => {
    if (!has("lead")) return false;
    if (event.key === "j" || event.key === "ArrowDown") {
      setChosen(steps[Math.min(index + 1, steps.length - 1)]!.id);
      setNotice(null);
      return true;
    }
    if (event.key === "k" || event.key === "ArrowUp") {
      setChosen(steps[Math.max(index - 1, 0)]!.id);
      setNotice(null);
      return true;
    }
    if (event.key === "Enter" && current.screen) {
      void navigate({ to: current.screen.to, params: { projectId: project.id } });
      return true;
    }
    return false;
  });

  if (!has("lead")) {
    return (
      <Page
        title="Workflow"
        summary="The methods lead sets the review up. Your queue fills once a stage you screen is open and the AI has read its records."
      >
        <People editable={false} onChanged={() => {}} />
      </Page>
    );
  }

  // A step whose panel only explains leads to its screen with the primary button; a step with a
  // form of its own keeps the form's button primary.
  const guideOnly =
    current.id === "protocol" ||
    current.id === "searches" ||
    current.id === "retrieval" ||
    (current.id === "fulltext" && current.active === true) ||
    (current.id === "screening" && current.active === true && allOpen) ||
    current.id === "extraction" ||
    current.id === "adjudication" ||
    current.id === "riskofbias" ||
    current.id === "reports" ||
    (current.id === "corpus" && current.done);
  return (
    <Page
      title="Workflow"
      summary={
        `Set up: ${setupDone} of ${SETUP_STEPS.size} steps done. ` +
        (doneCount === steps.length
          ? "Every step is done."
          : `${next.active ? "In progress" : "Next"}: ${next.title.toLowerCase()}${next.active ? `, ${next.summary.replace(/^In progress,? ?/, "")}` : ""}.`) +
        (!seesLeadData
          ? " You screen, audit, or adjudicate a stage yourself, so Kittum hides the counts only the methods lead sees."
          : "")
      }
    >
      <div className="grid grid-cols-[minmax(0,380px)_minmax(0,1fr)] gap-x-12">
        <div>
          <ol aria-label="Setup steps" className="relative">
            {steps.map((step, i) => [
              i === 0 || groupOf(step.id) !== groupOf(steps[i - 1]!.id) ? (
                <li
                  key={`group-${step.id}`}
                  aria-hidden="true"
                  className={`mb-2 text-xs font-semibold text-ink-2 ${i ? "mt-3" : ""}`}
                >
                  {GROUPS[groupOf(step.id)]![0]}
                </li>
              ) : null,
              <StepRow
                key={step.id}
                step={step}
                number={numbers.get(step.id) ?? null}
                selected={step.id === current.id}
                next={step.id === next.id && !step.done}
                last={i === steps.length - 1 || groupOf(step.id) !== groupOf(steps[i + 1]!.id)}
                reached={steps.slice(0, i).every((s) => s.done || s.active)}
                onSelect={() => {
                  setChosen(step.id);
                  setNotice(null);
                }}
              />,
            ])}
          </ol>
        </div>
        <section
          aria-label={current.title}
          data-testid="setup-step"
          className="max-w-[880px] min-w-0 self-start rounded-[6px] bg-raised px-7 pt-5 pb-6 shadow-raised"
        >
          <h2 className="text-lg font-semibold">{current.title}</h2>
          {notice ? (
            <p
              role="status"
              className="mt-3 max-w-[64ch] border-l-2 border-petrol pl-3 text-sm"
              data-testid="setup-notice"
            >
              {notice}
            </p>
          ) : null}
          <div className="mt-3">
            <Panel
              step={current.id}
              searches={progress ? searches : null}
              progress={progress}
              figures={{ fullTexts, included, decided, assigned }}
              onChanged={(message) => {
                // Stay on the step just worked on; the spine shows what is next.
                setChosen(current.id);
                setTick((t) => t + 1);
                if (message) setNotice(message);
              }}
            />
          </div>
          {current.screen ? (
            <p className="mt-5 flex flex-wrap items-center gap-3">
              <Button
                kind={guideOnly ? "primary" : "secondary"}
                keys={["Enter"]}
                onClick={() =>
                  void navigate({ to: current.screen!.to, params: { projectId: project.id } })
                }
              >
                {current.screen.label}
              </Button>
              {current.id === "screening" && current.active ? (
                <Button
                  onClick={() =>
                    void navigate({
                      to: "/p/$projectId/progress",
                      params: { projectId: project.id },
                    })
                  }
                >
                  Watch progress
                </Button>
              ) : null}
            </p>
          ) : null}
        </section>
      </div>
    </Page>
  );
}

/** One step on the spine: the rule runs solid through the steps already done. */
function StepRow({
  step,
  number,
  selected,
  next,
  last,
  reached,
  onSelect,
}: {
  step: Step;
  number: number | null;
  selected: boolean;
  next: boolean;
  last: boolean;
  reached: boolean;
  onSelect: () => void;
}) {
  if (step.branch) {
    // A branch: the main line runs on past it, and a short elbow leads to a small mark.
    return (
      <li
        className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 pb-4"
        data-testid="setup-row"
        data-state={step.active ? "active" : "later"}
      >
        <span
          aria-hidden="true"
          className="absolute top-0 bottom-0 left-[13px] w-[2px] bg-rule-strong"
        />
        <span
          aria-hidden="true"
          className="absolute top-[13px] left-[14px] h-[2px] w-[12px] bg-rule-strong"
        />
        <span
          aria-hidden="true"
          className={`relative z-[1] mt-[7px] ml-[22px] h-3 w-3 rounded-full ${step.active ? "bg-petrol" : "border-2 border-rule-strong bg-paper"}`}
        />
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected || undefined}
          className={`rounded-[4px] px-2.5 py-0.5 text-left ${selected ? "bg-sheet-2 shadow-[inset_3px_0_0_var(--petrol)]" : "hover:bg-sheet-2"}`}
        >
          <span className="block text-sm font-semibold">{step.title}</span>
          <span className="block text-sm text-ink-2">{step.summary}</span>
        </button>
      </li>
    );
  }
  return (
    <li
      className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 pb-4"
      data-testid="setup-row"
      data-state={step.done ? "done" : step.active ? "active" : next ? "next" : "later"}
    >
      {!last ? (
        <span
          aria-hidden="true"
          className={`absolute top-7 bottom-0 left-[13px] w-[2px] ${step.done ? "bg-petrol" : "bg-rule-strong"}`}
        />
      ) : null}
      {/* Every step keeps its number; a small badge at its corner says done or in progress. */}
      <span
        aria-hidden="true"
        className={`relative z-[1] mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${
          step.done
            ? "bg-petrol text-petrol-ink"
            : step.active || next
              ? "border-2 border-petrol bg-sheet text-petrol"
              : "border border-rule-strong bg-paper text-ink-2"
        }`}
      >
        {number}
        {step.done || step.active ? (
          <span className="absolute -right-1 -bottom-1 flex h-[14px] w-[14px] items-center justify-center rounded-full bg-sheet text-petrol shadow-[0_0_0_1.5px_var(--petrol)]">
            {step.done ? (
              <svg width="8" height="7" viewBox="0 0 12 10">
                <path
                  d="M1 5.2l3.4 3.3L11 1.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                />
              </svg>
            ) : (
              // In progress: half filled.
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M5 0.5a4.5 4.5 0 0 0 0 9z" fill="currentColor" />
              </svg>
            )}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected || undefined}
        className={`rounded-[3px] px-2.5 py-1 text-left ${selected ? "bg-sheet shadow-[inset_3px_0_0_var(--petrol)]" : "hover:bg-sheet"}`}
      >
        <span className={`block font-semibold ${reached || step.done ? "text-ink" : "text-ink-2"}`}>
          {step.title}
          <span className="sr-only">
            {step.done ? ", done" : step.active ? ", in progress" : next ? ", next" : ""}
          </span>
        </span>
        <span className="mt-0.5 block text-sm text-ink-2">{step.summary}</span>
      </button>
    </li>
  );
}

interface Figures {
  readonly fullTexts: number;
  readonly included: number;
  readonly decided: number;
  readonly assigned: number;
}

function Panel({
  step,
  searches,
  progress,
  figures,
  onChanged,
}: {
  step: StepId;
  searches: number | null;
  progress: Progress | null;
  figures: Figures;
  onChanged: (message: string | null) => void;
}) {
  const { protocol, labels, project, seesLeadData, scopeLabel } = useProject();
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const queues = useQueues(workbench, project, progress ? 1 : 0);
  /** Each screener's progress in a stage, or nothing before the stage opens. */
  const screeners = (stage: StageInfo["stage"]) => {
    const rows = (queues ?? []).filter((q) => q.stage === stage);
    return rows.length ? (
      <div className="mt-5">
        <h3 className="text-sm font-semibold">Screeners</h3>
        <div className="mt-1 max-w-[560px]">
          <QueueRows caption="Each screener's progress" queues={rows} />
        </div>
      </div>
    ) : null;
  };
  /** The stage's figures per question, when there is more than one. */
  const perQuestion = (stage: StageInfo["stage"]) => {
    const rows = (progress?.stages ?? []).filter((x) => x.stage.stage === stage);
    return seesLeadData && rows.length > 1 ? (
      <table className="mt-4 w-full max-w-[720px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-rule-strong text-left text-ink-2">
            <th className="py-1 pr-4 font-medium">{labels.scope}</th>
            <th className="py-1 pr-4 font-medium">Decided</th>
            <th className="py-1 font-medium">Included</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.stage.stage_id} className="border-b border-rule">
              <td className="max-w-[40ch] truncate py-1.5 pr-4">{scopeLabel(x.stage.scope_id)}</td>
              <td className="py-1.5 pr-4 tabular-nums">
                {x.status.screened} of {x.status.screened + x.status.remaining}
              </td>
              <td className="py-1.5 tabular-nums">{x.outcomes?.["include"] ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null;
  };
  switch (step) {
    case "people":
      return <People editable onChanged={onChanged} />;
    case "protocol":
      return (
        <Guide>
          {protocol
            ? "Every screening decision reads the published version. To change it, write a new version: Kittum shows what it changes before you publish, and a changed screening mode needs a reason."
            : "Write it and publish it. Fill in the form, ask a model for a draft, or write YAML. Kittum marks each problem at its field, and the ledger records your approval when you publish."}
        </Guide>
      );
    case "searches":
      return (
        <>
          <Guide>
            Add one search per database and query, as PRISMA-S asks. Run PubMed, Europe PMC, and
            ClinicalTrials.gov live; for any other database, import its export file with the query
            as you ran it.
          </Guide>
          {protocol ? (
            <dl className="mt-4 grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-sm">
              {protocol.protocol.topics.map((t) => (
                <div key={t.id} className="contents">
                  <dt className="text-ink-2">Sources for {t.label}</dt>
                  <dd>{t.sources.map((s) => s.name).join(", ")}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      );
    case "corpus":
      return (
        <BuildOrDone
          searches={searches}
          onBuilt={() =>
            onChanged(
              "Kittum built the corpus. Confirm duplicates and study links before you open screening. Links you confirm later count from the next stage on.",
            )
          }
        />
      );
    case "screening":
      return (
        <>
          {seesLeadData && figures.assigned > 0 ? (
            <Facts
              items={[
                ["Records decided", `${figures.decided} of ${figures.assigned}`],
                // Inclusions mean something only once records are decided.
                ...(figures.decided
                  ? [["Included so far", String(figures.included)] as const]
                  : []),
              ]}
            />
          ) : null}
          {perQuestion("title_abstract")}
          {screeners("title_abstract")}
          {project.stages.some((x) => x.stage === "title_abstract") ? (
            <p className="mt-4 text-sm text-ink-2">
              Next: retrieval starts with the first included record; full-text screening opens when
              the PDFs are in.
            </p>
          ) : null}
          <div className="mt-5">
            <OpenStage only="title_abstract" onOpened={(message) => onChanged(message)} />
          </div>
        </>
      );
    case "adjudication": {
      const open = (progress?.stages ?? []).reduce((n, x) => n + (x.status.conflicts ?? 0), 0);
      return (
        <>
          <Guide>
            When two screeners decide a record differently, the adjudicator settles it. Kittum sends
            the conflict there on its own.
          </Guide>
          {seesLeadData && project.stages.length ? (
            <Facts items={[["Conflicts to settle", String(open)]]} />
          ) : null}
        </>
      );
    }
    case "retrieval":
      return (
        <>
          <Guide>
            Upload a PDF for each included record. Full-text screening opens when they are in.{" "}
            <span
              className="cursor-help text-sm text-petrol underline decoration-dotted underline-offset-2"
              title="Add the full-text sentinels on the Retrieval screen too: reports with a known outcome that join every full-text queue unmarked, to check the screening."
            >
              Sentinels?
            </span>
          </Guide>
          {seesLeadData ? (
            <Facts
              items={[
                [
                  "Included at title and abstract",
                  figures.included ? String(figures.included) : "None yet",
                ],
                ["PDFs attached, including sentinels", String(figures.fullTexts)],
              ]}
            />
          ) : null}
        </>
      );
    case "fulltext":
      return (
        <>
          {project.stages.some((x) => x.stage === "full_text") ? null : (
            <Guide>
              Each included record is screened again on its full text. Open the stage once its PDFs
              are in.
            </Guide>
          )}
          {perQuestion("full_text")}
          {screeners("full_text")}
          {figures.fullTexts > 0 ? (
            <div className="mt-5">
              <OpenStage only="full_text" onOpened={(message) => onChanged(message)} />
            </div>
          ) : null}
        </>
      );
    case "extraction":
      return (
        <Guide>
          Request a run on a {labels.report.toLowerCase()} with its full text and an extraction
          schema. The Janus path needs no model; the LLM path needs a model server. Reviewers accept
          each value against its source.
          {project.stages.some((s) => s.stage === "full_text")
            ? ""
            : " Extraction starts once full-text screening has included reports."}
        </Guide>
      );
    case "riskofbias":
      return (
        <Guide>
          Appraise each included {labels.study.toLowerCase()} with RoB 2, question by question,
          against the quotes in its full text.
        </Guide>
      );
    case "reports":
      return (
        <Guide>
          The PRISMA flow, the AI-use disclosure, and the handover bundle come from the ledger.
          Render them at any time; they fill as the review goes.
        </Guide>
      );
  }
}

/** The figures that say where a step stands, above its action. */
function Facts({ items }: { items: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="mt-4 mb-1 flex flex-wrap gap-x-10 gap-y-2">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-sm text-ink-2">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BuildOrDone({ searches, onBuilt }: { searches: number | null; onBuilt: () => void }) {
  const { project } = useProject();
  const [built, setBuilt] = useState(false);
  if (built || project.stages.length > 0) {
    return <Guide>Kittum built the corpus. Screening opens on its newest revision.</Guide>;
  }
  return (
    <BuildCorpus
      searches={searches}
      onBuilt={() => {
        setBuilt(true);
        onBuilt();
      }}
    />
  );
}

const Guide = ({ children }: { children: ReactNode }) => (
  <p className="max-w-[64ch] text-md text-ink-2">{children}</p>
);

/** The project's people, and for the lead a form to add one. */
function People({
  editable,
  onChanged,
}: {
  editable: boolean;
  onChanged: (message: string | null) => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const router = useRouter();
  const { project, me } = useProject();
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<ReadonlyArray<Role>>(["reviewer"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useKeys((event) => {
    if (!editable || event.key !== "a") return false;
    input.current?.focus();
    return true;
  });

  const add = async () => {
    if (!name.trim() || roles.length === 0) {
      setError("Give a name and at least one role.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const member = await run(
        workbench.addMember({
          projectId: project.id,
          as: me.actor_id,
          displayName: name.trim(),
          roles,
        }),
      );
      await router.invalidate();
      setName("");
      onChanged(`Added ${member.display_name}.`);
      input.current?.focus();
    } catch (e) {
      setError(failure(e, "Kittum could not add the person."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-[64ch]">
      <table className="narrow w-full border-collapse text-sm" aria-label="People on this review">
        <tbody>
          {project.members.map((m) => (
            <tr key={m.actor_id} className="border-b border-rule">
              <td className="py-1.5 pr-4 font-medium">{m.display_name}</td>
              <td className="py-1.5 text-ink-2">{m.roles.map((r) => ROLE_LABELS[r]).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {editable ? (
        <form
          aria-label="Add a person"
          className="mt-5 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void add();
          }}
        >
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <Field label="Name">
                <TextInput
                  ref={input}
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") e.currentTarget.blur(); // back to the screen's keys
                  }}
                  placeholder="Sam Okafor"
                />
              </Field>
            </div>
            <Button kind="primary" type="submit" disabled={busy}>
              Add
            </Button>
          </div>
          <fieldset className="flex flex-wrap gap-x-5 gap-y-1.5">
            <legend className="mb-1 text-xs font-semibold text-ink-2">Roles</legend>
            {ROLES.map((role) => (
              <label key={role} className="flex cursor-default items-center gap-2 text-sm">
                <Checkbox.Root
                  checked={roles.includes(role)}
                  onCheckedChange={(on) =>
                    setRoles((all) => (on ? [...all, role] : all.filter((r) => r !== role)))
                  }
                  className="flex h-4 w-4 items-center justify-center rounded-[3px] border border-rule-strong bg-sheet data-[checked]:border-petrol data-[checked]:bg-petrol"
                >
                  <Checkbox.Indicator className="text-petrol-ink">
                    <svg width="10" height="8" viewBox="0 0 10 8" aria-hidden="true">
                      <path
                        d="M1 4.2l2.6 2.5L9 1.2"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                      />
                    </svg>
                  </Checkbox.Indicator>
                </Checkbox.Root>
                {ROLE_LABELS[role]}
              </label>
            ))}
          </fieldset>
          <p className="text-xs text-ink-2">
            <Key k="a" /> jumps to the name, <Key k="Escape" /> leaves it.{" "}
            <span title="There is no sign-in yet. A link with ?as= and a person's ID opens the review as them.">
              Each person picks their name when they open the review.
            </span>
          </p>
          {error ? (
            <p role="alert" className="text-sm text-exclude">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
