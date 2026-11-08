// Decisions from a spreadsheet (DESIGN.md, "Working export"): a screener of a working topic edits
// the Your decision, Reason, and Comment columns of their own working export in Excel and brings
// the file back here. The server answers with a preview (what would be decided, what stays, and
// why the other rows are refused) and records nothing until Apply, which imports the file exactly
// as previewed: one batch for the file, one decision per changed row.
import { useRef, useState } from "react";

import type { Criterion, DecisionImportPreview, ImportRow } from "../../../data/schema.ts";
import { run, WorkbenchError } from "../../../data/workbench.ts";
import type { Caller, Workbench } from "../../../data/workbench.ts";
import { OUTCOMES } from "../../../ui/Status.tsx";
import { numbered } from "../criteria.ts";

const BUTTON =
  "h-6 flex-none rounded-[2px] border border-rule-strong bg-sheet px-2 whitespace-nowrap hover:bg-sheet-2 disabled:text-ink-3";

const REFUSALS: Record<NonNullable<ImportRow["refusal"]>, string> = {
  unknown_ref: "Unknown Ref",
  not_yours: "Not yours",
  duplicate: "Twice in the file",
  unreadable: "Unreadable",
  no_decision: "No decision",
  invalid: "Not allowed",
  stale: "Changed in Kittum",
  decided: "Decided in Kittum",
  second_opinion: "Second opinion",
  withdrawn: "Withdrawn",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const says = (row: ImportRow, criteria: ReadonlyArray<Criterion>) => {
  const d = row.decision;
  const outcome = d.outcome ? OUTCOMES[d.outcome].label : "";
  const reason = d.reason_criterion_id ? ` on ${numbered(criteria, d.reason_criterion_id)}` : "";
  const comment = d.comment ? `${outcome ? " · " : ""}“${d.comment}”` : "";
  return `${outcome}${reason}${comment}`;
};

type Picked = { readonly name: string; readonly data: Uint8Array };

/** The toolbar's "Import decisions" button, and the preview panel it opens over the table. */
export function ImportDecisions({
  workbench,
  caller,
  stageId,
  criteria,
  onImported,
}: {
  workbench: Workbench;
  caller: Caller;
  stageId: string;
  criteria: ReadonlyArray<Criterion>;
  /** After an import: the message to show, and the table to load again. */
  onImported: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<Picked | null>(null);
  const [preview, setPreview] = useState<DecisionImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const look = async (picked: Picked) => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      setPreview(
        await run(
          workbench.previewDecisionImport({
            ...caller,
            stageId,
            data: picked.data,
            fileName: picked.name,
          }),
        ),
      );
    } catch (e) {
      setError(e instanceof WorkbenchError ? e.message : "Kittum could not read the file.");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const done = await run(
        workbench.importDecisions({
          ...caller,
          stageId,
          data: file.data,
          fileName: file.name,
          previewHash: preview.preview.preview_hash,
        }),
      );
      const n = done.decided + done.awaiting_final;
      const waiting =
        done.awaiting_final > 0
          ? ` ${done.awaiting_final} ${done.awaiting_final === 1 ? "waits" : "wait"} for your final decision after the AI's reading.`
          : "";
      close();
      onImported(
        `Imported ${n} ${n === 1 ? "decision" : "decisions"} from ${file.name}.${waiting}`,
      );
    } catch (e) {
      setError(e instanceof WorkbenchError ? e.message : "The import was not recorded.");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setFile(null);
    setPreview(null);
    setError(null);
  };

  const p = preview?.preview;
  const rows = p ? [...p.changes, ...p.refused] : [];
  return (
    <>
      <button
        type="button"
        className={BUTTON}
        onClick={() => input.current?.click()}
        disabled={busy}
        title="Bring back decisions from your working export, edited in a spreadsheet"
      >
        Import decisions
      </button>
      <input
        ref={input}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        data-testid="import-file"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          if (!chosen) return;
          void chosen.arrayBuffer().then((buffer) => {
            const picked = { name: chosen.name, data: new Uint8Array(buffer) };
            setFile(picked);
            void look(picked);
          });
        }}
      />
      {file ? (
        <section
          className="absolute top-full right-0 z-20 mt-px flex max-h-[60vh] w-[min(760px,100%)] flex-col border border-rule-strong bg-sheet text-xs shadow-[0_8px_24px_rgb(0_0_0/0.16)]"
          aria-label="Import decisions"
          data-testid="import-panel"
          // The table's keys pause while the panel is open, so Enter presses its buttons.
          data-popup-open=""
        >
          <header className="flex items-baseline gap-2 border-b border-rule px-3 py-2">
            <span className="font-semibold text-ink">{file.name}</span>
            {preview ? (
              <span className="text-ink-3">
                exported by {preview.exported_by}, {when(preview.exported_at)} · {preview.rows} rows
              </span>
            ) : null}
            <button
              type="button"
              className="ml-auto text-ink-2 hover:underline"
              onClick={close}
              disabled={busy}
            >
              Close
            </button>
          </header>
          {busy && !preview ? <p className="px-3 py-2 text-ink-3">Reading the file…</p> : null}
          {p ? (
            <>
              <p className="flex gap-4 px-3 py-2" data-testid="import-counts">
                <span className="font-semibold text-ink">{p.changes.length} to decide</span>
                <span className="text-ink-2">{p.unchanged} unchanged</span>
                <span className={p.refused.length ? "text-exclude" : "text-ink-2"}>
                  {p.refused.length} refused
                </span>
              </p>
              {rows.length ? (
                <div className="min-h-0 overflow-y-auto border-y border-rule">
                  <table className="w-full border-collapse">
                    <thead className="sticky top-0 bg-sheet-2 text-left text-ink-2">
                      <tr>
                        <th className="w-10 border-b border-rule px-2 py-0.5 font-normal">Row</th>
                        <th className="border-b border-rule px-2 py-0.5 font-normal">Record</th>
                        <th className="border-b border-rule px-2 py-0.5 font-normal">
                          The file says
                        </th>
                        <th className="border-b border-rule px-2 py-0.5 font-normal">In Kittum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={`${r.row}-${r.ref}`} className="h-6 align-top">
                          <td className="border-b border-rule px-2 py-0.5 text-ink-3 tabular-nums">
                            {r.row}
                          </td>
                          <td
                            className="max-w-[260px] truncate border-b border-rule px-2 py-0.5"
                            title={r.title ?? r.ref}
                          >
                            {r.title ?? <span className="text-ink-3">{r.ref || "No Ref"}</span>}
                          </td>
                          <td
                            className="max-w-[200px] truncate border-b border-rule px-2 py-0.5"
                            title={says(r, criteria)}
                          >
                            {says(r, criteria)}
                          </td>
                          <td className="border-b border-rule px-2 py-0.5">
                            {r.refusal ? (
                              <span className="text-exclude" title={r.message ?? undefined}>
                                {REFUSALS[r.refusal]}:{" "}
                                <span className="text-ink-2">{r.message}</span>
                              </span>
                            ) : (
                              <span className="text-include">Will be decided</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : null}
          <footer className="flex items-center gap-3 px-3 py-2">
            {p ? (
              <button
                type="button"
                className={`${BUTTON} font-semibold`}
                onClick={() => void apply()}
                disabled={busy || p.changes.length === 0}
              >
                {busy
                  ? "Importing…"
                  : `Apply ${p.changes.length} ${p.changes.length === 1 ? "decision" : "decisions"}`}
              </button>
            ) : null}
            {error ? (
              <>
                <span role="alert" className="min-w-0 text-exclude">
                  {error}
                </span>
                {preview ? (
                  <button
                    type="button"
                    className={BUTTON}
                    onClick={() => void look(file)}
                    disabled={busy}
                  >
                    Preview again
                  </button>
                ) : null}
              </>
            ) : (
              <span className="text-ink-3">
                Nothing is recorded until Apply. Kittum records that you imported the file, not who
                filled in each row, and keeps no timing for these decisions.
              </span>
            )}
          </footer>
        </section>
      ) : null}
    </>
  );
}
