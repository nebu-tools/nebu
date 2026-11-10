// Progress (DESIGN.md, "Reviewer workbench"): the live PRISMA flow, the open work, and for the
// methods lead the quality checks and the agreement. Screeners see only their own counts, as the
// server shows them; nothing here is computed from data the viewer may not see.
import { Link, useRouteContext, useRouter } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import type {
  LedgerSummary,
  PairAgreement,
  PrismaFlow,
  Progress,
  RetrievalItem,
  ScreeningTable,
  StageInfo,
  StageProgressView,
} from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { formatDateTime } from "../../lib/format.ts";
import {
  isRegistryOnly,
  MODE_LABELS,
  modeLabel,
  revealLabel,
  sourceLabel,
} from "../../lib/labels.ts";
import { Button } from "../../ui/Button.tsx";
import { useKeys } from "../../ui/keys.ts";
import { Page } from "../../ui/Page.tsx";
import { Help } from "../../ui/Help.tsx";
import { Panel } from "../../ui/Panel.tsx";
import { Mark, NOT_DONE, Status, VERDICTS } from "../../ui/Status.tsx";
import { useProject } from "../project.tsx";

const STAGE_LABEL = { title_abstract: "Title and abstract", full_text: "Full text" } as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where a count's records can be opened: the Audit screen lists every PRISMA count. */
interface Links {
  readonly projectId: string;
  /** False where the audit is not there to open (the example data, a screener). */
  readonly audit: boolean;
}

export function ProgressScreen() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const router = useRouter();
  const { project, protocol, me, seesLeadData, labels, scopeLabel } = useProject();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [ledger, setLedger] = useState<LedgerSummary | null>(null);
  // The ledger's PRISMA flow per scope: retrieval and studies included, for the lead.
  const [flows, setFlows] = useState<ReadonlyArray<PrismaFlow> | null>(null);
  // Every report with its full text, to tell registry records (no article yet) from reports
  // that need a PDF, as Retrieval does.
  const [reports, setReports] = useState<ReadonlyArray<RetrievalItem> | null>(null);
  // Each stage as the lead's screening table has it: who decided what, and when.
  const [tables, setTables] = useState<ReadonlyArray<ScreeningTable>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const lead = seesLeadData;

  useEffect(() => {
    let live = true;
    run(workbench.progress({ projectId: project.id, as: me.actor_id })).then(
      (p) => live && setProgress(p),
      (e: unknown) =>
        live &&
        setNotice(
          e instanceof WorkbenchError
            ? e.message
            : "Kittum could not load the progress. Press r to try again.",
        ),
    );
    if (lead && workbench.live) {
      const caller = { projectId: project.id, as: me.actor_id };
      run(workbench.ledger(caller)).then(
        (l) => live && setLedger(l),
        () => live && setLedger(null),
      );
      run(workbench.asOf({ ...caller, cutoffSeq: null })).then(
        (a) => live && setFlows(a.flows),
        () => live && setFlows(null),
      );
      run(workbench.fullTexts(caller)).then(
        (r) => live && setReports(r),
        () => live && setReports(null),
      );
      Promise.all(
        project.stages.map((s) =>
          run(workbench.screeningTable({ ...caller, scopeId: s.scope_id, stage: s.stage })),
        ),
      ).then(
        (t) => live && setTables(t),
        () => live && setTables([]),
      );
    }
    return () => {
      live = false;
    };
  }, [workbench, project.id, project.stages, me.actor_id, lead, tick]);

  // Scopes screened at title and abstract whose full text is not open yet.
  const openable = lead
    ? project.stages.filter(
        (s) =>
          s.stage === "title_abstract" &&
          !project.stages.some((f) => f.stage === "full_text" && f.scope_id === s.scope_id),
      )
    : [];

  const openFullText = useCallback(
    async (stage: StageInfo) => {
      setNotice(null);
      try {
        await run(
          workbench.openStage({
            projectId: project.id,
            as: me.actor_id,
            scopeId: stage.scope_id,
            stage: "full_text",
          }),
        );
        // The project's stages changed: load them again.
        await router.invalidate();
        setTick((t) => t + 1);
      } catch (e) {
        setNotice(
          e instanceof WorkbenchError ? e.message : "Kittum could not open full-text screening.",
        );
      }
    },
    [workbench, router, project.id, me.actor_id],
  );

  useKeys((event) => {
    if (event.key === "n" && openable[0]) {
      void openFullText(openable[0]);
      return true;
    }
    if (event.key === "r") {
      setTick((t) => t + 1);
      return true;
    }
    return false;
  });

  const names = new Map(project.members.map((m) => [m.actor_id, m.display_name]));
  // The ledger's flow names sources as the PRISMA report does; the protocol fills the rest.
  // A source's database name first ("MEDLINE"), as every other screen names it.
  const given = new Map<string, string>();
  for (const flow of flows ?? [])
    for (const x of flow.identified_by_source) given.set(x.source, x.name);
  for (const topic of protocol?.protocol.topics ?? []) {
    for (const x of topic.sources) if (!given.has(x.id)) given.set(x.id, x.name);
  }
  const sourceName = (id: string) => sourceLabel(id, given.get(id));
  const multiScope = new Set(progress?.stages.map((s) => s.stage.scope_id) ?? []).size > 1;
  const links: Links = { projectId: project.id, audit: lead && workbench.live };
  const stageName = (s: StageProgressView) =>
    `${STAGE_LABEL[s.stage.stage]}${multiScope ? `, ${scopeLabel(s.stage.scope_id)}` : ""}`;

  return (
    <Page
      kind="data"
      title="Progress"
      summary={
        <>
          <span>{lead ? "The whole review" : "Your own work"}</span>
          {progress ? <Summary progress={progress} lead={lead} /> : null}
          {ledger && !ledger.ok ? (
            <span className="mt-1 block text-exclude" data-testid="ledger">
              These figures rest on ledger events after event{" "}
              {ledger.checked_through_seq ?? (ledger.verify?.first_bad_seq ?? 1) - 1}, which do not
              verify.{" "}
              <Link
                to="/p/$projectId/audit"
                params={{ projectId: project.id }}
                className="font-medium hover:underline"
              >
                Open the audit
              </Link>
            </span>
          ) : null}
        </>
      }
      actions={
        <>
          <Button kind="quiet" keys={["r"]} onClick={() => setTick((t) => t + 1)}>
            Refresh
          </Button>
          {openable[0] ? (
            <Button
              kind="primary"
              keys={["n"]}
              onClick={() => openable[0] && void openFullText(openable[0])}
            >
              Open full-text screening, {labels.scope.toLowerCase()}{" "}
              {scopeLabel(openable[0].scope_id)}
            </Button>
          ) : null}
        </>
      }
    >
      {notice ? (
        <p role="alert" className="mb-4 text-sm text-exclude">
          {notice}
        </p>
      ) : null}
      {!progress ? (
        notice ? null : (
          <p className="text-md text-ink-2">Loading progress.</p>
        )
      ) : (
        <>
          {lead ? (
            <OpenWork
              progress={progress}
              flows={flows}
              reports={reports}
              projectId={project.id}
              stageName={stageName}
            />
          ) : null}
          {/* Raise what the lead acts on: the quality checks, when a documented stage has them.
              The flow, the decisions of a working stage, and the folded details explain; they
              are recessed. A working stage alone leaves nothing to act on, so no sheet. */}
          <div className="grid grid-cols-[minmax(0,40rem)_minmax(0,1fr)] items-start gap-x-8 gap-y-6">
            <Panel
              level="recessed"
              title="Flow of records"
              summary={links.audit ? "Each count opens its records." : undefined}
              testId="flow"
            >
              <Flow
                progress={progress}
                flows={flows}
                reports={reports}
                lead={lead}
                links={links}
                sourceName={sourceName}
                scopeLabel={multiScope ? scopeLabel : null}
              />
            </Panel>
            <div className="flex flex-col gap-6">
              {lead ? (
                <>
                  <Quality
                    progress={progress}
                    names={names}
                    stageName={stageName}
                    unverified={ledger !== null && !ledger.ok}
                  />
                  <People progress={progress} tables={tables} names={names} stageName={stageName} />
                </>
              ) : (
                <p className="max-w-[60ch] text-md text-ink-2">
                  Only the methods lead sees agreement, extra screens, and the audit sample. You see
                  your own counts, so nothing here shows another person&rsquo;s decisions.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </Page>
  );
}

/** The one-line state under the title: what came in and what came out. */
function Summary({ progress, lead }: { progress: Progress; lead: boolean }) {
  const parts: string[] = [];
  const id = progress.identification;
  if (lead && id) parts.push(`${id.total_records_identified} records identified`);
  const sum = (stage: "title_abstract" | "full_text", f: (s: StageProgressView) => number) =>
    progress.stages.filter((s) => s.stage.stage === stage).reduce((n, s) => n + f(s), 0);
  const ta = progress.stages.some((s) => s.stage.stage === "title_abstract");
  const ft = progress.stages.some((s) => s.stage.stage === "full_text");
  if (ta) {
    const left = sum("title_abstract", (s) => s.status.remaining);
    parts.push(
      `${sum("title_abstract", (s) => s.status.screened)} screened at title and abstract${left ? `, ${left} to go` : ""}`,
    );
  }
  if (ft) {
    const left = sum("full_text", (s) => s.status.remaining);
    parts.push(
      `${sum("full_text", (s) => s.status.screened)} at full text${left ? `, ${left} to go` : ""}`,
    );
    if (lead) parts.push(`${sum("full_text", (s) => s.outcomes?.["include"] ?? 0)} included`);
  }
  return parts.length ? <span>: {parts.join(", ")}.</span> : <span>.</span>;
}

/** Sums over a scope: what is sought, retrieved, waiting for a PDF, and registry records with no
 * article yet. The last three add up to the first. */
function retrieval(
  view: StageProgressView | undefined,
  flow: PrismaFlow | null,
  reports: ReadonlyArray<RetrievalItem> | null,
) {
  const o = view?.outcomes;
  // Unclear at title and abstract means include: it is sought like an included record.
  const unclear = (o?.["unclear"] ?? 0) + (o?.["insufficient_information"] ?? 0);
  const sought = flow ? flow.reports_sought : o ? (o["include"] ?? 0) + unclear : null;
  const awaiting = flow ? flow.reports_not_retrieved : null;
  const retrieved = flow ? flow.reports_sought - flow.reports_not_retrieved : null;
  const byRef = new Map((reports ?? []).map((r) => [r.item_ref, r]));
  const registry =
    flow && reports
      ? (flow.members["reports_not_retrieved"] ?? []).filter((ref) => {
          const item = byRef.get(ref);
          return item !== undefined && isRegistryOnly(item);
        }).length
      : 0;
  const needPdf = awaiting === null ? null : awaiting - registry;
  return { sought, unclear, awaiting, retrieved, registry, needPdf };
}

/** The flow of one scope, from the ledger, or null before it loads. */
const flowOf = (flows: ReadonlyArray<PrismaFlow> | null, scope: string) =>
  flows?.find((f) => f.scope_id === scope && f.records_identified > 0) ??
  flows?.find((f) => f.scope_id === scope) ??
  null;

const WORK_ROUTES = {
  retrieval: "/p/$projectId/retrieval",
  adjudication: "/p/$projectId/adjudication",
  table: "/p/$projectId/screening/table",
} as const;

/** What still needs doing, each with the screen where it is done. */
function OpenWork({
  progress,
  flows,
  reports,
  projectId,
  stageName,
}: {
  progress: Progress;
  flows: ReadonlyArray<PrismaFlow> | null;
  reports: ReadonlyArray<RetrievalItem> | null;
  projectId: string;
  stageName: (s: StageProgressView) => string;
}) {
  type Item = { key: string; text: string; to?: keyof typeof WORK_ROUTES };
  const items: Item[] = [];
  for (const view of progress.stages) {
    const { stage, scope_id: scope } = view.stage;
    const name = stageName(view);
    const { remaining, conflicts, metrics } = view.status;
    if (remaining > 0) {
      items.push({
        key: `${stage}-${scope}-remaining`,
        text: `${name}: ${plural(remaining, stage === "title_abstract" ? "record" : "report")} to screen`,
        to: "table",
      });
    }
    if (conflicts) {
      items.push({
        key: `${stage}-${scope}-conflicts`,
        text: `${name}: ${plural(conflicts, "conflict")} to adjudicate`,
        to: "adjudication",
      });
    }
    const asked = metrics?.second_opinions;
    if (asked?.pending) {
      items.push({
        key: `${stage}-${scope}-opinions`,
        text: `${name}: ${plural(asked.pending, "second opinion")} waiting`,
      });
    }
    const audit = metrics?.documentation === "complete" ? metrics.audit : null;
    if (audit && audit.audit_samples > audit.audit_decided) {
      items.push({
        key: `${stage}-${scope}-audit`,
        text: `${name}: ${plural(audit.audit_samples - audit.audit_decided, "audit record")} to screen`,
      });
    }
    if (stage === "title_abstract") {
      const { needPdf } = retrieval(view, flowOf(flows, scope), reports);
      if (needPdf) {
        items.push({
          key: `${scope}-need-pdf`,
          text: `${plural(needPdf, "article needs", "articles need")} a PDF`,
          to: "retrieval",
        });
      }
    }
  }
  if (progress.stages.length === 0) return null;
  return (
    <section
      aria-label="Open work"
      className="-mt-2 mb-5 flex flex-wrap items-center gap-x-6 gap-y-1"
      data-testid="open-work"
    >
      <h2 className="text-md font-semibold">Next:</h2>
      {items.length === 0 ? (
        <Status term={VERDICTS.met}>
          <span className="text-md text-ink">Nothing is open. Every stage is decided.</span>
        </Status>
      ) : (
        items.map((item) => (
          <span key={item.key} className="inline-flex items-center gap-2 text-md">
            <Mark term={NOT_DONE} />
            {item.to ? (
              <Link
                to={WORK_ROUTES[item.to]}
                params={{ projectId }}
                className="text-petrol hover:underline"
                data-testid={`open-${item.key}`}
              >
                {item.text}
              </Link>
            ) : (
              <span data-testid={`open-${item.key}`}>{item.text}</span>
            )}
          </span>
        ))
      )}
    </section>
  );
}

interface Step {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  /** The PRISMA count behind the number, to open its records on the Audit screen. */
  readonly count?: string | undefined;
  readonly scope?: string | undefined;
  readonly detail?: ReactNode;
  readonly side?: ReactNode;
}

type Row = Step | { readonly phase: string; readonly key: string };

/** A number that opens the records behind it, where the Audit screen can list them. */
function Count({
  value,
  count,
  scope,
  links,
  testId,
  className,
}: {
  value: number | null;
  count?: string | undefined;
  scope?: string | undefined;
  links: Links;
  testId: string;
  className?: string;
}) {
  const text = (
    <span className={className} data-testid={testId}>
      {value ?? "None"}
    </span>
  );
  if (!count || !links.audit || value === null) return text;
  return (
    <Link
      to="/p/$projectId/audit"
      params={{ projectId: links.projectId }}
      search={{ count, ...(scope ? { scope } : {}) }}
      title="Open these records"
      className="text-petrol underline-offset-4 hover:underline"
    >
      {text}
    </Link>
  );
}

function Side({
  label,
  value,
  testId,
  count,
  scope,
  links,
  title,
}: {
  label: ReactNode;
  value: number;
  testId: string;
  count?: string | undefined;
  scope?: string | undefined;
  links: Links;
  title?: string | undefined;
}) {
  return (
    <span className="flex items-baseline justify-between gap-3 text-sm" title={title}>
      <span className="text-ink-2">{label}</span>
      <Count
        value={value}
        count={count}
        scope={scope}
        links={links}
        testId={testId}
        className="font-semibold tabular-nums"
      />
    </span>
  );
}

/**
 * The PRISMA 2020 flow as a column of steps in its order: identification, screening, retrieval,
 * eligibility, inclusion. Each step is a number; the records that leave the flow sit to the
 * right of the step they leave at, and studies sit beside reports.
 */
function Flow({
  progress,
  flows,
  reports,
  lead,
  links,
  sourceName,
  scopeLabel,
}: {
  progress: Progress;
  flows: ReadonlyArray<PrismaFlow> | null;
  reports: ReadonlyArray<RetrievalItem> | null;
  lead: boolean;
  links: Links;
  sourceName: (id: string) => string;
  /** Null with a single scope. */
  scopeLabel: ((scope: string) => string) | null;
}) {
  const id = progress.identification;
  const scopes = [...new Set(progress.stages.map((s) => s.stage.scope_id))];
  // With one scope its counts are the review's; with several, each count opens in its own.
  const only = scopes.length === 1 ? scopes[0] : undefined;
  const rows: Row[] = [];
  if (id) {
    rows.push({ phase: "Identification", key: "phase-identification" });
    const sources = Object.entries(id.records_identified_per_source);
    rows.push({
      key: "identified",
      label: "Records identified",
      value: id.total_records_identified,
      count: only ? "records_identified" : undefined,
      scope: only,
      detail: (
        <>
          {sources.map(([source, n], i) => (
            <span key={source} title={`Source ID: ${source}`}>
              {i > 0 ? ", " : ""}
              {sourceName(source)} {n}
            </span>
          ))}
          {`${sources.length ? ", " : ""}from ${plural(progress.searches, "search", "searches")}`}
        </>
      ),
      side: (
        <Side
          label="Duplicates removed"
          value={id.duplicates_removed}
          testId="duplicates"
          links={links}
        />
      ),
    });
    rows.push({
      key: "unique",
      label: "Reports after duplicates removed",
      value: id.unique_records,
      count: only ? "unique_records" : undefined,
      scope: only,
      side: (
        <Side label="Studies" value={id.studies_identified} testId="flow-studies" links={links} />
      ),
    });
  }

  for (const scope of scopes) {
    const at = (stage: "title_abstract" | "full_text") =>
      progress.stages.find((s) => s.stage.stage === stage && s.stage.scope_id === scope);
    const ta = at("title_abstract");
    const ft = at("full_text");
    const flow = lead ? flowOf(flows, scope) : null;
    const suffix = scopeLabel ? `, ${scopeLabel(scope)}` : "";
    const r = retrieval(ta, flow, reports);
    if (ta) {
      rows.push({ phase: `Screening${suffix}`, key: `phase-screening-${scope}` });
      rows.push(screenedStep(ta, lead, links, null));
      if (ta.outcomes && r.sought !== null) {
        const included = ta.outcomes["include"] ?? 0;
        rows.push({
          key: `title_abstract-${scope}-included`,
          label: lead ? "Reports sought for retrieval" : "Included for full text",
          value: r.sought,
          count: "reports_sought",
          scope,
          detail:
            lead && r.unclear
              ? `${included} included and ${r.unclear} marked unclear, which counts as included`
              : undefined,
          side:
            lead && r.awaiting !== null && r.retrieved !== null ? (
              <>
                <Side
                  label="Retrieved"
                  value={r.retrieved}
                  testId={`${scope}-retrieved`}
                  links={links}
                  title={
                    scopes.length === 1 && progress.full_texts !== r.retrieved
                      ? `${plural(progress.full_texts, "PDF")} in the review in all. The others are sentinels or belong to reports that were not sought.`
                      : undefined
                  }
                />
                <Side
                  label={
                    <Link
                      to="/p/$projectId/retrieval"
                      params={{ projectId: links.projectId }}
                      className="text-petrol hover:underline"
                      title="No PDF yet. Upload or fetch them on Retrieval."
                    >
                      Articles need a PDF
                    </Link>
                  }
                  value={r.needPdf ?? r.awaiting}
                  testId={`${scope}-not-retrieved`}
                  count={r.registry ? undefined : "reports_not_retrieved"}
                  scope={scope}
                  links={links}
                />
                {r.registry ? (
                  <Side
                    label={
                      <span title="Trial registry entries: no article to retrieve until the trial's results are published.">
                        Registry records, no article yet
                      </span>
                    }
                    value={r.registry}
                    testId={`${scope}-registry`}
                    links={links}
                  />
                ) : null}
              </>
            ) : lead && !flow && scopes.length === 1 ? (
              <Side
                label="PDFs uploaded"
                value={progress.full_texts}
                testId={`${scope}-pdfs`}
                links={links}
              />
            ) : undefined,
        });
      }
    }
    if (ft) {
      if (!ta) rows.push({ phase: `Screening${suffix}`, key: `phase-screening-${scope}` });
      rows.push(screenedStep(ft, lead, links, lead ? r.sought : null));
      if (ft.outcomes) {
        rows.push({ phase: `Included${suffix}`, key: `phase-included-${scope}` });
        rows.push({
          key: `full_text-${scope}-included`,
          label: lead ? "Reports included in the review" : "Included in the review",
          value: ft.outcomes["include"] ?? 0,
          count: "reports_included",
          scope,
          side: flow ? (
            <Side
              label="Studies included"
              value={flow.studies_included}
              testId={`${scope}-studies-included`}
              count="studies_included"
              scope={scope}
              links={links}
            />
          ) : undefined,
        });
      }
    }
  }
  if (rows.length === 0) {
    return <p className="text-md text-ink-2">No searches are recorded yet.</p>;
  }
  return (
    <ol>
      {rows.map((row) =>
        "phase" in row ? (
          <li key={row.key} className="pt-4 pb-0.5 text-xs font-semibold text-ink-2 first:pt-0">
            {row.phase}
          </li>
        ) : (
          <li
            key={row.key}
            className="grid grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,15rem)] items-start gap-x-5 py-2.5"
          >
            <span className="text-right text-[1.75rem] leading-none font-semibold tracking-[-0.02em] tabular-nums">
              <Count
                value={row.value}
                count={row.count}
                scope={row.scope}
                links={links}
                testId={`flow-${row.key}`}
              />
            </span>
            <span className="pt-0.5">
              <span className="block text-md">{row.label}</span>
              {row.detail ? (
                <span className="mt-0.5 block text-sm text-ink-2">{row.detail}</span>
              ) : null}
            </span>
            <span className="grid gap-1 pt-0.5">{row.side}</span>
          </li>
        ),
      )}
    </ol>
  );
}

function screenedStep(
  view: StageProgressView,
  lead: boolean,
  links: Links,
  /** Full text: every report sought for retrieval, PDF or not, for the stage's own bar. */
  sought: number | null,
): Step {
  const stage = view.stage.stage;
  const scope = view.stage.scope_id;
  const o = view.outcomes;
  const { screened, remaining, conflicts } = view.status;
  const open = conflicts ? `, ${plural(conflicts, "open conflict")}` : "";
  // At full text the stage's bar runs over every report sought, not only those with a PDF, so
  // it does not look finished while reports still wait for one.
  const whole =
    stage === "full_text" && sought !== null ? Math.max(sought, screened + remaining) : null;
  const detail =
    whole !== null
      ? `${screened} of ${whole} sought reports assessed. Available PDFs: ${screened} of ${screened + remaining}${open}.`
      : `${screened} done, ${remaining} to go${conflicts !== null ? `, ${plural(conflicts, "open conflict")}` : ""}`;
  const ta = stage === "title_abstract";
  return {
    key: `${stage}-${scope}-screened`,
    label: ta
      ? lead
        ? "Records screened at title and abstract"
        : "Title and abstract, your screens"
      : lead
        ? "Reports assessed at full text"
        : "Full text, your screens",
    value: screened + remaining,
    count: ta ? "records_screened" : "reports_assessed",
    scope,
    detail,
    side: o ? (
      <>
        {ta && lead ? (
          <Side
            label={<span title="Sought for retrieval in the next step">Included</span>}
            value={(o["include"] ?? 0) + (o["unclear"] ?? 0) + (o["insufficient_information"] ?? 0)}
            testId={`${stage}-${scope}-include`}
            count="reports_sought"
            scope={scope}
            links={links}
          />
        ) : null}
        <Side
          label="Excluded"
          value={o["exclude"] ?? 0}
          testId={`${stage}-${scope}-excluded`}
          count={ta ? "records_excluded" : "reports_excluded"}
          scope={scope}
          links={links}
        />
        <Side
          label="In conflict"
          value={o["conflict"] ?? 0}
          testId={`${stage}-${scope}-conflict`}
          count={ta ? "records_unresolved" : "reports_unresolved"}
          scope={scope}
          links={links}
        />
        <Side
          label={ta || !lead ? "Not yet decided" : "With a PDF, not yet decided"}
          value={o["pending"] ?? 0}
          testId={`${stage}-${scope}-pending`}
          count={ta ? "records_awaiting_screening" : "reports_awaiting_assessment"}
          scope={scope}
          links={links}
        />
      </>
    ) : undefined,
  };
}

const fixed = (n: number | null) => (n === null ? "Not defined" : n.toFixed(2));

/** Missed relevant records as whole records: the estimate rounded, the bound rounded up. */
const missed = (estimate: number, upper: number) => ({
  estimate: Math.round(estimate),
  upper: Math.ceil(upper - 1e-9),
});

/** The screening mode in words, with what it means in the hover. */
function ModeName({ view }: { view: StageProgressView }) {
  const working = view.status.metrics?.documentation === "working";
  return (
    <Help
      text={`${MODE_LABELS[view.stage.mode]?.long ?? ""}${
        working
          ? " A second opinion sees the first decision. There is no audit sample."
          : " Every decision is blind until the screener commits it."
      }`}
    >
      {modeLabel(view.stage.mode)}
    </Help>
  );
}

/** A table's stage cell. The mode shows here only when the stages differ in it; otherwise the
 * table's heading names it once. */
function StageCell({ view, name, mode }: { view: StageProgressView; name: string; mode: boolean }) {
  return (
    <th scope="row" className="w-[13rem] py-2 pr-4 text-left align-top font-normal">
      <span className="block font-medium">{name}</span>
      <span className="block text-sm text-ink-2">
        {mode ? (
          <span className="block">
            <ModeName view={view} />
          </span>
        ) : null}
        <span className="block">{revealLabel(view.stage.reveal)}</span>
      </span>
    </th>
  );
}

/** The stages' shared mode, named once in a group's summary line, or nothing. */
function SharedMode({ views }: { views: ReadonlyArray<StageProgressView> }) {
  const shared = new Set(views.map((v) => v.stage.mode)).size === 1 ? views[0] : undefined;
  return shared ? <ModeName view={shared} /> : null;
}

/** The folded agreement panel's one line: the screeners' kappa per stage, and how many
 * comparisons with the AI fall below 0.4. */
const agreementSummary = (
  views: ReadonlyArray<StageProgressView>,
  stageName: (s: StageProgressView) => string,
) => {
  const kappas = views.flatMap((v) => {
    const human = v.status.metrics?.agreement.find((p) => p.kind === "human_human");
    return human?.kappa != null
      ? [
          `${human.kappa.toFixed(2)} over ${plural(human.items, "record")} (${stageName(v).toLowerCase()})`,
        ]
      : [];
  });
  const low = views
    .flatMap((v) => v.status.metrics?.agreement ?? [])
    .filter((p) => p.kind !== "human_human" && p.kappa !== null && p.kappa < 0.4).length;
  const parts = [
    kappas.length ? `Kappa between screeners ${kappas.join(", ")}` : null,
    low ? `${plural(low, "comparison")} with the AI below 0.4` : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(". ")}.` : "Agreement and the audit's estimate per stage.";
};

/**
 * The lead's quality figures: every stage's checks in one table first, so both stages sit above
 * the fold, then the selected stage's details and agreement.
 */
function Quality({
  progress,
  names,
  stageName,
  unverified,
}: {
  progress: Progress;
  names: Map<string, string>;
  stageName: (s: StageProgressView) => string;
  /** The chain breaks: the page says so once; here the results say "recorded". */
  unverified: boolean;
}) {
  const withMetrics = progress.stages.filter((s) => s.status.metrics);
  const complete = withMetrics.filter((s) => s.status.metrics?.documentation === "complete");
  const working = withMetrics.filter((s) => s.status.metrics?.documentation === "working");
  const [picked, setPicked] = useState<string | null>(null);
  const shown = complete.find((s) => s.stage.stage_id === picked) ?? complete[0] ?? null;
  if (withMetrics.length === 0) {
    return (
      <p className="text-md text-ink-2">
        No screening stage is open yet. Quality checks and agreement appear here once screening
        starts.
      </p>
    );
  }
  const th = "py-2 pr-4 text-left align-bottom text-sm font-normal text-ink-2";
  return (
    <>
      {complete.length > 0 ? (
        <Panel
          label="Quality checks"
          title="Quality checks"
          summary={<SharedMode views={complete} />}
          testId="quality"
        >
          <div>
            <table className="w-full tabular-nums">
              <thead>
                <tr className="border-b border-rule">
                  <th className={th}>Stage</th>
                  <th className={th}>
                    <Help text="Records with a known outcome, hidden in the queues: how many the screeners decided as expected.">
                      Sentinels
                    </Help>
                  </th>
                  <th className={th}>
                    <Help text="Excluded records an auditor screens again, blind.">
                      Audit sample
                    </Help>
                  </th>
                  <th className={th}>
                    <Help text="How many relevant records the excluded ones may still hold, from the audit sample: the estimate and its one-sided 95% upper bound.">
                      Estimated missed
                    </Help>
                  </th>
                  <th className={th}>
                    <Help text="Conflicts between the screeners that an adjudicator resolved.">
                      Conflicts resolved
                    </Help>
                  </th>
                  <th className={th}>
                    <Help text="Records the screeners agreed on but the AI did not: each goes to the auditor for a blind extra screen.">
                      AI-triggered extra screens
                    </Help>
                  </th>
                </tr>
              </thead>
              <tbody>
                {complete.map((view, _, group) => {
                  const metrics = view.status.metrics!;
                  const audit = metrics.audit;
                  const stage = view.stage.stage;
                  const wrong = audit.sentinels_decided - audit.sentinels_correct;
                  const left = audit.audit_samples - audit.audit_decided;
                  const e = audit.elusion;
                  const m = e ? missed(e.estimate, e.upper) : null;
                  const r = metrics.rescreens;
                  return (
                    <tr key={view.stage.stage_id} className="border-b border-rule last:border-0">
                      <StageCell
                        view={view}
                        name={stageName(view)}
                        mode={new Set(group.map((v) => v.stage.mode)).size > 1}
                      />
                      <td className="py-2 pr-4 align-top">
                        <span className="text-md font-semibold">
                          {audit.sentinels_correct} of {audit.sentinels_decided}
                        </span>
                        <span className="block text-sm">
                          {audit.sentinels_decided === 0 ? (
                            <span className="text-ink-2">
                              {audit.sentinels} placed, none decided
                            </span>
                          ) : wrong === 0 ? (
                            <Status term={VERDICTS.met}>
                              {unverified ? "Recorded as correct" : "All correct"}
                            </Status>
                          ) : (
                            <Status term={VERDICTS.not_met}>{wrong} wrong</Status>
                          )}
                        </span>
                      </td>
                      <td className="py-2 pr-4 align-top">
                        <span className="text-md font-semibold" data-testid={`${stage}-audit`}>
                          {audit.audit_decided} of {audit.audit_samples}
                        </span>
                        <span className="block text-sm">
                          {audit.audit_samples === 0 ? (
                            <span className="text-ink-2">No sample</span>
                          ) : left === 0 ? (
                            <Status term={VERDICTS.met}>Done</Status>
                          ) : (
                            <Status term={NOT_DONE}>{left} to screen</Status>
                          )}
                        </span>
                      </td>
                      <td className="py-2 pr-4 align-top">
                        {e && m ? (
                          <>
                            <span className="text-md font-semibold whitespace-nowrap">
                              Estimate {m.estimate}
                            </span>
                            <span className="block text-sm whitespace-nowrap text-ink-2">
                              95% bound: up to {m.upper} of{" "}
                              <Help text={frame(view)}>{audit.excluded_population}</Help>
                            </span>
                          </>
                        ) : (
                          <span className="text-sm text-ink-2">No estimate yet</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 align-top">
                        <span
                          className="text-md font-semibold"
                          data-testid={`${stage}-adjudicated`}
                        >
                          {metrics.conflicts_resolved}
                        </span>
                      </td>
                      <td className="py-2 align-top">
                        <span className="text-md font-semibold">{r.triggered}</span>
                        <span
                          className="block text-sm whitespace-nowrap text-ink-2"
                          data-testid={`${stage}-rescreens`}
                        >
                          {r.triggered} sent, {r.pending} waiting, {r.upheld} upheld,{" "}
                          {r.adjudicated} adjudicated
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
      {working.length > 0 ? (
        <Panel
          level="recessed"
          label="Records and decisions"
          title="Records and decisions"
          summary={<SharedMode views={working} />}
          testId="decisions"
        >
          <div>
            <table className="w-full tabular-nums">
              <thead>
                <tr className="border-b border-rule">
                  <th className={th}>Stage</th>
                  <th className={th}>Records screened</th>
                  <th className={th}>Decision events</th>
                  <th className={th}>Second opinions</th>
                  <th className={th}>
                    <Help text="Decisions made with the AI's reading on screen, before the screener decided.">
                      Decided with AI visible
                    </Help>
                  </th>
                  <th className={th}>
                    <Help text="AI readings shown after the screener's own decision.">
                      AI shown after
                    </Help>
                  </th>
                </tr>
              </thead>
              <tbody>
                {working.map((view, _, group) => {
                  // Mode S: a second opinion is a second decision on the same record, so
                  // decisions and records are counted apart.
                  const metrics = view.status.metrics!;
                  const asked = metrics.second_opinions;
                  const answered = asked ? asked.kept + asked.changed : 0;
                  const screened = view.status.screened;
                  return (
                    <tr key={view.stage.stage_id} className="border-b border-rule last:border-0">
                      <StageCell
                        view={view}
                        name={stageName(view)}
                        mode={new Set(group.map((v) => v.stage.mode)).size > 1}
                      />
                      <td className="py-2 pr-4 align-top text-md font-semibold">{screened}</td>
                      <td className="py-2 pr-4 align-top">
                        <span className="text-md font-semibold">{screened + answered}</span>
                        <span className="block text-sm text-ink-2">
                          {answered
                            ? `One per record, plus ${plural(answered, "second opinion")}`
                            : "One per record"}
                        </span>
                      </td>
                      <td className="py-2 pr-4 align-top">
                        <span className="text-md font-semibold">{asked?.requested ?? 0}</span>
                        <span
                          className="block text-sm text-ink-2"
                          data-testid={`${view.stage.stage}-second-opinions`}
                        >
                          {asked?.requested
                            ? `${asked.requested} asked, ${asked.pending} waiting, ${asked.kept} kept, ${asked.changed} changed`
                            : "None asked"}
                        </span>
                      </td>
                      {view.stage.reveal === "never" ? (
                        <td colSpan={2} className="py-2 align-top text-sm text-ink-2">
                          This stage never shows the AI&rsquo;s reading.
                        </td>
                      ) : (
                        <>
                          <td className="py-2 pr-4 align-top text-md font-semibold">
                            {metrics.ai_shown_before ?? 0}
                          </td>
                          <td className="py-2 align-top text-md font-semibold">
                            {metrics.reveals_shown}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
      {shown ? (
        <Panel
          level="recessed"
          label="Agreement and missed records"
          title="Agreement and missed records"
          summary={agreementSummary(complete, stageName)}
          fold="closed"
          testId="stage-details"
        >
          {complete.length > 1 ? (
            <div role="tablist" aria-label="Stages" className="-mt-1 mb-2 flex gap-1">
              {complete.map((view) => {
                const on = view === shown;
                return (
                  <button
                    key={view.stage.stage_id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setPicked(view.stage.stage_id)}
                    className={`-mb-px border-b-2 px-3 py-2 text-md ${
                      on
                        ? "border-petrol font-semibold text-ink"
                        : "border-transparent text-ink-2 hover:text-ink"
                    }`}
                  >
                    {stageName(view)}
                  </button>
                );
              })}
            </div>
          ) : null}
          <StageDetail key={shown.stage.stage_id} view={shown} names={names} />
        </Panel>
      ) : null}
    </>
  );
}

function StageDetail({ view, names }: { view: StageProgressView; names: Map<string, string> }) {
  const metrics = view.status.metrics!;
  const rater = (id: string) => (id === "ai" ? "AI judge" : (names.get(id) ?? "Someone"));
  const human = metrics.agreement.filter((p) => p.kind === "human_human");
  const withAi = metrics.agreement.filter((p) => p.kind !== "human_human");
  return (
    <div
      role="tabpanel"
      className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)] items-start gap-x-8 gap-y-5 px-5 py-4"
    >
      <div className="grid gap-5">
        {metrics.agreement.length > 0 ? (
          <section aria-label="Agreement">
            <h3 className="text-sm font-semibold">
              <Help text="Every decision here was made before any AI output was shown. Kappa and PABAK cover every record both sides decided, agreed or not. Open a row for its 2x2 table.">
                Agreement on the blind decisions
              </Help>
            </h3>
            <AgreementTable
              stage={STAGE_LABEL[view.stage.stage]}
              groups={[
                ["Between screeners", human],
                ["Each screener against the AI", withAi],
              ]}
              rater={rater}
            />
          </section>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-8">
          <div>
            <dt className="text-sm text-ink-2">
              <Help text="Counts decisions, not records: each screener's decision after which Kittum showed the AI's disagreeing reading counts once.">
                Decision events followed by the AI&rsquo;s reading
              </Help>
            </dt>
            <dd className="text-lg font-semibold tabular-nums">{metrics.reveals_shown}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-2">
              Decisions changed after seeing an AI disagreement
            </dt>
            <dd className="text-lg font-semibold tabular-nums">{metrics.revised_after_reveal}</dd>
          </div>
        </dl>
      </div>
      <div>
        <MissedRelevant view={view} />
      </div>
    </div>
  );
}

const ROLE_WORDS = {
  screener: "Screener",
  auditor: "Auditor",
  second_opinion: "Second opinion",
} as const;

/** Each person's share of each stage: what they decided, how, and when they last did. */
function People({
  progress,
  tables,
  names,
  stageName,
}: {
  progress: Progress;
  tables: ReadonlyArray<ScreeningTable>;
  names: Map<string, string>;
  stageName: (s: StageProgressView) => string;
}) {
  const stages = progress.stages
    .map((view) => ({ view, table: tables.find((t) => t.stage_id === view.stage.stage_id) }))
    .filter((s) => s.table && s.table.rows.length > 0);
  if (stages.length === 0) return null;
  const th = "py-2 pr-4 text-left align-bottom text-sm font-normal text-ink-2";
  const td = "py-1.5 pr-4 text-right tabular-nums";
  const everyone = new Set<string>();
  let lastAt: string | null = null;
  for (const { table } of stages) {
    for (const row of table!.rows) {
      for (const d of row.decisions) {
        if (d.reviewer_id) everyone.add(names.get(d.reviewer_id) ?? "Someone");
        if (d.state === "decided" && d.decided_at && (!lastAt || d.decided_at > lastAt)) {
          lastAt = d.decided_at;
        }
      }
    }
  }
  const peopleSummary = `${[...everyone].join(", ")}${lastAt ? `; last decision ${formatDateTime(lastAt)}` : ""}`;
  return (
    <Panel
      level="recessed"
      label="Who decided what"
      title="Who decided what"
      summary={peopleSummary}
      fold="closed"
      testId="people"
    >
      <div>
        <table className="w-full text-md">
          <thead>
            <tr className="border-b border-rule">
              <th className={th}>Person</th>
              <th className={th}>Role</th>
              <th className={`${th} text-right`}>Decided</th>
              <th className={`${th} text-right`}>Include</th>
              <th className={`${th} text-right`}>Exclude</th>
              <th className={`${th} text-right`}>Unclear</th>
              <th className={`${th} text-right`}>
                <Help text="Second opinions this person asked a colleague for">
                  Asked 2nd opinion
                </Help>
              </th>
              <th className={`${th} text-right`}>
                <Help text="Second opinions this person gave on a colleague's decision">
                  Gave 2nd opinion
                </Help>
              </th>
              <th className={th}>Last decision</th>
            </tr>
          </thead>
          <tbody>
            {stages.map(({ view, table }) => {
              type Tally = {
                roles: Set<string>;
                assigned: number;
                decided: number;
                outcomes: Record<string, number>;
                asked: number;
                gave: number;
                last: string | null;
              };
              const people = new Map<string, Tally>();
              for (const row of table!.rows) {
                for (const d of row.decisions) {
                  if (!d.reviewer_id) continue;
                  const t: Tally = people.get(d.reviewer_id) ?? {
                    roles: new Set(),
                    assigned: 0,
                    decided: 0,
                    outcomes: {},
                    asked: 0,
                    gave: 0,
                    last: null,
                  };
                  if (d.role) t.roles.add(ROLE_WORDS[d.role]);
                  t.assigned += 1;
                  if (d.state === "decided") {
                    t.decided += 1;
                    if (d.outcome) t.outcomes[d.outcome] = (t.outcomes[d.outcome] ?? 0) + 1;
                    if (d.second_opinion) t.asked += 1;
                    if (d.role === "second_opinion") t.gave += 1;
                    if (d.decided_at && (!t.last || d.decided_at > t.last)) t.last = d.decided_at;
                  }
                  people.set(d.reviewer_id, t);
                }
              }
              return (
                <Fragment key={view.stage.stage_id}>
                  <tr>
                    <th
                      colSpan={9}
                      scope="colgroup"
                      className="pt-3 pb-1 text-left text-sm font-semibold"
                    >
                      {stageName(view)}
                    </th>
                  </tr>
                  {[...people].map(([id, t]) => (
                    <tr key={id} className="border-t border-rule">
                      <td className="py-1.5 pr-4 whitespace-nowrap">
                        {names.get(id) ?? "Someone"}
                      </td>
                      <td className="py-1.5 pr-4 text-sm text-ink-2">{[...t.roles].join(", ")}</td>
                      <td className={td}>
                        {t.decided}
                        {t.assigned > t.decided ? (
                          <span className="text-sm text-ink-2"> of {t.assigned}</span>
                        ) : null}
                      </td>
                      <td className={td}>{t.outcomes["include"] ?? 0}</td>
                      <td className={td}>{t.outcomes["exclude"] ?? 0}</td>
                      <td className={td}>
                        {(t.outcomes["unclear"] ?? 0) +
                          (t.outcomes["insufficient_information"] ?? 0)}
                      </td>
                      <td className={td}>{t.asked}</td>
                      <td className={td}>{t.gave}</td>
                      <td className="py-1.5 text-sm whitespace-nowrap text-ink-2 tabular-nums">
                        {t.last ? formatDateTime(t.last) : "None yet"}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** Excluded records outside the audit's frame: those excluded after a conflict. */
const outside = (view: StageProgressView) => {
  const excluded = view.outcomes?.["exclude"] ?? null;
  const population = view.status.metrics?.audit.excluded_population ?? 0;
  return excluded !== null && view.status.remaining === 0 ? Math.max(0, excluded - population) : 0;
};

/** What the audit's denominator counts, and why it can be smaller than the records excluded. */
const frame = (view: StageProgressView) => {
  const apart = outside(view);
  const excluded = view.outcomes?.["exclude"] ?? 0;
  return apart > 0
    ? `${excluded} records are excluded in all. The audit samples the ones the screeners excluded without a conflict. The other ${apart} went to adjudication, so a third person read ${apart === 1 ? "it" : "them"}.`
    : "The records the screeners excluded without a conflict, and the records not yet screened.";
};

/**
 * Relevant records the excluded ones may still hold, as the audit sample estimates them: the
 * sample's own finding first, then the estimate and the bound on a scale of the excluded records.
 */
function MissedRelevant({ view }: { view: StageProgressView }) {
  const audit = view.status.metrics?.audit;
  if (!audit) return null;
  const e = audit.elusion;
  const population = audit.excluded_population;
  const apart = outside(view);
  const scope = <Help text={frame(view)}>{plural(population, "excluded record")}</Help>;
  if (!e) {
    return (
      <p className="text-md">
        <span className="font-semibold">Missed relevant records:</span>{" "}
        <span className="text-ink-2">
          no estimate yet for the {scope}. A group of them has no screened audit sample.
        </span>
      </p>
    );
  }
  const m = missed(e.estimate, e.upper);
  const pct = (n: number) => `${Math.min(100, (n / Math.max(population, 1)) * 100)}%`;
  return (
    <section aria-label="Audit gauge">
      {/* The figures are in the quality checks; here the scale, and what the frame leaves out. */}
      <h3 className="text-sm font-semibold">Missed relevant records among the {scope}</h3>
      {apart > 0 ? (
        <p className="mt-0.5 text-sm text-ink-2">
          {apart} more excluded {apart === 1 ? "record" : "records"} went to adjudication and{" "}
          {apart === 1 ? "is" : "are"} outside the sample.
        </p>
      ) : null}
      <div className="mt-3 max-w-[40rem]" aria-hidden="true">
        <div className="relative h-3 rounded-full bg-sheet-2 shadow-[inset_0_0_0_1px_var(--rule)]">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-petrol-wash"
            style={{ width: pct(e.upper) }}
          />
          <div
            className="absolute inset-y-[-3px] w-[3px] -translate-x-1/2 rounded-[1px] bg-petrol"
            style={{ left: pct(e.estimate) }}
          />
        </div>
        <div className="relative mt-1 h-5 text-sm text-ink-2 tabular-nums">
          <span className="absolute left-0">0</span>
          <span className="absolute -translate-x-1/2" style={{ left: pct(e.upper) }}>
            {m.upper < population ? `${Math.round(e.confidence * 100)}% bound ${m.upper}` : ""}
          </span>
          <span className="absolute right-0">{population}</span>
        </div>
      </div>
    </section>
  );
}

const AI_READING = {
  human_ai: "the AI’s raw reading",
  human_ai_verified: "the AI’s quote-checked reading",
} as const;

const AI_READING_HELP = {
  human_ai: "The AI’s raw reading excludes a record when it answered not met for any criterion.",
  human_ai_verified:
    "The AI’s quote-checked reading excludes a record only where Kittum found the quote the AI gave for a criterion not met.",
} as const;

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Kappa or PABAK below 0.4 is weak agreement; below 0 is worse than chance. */
function Flag({ value, name }: { value: number | null; name: string }) {
  if (value === null || value >= 0.4) return null;
  const below = value < 0;
  return (
    <span
      className={`mt-0.5 block w-fit rounded-full px-2 py-px text-xs font-medium ${
        below
          ? "bg-exclude-wash text-exclude"
          : "bg-sheet-2 text-ink-2 shadow-[inset_0_0_0_1px_var(--rule-strong)]"
      }`}
      title={
        below
          ? `${name} below 0: the two agree less often than chance would make them.`
          : `${name} below 0.4: weak agreement beyond chance.`
      }
    >
      {below ? "Below chance" : "Low"}
    </span>
  );
}

/**
 * Every pair's agreement as one table: how many records both decided, how many they agreed on,
 * and kappa and PABAK over all of them. A row opens to the 2x2 table behind it.
 */
function AgreementTable({
  stage,
  groups,
  rater,
}: {
  stage: string;
  groups: ReadonlyArray<readonly [string, ReadonlyArray<PairAgreement>]>;
  rater: (id: string) => string;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const th = "py-1.5 font-normal";
  return (
    <table className="mt-2 w-full text-sm tabular-nums" aria-label={`Agreement, ${stage}`}>
      <thead className="text-left text-ink-2">
        <tr className="border-b border-rule">
          <th className={th}>Pair</th>
          <th className={`${th} pr-6 text-right`}>
            <Help text="Records both sides decided">Both decided</Help>
          </th>
          <th className={`${th} pr-6 text-right`}>Agreed</th>
          <th className={`${th} w-[10.5rem]`}>
            <Help text="Cohen's kappa: agreement beyond chance. 1 is perfect, 0 is what chance gives. Below 0.4 is flagged.">
              Kappa
            </Help>
          </th>
          <th className={`${th} w-[10.5rem]`}>
            <Help text="Prevalence- and bias-adjusted kappa: kappa as if include and exclude were equally common. Below 0.4 is flagged.">
              PABAK
            </Help>
          </th>
        </tr>
      </thead>
      <tbody>
        {groups.map(([title, pairs]) =>
          pairs.length === 0 ? null : (
            <Fragment key={title}>
              <tr>
                <th
                  colSpan={5}
                  scope="colgroup"
                  className="pt-3 pb-1 text-left text-xs font-semibold text-ink-2"
                >
                  {title}
                </th>
              </tr>
              {pairs.map((pair) => {
                const key = `${pair.kind}-${pair.raters.join()}`;
                const first = rater(pair.raters[0]);
                const second =
                  pair.kind === "human_human" ? rater(pair.raters[1]) : AI_READING[pair.kind];
                const agreed = (pair.include_include ?? 0) + (pair.exclude_exclude ?? 0);
                const expanded = open.has(key);
                return (
                  <Fragment key={key}>
                    <tr
                      className="border-t border-rule"
                      data-testid="agreement"
                      data-kind={pair.kind}
                    >
                      <td className="py-1.5">
                        <button
                          type="button"
                          onClick={() => toggle(key)}
                          aria-expanded={expanded}
                          className="flex items-center gap-2 text-left whitespace-nowrap hover:text-petrol"
                          title={
                            pair.kind === "human_human" ? undefined : AI_READING_HELP[pair.kind]
                          }
                        >
                          <span
                            aria-hidden="true"
                            className={`inline-block w-3 text-ink-2 transition-transform ${expanded ? "rotate-90" : ""}`}
                          >
                            ›
                          </span>
                          <span>
                            {first} and {second}
                          </span>
                        </button>
                      </td>
                      <td className="pr-6 text-right">{pair.items}</td>
                      <td className="pr-6 text-right whitespace-nowrap" data-testid="agreed">
                        {pair.items === 0
                          ? "None yet"
                          : `${agreed} (${Math.round((agreed / pair.items) * 100)}%)`}
                      </td>
                      <td className="whitespace-nowrap">
                        <span
                          className="font-semibold"
                          data-testid={pair.kind === "human_human" ? "kappa" : undefined}
                        >
                          {fixed(pair.kappa)}
                        </span>{" "}
                        <Flag value={pair.kappa} name="Kappa" />
                      </td>
                      <td className="whitespace-nowrap">
                        <span className="font-semibold">{fixed(pair.pabak)}</span>{" "}
                        <Flag value={pair.pabak} name="PABAK" />
                      </td>
                    </tr>
                    {expanded ? (
                      <tr>
                        <td colSpan={5} className="pb-3 pl-5">
                          <TwoByTwo pair={pair} first={first} second={second} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </Fragment>
          ),
        )}
      </tbody>
    </table>
  );
}

function TwoByTwo({ pair, first, second }: { pair: PairAgreement; first: string; second: string }) {
  const cell = "px-3 py-1 text-right tabular-nums";
  return (
    <div className="flex items-start gap-8">
      <table className="text-sm" aria-label={`${first} against ${second}`}>
        <thead className="text-ink-2">
          <tr>
            <th />
            <th colSpan={2} className="px-3 py-1 text-center font-normal">
              {capital(second)}
            </th>
          </tr>
          <tr>
            <th className="px-3 py-1 text-left font-normal">{first}</th>
            <th className="px-3 py-1 text-right font-normal">Include</th>
            <th className="px-3 py-1 text-right font-normal">Exclude</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-rule">
            <th className="px-3 py-1 text-left font-normal text-ink-2">Include</th>
            <td className={`${cell} bg-include-wash font-semibold`}>{pair.include_include ?? 0}</td>
            <td className={cell}>{pair.include_exclude ?? 0}</td>
          </tr>
          <tr className="border-t border-rule">
            <th className="px-3 py-1 text-left font-normal text-ink-2">Exclude</th>
            <td className={cell}>{pair.exclude_include ?? 0}</td>
            <td className={`${cell} bg-exclude-wash font-semibold`}>{pair.exclude_exclude ?? 0}</td>
          </tr>
        </tbody>
      </table>
      <p className="max-w-[44ch] pt-1 text-sm text-ink-2">
        The shaded cells are the records both decided the same way. Kappa and PABAK count every
        record in the table.
        {pair.kind !== "human_human" ? ` ${AI_READING_HELP[pair.kind]}` : ""}
      </p>
    </div>
  );
}
