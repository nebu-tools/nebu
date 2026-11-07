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

export function ShowPrompt({
  caller,
  stageId,
  assignmentId,
  itemRef,
  open,
  onToggle,
}: {
  caller: Caller;
  stageId: string;
  assignmentId?: string | null;
  itemRef?: string | null;
  open: boolean;
  onToggle: () => void;
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

  return (
    <section className="border-t border-rule px-4 py-2 text-xs" data-testid="record-prompt">
      <button type="button" className="text-petrol hover:underline" onClick={onToggle}>
        {open ? "Hide the prompt" : "Show the prompt"}
      </button>
      <span className="ml-2 text-ink-3">(p)</span>
      {open ? (
        error ? (
          <p role="alert" className="mt-1 text-exclude">
            {error}
          </p>
        ) : prompt ? (
          <div className="mt-2 grid gap-2">
            <p className="text-ink-2">
              What the AI reads this record with: strictness <b>{prompt.strictness}</b>
              {prompt.guidance ? ", with the team's guidance" : ", no guidance"}. Protocol{" "}
              <code className="text-2xs">{prompt.protocol_hash.slice(0, 12)}</code>, instructions{" "}
              <code className="text-2xs">{prompt.instructions_hash.slice(0, 12)}</code>.
            </p>
            <PromptText label="System message" text={prompt.system} />
            <PromptText label="User message" text={prompt.user} />
          </div>
        ) : (
          <p className="mt-1 text-ink-3">Loading the prompt.</p>
        )
      ) : null}
    </section>
  );
}

function PromptText({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <h3 className="text-2xs font-semibold tracking-wide text-ink-3 uppercase">{label}</h3>
      <pre className="mt-0.5 max-h-[320px] overflow-auto rounded-[2px] border border-rule bg-sheet-2 px-2 py-1.5 font-mono text-2xs leading-[16px] whitespace-pre-wrap text-ink-2">
        {text}
      </pre>
    </div>
  );
}
