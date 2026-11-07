// Complete the pool (DESIGN.md): the papers a topic's searches should find, such as the ones the
// customer already has, beside what the searches found. The ones the searches missed are the
// gaps to look into; the new ones are what needs screening. The pool is never a search result.
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { PoolComparison, PoolEntry } from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { failure, Field, FileInput, FormDialog, Select } from "../../ui/Form.tsx";
import { useProject } from "../project.tsx";
import { FILE_TYPES, FORMATS, fileBytes, formatOf } from "./SearchForms.tsx";

type Topic = { readonly id: string; readonly label: string };

export function KnownPools({ tick }: { tick: number }) {
  const { protocol } = useProject();
  const topics = protocol?.protocol.topics ?? [];
  if (!topics.length) return null;
  return (
    <section className="mt-12" aria-label="Known pool">
      <h2 className="text-md font-semibold">Known pool</h2>
      <p className="mt-1 max-w-[70ch] text-sm text-ink-2">
        The papers the search should find, such as the ones the customer already has. Kittum
        compares them with the search by DOI, PMID, and then title, year, and first author. They are
        not search results and never count as ones.
      </p>
      {topics.map((topic) => (
        <TopicPool key={topic.id} topic={topic} many={topics.length > 1} tick={tick} />
      ))}
    </section>
  );
}

function TopicPool({ topic, many, tick }: { topic: Topic; many: boolean; tick: number }) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me } = useProject();
  const [pool, setPool] = useState<PoolComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [changed, setChanged] = useState(0);

  useEffect(() => {
    let live = true;
    run(workbench.knownPool({ projectId: project.id, as: me.actor_id, topicId: topic.id })).then(
      (found) => live && setPool(found),
      (e: unknown) =>
        live &&
        setError(e instanceof WorkbenchError ? e.message : "Kittum could not load the pool."),
    );
    return () => {
      live = false;
    };
  }, [workbench, project.id, me.actor_id, topic.id, tick, changed]);

  const withdraw = async (fileId: string) => {
    try {
      await run(workbench.withdrawKnownPool({ projectId: project.id, as: me.actor_id, fileId }));
      setChanged((c) => c + 1);
    } catch (e) {
      setError(failure(e, "Kittum could not take the file out of the pool."));
    }
  };

  const files = pool?.files ?? [];
  const unit = pool?.basis === "reports" ? "records" : "search records";
  return (
    <div className="mt-5 border-t border-rule-strong pt-4" data-testid={`pool-${topic.id}`}>
      <div className="flex items-baseline gap-4">
        {many ? <h3 className="text-sm font-semibold">{topic.label}</h3> : null}
        <button type="button" className="ml-auto text-sm" onClick={() => setAdding(true)}>
          Add known papers
        </button>
      </div>
      <AddPool
        topic={topic}
        open={adding}
        onOpenChange={setAdding}
        onDone={() => {
          setAdding(false);
          setChanged((c) => c + 1);
        }}
      />
      {error ? (
        <p role="alert" className="mt-2 text-sm text-exclude">
          {error}
        </p>
      ) : pool === null ? (
        <p className="mt-2 text-sm text-ink-3">Loading the pool.</p>
      ) : pool.pool_size === 0 ? (
        <p className="mt-2 text-sm text-ink-2">
          No known papers yet. Add the customer's list as RIS, NBIB, CSV, or Excel.
        </p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1 text-sm">
            <dt className="text-right font-semibold tabular-nums" data-testid="pool-found">
              {pool.found.length}
            </dt>
            <dd>of {pool.pool_size} known papers found by the search</dd>
            <dt
              className={`text-right font-semibold tabular-nums ${pool.not_found.length ? "text-exclude" : ""}`}
              data-testid="pool-missed"
            >
              {pool.not_found.length}
            </dt>
            <dd>known papers the search did not find. Check the search for each.</dd>
            <dt className="text-right font-semibold tabular-nums" data-testid="pool-new">
              {pool.new}
            </dt>
            <dd>
              new {unit} of {pool.searched}, not in the pool. These need screening.
              {pool.basis === "records" ? (
                <span className="text-ink-3">
                  {" "}
                  Duplicates are not removed until the corpus is built.
                </span>
              ) : null}
            </dd>
          </dl>
          {pool.not_found.length ? <Missed entries={pool.not_found} /> : null}
        </>
      )}
      {files.length ? (
        <ul className="mt-4 text-xs text-ink-3" aria-label="Pool files">
          {files.map((f) => (
            <li key={f.id} className="flex gap-3">
              <span className={f.withdrawn_at ? "line-through" : ""}>
                {f.file_name ?? f.format}, {f.entries} papers, added {f.imported_at.slice(0, 10)}
              </span>
              {f.withdrawn_at ? (
                <span>taken out {f.withdrawn_at.slice(0, 10)}</span>
              ) : (
                <button type="button" className="underline" onClick={() => void withdraw(f.id)}>
                  Take out of the pool
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Missed({ entries }: { entries: ReadonlyArray<PoolEntry> }) {
  return (
    <ol
      className="mt-3 border-l-2 border-exclude pl-3 text-sm"
      aria-label="Not found by the search"
    >
      {entries.map(({ id, record: r }) => (
        <li key={id} className="py-1">
          <span>{r.title}</span>
          <span className="block text-xs text-ink-3">
            {[
              r.authors?.[0]
                ? `${r.authors[0]}${(r.authors?.length ?? 0) > 1 ? " et al." : ""}`
                : null,
              r.year,
              r.journal,
              r.doi ? `DOI ${r.doi}` : null,
              r.pmid ? `PMID ${r.pmid}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </li>
      ))}
    </ol>
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
