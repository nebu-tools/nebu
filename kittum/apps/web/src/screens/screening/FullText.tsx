// Full-text screening (DESIGN.md, "Reviewer workbench"): the report on the left, the criteria on
// the right with one active. Mentions of the active criterion come in document order and carry no
// verdict colour; the reviewer adopts the ones that are evidence. One reason decides: exclude on
// the criterion the report fails, with evidence for it, or include, which says every criterion is
// met. A verdict on each criterion is optional. A PDF that is not the record's report is marked
// as the wrong document, which takes it out of screening and is not an exclusion.
import { Link, useRouteContext } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type {
  Anchor,
  Criterion,
  CriterionStatus,
  Decision,
  FullTextAssignment,
  Outcome,
  Reveal,
  ScopeStatus,
  TableDecision,
} from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/Empty.tsx";
import { Key, KeyHint } from "../../ui/Key.tsx";
import { useKeys } from "../../ui/keys.ts";
import { Mark, OUTCOMES, Status, VERDICTS } from "../../ui/Status.tsx";
import { PdfViewer } from "../pdf/PdfViewer.tsx";
import type { PageHighlight } from "../pdf/PdfViewer.tsx";
import { useProject } from "../project.tsx";
import { AiReading } from "./AiReading.tsx";
import type { CriterionName } from "./AiReading.tsx";
import { Mentions, useEvidence } from "./evidence.tsx";
import { AiBefore, AskSecondOpinion, SecondOpinionAsked } from "./Targeted.tsx";
import { byKey, keyOf, numberOf, numbered } from "./criteria.ts";

const VERDICT_KEYS: Record<string, CriterionStatus> = { y: "met", n: "not_met", "?": "unclear" };
/** Outcomes that name one criterion: the key, then the criterion's number. */
const ON_A_CRITERION: Record<string, "exclude" | "insufficient_information"> = {
  e: "exclude",
  x: "insufficient_information",
};

/** The reviewer's full-text queue, one report at a time. */
export function FullTextQueue() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, labels, screeningStage, scopeLabel, has, criteriaFor } = useProject();
  const scopeId = screeningStage("full_text")?.scope_id ?? null;
  // The finished queue's own work: this person's full-text decisions, by outcome and reason.
  const [mine, setMine] = useState<ReadonlyArray<TableDecision> | null>(null);
  const titleAbstract = screeningStage("title_abstract")?.scope_id ?? null;
  // Title and abstract records still waiting for this person: the next queue to offer.
  const [waitingElsewhere, setWaitingElsewhere] = useState(0);
  const [assignment, setAssignment] = useState<FullTextAssignment | null | undefined>(undefined);
  const [status, setStatus] = useState<ScopeStatus | null>(null);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [poll, setPoll] = useState(0);
  // Full texts still unread by the AI judge, while the queue is empty.
  const unread = assignment === null ? (status?.remaining ?? 0) : 0;

  useEffect(() => {
    if (!scopeId) return;
    let live = true;
    const caller = { projectId: project.id, as: me.actor_id };
    run(workbench.fullText({ ...caller, scopeId }))
      .then(async (next) => {
        // The counts for the strip; a failure there leaves the strip empty, not the screen.
        const counts = await run(
          workbench.status({ ...caller, scopeId, stage: "full_text" }),
        ).catch(() => null);
        if (!live) return;
        setStatus(counts);
        setAssignment(next);
      })
      .catch(
        (e: unknown) =>
          live &&
          setError(
            e instanceof WorkbenchError ? e.message : "Kittum could not load the full text.",
          ),
      );
    return () => {
      live = false;
    };
  }, [workbench, project.id, me.actor_id, scopeId, done, poll]);

  useEffect(() => {
    if (assignment !== null || !titleAbstract) return;
    let live = true;
    void run(
      workbench.status({
        projectId: project.id,
        as: me.actor_id,
        scopeId: titleAbstract,
        stage: "title_abstract",
      }),
    ).then(
      (s) => live && setWaitingElsewhere(s.remaining),
      () => live && setWaitingElsewhere(0),
    );
    return () => {
      live = false;
    };
  }, [assignment, titleAbstract, workbench, project.id, me.actor_id]);

  useEffect(() => {
    if (assignment !== null || !scopeId) return;
    let live = true;
    void run(
      workbench.screeningTable({
        projectId: project.id,
        as: me.actor_id,
        scopeId,
        stage: "full_text",
      }),
    ).then(
      (table) =>
        live &&
        setMine(
          table.rows.flatMap((r) =>
            r.decisions.filter((d) => d.reviewer_id === me.actor_id && d.outcome),
          ),
        ),
      () => live && setMine(null),
    );
    return () => {
      live = false;
    };
  }, [assignment, scopeId, workbench, project.id, me.actor_id]);

  useEffect(() => {
    if (assignment !== null || unread === 0) return;
    const timer = window.setTimeout(() => setPoll((n) => n + 1), 3000);
    return () => window.clearTimeout(timer);
  }, [assignment, unread, poll]);

  const params = { projectId: project.id };
  const scopeFull = scopeId ? scopeLabel(scopeId) : "";
  const next = (
    <>
      {waitingElsewhere > 0 ? (
        <Link to="/p/$projectId/screening/title-abstract" params={params} className={PRIMARY}>
          Start title and abstract ({waitingElsewhere} waiting)
        </Link>
      ) : null}
      <Link
        to="/p/$projectId/screening/table"
        params={params}
        className={waitingElsewhere > 0 ? SECONDARY : PRIMARY}
      >
        Review your decisions
      </Link>
      <Link
        to="/p/$projectId/progress"
        params={params}
        className="rounded-[4px] px-3 py-1.5 text-sm text-petrol hover:bg-petrol-wash"
      >
        See the review&rsquo;s progress
      </Link>
      {has("lead") ? (
        <Link
          to="/p/$projectId/retrieval"
          params={params}
          className="rounded-[4px] px-3 py-1.5 text-sm text-petrol hover:bg-petrol-wash"
        >
          Find the PDFs still missing
        </Link>
      ) : null}
    </>
  );

  let body: ReactNode;
  if (error) {
    body = (
      <EmptyState title="Kittum could not load the full text" testId="fulltext-error">
        <span role="alert">{error}</span>
      </EmptyState>
    );
  } else if (!scopeId) {
    body = (
      <EmptyState title="No full texts to screen" actions={next}>
        A record comes here after it passes title and abstract screening and has a full text, once
        the methods lead opens full-text screening for its {labels.scope.toLowerCase()}.
      </EmptyState>
    );
  } else if (assignment === undefined) {
    body = <p className="px-8 py-10 text-ink-2">Loading the next full text.</p>;
  } else if (assignment === null && unread > 0) {
    body = (
      <EmptyState
        title="The AI judge is reading"
        figures={[
          ["Full texts you decided", status?.screened ?? "–"],
          ["Not yet read by the AI judge", unread],
        ]}
      >
        Each of your full texts appears here once the AI judge has read it. This page checks again
        every few seconds.
      </EmptyState>
    );
  } else if (assignment === null) {
    body = (
      <EmptyState
        title="Your available full-text queue is done"
        testId="fulltext-finished"
        figures={[
          ["Full texts you decided", status?.screened ?? "–"],
          ...decidedFigures(mine, criteriaFor("full_text", scopeId)),
          ...(done > 0 ? [["Decided in this session", done] as const] : []),
        ]}
        actions={next}
      >
        You have decided every full text that is ready for you. A report still waiting for its PDF
        joins your queue once the PDF is in.
      </EmptyState>
    );
  } else {
    body = (
      <FullTextScreen
        key={assignment.assignment_id}
        assignment={assignment}
        onDecided={() => setDone((n) => n + 1)}
      />
    );
  }

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <QueueBar
        scopeLabel={scopeFull ? `${labels.scope}: ${shortQuestion(scopeFull)}` : "Full text"}
        title={scopeFull}
        status={status}
      />
      <div className="min-h-0 overflow-y-auto">{body}</div>
    </div>
  );
}

const PRIMARY =
  "rounded-[4px] border border-petrol bg-petrol px-3 py-1.5 text-sm font-medium text-petrol-ink hover:brightness-110";
const SECONDARY =
  "rounded-[4px] border border-rule-strong bg-sheet px-3 py-1.5 text-sm hover:bg-sheet-2";

/** A research question short enough for a strip or a table cell; the full one goes in a hover.
 * "Do mobile phone interventions (smartphone apps, …) help adults who smoke…" loses its
 * parentheses first, then is cut at a word. */
export const shortQuestion = (question: string, length = 64) => {
  const plain = question
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= length) return plain;
  const cut = plain.slice(0, length + 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > 20 ? cut.slice(0, word) : plain.slice(0, length)).replace(/[\s,:;]+$/, "")}…`;
};

/** "Included 4" and "Excluded 5: 3 on 1 Population, 2 on 4 Study type", from the decisions. */
const decidedFigures = (
  decisions: ReadonlyArray<TableDecision> | null,
  criteria: ReadonlyArray<Criterion>,
): ReadonlyArray<readonly [string, ReactNode]> => {
  if (!decisions?.length) return [];
  const out: Array<readonly [string, ReactNode]> = [];
  for (const outcome of ["include", "exclude", "insufficient_information", "unclear"] as const) {
    const these = decisions.filter((d) => d.outcome === outcome);
    if (!these.length) continue;
    const reasons = new Map<string, number>();
    for (const d of these)
      if (d.reason_criterion_id)
        reasons.set(d.reason_criterion_id, (reasons.get(d.reason_criterion_id) ?? 0) + 1);
    const why = [...reasons]
      .toSorted((a, b) => b[1] - a[1])
      .map(([id, n]) => `${n} on ${numbered(criteria, id)}`)
      .join(", ");
    out.push([OUTCOMES[outcome].past, `${these.length}${why ? `: ${why}` : ""}`]);
  }
  return out;
};

/** The strip above the queue, as on title and abstract: where, and how far. */
function QueueBar({
  scopeLabel,
  title,
  status,
}: {
  scopeLabel: string;
  title: string;
  status: ScopeStatus | null;
}) {
  const total = status ? status.screened + status.remaining : 0;
  const share = total ? status!.screened / total : 0;
  return (
    <div className="flex h-9 items-center gap-4 border-b border-rule bg-paper px-4 text-xs">
      <span className="min-w-0 truncate text-ink-2" title={title || scopeLabel}>
        {scopeLabel}
      </span>
      {status ? (
        <span className="ml-auto flex flex-none items-center gap-2.5 text-ink-2">
          <span
            className="h-1.5 w-40 overflow-hidden rounded-full bg-rule"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={status.screened}
            aria-label="Full texts screened"
          >
            <span className="block h-full bg-petrol" style={{ width: `${share * 100}%` }} />
          </span>
          <span className="whitespace-nowrap tabular-nums">
            {status.screened} of {total} screened
          </span>
        </span>
      ) : null}
    </div>
  );
}

function FullTextScreen({
  assignment,
  onDecided,
}: {
  assignment: FullTextAssignment;
  onDecided?: () => void;
}) {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, labels, criteriaFor, screeningStage } = useProject();
  const targeted = screeningStage("full_text")?.mode === "S";
  const criteria = useMemo(
    () => criteriaFor("full_text", assignment.scope_id),
    [criteriaFor, assignment.scope_id],
  );
  const mentions = useMemo(() => new Map(assignment.mentions), [assignment.mentions]);
  const nameOf = (c: Criterion) => `${numberOf(criteria, c.id)} ${labels[c.slot] ?? c.slot}`;
  const {
    active,
    setActive,
    criterion,
    stateOf,
    update,
    currentMention,
    selection,
    setSelection,
    notice,
    setNotice,
    busy: adopting,
    highlights: evidenceHighlights,
    jump: jumpMention,
    adopt,
  } = useEvidence({
    workbench,
    layerId: assignment.layer.id,
    criteria,
    mentions,
    nameOf,
  });
  const [outcome, setOutcome] = useState<{ outcome: Outcome; reason: string | null } | null>(null);
  // `e` or `x` waits for the criterion's number.
  const [armed, setArmed] = useState<"exclude" | "insufficient_information" | null>(null);
  // `w` opens the wrong-document form; once sent, the report is out of screening.
  const [wrong, setWrong] = useState<"asking" | "sent" | null>(null);
  const [busy, setBusy] = useState(false);
  // The server's token, and the AI's reading once a provisional decision revealed it.
  const [etag, setEtag] = useState(assignment.etag);
  const [reveal, setReveal] = useState<Reveal | null>(assignment.reveal);
  const [aiQuote, setAiQuote] = useState<Anchor | null>(null);
  const [showQuote, setShowQuote] = useState(0);
  // The page follows the current mention, or the AI's quote when it was asked for last.
  const [follow, setFollow] = useState<"mention" | "ai">("mention");
  const [provisional, setProvisional] = useState<Decision | null>(null);
  // DESIGN.md "Metrics": when the report appeared and when the reviewer first acted on it.
  const [shownAt] = useState(() => new Date().toISOString());
  const firstKeyAt = useRef<string | null>(null);
  // A reveal that came with the item was shown when the item was, and so was a reading the stage
  // shows before the decision.
  const revealedAt = useRef<string | null>(assignment.reveal || assignment.ai ? shownAt : null);
  // Mode S, key f: the decision asks a colleague, with this comment.
  const [asking, setAsking] = useState<{ comment: string; typing: boolean } | null>(null);

  // The AI's quote on the page, once its reading is shown: the server places it.
  const revealed = reveal !== null;
  useEffect(() => {
    if (!revealed) return;
    let live = true;
    void run(
      workbench.aiQuote({
        projectId: project.id,
        as: me.actor_id,
        assignmentId: assignment.assignment_id,
      }),
    ).then(
      (found) => {
        if (!live) return;
        setAiQuote(found);
        setShowQuote((n) => n + 1);
        setFollow("ai");
      },
      () => live && setAiQuote(null),
    );
    return () => {
      live = false;
    };
  }, [revealed, workbench, project.id, me.actor_id, assignment.assignment_id]);

  const verdicts = criteria.filter((c) => stateOf(c.id).verdict !== null).length;

  const highlights = useMemo(
    (): PageHighlight[] => [
      ...evidenceHighlights,
      ...(aiQuote
        ? [
            {
              id: aiQuote.id,
              boxes: aiQuote.boxes,
              kind: "ai" as const,
              label: "The AI judge's quote",
            },
          ]
        : []),
    ],
    [evidenceHighlights, aiQuote],
  );
  const aiBox = aiQuote?.boxes[0];
  const mentionBox = currentMention?.boxes[0];
  const target =
    follow === "ai" && aiQuote && aiBox
      ? { key: `${aiQuote.id}-${showQuote}`, box: aiBox }
      : currentMention && mentionBox
        ? { key: currentMention.id, box: mentionBox }
        : null;

  const jump = (step: 1 | -1) => {
    jumpMention(step);
    setFollow("mention");
  };

  const send = async (given: Decision, phase: "provisional" | "final") => {
    const now = new Date().toISOString();
    const decision: Decision =
      asking && !asking.typing
        ? { ...given, comment: asking.comment.trim() || null, second_opinion: true }
        : given;
    setBusy(true);
    try {
      const result = await run(
        workbench.decide({
          projectId: project.id,
          as: me.actor_id,
          assignmentId: assignment.assignment_id,
          decision,
          phase,
          expectedEtag: etag,
          timing: {
            shown_at: shownAt,
            first_key_at: firstKeyAt.current ?? now,
            decided_at: now,
            reveal_shown_at: revealedAt.current,
          },
        }),
      );
      setEtag(result.etag);
      if (result.phase === "provisional" && result.reveal) {
        // The AI read the report differently: show its reading, then keep or change.
        revealedAt.current = new Date().toISOString();
        setReveal(result.reveal);
        setProvisional(decision);
        setNotice(null);
        return;
      }
      setOutcome({ outcome: decision.outcome, reason: decision.reason_criterion_id });
      setNotice(null);
      if (onDecided) window.setTimeout(onDecided, 900);
    } catch (e) {
      setNotice(
        e instanceof WorkbenchError ? e.message : "Kittum did not record the decision. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  /** The reviewer's readings so far, with each one's evidence. */
  const readings = (override?: { id: string; status: CriterionStatus }) =>
    criteria.flatMap((c) => {
      const state = stateOf(c.id);
      const status = override?.id === c.id ? override.status : state.verdict;
      return status
        ? [
            {
              criterion_id: c.id,
              status,
              evidence_anchor_ids: state.evidence.map((e) => e.id),
            },
          ]
        : [];
    });
  const phase = reveal && !outcome ? "final" : "provisional";

  /** `i`: one action that says every criterion is met. Evidence is optional. */
  const include = async () => {
    const against = criteria.filter((c) => {
      const verdict = stateOf(c.id).verdict;
      return verdict !== null && verdict !== "met";
    });
    const [first] = against;
    if (first) {
      setNotice(
        `Include means every criterion is met, but you marked ${nameOf(first)} ${VERDICTS[stateOf(first.id).verdict ?? "unclear"].label.toLowerCase()}. Change that verdict, or exclude.`,
      );
      return;
    }
    await send(
      {
        outcome: "include",
        reason_criterion_id: null,
        evidence_anchor_ids: criteria.flatMap((c) => stateOf(c.id).evidence.map((e) => e.id)),
        comment: null,
        criteria: readings(),
      },
      phase,
    );
  };

  /** `e` or `x` and a number: the one criterion the report fails, or lacks information on. */
  const decideOn = async (chosen: "exclude" | "insufficient_information", c: Criterion) => {
    const evidence = stateOf(c.id).evidence;
    const all = criteria.flatMap((x) => stateOf(x.id).evidence.map((e) => e.id));
    if (chosen === "exclude" && evidence.length === 0) {
      setActive(criteria.indexOf(c));
      setNotice(
        `To exclude on ${nameOf(c)}, adopt evidence for it first. Go to a mention with . and press Enter.`,
      );
      return;
    }
    if (chosen === "insufficient_information" && all.length === 0) {
      setActive(criteria.indexOf(c));
      setNotice(
        "Insufficient information needs at least one evidence span. Adopt one with Enter first.",
      );
      return;
    }
    const status = chosen === "exclude" ? "not_met" : "unclear";
    update(c.id, (s) => ({ ...s, verdict: status }));
    await send(
      {
        outcome: chosen,
        reason_criterion_id: chosen === "exclude" ? c.id : null,
        evidence_anchor_ids: chosen === "exclude" ? evidence.map((e) => e.id) : all,
        comment: null,
        criteria: readings({ id: c.id, status }),
      },
      phase,
    );
  };

  /** Space after a reveal: the provisional decision stands as the final one. */
  const keep = () => {
    if (!reveal || !provisional || outcome) return false;
    void send(provisional, "final");
    return true;
  };

  const markWrong = async (note: string) => {
    setBusy(true);
    try {
      await run(
        workbench.wrongDocument({
          projectId: project.id,
          as: me.actor_id,
          assignmentId: assignment.assignment_id,
          expectedEtag: etag,
          documentId: assignment.document.id,
          note: note.trim() || null,
        }),
      );
      setWrong("sent");
      setNotice(null);
      if (onDecided) window.setTimeout(onDecided, 1400);
    } catch (e) {
      setWrong(null);
      setNotice(e instanceof WorkbenchError ? e.message : "Kittum did not record it. Try again.");
    } finally {
      setBusy(false);
    }
  };

  function handleKey(event: KeyboardEvent): boolean {
    if (busy || adopting || !criterion || outcome || wrong) return false;
    const key = event.key;
    // A held key repeats; adopting toggles and verdicts advance, so act on the first press only.
    if (
      event.repeat &&
      (key === "Enter" || key in VERDICT_KEYS || key in ON_A_CRITERION || key === "i")
    )
      return true;
    if (armed) {
      setArmed(null);
      if (/^[1-9]$/.test(key)) {
        const chosen = byKey(criteria, key);
        if (chosen) void decideOn(armed, chosen);
        else
          setNotice(
            `There is no criterion ${key}. Press ${criteria.map((c) => keyOf(criteria, c.id)).join(", ")}.`,
          );
        return true;
      }
      if (key === "Escape" || key === "Backspace" || key in ON_A_CRITERION) return true;
    }
    if (key === " ") return keep();
    if (key === "f" && targeted) {
      if (assignment.second_opinion)
        setNotice("This is a second opinion. Your decision settles the record.");
      else setAsking({ comment: asking?.comment ?? "", typing: true });
      return true;
    }
    if (key === "Escape" && asking) {
      setAsking(null);
      return true;
    }
    if (key === "ArrowDown" || key === "j") {
      setActive((a) => Math.min(a + 1, criteria.length - 1));
      return true;
    }
    if (key === "ArrowUp" || key === "k") {
      setActive((a) => Math.max(a - 1, 0));
      return true;
    }
    if (key === "." || key === ",") {
      jump(key === "." ? 1 : -1);
      return true;
    }
    if (key === "Enter") {
      void adopt();
      return true;
    }
    if (key === "q") {
      if (aiQuote) {
        setShowQuote((n) => n + 1);
        setFollow("ai");
        setNotice(null);
      } else {
        setNotice(
          reveal
            ? "The AI judge's quote is not on the page, so there is nothing to show."
            : "The AI judge's reading appears after you decide.",
        );
      }
      return true;
    }
    if (key === "w") {
      setWrong("asking");
      return true;
    }
    if (/^[1-9]$/.test(key)) {
      setNotice("To decide on a criterion, press e or x first, then its number.");
      return true;
    }
    const verdict = VERDICT_KEYS[key];
    if (verdict) {
      update(criterion.id, (s) => ({ ...s, verdict }));
      const next = criteria.findIndex((c, i) => i > active && stateOf(c.id).verdict === null);
      if (next >= 0) setActive(next);
      setNotice(null);
      return true;
    }
    if (key === "i") {
      void include();
      return true;
    }
    const chosen = ON_A_CRITERION[key];
    if (chosen) {
      setArmed(chosen);
      setNotice(null);
      return true;
    }
    return false;
  }

  useKeys((event) => {
    const at = new Date().toISOString();
    const handled = handleKey(event);
    if (handled) firstKeyAt.current ??= at;
    return handled;
  });
  /** A click on a button sends its key, so it goes through the same guards and timing. */
  const press = (key: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  const locked = busy || adopting || outcome !== null || wrong !== null;

  const revealedCriterion = reveal ? criteria.find((x) => x.id === reveal.criterion_id) : undefined;
  const aiPage = aiQuote?.boxes[0]?.page;
  const reasonCriterion = outcome?.reason
    ? criteria.find((c) => c.id === outcome.reason)
    : undefined;

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(380px,34%)] bg-paper">
      <PdfViewer
        workbench={workbench}
        layer={assignment.layer}
        highlights={highlights}
        target={target}
        onSelection={setSelection}
        label={`${assignment.report.study_label}, ${assignment.report.citation}`}
      />
      <aside
        className="my-3 mr-3 flex min-h-0 flex-col overflow-hidden rounded-[6px] bg-raised shadow-raised"
        aria-label="Criteria"
      >
        <header className="px-5 pt-4 pb-2">
          <p className="text-sm text-ink-2">
            {labels.report} {assignment.report.study_label}
            {assignment.report.licence ? `, ${assignment.report.licence}` : ""}
          </p>
          <h1 className="mt-1 line-clamp-2 text-md font-semibold" title={assignment.report.title}>
            {assignment.report.title}
          </h1>
        </header>
        <ol className="min-h-0 flex-1 overflow-y-auto" data-testid="criteria-list">
          {criteria.map((c, index) => {
            const state = stateOf(c.id);
            const isActive = index === active;
            const list = mentions.get(c.id) ?? [];
            const chosen = outcome?.reason === c.id;
            return (
              <li
                key={c.id}
                aria-current={isActive || undefined}
                data-revealed={reveal?.criterion_id === c.id || undefined}
                className={`px-5 py-2.5 ${isActive ? "bg-petrol-wash/50 shadow-[inset_3px_0_0_var(--petrol)]" : ""} ${armed ? "shadow-[inset_0_2px_0_var(--exclude)]" : ""}`}
                onClick={() => (armed ? press(keyOf(criteria, c.id)) : setActive(index))}
                title={armed ? `Choose criterion ${numberOf(criteria, c.id)}` : undefined}
              >
                <div className="flex items-center gap-2">
                  <span className={armed === "exclude" ? "text-exclude" : ""}>
                    <Key k={keyOf(criteria, c.id)} on={armed !== null} />
                  </span>
                  <span className="text-xs text-ink-2">{labels[c.slot] ?? c.slot}</span>
                  {chosen ? <Mark term={OUTCOMES.exclude} title="Your exclusion reason" /> : null}
                  <span className="ml-auto flex items-center gap-2 text-xs">
                    {state.evidence.length > 0 ? (
                      <span className="text-ink-2">
                        {state.evidence.length} evidence{" "}
                        {state.evidence.length === 1 ? "span" : "spans"}
                      </span>
                    ) : null}
                    {state.verdict ? (
                      <Status term={VERDICTS[state.verdict]} />
                    ) : (
                      <span className="text-ink-2">No verdict</span>
                    )}
                  </span>
                </div>
                <p
                  className={`mt-1 text-sm ${isActive || armed ? "" : "line-clamp-2 text-ink-2"}`}
                  title={c.text_de}
                >
                  {c.text_en}
                </p>
                {isActive ? (
                  <Mentions
                    mentions={list}
                    cursor={state.cursor}
                    adopted={new Set(state.evidence.map((e) => e.key))}
                    selections={state.evidence.filter((e) => e.key.startsWith("selection-"))}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
        {assignment.second_opinion ? (
          <SecondOpinionAsked
            asked={assignment.second_opinion}
            criteria={criteria}
            labels={labels}
          />
        ) : null}
        {assignment.ai && !reveal ? (
          <AiBefore ai={assignment.ai} criteria={criteria} labels={labels} marked={null} />
        ) : null}
        {asking && !outcome ? (
          <AskSecondOpinion
            comment={asking.comment}
            onComment={(comment) => setAsking({ comment, typing: true })}
            onDone={() => setAsking((a) => a && { ...a, typing: false })}
            onCancel={() => setAsking(null)}
          />
        ) : null}
        {reveal ? (
          <FullTextReveal
            reveal={reveal}
            criterion={{
              number: revealedCriterion ? criteria.indexOf(revealedCriterion) + 1 : null,
              label: revealedCriterion
                ? (labels[revealedCriterion.slot] ?? revealedCriterion.slot)
                : reveal.criterion_id,
              text: revealedCriterion?.text_en ?? null,
            }}
            markedAt={
              aiPage
                ? `Marked on page ${aiPage}.`
                : reveal.quote_verified && reveal.quote_span?.part === "title"
                  ? "It is in the record's title, not on the page."
                  : null
            }
            canJump={aiPage !== undefined}
            agrees={
              provisional !== null &&
              (provisional.outcome === "exclude") === (reveal.status === "not_met")
            }
            settled={outcome !== null}
          />
        ) : null}
        {wrong ? (
          <WrongDocumentForm
            sent={wrong === "sent"}
            busy={busy}
            report={labels.report.toLowerCase()}
            onCancel={() => setWrong(null)}
            onSend={(note) => void markWrong(note)}
          />
        ) : (
          <footer className="px-5 pt-3 pb-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                kind="primary"
                size="sm"
                keys={["i"]}
                disabled={locked}
                title="Include: every criterion is met"
                onMouseDown={keepFocus}
                onClick={() => press("i")}
              >
                Include
              </Button>
              <Button
                kind="danger"
                size="sm"
                keys={["e"]}
                disabled={locked}
                aria-pressed={armed === "exclude"}
                onMouseDown={keepFocus}
                onClick={() => press(armed === "exclude" ? "Escape" : "e")}
              >
                {armed === "exclude" ? "Exclude on which criterion?" : "Exclude on a criterion"}
              </Button>
              <Button
                size="sm"
                keys={["x"]}
                disabled={locked}
                aria-pressed={armed === "insufficient_information"}
                onMouseDown={keepFocus}
                onClick={() => press(armed === "insufficient_information" ? "Escape" : "x")}
              >
                Insufficient information
              </Button>
              {targeted ? (
                <Button
                  size="sm"
                  keys={["f"]}
                  disabled={locked}
                  aria-pressed={Boolean(asking)}
                  onMouseDown={keepFocus}
                  onClick={() => press("f")}
                >
                  {asking ? "Asking for a second opinion" : "Second opinion"}
                </Button>
              ) : null}
              <Button
                kind="quiet"
                size="sm"
                keys={["w"]}
                disabled={locked}
                className="ml-auto"
                onMouseDown={keepFocus}
                onClick={() => press("w")}
              >
                Wrong document
              </Button>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
              <KeyHint keys={[",", "."]}>Mentions</KeyHint>
              <KeyHint keys={["Enter"]}>{selection ? "Adopt selection" : "Adopt"}</KeyHint>
              <KeyHint keys={["y", "n", "?"]}>Verdict, optional</KeyHint>
              {aiQuote ? <KeyHint keys={["q"]}>The AI&rsquo;s quote</KeyHint> : null}
            </div>
            <p
              className="mt-2 min-h-5 text-xs text-ink-2"
              aria-live="polite"
              data-testid="fulltext-notice"
            >
              {outcome ? (
                <Status term={OUTCOMES[outcome.outcome]}>
                  {OUTCOMES[outcome.outcome].past}
                  {reasonCriterion ? ` on ${nameOf(reasonCriterion)}` : ""}.
                </Status>
              ) : armed ? (
                `Now press 1 to ${criteria.length}, or click the criterion. Esc cancels.`
              ) : (
                (notice ??
                (verdicts > 0
                  ? `${verdicts} of ${criteria.length} criteria have your verdict. Decide when you are sure.`
                  : "Decide when you are sure. You do not need a verdict on every criterion."))
              )}
            </p>
          </footer>
        )}
      </aside>
    </div>
  );
}

/** Buttons on the decision rail keep the keyboard focus where it was, so keys go on working. */
const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

function WrongDocumentForm({
  sent,
  busy,
  report,
  onCancel,
  onSend,
}: {
  sent: boolean;
  busy: boolean;
  report: string;
  onCancel: () => void;
  onSend: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  if (sent) {
    return (
      <footer
        className="bg-sheet-2 px-5 py-3 text-sm"
        data-testid="wrong-document-sent"
        aria-live="polite"
      >
        <p className="font-semibold">Marked as the wrong document</p>
        <p className="mt-1 text-xs text-ink-2">
          Kittum took this {report} out of screening and detached the PDF. The record now shows as
          missing its full text. This is not an exclusion.
        </p>
      </footer>
    );
  }
  return (
    <form
      className="bg-sheet-2 px-5 py-3 text-sm"
      aria-label="Wrong document"
      data-testid="wrong-document"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSend(note);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <p className="font-semibold">Is this PDF not the record&rsquo;s {report}?</p>
      <p className="mt-1 text-xs text-ink-2">
        Kittum takes the {report} out of screening and detaches the PDF from the record. The record
        then shows as missing its full text, and the methods lead can attach the right one. This is
        not an exclusion.
      </p>
      <label className="mt-2.5 block text-xs text-ink-2" htmlFor="wrong-document-note">
        What is the PDF instead? Optional.
      </label>
      <input
        id="wrong-document-note"
        ref={field}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="mt-1 w-full rounded-[3px] border border-rule-strong bg-sheet px-2 py-1 text-sm"
        placeholder="For example, the journal's reporting checklist"
        maxLength={500}
      />
      <p className="mt-2.5 flex gap-4 text-xs">
        <KeyHint keys={["Enter"]}>Mark as the wrong document</KeyHint>
        <KeyHint keys={["Escape"]}>Cancel</KeyHint>
      </p>
    </form>
  );
}

function FullTextReveal({
  reveal,
  criterion,
  markedAt,
  canJump,
  agrees,
  settled,
}: {
  reveal: Reveal;
  criterion: CriterionName;
  markedAt: string | null;
  canJump: boolean;
  agrees: boolean;
  settled: boolean;
}) {
  return (
    <section
      aria-label="AI judge"
      data-testid="ai-reveal"
      className="reveal-enter evidence-item max-h-[45%] overflow-y-auto border-t border-rule px-5 py-2.5"
    >
      <p className="text-sm font-semibold">
        {agrees ? "The AI judge agrees" : "The AI judge disagrees"}
      </p>
      <div className="mt-1">
        <AiReading
          criterion={criterion}
          status={reveal.status}
          downgradedFrom={reveal.downgraded_from}
          rationale={reveal.rationale}
          quote={reveal.quote || null}
          verified={reveal.quote_verified ?? false}
          markedAt={markedAt}
          compact
        />
      </div>
      {settled ? null : (
        <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <KeyHint keys={[" "]}>Keep yours</KeyHint>
          <KeyHint keys={["i", "e", "x"]}>Change it</KeyHint>
          {canJump ? <KeyHint keys={["q"]}>Show the quote</KeyHint> : null}
        </p>
      )}
    </section>
  );
}
