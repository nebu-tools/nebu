// The published protocol (DESIGN.md, "Protocol"): the questions, the outcomes, and per search
// topic its screening mode, audit plan, sources, and criteria. Every heading uses the profile's
// words for core concepts. The methods lead writes versions in the form or as YAML, and publishes
// them.
import { useRouteContext } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { Criterion, ProfileLabels, ProtocolRevision, SearchTopic } from "../../data/schema.ts";
import { run } from "../../data/workbench.ts";
import { formatDate } from "../../lib/format.ts";
import { keyWords, modeLabel, revealLabel } from "../../lib/labels.ts";
import { Button } from "../../ui/Button.tsx";
import { failure } from "../../ui/Form.tsx";
import { useKeys } from "../../ui/keys.ts";
import { plural, useProject } from "../project.tsx";
import { Assistant } from "./Assistant.tsx";
import type { FormState, Handover } from "./Assistant.tsx";
import { forSaving, toDoc } from "./document.ts";
import { Help } from "../../ui/Help.tsx";
import { ProtocolEditor } from "./ProtocolEditor.tsx";

export const MODES: Record<SearchTopic["mode"], string> = {
  M1: "Two people screen every record. The AI screens it too, as a third screener.",
  M2: "One person screens every record and the AI is the second screener. Every disagreement gets a blind extra screen.",
  M3: "Two people screen in the AI's order and stop when a statistical test set in advance passes.",
  S: "One person of a pool screens each record and asks a colleague for a second opinion when unsure. The colleague sees the first decision.",
};

/** What a topic's documentation level allows, in a line. */
export const DOCUMENTATION: Record<SearchTopic["documentation"], string> = {
  complete: "Complete documentation, with sentinels and an audit sample",
  working: "Working documentation; no audit sample",
};

/** When reviewers may see the AI's reading, as the documentation level allows it. */
const AI_EXPOSURE: Record<SearchTopic["documentation"], string> = {
  complete: "Only after a person decides, never before",
  working: "May show before the decision, if the stage is opened that way",
};

const STAGES: Record<string, string> = {
  title_abstract: "Title and abstract",
  full_text: "Full text",
};

type Writing =
  | { readonly mode: "form"; readonly handover: Handover | null }
  | {
      readonly mode: "yaml";
      readonly base: ProtocolRevision | null;
      readonly text: string | null;
      /** Where the form was, to go back to when the YAML stays as it was. */
      readonly back: Handover | null;
    };

export function ProtocolScreen() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { protocol, has } = useProject();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [writing, setWriting] = useState<Writing>({ mode: "form", handover: null });
  const [switching, setSwitching] = useState<string | null>(null);
  // A switch between the views in progress: both are inert until it ends, so no key is lost.
  const [moving, setMoving] = useState(false);
  const [formReady, setFormReady] = useState(false);
  // Where the form puts its revision bar: in the toolbar, beside the tabs.
  const [barSlot, setBarSlot] = useState<HTMLDivElement | null>(null);
  // What each view holds now, so the other one opens the same protocol.
  const form = useRef<FormState | null>(null);
  const yaml = useRef<{ readonly text: string; readonly changed: boolean } | null>(null);
  const onCurrent = useCallback((current: FormState) => {
    form.current = current;
    setFormReady(current.ready);
  }, []);
  const lead = has("lead");
  useKeys((event) => {
    if (event.key !== "v" || !lead || editing || !protocol) return false;
    setEditing(true);
    setNotice(null);
    return true;
  });
  if (lead && (editing || !protocol)) {
    const published = (message: string) => {
      setEditing(false);
      setWriting({ mode: "form", handover: null });
      setNotice(message);
    };
    const toYaml = async () => {
      const current = form.current;
      if (moving || !current?.ready) return;
      setSwitching(null);
      const back: Handover = { working: current.working, selected: current.selected };
      if (!current.shown) return setWriting({ mode: "yaml", base: null, text: null, back });
      setMoving(true);
      try {
        const text = await run(workbench.protocolYaml(forSaving(current.shown.doc)));
        setWriting({ mode: "yaml", base: current.shown.base, text, back });
      } catch (e) {
        setSwitching(failure(e, "Kittum could not turn the form into YAML."));
      } finally {
        setMoving(false);
      }
    };
    const toForm = async () => {
      if (moving || writing.mode !== "yaml") return;
      setSwitching(null);
      const text = yaml.current;
      // YAML left as it was: the form comes back as the lead left it, unsaved changes included.
      if (!text?.changed || !text.text.trim()) {
        return setWriting({ mode: "form", handover: writing.back });
      }
      setMoving(true);
      try {
        const parsed = await run(workbench.parseProtocol(text.text));
        if (!parsed.source) {
          setSwitching(
            `The form cannot show this YAML. ${parsed.issues?.[0]?.message ?? ""} Fix it, or reload the page to drop it.`,
          );
          return;
        }
        const read = toDoc(parsed.source);
        if ("problem" in read) {
          setSwitching(`The form cannot show this YAML. ${read.problem} Fix it in the YAML.`);
          return;
        }
        setWriting({
          mode: "form",
          handover: {
            working: { doc: read.doc, base: writing.base },
            selected: writing.base?.id ?? writing.back?.selected ?? null,
          },
        });
      } catch (e) {
        setSwitching(failure(e, "Kittum could not read the YAML."));
      } finally {
        setMoving(false);
      }
    };
    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* One toolbar above the form: how to write, the form's revision bar (the form puts it in
        the slot), and the way back. It sits outside the form's scroll, so it never covers a
        field. Over the form it spans the lead pages' column, as the form below does. */}
        <div className="border-b border-rule-strong bg-sheet py-1.5 text-sm">
          <div
            className={`flex min-h-9 items-center gap-3 ${writing.mode === "form" ? "mx-auto max-w-[1616px] px-8" : "px-4"}`}
          >
            <div className="flex items-center gap-1" role="tablist" aria-label="How to write">
              {(
                [
                  ["form", "Form"],
                  ["yaml", "YAML"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={writing.mode === mode}
                  title={
                    mode === "yaml"
                      ? "The same protocol as text, for people who know the format"
                      : "The same protocol as fields"
                  }
                  disabled={moving || (mode === "yaml" && writing.mode === "form" && !formReady)}
                  onClick={() =>
                    writing.mode === mode ? undefined : void (mode === "yaml" ? toYaml() : toForm())
                  }
                  className={`rounded-[3px] px-2.5 py-1 disabled:cursor-wait disabled:opacity-50 ${writing.mode === mode ? "bg-sheet font-semibold text-ink shadow-[inset_0_-2px_0_var(--petrol)]" : "text-ink-2 hover:text-ink"}`}
                >
                  {label}
                </button>
              ))}
              {switching ? (
                <span role="alert" className="ml-3 text-xs text-exclude">
                  {switching}
                </span>
              ) : null}
            </div>
            <div ref={setBarSlot} className="flex min-w-0 flex-1 items-center gap-x-3" />
            {protocol ? (
              <Button kind="quiet" size="sm" onClick={() => setEditing(false)}>
                Back to the published version
              </Button>
            ) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1" inert={moving}>
          {writing.mode === "form" ? (
            <Assistant
              barSlot={barSlot}
              handover={writing.handover}
              paused={moving}
              onCurrent={onCurrent}
              onPublished={published}
            />
          ) : (
            <ProtocolEditor
              key={writing.base?.id ?? "text"}
              initialText={writing.text}
              base={writing.base}
              onText={(text, changed) => {
                yaml.current = { text, changed };
              }}
              onRevisionSaved={() => {
                yaml.current = null;
                setWriting({ mode: "form", handover: null });
              }}
              onCancel={null}
              onPublished={published}
            />
          )}
        </div>
      </div>
    );
  }
  if (!protocol) {
    return (
      <section className="h-full overflow-y-auto bg-paper">
        <div className="mx-auto max-w-[720px] px-8 py-14">
          <h1 className="text-xl font-semibold">No protocol is published yet</h1>
          <p className="mt-2 max-w-[62ch] text-md text-ink-2">
            Every decision reads the published protocol, so screening waits for it. The methods lead
            writes and publishes it here, and the ledger records their approval.
          </p>
        </div>
      </section>
    );
  }
  return (
    <Published
      notice={notice}
      lead={lead}
      onWrite={() => {
        setEditing(true);
        setNotice(null);
      }}
    />
  );
}

function Published({
  notice,
  lead,
  onWrite,
}: {
  notice: string | null;
  lead: boolean;
  onWrite: () => void;
}) {
  const { protocol, labels } = useProject();
  if (!protocol) return null;
  const { protocol: review, profile } = protocol;
  const criteria = review.topics.reduce((n, t) => n + t.criteria.length, 0);
  const questionName = new Map(
    review.questions.map((q, i) => [q.id, q.short_label || `${labels.scope} ${i + 1}`]),
  );
  const sections: ReadonlyArray<readonly [string, string]> = [
    ["criteria", "Eligibility criteria"],
    ["questions", plural(labels.scope)],
    ["outcomes", plural(labels.outcome)],
    ["settings", "Screening settings"],
  ];
  const outcomes = review.outcomes.length;
  return (
    <section className="h-full overflow-y-auto bg-paper">
      <article className="px-8 pt-6 pb-16" aria-label="Protocol">
        {notice ? (
          <p
            role="status"
            className="mb-5 max-w-[1200px] border-l-2 border-petrol pl-3 text-sm"
            data-testid="protocol-notice"
          >
            {notice}
          </p>
        ) : null}
        <div className="grid grid-cols-[minmax(0,1fr)_420px] items-start gap-x-10">
          <div className="min-w-0">
            <header className="flex items-start gap-8">
              <div className="min-w-0">
                <h1 className="max-w-[70ch] text-xl font-semibold tracking-[-0.01em] text-balance">
                  {review.title}
                </h1>
                <p className="mt-1 text-sm text-ink-2">
                  Version {review.version_label}
                  {protocol.published_at ? `, published ${formatDate(protocol.published_at)}` : ""}.
                </p>
              </div>
              {lead ? (
                <span className="ml-auto shrink-0">
                  <Button keys={["v"]} onClick={onWrite}>
                    Write a new version
                  </Button>
                </span>
              ) : null}
            </header>
            <nav aria-label="Sections" className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
              {sections.map(([id, name]) => (
                <Jump
                  key={id}
                  to={id}
                  className="text-petrol underline decoration-petrol/30 underline-offset-2 hover:decoration-petrol"
                >
                  {name}
                </Jump>
              ))}
            </nav>

            <div className="mt-5 grid gap-6">
              {/* The criteria are the sheet: what people come here to read. */}
              {review.topics.map((topic, ti) => (
                <Criteria
                  key={topic.id}
                  id={ti === 0 ? "criteria" : undefined}
                  topic={topic}
                  labels={labels}
                  count={criteria}
                  title={
                    review.topics.length > 1
                      ? `Eligibility criteria: ${topic.label}`
                      : "Eligibility criteria"
                  }
                />
              ))}

              <Fold
                id="questions"
                title={plural(labels.scope)}
                summary={review.questions
                  .map((q, i) => questionName.get(q.id) ?? `${i + 1}`)
                  .join("; ")}
              >
                <ol className="grid gap-7">
                  {review.questions.map((q, i) => (
                    <li key={q.id} id={`question-${q.id}`} className="scroll-mt-6" title={q.id}>
                      <span className="text-sm text-ink-2">
                        {labels.scope} {i + 1}
                      </span>
                      {q.short_label ? (
                        <h3 className="text-md font-semibold">{q.short_label}</h3>
                      ) : null}
                      <p
                        className={`mt-0.5 max-w-[80ch] text-md ${q.short_label ? "" : "font-semibold"}`}
                      >
                        {q.label}
                      </p>
                      <dl className="mt-3 grid grid-cols-[8rem_minmax(0,72ch)] gap-x-5 gap-y-2 text-md">
                        <dt className="pt-[3px] text-sm text-ink-2">{labels.population}</dt>
                        <dd>{q.population}</dd>
                        <dt className="pt-[3px] text-sm text-ink-2">{labels.intervention}</dt>
                        <dd>{q.intervention}</dd>
                        {q.comparators.length > 0 ? (
                          <>
                            <dt className="pt-[3px] text-sm text-ink-2">{labels.comparator}</dt>
                            <dd>
                              {q.comparators.length === 1 ? (
                                q.comparators[0]
                              ) : (
                                <ul className="grid list-disc gap-1 pl-5 marker:text-ink-2">
                                  {q.comparators.map((c) => (
                                    <li key={c}>{c}</li>
                                  ))}
                                </ul>
                              )}
                            </dd>
                          </>
                        ) : null}
                      </dl>
                    </li>
                  ))}
                </ol>
              </Fold>

              <Fold
                id="outcomes"
                title={plural(labels.outcome)}
                summary={`${outcomes} ${outcomes === 1 ? labels.outcome.toLowerCase() : plural(labels.outcome).toLowerCase()}: ${review.outcomes.map((o) => o.name).join("; ")}`}
              >
                <Outcomes outcomes={review.outcomes} />
              </Fold>
            </div>
          </div>

          {/* Context beside the sheet: recessed groups, not cards. */}
          <aside className="sticky top-6 grid gap-3" aria-label="Screening settings">
            <span id="settings" className="sr-only">
              Screening settings
            </span>
            {review.topics.map((topic) => (
              <Topic
                key={topic.id}
                topic={topic}
                labels={labels}
                questionName={questionName}
                single={
                  review.topics.length === 1 && topic.scopes.length === review.questions.length
                }
              />
            ))}
            <section id="version" className="rounded-[4px] bg-sheet-2 px-5 py-4 text-sm">
              <h2 className="text-sm font-semibold">This version</h2>
              <dl className="mt-2 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                <dt className="text-ink-2">Version</dt>
                <dd>{review.version_label}</dd>
                <dt className="text-ink-2">Published</dt>
                <dd>
                  {protocol.published_at ? formatDate(protocol.published_at) : "Not published"}
                </dd>
                <dt
                  className="text-ink-2"
                  title="A profile adds the rules and words of one agency or jurisdiction."
                >
                  Agency profile
                </dt>
                <dd>{profile.id ?? "none (Kittum’s own wording)"}</dd>
                <dt className="text-ink-2">Content hash</dt>
                <dd className="flex items-center gap-2">
                  <code className="font-mono text-xs" title={protocol.content_hash}>
                    {protocol.content_hash.slice(0, 12)}
                  </code>
                  <CopyButton text={protocol.content_hash} />
                </dd>
              </dl>
            </section>
          </aside>
        </div>
      </article>
    </section>
  );
}

/** Copies a value and says so for a moment. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      kind="quiet"
      size="sm"
      aria-label="Copy the content hash"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** A link to a part of the page. The page scrolls in its own pane, so the link scrolls there
 * and leaves the URL alone. */
function Jump({
  to,
  title,
  className,
  children,
}: {
  to: string;
  title?: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <a
      href={`#${to}`}
      title={title}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        const target = document.getElementById(to);
        // A part inside a folded group opens it first.
        const fold = target instanceof HTMLDetailsElement ? target : target?.closest("details");
        if (fold) fold.open = true;
        target?.scrollIntoView({ block: "start", behavior: "smooth" });
      }}
    >
      {children}
    </a>
  );
}

const OUTCOME_KINDS: Record<string, string> = { primary: "Primary", secondary: "Secondary" };

/** Outcomes by name. Primary and secondary are said in words; any other category is a
 * vocabulary key, shown only on hover. */
function Outcomes({
  outcomes,
}: {
  outcomes: ReadonlyArray<{
    readonly id: string;
    readonly category: string;
    readonly name: string;
  }>;
}) {
  const ranked = [...outcomes].sort(
    (a, b) => Number(b.category === "primary") - Number(a.category === "primary"),
  );
  return (
    <ul className="grid max-w-[80ch] gap-1.5 text-md">
      {ranked.map((o) => (
        <li
          key={o.id}
          className="flex items-baseline gap-3"
          title={`Category: ${keyWords(o.category)} (${o.category})`}
        >
          {OUTCOME_KINDS[o.category] ? (
            <span className="w-[5.5rem] flex-none text-sm text-ink-2">
              {OUTCOME_KINDS[o.category]}
            </span>
          ) : null}
          <span>{o.name}</span>
        </li>
      ))}
    </ul>
  );
}

function Topic({
  topic,
  labels,
  questionName,
  single,
}: {
  topic: SearchTopic;
  labels: ProfileLabels;
  questionName: ReadonlyMap<string, string>;
  /** The review's only search topic, covering every question. */
  single: boolean;
}) {
  const row = "grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4";
  const { project } = useProject();
  // The stages open for this topic, one per stage kind: each says when reviewers see the AI.
  const open = [
    ...new Map(
      project.stages.filter((s) => s.topic_id === topic.id).map((s) => [s.stage, s] as const),
    ).values(),
  ];
  return (
    <section className="rounded-[4px] bg-sheet-2 px-5 py-4 text-sm" title={topic.id}>
      <h2 className="text-sm font-semibold">
        {labels.search_topic}: {topic.label}
      </h2>
      <dl className="mt-3 grid gap-y-2.5">
        <div className={row}>
          <dt className="text-ink-2">Screening mode</dt>
          <dd>
            <span className="font-semibold" title={`${MODES[topic.mode]} (mode ${topic.mode})`}>
              {modeLabel(topic.mode)}
            </span>
            {topic.mode_rationale ? (
              <details className="mt-0.5">
                <summary className="cursor-pointer text-ink-2 hover:text-ink">
                  Why this mode
                </summary>
                <p className="mt-1">{topic.mode_rationale}</p>
              </details>
            ) : null}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-ink-2">Documentation</dt>
          <dd
            data-testid="documentation"
            title="Either way, the ledger records every decision, second opinion, and AI reading shown."
          >
            {DOCUMENTATION[topic.documentation]}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-ink-2">AI’s reading</dt>
          <dd>
            {/* Each stage's own setting once it is open; the rule the documentation level sets before. */}
            <ul className="grid gap-0.5">
              {(["title_abstract", "full_text"] as const).map((kind) => {
                const stage = open.find((s) => s.stage === kind);
                return (
                  <li key={kind}>
                    <span className="text-ink-2">{STAGES[kind]}: </span>
                    {stage ? (
                      revealLabel(stage.reveal)
                    ) : (
                      <span title={AI_EXPOSURE[topic.documentation]}>set when the stage opens</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </dd>
        </div>
        {topic.mode === "S" ? null : (
          <div className={row}>
            <dt className="text-ink-2">Audit</dt>
            <dd>
              {topic.sentinel_percent}% of records as sentinels with known labels,{" "}
              {topic.random_audit_percent}% re-screened by the auditor
            </dd>
          </div>
        )}
        {/* With one topic for every question, the questions section above says it all. */}
        {single ? null : (
          <div className={row}>
            <dt className="text-ink-2">{plural(labels.scope)}</dt>
            <dd className="grid gap-0.5">
              {topic.scopes.map((s) => {
                const name = questionName.get(s.id);
                return name ? (
                  <Jump
                    key={s.id}
                    to={`question-${s.id}`}
                    title={s.label}
                    className="text-petrol underline decoration-petrol/40 underline-offset-2 hover:decoration-petrol"
                  >
                    {name}
                  </Jump>
                ) : (
                  <span key={s.id}>{s.label}</span>
                );
              })}
            </dd>
          </div>
        )}
        <div className={row}>
          <dt className="text-ink-2">Sources</dt>
          <dd>
            <ul>
              {topic.sources.map((s) => (
                <li key={s.id} title={`${s.id}, ${s.kind}`}>
                  {s.name}
                </li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Criteria({
  id,
  topic,
  labels,
  title,
  count,
}: {
  id: string | undefined;
  topic: SearchTopic;
  labels: ProfileLabels;
  title: string;
  count: number;
}) {
  // The second language folds away: the reader reads one wording, the other is a click on.
  const bilingual = topic.criteria.some((c) => c.text_de !== c.text_en);
  const [german, setGerman] = useState(false);
  const excluding = topic.criteria.filter((c) => c.polarity === "exclude").length;
  // This topic's own count; `count` is the review's, for a review with one topic the same.
  const own = topic.criteria.length || count;
  return (
    <section id={id} className="scroll-mt-6 rounded-[6px] bg-raised px-6 pt-5 pb-3 shadow-raised">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold">
          <Help text="A reviewer who excludes a record names one of these by its number. The numbers are the same on every screen.">
            {title}
          </Help>
        </h2>
        <p className="text-sm text-ink-2">
          {own} {own === 1 ? "criterion" : "criteria"}
          {excluding
            ? `, ${excluding} of them ${excluding === 1 ? "an exclusion" : "exclusions"}`
            : ""}
        </p>
        {bilingual ? (
          <Button kind="quiet" size="sm" className="ml-auto" onClick={() => setGerman((g) => !g)}>
            {german ? "Hide the German wording" : "Show the German wording"}
          </Button>
        ) : null}
      </header>
      <table className="mt-3 w-full border-collapse text-md">
        <thead>
          <tr className="border-b border-rule-strong text-left text-sm text-ink-2">
            <th className="w-10 py-1.5 pr-3 font-medium">No.</th>
            <th className="w-[9rem] py-1.5 pr-4 font-medium">Part</th>
            <th className="w-[7rem] py-1.5 pr-4 font-medium">Rule</th>
            <th className="w-[10rem] py-1.5 pr-4 font-medium">Applies at</th>
            <th className="py-1.5 font-medium">Criterion</th>
          </tr>
        </thead>
        <tbody>
          {topic.criteria.map((c, index) => (
            <CriterionRow key={c.id} criterion={c} index={index} labels={labels} german={german} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CriterionRow({
  criterion: c,
  index,
  labels,
  german,
}: {
  criterion: Criterion;
  index: number;
  labels: ProfileLabels;
  german: boolean;
}) {
  return (
    <tr className="border-b border-rule align-baseline last:border-b-0" title={c.id}>
      <td className="py-3 pr-3 font-semibold tabular-nums">{index + 1}</td>
      <td className="py-3 pr-4 text-sm">{labels[c.slot]}</td>
      <td className="py-3 pr-4">
        {/* A rule, not a verdict: neutral ink, so an exclusion does not read as a failure. The
        exclusions carry an outlined tag, so they stand out among the inclusions. */}
        {c.polarity === "include" ? (
          <span className="text-sm text-ink-2">Inclusion</span>
        ) : (
          <span className="inline-block rounded-[4px] border border-ink-2 px-1.5 text-xs font-semibold text-ink">
            Exclusion
          </span>
        )}
      </td>
      <td className="py-3 pr-4 text-sm text-ink-2">
        {c.decidable_at.length > 1
          ? "Both stages"
          : `${c.decidable_at.map((s) => STAGES[s] ?? s).join(", ")} only`}
      </td>
      <td className="py-3">
        {c.short_label ? (
          <span className="block text-md font-semibold">{c.short_label}</span>
        ) : null}
        <span className="block max-w-[68ch]">{c.text_en}</span>
        {german && c.text_de !== c.text_en ? (
          <span className="mt-0.5 block max-w-[68ch] text-sm text-ink-2" lang="de">
            {c.text_de}
          </span>
        ) : null}
        {c.exclusion_reason ? (
          <span className="mt-1 block text-sm text-ink-2">
            In the flow diagram: {c.exclusion_reason}
          </span>
        ) : null}
        {c.keywords.length ? (
          <details className="mt-1 text-sm text-ink-2">
            <summary
              className="cursor-pointer hover:text-ink"
              title="An exclusion on this criterion needs a quote that contains one of these word stems."
            >
              Matching terms ({c.keywords.length})
            </summary>
            <p className="mt-0.5">
              {c.keywords.map((k) => (/[\s*]$/.test(k) ? k : `${k}*`)).join(", ")}
            </p>
          </details>
        ) : null}
      </td>
    </tr>
  );
}

/** Context that folds: a recessed group with its title and one summary line, open on a click. */
function Fold({
  id,
  title,
  summary,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <details id={id} className="group scroll-mt-6 rounded-[4px] bg-sheet-2 px-6 py-4">
      <summary className="flex cursor-pointer list-none items-baseline gap-3">
        <span aria-hidden="true" className="text-ink-2 transition-transform group-open:rotate-90">
          ›
        </span>
        <span className="text-md font-semibold">{title}</span>
        <span className="min-w-0 truncate text-sm text-ink-2">{summary}</span>
      </summary>
      <div className="mt-4 pl-5">{children}</div>
    </details>
  );
}
