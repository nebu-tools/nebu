// Complete the pool (DESIGN.md): the papers a topic's searches should find, such as the ones the
// customer already has, beside what the searches found. The ones the searches missed are the
// gaps to look into; the new ones are what needs screening. The pool is never a search result.
// The screen's summary strip carries the counts; this panel lists the papers.
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { PoolComparison, PoolEntry } from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { formatDate } from "../../lib/format.ts";
import { studyLabel } from "../../lib/labels.ts";
import { Button } from "../../ui/Button.tsx";
import { failure, Field, FileInput, FormDialog, Select } from "../../ui/Form.tsx";
import { Panel } from "../../ui/Panel.tsx";
import { Mark, VERDICTS } from "../../ui/Status.tsx";
import { useProject } from "../project.tsx";
import { FILE_TYPES, FORMATS, fileBytes, formatOf } from "./SearchForms.tsx";

type Topic = { readonly id: string; readonly label: string };

export interface PoolState {
  readonly pool: PoolComparison | null;
  readonly error: string | null;
}

/** The known pool of every search topic, compared with the searches. `tick` reloads them after a
 * search is added; `reload` after the pool itself changes. */
export function useKnownPools(tick: number) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, protocol, seesLeadData } = useProject();
  const topics: ReadonlyArray<Topic> = protocol?.protocol.topics ?? [];
  const ids = topics.map((t) => t.id).join("\n");
  const [pools, setPools] = useState<ReadonlyMap<string, PoolState>>(new Map());
  const [changed, setChanged] = useState(0);

  useEffect(() => {
    if (!seesLeadData || !ids) return;
    let live = true;
    for (const topicId of ids.split("\n")) {
      run(workbench.knownPool({ projectId: project.id, as: me.actor_id, topicId })).then(
        (pool) => live && setPools((p) => new Map(p).set(topicId, { pool, error: null })),
        (e: unknown) =>
          live &&
          setPools((p) =>
            new Map(p).set(topicId, {
              pool: null,
              error: e instanceof WorkbenchError ? e.message : "Kittum could not load the pool.",
            }),
          ),
      );
    }
    return () => {
      live = false;
    };
  }, [workbench, project.id, me.actor_id, seesLeadData, ids, tick, changed]);

  return { topics, pools, reload: () => setChanged((c) => c + 1) };
}

/** The pools' figures added up over the topics, for the summary strip. Null before any pool
 * has loaded. */
export function poolTotals(pools: ReadonlyMap<string, PoolState>) {
  const loaded = [...pools.values()].flatMap((s) => (s.pool ? [s.pool] : []));
  if (!loaded.length) return null;
  return {
    size: loaded.reduce((n, p) => n + p.pool_size, 0),
    found: loaded.reduce((n, p) => n + p.found.length, 0),
    missed: loaded.reduce((n, p) => n + p.not_found.length, 0),
    fresh: loaded.reduce((n, p) => n + p.new, 0),
    searched: loaded.reduce((n, p) => n + p.searched, 0),
    /** Before the corpus is built, the pool is compared with the search records. */
    unit: loaded.every((p) => p.basis === "reports") ? "records" : "search records",
  };
}

const MATCHING =
  "The papers the search should find, such as the ones the customer already has. Kittum matches them with the search records by DOI, then PMID, then title, year, and first author. They are not search results and never count as ones.";

export function KnownPools({
  topics,
  pools,
  onChanged,
  showMissed,
}: {
  topics: ReadonlyArray<Topic>;
  pools: ReadonlyMap<string, PoolState>;
  onChanged: () => void;
  /** Goes up each time the summary asks to see the missed papers. */
  showMissed: number;
}) {
  if (!topics.length) return null;
  return (
    <Panel
      title={
        // The explanation is a hover on the title; "?" means unclear elsewhere.
        <span
          className="cursor-help underline decoration-ink-3 decoration-dotted underline-offset-4"
          title={MATCHING}
        >
          Known pool
        </span>
      }
    >
      {topics.map((topic, i) => (
        <TopicPool
          key={topic.id}
          topic={topic}
          many={topics.length > 1}
          state={pools.get(topic.id)}
          onChanged={onChanged}
          // The summary's "Show them" opens the first topic with missed papers.
          showMissed={
            topics.findIndex((t) => pools.get(t.id)?.pool?.not_found.length) === i ? showMissed : 0
          }
        />
      ))}
    </Panel>
  );
}

type Tab = "missed" | "found";

function TopicPool({
  topic,
  many,
  state,
  onChanged,
  showMissed,
}: {
  topic: Topic;
  many: boolean;
  state: PoolState | undefined;
  onChanged: () => void;
  showMissed: number;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Tab | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const missedList = useRef<HTMLOListElement>(null);
  const pool = state?.pool ?? null;
  const shownError = error ?? state?.error ?? null;
  // The summary's "Show them" opens the missed papers until the lead picks a tab again.
  const [answered, setAnswered] = useState(0);
  const tab: Tab =
    showMissed > answered ? "missed" : (chosen ?? (pool?.not_found.length ? "missed" : "found"));
  const choose = (t: Tab) => {
    setChosen(t);
    setAnswered(showMissed);
  };

  useEffect(() => {
    if (!showMissed) return;
    requestAnimationFrame(() => {
      missedList.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      missedList.current?.focus({ preventScroll: true });
    });
  }, [showMissed]);

  const withdraw = async (fileId: string) => {
    try {
      await run(workbench.withdrawKnownPool({ projectId: project.id, as: me.actor_id, fileId }));
      setError(null);
      setConfirming(null);
      onChanged();
    } catch (e) {
      setError(failure(e, "Kittum could not take the file out of the pool."));
    }
  };

  const files = pool?.files ?? [];
  const tabId = (t: Tab) => `pool-${topic.id}-${t}`;
  return (
    <div className="mt-6 first:mt-0" data-testid={`pool-${topic.id}`}>
      {many ? <h3 className="text-sm font-semibold">{topic.label}</h3> : null}
      <AddPool
        topic={topic}
        open={adding}
        onOpenChange={setAdding}
        onDone={() => {
          setAdding(false);
          onChanged();
        }}
      />
      {shownError ? (
        <p role="alert" className="mt-2 text-sm text-exclude">
          {shownError}
        </p>
      ) : pool === null ? (
        <p className="mt-2 text-sm text-ink-2">Loading the pool.</p>
      ) : pool.pool_size === 0 ? (
        <p className="text-sm text-ink-2">
          No known papers yet. Add the customer's list as RIS, NBIB, CSV, or Excel.
        </p>
      ) : (
        <>
          <div role="tablist" aria-label="Known papers" className="flex border-b border-rule">
            {(
              [
                ["missed", "Not found", pool.not_found.length],
                ["found", "Found", pool.found.length],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={tabId(id)}
                aria-selected={tab === id}
                aria-controls={`${tabId(id)}-panel`}
                onClick={() => choose(id)}
                className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-1.5 text-sm font-medium ${
                  tab === id
                    ? "border-petrol text-ink"
                    : "border-transparent text-ink-2 hover:text-ink"
                }`}
              >
                {label}
                {/* One topic: the summary strip has the counts. Several: each topic its own. */}
                {many ? (
                  <span className="rounded-full bg-sheet-2 px-1.5 text-xs tabular-nums">
                    {count}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`${tabId(tab)}-panel`} aria-labelledby={tabId(tab)}>
            {tab === "missed" ? (
              pool.not_found.length ? (
                <Missed entries={pool.not_found} listRef={missedList} />
              ) : (
                <p className="mt-3 text-sm text-ink-2">The search found every known paper.</p>
              )
            ) : pool.found.length ? (
              <PaperList
                label="Found by the search"
                entries={pool.found.map((m) => ({ entry: m.entry, matched: m.evidence }))}
              />
            ) : (
              <p className="mt-3 text-sm text-ink-2">The search found none of the known papers.</p>
            )}
          </div>
        </>
      )}
      <div className="mt-5 text-sm">
        <div className="flex items-center gap-3">
          {files.length ? <h3 className="text-xs font-semibold text-ink-2">Pool files</h3> : null}
          <Button size="sm" className="ml-auto" onClick={() => setAdding(true)}>
            Add known papers
          </Button>
        </div>
        {files.length ? (
          <ul className="mt-1 grid gap-0.5" aria-label="Pool files">
            {files.map((f) => (
              <li key={f.id} className="flex min-h-7 flex-wrap items-center gap-x-3">
                <span
                  className={`min-w-0 flex-1 ${f.withdrawn_at ? "text-ink-2 line-through" : ""}`}
                >
                  {f.file_name ?? f.format}, {f.entries} papers, added {formatDate(f.imported_at)}
                </span>
                {f.withdrawn_at ? (
                  <span className="text-ink-2">removed {formatDate(f.withdrawn_at)}</span>
                ) : confirming === f.id ? (
                  <span className="flex items-center gap-2">
                    <span className="text-ink-2">Its papers stop counting.</span>
                    <Button kind="danger" size="sm" onClick={() => void withdraw(f.id)}>
                      Remove it
                    </Button>
                    <Button kind="quiet" size="sm" onClick={() => setConfirming(null)}>
                      Keep it
                    </Button>
                  </span>
                ) : (
                  <Button kind="quiet" size="sm" onClick={() => setConfirming(f.id)}>
                    Remove this file
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

const SHOWN = 5;
const FOUND = { ...VERDICTS.met, label: "Found by the search" };
const NOT_FOUND = { ...VERDICTS.not_met, label: "Not found by the search" };

/** The journal; the year is in the study name. */
const meta = (r: PoolEntry["record"]) => r.journal ?? "";

/** A paper as a study is named: "Free 2011", then its title. */
function Title({ record: r }: { record: PoolEntry["record"] }) {
  const label = studyLabel(r.authors, r.year);
  return (
    <span className="block leading-snug">
      {label ? <span className="font-medium">{label}</span> : null}
      {label ? " " : null}
      {r.title}
    </span>
  );
}

const LINK = "text-petrol underline-offset-2 hover:underline";

/** Where to look a paper up: its DOI and PMID, and PubMed by its title, to see whether the
 * database has it and under which terms. */
function Lookup({ record: r }: { record: PoolEntry["record"] }) {
  return (
    <span className="inline-flex flex-wrap gap-x-3">
      {r.doi ? (
        <a className={LINK} href={`https://doi.org/${r.doi}`} target="_blank" rel="noreferrer">
          DOI {r.doi}
        </a>
      ) : null}
      {r.pmid ? (
        <a
          className={LINK}
          href={`https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`}
          target="_blank"
          rel="noreferrer"
        >
          PMID {r.pmid}
        </a>
      ) : null}
      <a
        className={LINK}
        href={`https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(r.title)}`}
        target="_blank"
        rel="noreferrer"
      >
        Search the title in PubMed
      </a>
    </span>
  );
}

function Missed({
  entries,
  listRef,
}: {
  entries: ReadonlyArray<PoolEntry>;
  listRef: React.Ref<HTMLOListElement>;
}) {
  const [all, setAll] = useState(false);
  // One abstract at a time, to read against the queries beside the panel.
  const [opened, setOpened] = useState<string | null>(null);
  const shown = all ? entries : entries.slice(0, SHOWN);
  return (
    <div className="mt-3">
      <ol
        ref={listRef}
        tabIndex={-1}
        className="mt-2 border-l-2 border-exclude text-sm outline-none focus-visible:ring-2 focus-visible:ring-exclude/40"
        aria-label="Not found by the search"
      >
        {shown.map(({ id, record: r }) => (
          <li key={id} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 py-2 pl-2.5">
            <span className="mt-0.5">
              <Mark term={NOT_FOUND} />
            </span>
            <span className="min-w-0">
              <Title record={r} />
              <span className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-2">
                {meta(r) ? <span>{meta(r)}</span> : null}
                <Lookup record={r} />
                {r.abstract ? (
                  <button
                    type="button"
                    className={LINK}
                    aria-expanded={opened === id}
                    onClick={() => setOpened((o) => (o === id ? null : id))}
                  >
                    {opened === id ? "Hide the abstract" : "Show the abstract"}
                  </button>
                ) : null}
              </span>
              {opened === id && r.abstract ? (
                <span className="mt-1.5 block border-l-2 border-rule pl-2.5 text-sm leading-relaxed text-ink-2">
                  {r.abstract}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {entries.length > SHOWN ? (
        <Button kind="quiet" size="sm" className="mt-1" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${entries.length}`}
        </Button>
      ) : null}
    </div>
  );
}

function PaperList({
  label,
  entries,
}: {
  label: string;
  entries: ReadonlyArray<{ readonly entry: PoolEntry; readonly matched: string }>;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, SHOWN);
  return (
    <div className="mt-3">
      <ol className="text-sm" aria-label={label}>
        {shown.map(({ entry: { id, record: r }, matched }) => (
          <li
            key={id}
            className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 border-b border-rule py-2 last:border-b-0"
          >
            <span className="mt-0.5">
              <Mark term={FOUND} />
            </span>
            <span className="min-w-0">
              <Title record={r} />
              <span className="mt-0.5 block text-xs text-ink-2">
                {[meta(r), matched ? `Matched by ${matched}` : null].filter(Boolean).join(" · ")}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {entries.length > SHOWN ? (
        <Button kind="quiet" size="sm" className="mt-1" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${entries.length}`}
        </Button>
      ) : null}
    </div>
  );
}

function AddPool({
  topic,
  open,
  onOpenChange,
  onDone,
}: {
  topic: Topic;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const [format, setFormat] = useState("records-xlsx");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!file) {
      setError("Choose the file.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await run(
        workbench.importKnownPool({
          projectId: project.id,
          as: me.actor_id,
          topicId: topic.id,
          data: await fileBytes(file),
          format,
          fileName: file.name,
        }),
      );
      setFile(null);
      onDone();
    } catch (e) {
      setError(failure(e, "Kittum could not read the file."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add known papers"
      description="A file of the papers the search should find. A list needs a Title column; Authors, Year, Journal, DOI, PMID, and Abstract help the match. Kittum keeps the file and records it in the ledger."
      submit="Add to the pool"
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
    >
      <Field label="File format">
        <Select value={format} onChange={(e) => setFormat(e.currentTarget.value)}>
          {FORMATS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="File">
        <FileInput
          label="Known papers file"
          accept={FILE_TYPES}
          onFile={(picked) => {
            setFile(picked);
            const guess = picked ? formatOf(picked.name) : null;
            if (guess) setFormat(guess);
            else if (picked?.name.toLowerCase().endsWith(".csv")) setFormat("records-csv");
          }}
        />
      </Field>
    </FormDialog>
  );
}
