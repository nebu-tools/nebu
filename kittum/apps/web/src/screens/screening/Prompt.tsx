// The prompt the AI judge reads a record with (DESIGN.md, "Screening and the AI judge"): the
// topic's instructions and the messages as the server renders them under the stage's protocol
// version. For the methods lead on any record, and for a screener in a topic with working
// documentation; a complete topic's screener never sees anything of the AI before deciding.
// The Audit screen shows the requests that were actually sent.
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { RecordPrompt } from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import type { Caller } from "../../data/workbench.ts";
import { numberOf, shortLabel } from "./criteria.ts";
import type { NumberedCriterion } from "./criteria.ts";

export function ShowPrompt({
  caller,
  stageId,
  assignmentId,
  itemRef,
  open,
  onToggle,
  criteria,
}: {
  caller: Caller;
  stageId: string;
  assignmentId?: string | null;
  itemRef?: string | null;
  open: boolean;
  onToggle: () => void;
  /** The stage's criteria, to key the IDs the prompt uses to their numbers and names. */
  criteria?: ReadonlyArray<NumberedCriterion>;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const target = assignmentId ?? itemRef ?? null;
  const key = `${stageId}:${target ?? ""}`;
  // What came back for which record: a record that changed shows nothing stale.
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly prompt?: RecordPrompt;
    readonly error?: string;
  } | null>(null);
  const prompt = loaded?.key === key ? (loaded.prompt ?? null) : null;
  const error = loaded?.key === key ? (loaded.error ?? null) : null;

  useEffect(() => {
    if (!open || !target) return;
    let live = true;
    run(
      workbench.recordPrompt({
        ...caller,
        stageId,
        ...(assignmentId ? { assignmentId } : {}),
        ...(itemRef ? { itemRef } : {}),
      }),
    ).then(
      (p) => live && setLoaded({ key, prompt: p }),
      (e: unknown) =>
        live &&
        setLoaded({
          key,
          error: e instanceof WorkbenchError ? e.message : "The prompt did not load.",
        }),
    );
    return () => {
      live = false;
    };
  }, [workbench, caller, stageId, assignmentId, itemRef, open, target, key]);

  const copy = () => {
    if (!prompt) return;
    void navigator.clipboard?.writeText(`${prompt.system}\n\n${prompt.user}`);
  };
  return (
    <section className="text-sm" data-testid="record-prompt" aria-label="The AI's prompt">
      <div className="flex items-center gap-3">
        <h2 className="font-semibold">The prompt the AI read this record with</h2>
        <span className="ml-auto flex items-center gap-2">
          {open && prompt ? (
            <button
              type="button"
              className="rounded-[4px] border border-rule-strong px-2.5 py-1 text-xs hover:bg-sheet-2"
              onClick={copy}
            >
              Copy
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-[4px] px-2.5 py-1 text-xs text-petrol hover:bg-petrol-wash"
            onClick={onToggle}
          >
            {open ? "Hide the prompt" : "Show the prompt"} <span className="text-ink-3">(p)</span>
          </button>
        </span>
      </div>
      {open ? (
        error ? (
          <p role="alert" className="mt-2 text-exclude">
            {error}
          </p>
        ) : prompt ? (
          <div className="mt-3 grid gap-4">
            <p className="text-ink-2">
              The AI read this record with strictness <b>{prompt.strictness}</b>
              {prompt.guidance ? ", with the team's guidance" : ", no guidance"}.
            </p>
            <nav className="flex gap-4 text-xs" aria-label="Parts of the prompt">
              {[
                ["prompt-criteria", "The criteria"],
                ["prompt-record", "The record"],
                ["prompt-system", "Instructions"],
              ].map(([id, label]) => (
                <a
                  key={id}
                  href={`#${id}`}
                  className="text-petrol hover:underline"
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(id!)?.scrollIntoView({ block: "start" });
                  }}
                >
                  {label}
                </a>
              ))}
            </nav>
            {/* A v2 prompt names criteria by ID alone; v3 gives each its number, name, and
                answer key, so the key table is only for the older prompt. */}
            {criteria?.length && !prompt.user.includes("Answer key:") ? (
              <table className="text-xs" data-testid="prompt-criteria-key">
                <caption className="pb-1 text-left text-xs font-semibold text-ink-2">
                  The prompt names criteria by their IDs
                </caption>
                <tbody>
                  {criteria.map((c) => (
                    <tr key={c.id}>
                      <td className="pr-3 text-ink-2">
                        {numberOf(criteria, c.id)} {shortLabel(c)}
                      </td>
                      <td>
                        <code className="text-2xs text-ink-3">{c.id}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <PromptParts user={prompt.user} />
            <details className="group scroll-mt-4" id="prompt-system">
              <summary className="cursor-pointer text-xs font-semibold text-ink-2">
                System message, the same for every record
                <span className="ml-3 font-normal tracking-normal text-petrol normal-case group-open:hidden">
                  Show
                </span>
              </summary>
              <div className="mt-1">
                <PromptText label="" text={prompt.system} />
              </div>
            </details>
            <p className="text-xs text-ink-3">
              Prompt hashes: protocol {prompt.protocol_hash.slice(0, 12)}, instructions{" "}
              {prompt.instructions_hash.slice(0, 12)}. The Audit screen shows every request as sent.
            </p>
          </div>
        ) : (
          <p className="mt-2 text-ink-3">Loading the prompt.</p>
        )
      ) : null}
    </section>
  );
}

/** The user message in two parts: the criteria, then the record, split where the record starts. */
function PromptParts({ user }: { user: string }) {
  const at = user.indexOf("The record follows.");
  const head = at > 0 ? user.slice(0, at).trimEnd() : user;
  const tail = at > 0 ? user.slice(at) : null;
  return (
    <>
      <div id="prompt-criteria" className="scroll-mt-4">
        <PromptText label="The criteria, as the AI read them" text={head} />
      </div>
      {tail ? (
        <div id="prompt-record" className="scroll-mt-4">
          <PromptText label="The record, as the AI read it" text={tail} />
        </div>
      ) : null}
    </>
  );
}

function PromptText({ label, text }: { label: string; text: string }) {
  return (
    <div>
      {label ? <h3 className="text-xs font-semibold text-ink-2">{label}</h3> : null}
      <div className="mt-1 rounded-[3px] border border-rule bg-sheet-2 px-4 py-3 text-[13.5px] leading-[1.55] whitespace-pre-wrap text-ink">
        {text}
      </div>
    </div>
  );
}
