// The searches as run (DESIGN.md, "Search"): one execution per database and strategy, with what
// PRISMA-S asks for: the platform, the verbatim strategy, limits, dates, and both counts. The
// summary comes first: how many searches and records, and what the searches found of the known
// pool, with the papers they missed beside the list of searches.
import { Link, useRouteContext } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { SearchExecution } from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { formatDateTime, formatTime } from "../../lib/format.ts";
import { sourceLabel } from "../../lib/labels.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/Empty.tsx";
import { KeyHint } from "../../ui/Key.tsx";
import { useKeys } from "../../ui/keys.ts";
import { Page } from "../../ui/Page.tsx";
import { LEAD_ONLY, useProject } from "../project.tsx";
import { KnownPools, poolTotals, useKnownPools } from "./KnownPool.tsx";
import { ImportSearch, RunSearch } from "./SearchForms.tsx";

/** Whether a key was pressed on a button or link, which acts on its own. */
const onControl = (event: KeyboardEvent) =>
  event.target instanceof HTMLElement && event.target.closest("button, a") !== null;

export function SearchScreen() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, seesLeadData, protocol } = useProject();
  const lead = seesLeadData;
  const [executions, setExecutions] = useState<ReadonlyArray<SearchExecution> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [form, setForm] = useState<"import" | "run" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showMissed, setShowMissed] = useState(0);
  const items = useRef<Array<HTMLElement | null>>([]);
  const canAdd = lead && protocol !== null;
  const { topics, pools, reload } = useKnownPools(tick);
  // Whether the corpus is built: the next step for a missing paper depends on it.
  const [built, setBuilt] = useState(false);
  useEffect(() => {
    if (!lead) return;
    let live = true;
    run(workbench.progress({ projectId: project.id, as: me.actor_id })).then(
      (p) => live && setBuilt(Boolean(p?.identity_revision_id)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [workbench, project.id, me.actor_id, lead]);

  const added = (execution: SearchExecution) => {
    setForm(null);
    setNotice(
      `Added the ${execution.plan.platform} search with ${execution.retrieved_count} records. Add the next database's search. Once every search is in, build the corpus on the Studies screen.`,
    );
    setTick((t) => t + 1);
  };

  const toggle = (id: string) =>
    setExpanded((open) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  useEffect(() => {
    if (!lead) return;
    let live = true;
    run(workbench.searches({ projectId: project.id, as: me.actor_id })).then(
      // The server lists the newest first; read them in the order they were run.
      (found) => live && setExecutions([...found].reverse()),
      (e: unknown) =>
        live &&
        setError(e instanceof WorkbenchError ? e.message : "Kittum could not load the searches."),
    );
    return () => {
      live = false;
    };
  }, [workbench, project.id, me.actor_id, lead, tick]);

  useEffect(() => {
    items.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useKeys((event) => {
    if (canAdd && (event.key === "i" || event.key === "n")) {
      setForm(event.key === "i" ? "import" : "run");
      return true;
    }
    if (!executions?.length) return false;
    if (event.key === "j" || event.key === "ArrowDown") {
      setSelected((i) => Math.min(i + 1, executions.length - 1));
      return true;
    }
    if (event.key === "k" || event.key === "ArrowUp") {
      setSelected((i) => Math.max(i - 1, 0));
      return true;
    }
    // Enter on a focused button or link is that control's own.
    if (event.key === "Enter" && !onControl(event)) {
      const current = executions[selected];
      if (!current) return false;
      toggle(current.id);
      return true;
    }
    return false;
  });

  if (!lead) {
    return (
      <section className="h-full overflow-y-auto bg-paper">
        <EmptyState title="Searches" testId="lead-only">
          {LEAD_ONLY}
        </EmptyState>
      </section>
    );
  }
  if (!protocol) {
    return (
      <section className="h-full overflow-y-auto bg-paper">
        <EmptyState
          title="Searches"
          actions={
            <Link
              to="/p/$projectId/protocol"
              params={{ projectId: project.id }}
              className="rounded-[4px] border border-rule-strong bg-sheet px-3 py-1.5 text-sm hover:bg-sheet-2"
            >
              Go to the protocol
            </Link>
          }
        >
          Publish the protocol first. Each search belongs to one of its search topics.
        </EmptyState>
      </section>
    );
  }

  const records = executions?.reduce((n, e) => n + e.retrieved_count, 0) ?? 0;
  const totals = poolTotals(pools);
  const task =
    executions?.length === 0
      ? "No searches yet. Add one search per database and query."
      : totals === null
        ? null
        : totals.size === 0
          ? "Add the customer's known papers to check what the search finds."
          : totals.missed === 0
            ? "The search found every known paper."
            : built
              ? "Check each missing paper against the queries."
              : "Check each missing paper against the queries before you build the corpus.";
  // Once the corpus is built, a new search is kept apart: say so where the lead reads the task.
  const summary = built
    ? [task, "The corpus is built, so a new search is kept but cannot join it yet."]
        .filter(Boolean)
        .join(" ")
    : task;

  return (
    <Page
      kind="lead"
      title="Searches"
      summary={summary}
      actions={
        canAdd ? (
          <>
            <Button keys={["i"]} onClick={() => setForm("import")}>
              Import a search file
            </Button>
            <Button keys={["n"]} onClick={() => setForm("run")}>
              Run a live search
            </Button>
          </>
        ) : null
      }
    >
      {canAdd ? (
        <>
          <ImportSearch
            open={form === "import"}
            onOpenChange={(o) => setForm(o ? "import" : null)}
            onDone={added}
          />
          <RunSearch
            open={form === "run"}
            onOpenChange={(o) => setForm(o ? "run" : null)}
            onDone={added}
          />
        </>
      ) : null}

      {/* One figure carries the page: what the search found of the known pool. The other
          counts are context, in one quiet line. */}
      <div aria-label="Summary" data-testid="search-summary">
        {totals && totals.size > 0 ? (
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span
              className={`text-xl font-semibold tabular-nums ${totals.missed === 0 ? "text-include" : ""}`}
            >
              <span data-testid="pool-found">{totals.found}</span> of {totals.size}
            </span>
            <span className="text-md">
              known papers found ({Math.round((totals.found / totals.size) * 100)}%)
            </span>
            {totals.missed ? (
              <Button kind="quiet" size="sm" onClick={() => setShowMissed((n) => n + 1)}>
                Show the <span data-testid="pool-missed">{totals.missed}</span> missing
              </Button>
            ) : null}
          </p>
        ) : null}
        <p className="mt-1 text-sm text-ink-2">
          {executions ? (
            <>
              {executions.length} {executions.length === 1 ? "search" : "searches"}, {records}{" "}
              records retrieved before deduplication
            </>
          ) : (
            "Loading the searches"
          )}
          {totals && totals.size > 0 ? (
            <>
              ; <span data-testid="pool-new">{totals.fresh}</span> of {totals.searched}{" "}
              {totals.unit} are not in the known pool
            </>
          ) : totals ? (
            "; no known papers yet"
          ) : null}
          .
        </p>
      </div>

      {notice ? (
        <p
          role="status"
          className="mt-4 max-w-[90ch] border-l-2 border-petrol py-1.5 pl-3 text-sm"
          data-testid="search-notice"
        >
          {notice}
        </p>
      ) : null}

      <div className="mt-6 grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_520px]">
        <div>
          {error ? (
            <p role="alert" className="text-exclude">
              {error}
            </p>
          ) : executions === null ? (
            <p className="text-ink-2">Loading the searches.</p>
          ) : executions.length === 0 ? (
            <div className="rounded-[4px] border border-dashed border-rule-strong bg-sheet px-6 py-8">
              <h2 className="text-md font-semibold">No searches yet</h2>
              <p className="mt-1 max-w-[70ch] text-ink-2">
                Run PubMed, Europe PMC, and ClinicalTrials.gov live with the buttons above, and
                import the export file of every other database. Add one search per database and
                query.
              </p>
            </div>
          ) : (
            <>
              <ol
                className="grid gap-1 rounded-[4px] bg-sheet-2 p-2"
                aria-label="Search executions"
              >
                {executions.map((execution, index) => (
                  <li
                    key={execution.id}
                    ref={(el) => {
                      items.current[index] = el;
                    }}
                    aria-current={index === selected || undefined}
                    onClick={() => setSelected(index)}
                    className={`rounded-[4px] px-4 py-3 ${
                      index === selected && executions.length > 2
                        ? "shadow-[inset_3px_0_0_var(--petrol)]"
                        : ""
                    }`}
                  >
                    <Execution
                      execution={execution}
                      selected={index === selected && executions.length > 2}
                      expanded={expanded.has(execution.id)}
                      onToggle={() => toggle(execution.id)}
                    />
                  </li>
                ))}
              </ol>
              {/* With few searches the list needs no keys; the Keys sheet lists them too. */}
              {executions.length > 2 ? (
                <p className="mt-2 text-xs">
                  <KeyHint keys={["j", "k"]}>Next and previous search</KeyHint>
                </p>
              ) : null}
            </>
          )}
        </div>
        {canAdd && topics.length ? (
          <aside>
            <KnownPools topics={topics} pools={pools} onChanged={reload} showMissed={showMissed} />
          </aside>
        ) : null}
      </div>
    </Page>
  );
}

function Execution({
  execution: e,
  selected,
  expanded,
  onToggle,
}: {
  execution: SearchExecution;
  selected: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const lines = e.plan.strategy.split("\n");
  const skipped = e.skipped_record_ids?.length ?? 0;
  const differs = e.reported_count !== e.retrieved_count;
  const name = sourceLabel(e.plan.source, e.plan.platform);
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(e.plan.strategy).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  const start = formatDateTime(e.started_at);
  const end = formatDateTime(e.ended_at);
  const query = "font-mono text-[12.5px] leading-[20px] break-words";
  return (
    <article aria-label={`${e.plan.platform} search`}>
      <header className="flex flex-wrap items-baseline gap-x-4 text-sm text-ink-2">
        <h2 className="text-md font-semibold text-ink" title={`Source ID: ${e.plan.source}`}>
          {name}
        </h2>
        <span
          title={
            e.raw_artifact_hashes.length
              ? `Raw ${e.kind === "live_api" ? "responses" : "file"}, SHA-256: ${e.raw_artifact_hashes.join(", ")}`
              : undefined
          }
        >
          {e.kind === "live_api" ? "Run live by Kittum" : "Imported from an export file"}, {start}
          {end !== start ? ` to ${formatTime(e.ended_at)}` : ""}
        </span>
        <span className="ml-auto text-ink" data-testid="search-counts">
          {e.reported_count} reported, {e.retrieved_count} retrieved
        </span>
        {differs ? (
          <span className="w-full text-exclude">
            {skipped > 0
              ? `${skipped} book records that Kittum cannot read yet`
              : "The counts differ, so this search is incomplete"}
          </span>
        ) : null}
      </header>
      <div className="mt-2 min-w-0 text-sm">
        <p className="sr-only">Query</p>
        {expanded ? (
          <>
            {lines.length > 1 ? (
              <ol className={`mt-0.5 ${query}`}>
                {lines.map((line, i) => (
                  <li key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2">
                    <span className="text-right text-ink-2 select-none">{i + 1}</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={`mt-0.5 ${query}`}>{e.plan.strategy}</p>
            )}
            {e.query_translation ? (
              <div className="mt-2">
                <p className="text-xs font-semibold text-ink-2">As the platform read it</p>
                <p className={`text-ink-2 ${query}`}>{e.query_translation}</p>
              </div>
            ) : null}
            {e.plan.limits?.length ? (
              <p className="mt-2 text-ink-2">
                <span className="font-semibold">Limits:</span> {e.plan.limits.join("; ")}
              </p>
            ) : null}
          </>
        ) : (
          <p className={`mt-0.5 line-clamp-3 whitespace-pre-wrap ${query}`}>{e.plan.strategy}</p>
        )}
        <span className="mt-1 flex items-center gap-1">
          <Button
            kind="quiet"
            size="sm"
            className="-ml-2.5"
            aria-expanded={expanded}
            {...(selected ? { keys: ["Enter"] } : {})}
            onClick={onToggle}
          >
            {expanded ? "Hide the full query" : "View full query"}
          </Button>
          {expanded ? (
            <Button kind="quiet" size="sm" onClick={copy}>
              {copied ? "Copied" : "Copy the query"}
            </Button>
          ) : null}
        </span>
      </div>
    </article>
  );
}
