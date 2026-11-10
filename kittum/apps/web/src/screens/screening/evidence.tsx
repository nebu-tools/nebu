// Evidence on a full text, as the full-text screen and the adjudicator gather it: one active
// criterion, its protocol-term mentions in document order (`,` and `.`), and the spans adopted
// as evidence for each criterion (Enter on a mention or a selection). Each adopted span is saved
// as an anchor on the layer, and a decision cites it by ID. The risk-of-bias screen gathers
// quotes per signalling question the same way, starting from the quotes already saved.
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { Anchor, Box, Criterion, CriterionStatus } from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import type { Workbench } from "../../data/workbench.ts";
import { Key } from "../../ui/Key.tsx";
import { ADOPTED, Mark } from "../../ui/Status.tsx";
import type { PageHighlight, TextSelection } from "../pdf/PdfViewer.tsx";

export interface Evidence {
  /** The saved anchor's ID. */
  readonly id: string;
  /** The mention or selection it came from, so Enter on it again removes it. */
  readonly key: string;
  readonly quote: string;
  readonly boxes: ReadonlyArray<Box>;
}

export interface CriterionState {
  readonly verdict: CriterionStatus | null;
  readonly evidence: ReadonlyArray<Evidence>;
  readonly cursor: number; // index into the mentions, -1 before the first jump
}

const EMPTY: CriterionState = { verdict: null, evidence: [], cursor: -1 };

export function useEvidence<C extends { readonly id: string } = Criterion>({
  workbench,
  layerId,
  criteria,
  mentions,
  nameOf,
  initial = {},
}: {
  workbench: Workbench;
  layerId: string;
  criteria: ReadonlyArray<C>;
  mentions: ReadonlyMap<string, ReadonlyArray<Anchor>>;
  nameOf: (criterion: C) => string;
  /** Evidence already saved, by criterion ID. */
  initial?: Readonly<Record<string, CriterionState>>;
}) {
  const [active, setActive] = useState(0);
  const [states, setStates] = useState<Record<string, CriterionState>>(() => ({ ...initial }));
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const criterion = criteria[active];
  const stateOf = useCallback((id: string): CriterionState => states[id] ?? EMPTY, [states]);
  const update = (id: string, change: (s: CriterionState) => CriterionState) =>
    setStates((all) => ({ ...all, [id]: change(all[id] ?? EMPTY) }));

  const activeMentions = useMemo(
    (): ReadonlyArray<Anchor> => (criterion ? (mentions.get(criterion.id) ?? []) : []),
    [criterion, mentions],
  );
  const activeState = criterion ? stateOf(criterion.id) : null;
  const currentMention =
    activeState && activeState.cursor >= 0 ? activeMentions[activeState.cursor] : undefined;

  /** The adopted spans, the active criterion's mentions, and the current one. */
  const highlights = useMemo(
    (): PageHighlight[] => [
      ...criteria.flatMap((c) =>
        stateOf(c.id).evidence.map((e) => ({
          id: `adopted-${c.id}-${e.id}`,
          boxes: e.boxes,
          kind: "adopted" as const,
          label: "Adopted evidence",
        })),
      ),
      ...activeMentions
        .filter((m) => m !== currentMention)
        .map((m) => ({ id: m.id, boxes: m.boxes, kind: "mention" as const, label: "Mention" })),
      ...(currentMention
        ? [
            {
              id: currentMention.id,
              boxes: currentMention.boxes,
              kind: "current" as const,
              label: "Current mention",
            },
          ]
        : []),
    ],
    [criteria, stateOf, activeMentions, currentMention],
  );

  const jump = (step: 1 | -1) => {
    if (!criterion) return;
    if (activeMentions.length === 0) {
      setNotice("This report never uses the protocol terms of this criterion.");
      return;
    }
    update(criterion.id, (s) => ({
      ...s,
      cursor:
        s.cursor < 0
          ? step === 1
            ? 0
            : activeMentions.length - 1
          : (s.cursor + step + activeMentions.length) % activeMentions.length,
    }));
    setNotice(null);
  };

  /** Adopts a selection, else `mention` if given, else the current mention. */
  const adopt = async (mention?: Anchor) => {
    if (!criterion) return;
    const chosen = mention ?? currentMention;
    const source =
      selection && !mention
        ? {
            key: `selection-${selection.start}-${selection.end}`,
            quote: selection.quote,
            start: selection.start,
            boxes: selection.boxes,
          }
        : chosen
          ? {
              key: chosen.id,
              quote: chosen.quote.exact,
              start: chosen.start,
              boxes: chosen.boxes,
            }
          : null;
    if (!source) {
      setNotice("Go to a mention with . first, or select text on the page.");
      return;
    }
    const already = stateOf(criterion.id).evidence.find((e) => e.key === source.key);
    if (already) {
      update(criterion.id, (s) => ({
        ...s,
        evidence: s.evidence.filter((e) => e.key !== source.key),
      }));
      setNotice("Removed from the evidence.");
      return;
    }
    setBusy(true);
    try {
      // The span becomes an anchor on the layer: the decision cites it by ID.
      const anchor = await run(
        workbench.adopt({ layerId, quote: source.quote, start: source.start }),
      );
      const evidence: Evidence = {
        id: anchor.id,
        key: source.key,
        quote: anchor.quote.exact,
        boxes: source.boxes,
      };
      update(criterion.id, (s) => ({ ...s, evidence: [...s.evidence, evidence] }));
      setNotice(`Adopted as evidence for ${nameOf(criterion)}.`);
    } catch (e) {
      setNotice(
        e instanceof WorkbenchError
          ? `Not adopted. ${e.message}`
          : "Not adopted. Select whole words and try again.",
      );
    } finally {
      setBusy(false);
    }
    if (selection && !mention) {
      window.getSelection()?.removeAllRanges();
      setSelection(null);
    }
  };

  return {
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
    busy,
    highlights,
    jump,
    adopt,
  };
}

/** The active criterion's mentions, and spans selected on the page, with what is adopted. With
 * `limit`, only the first few show (and the current and adopted ones), the rest behind a link. */
export function Mentions({
  mentions,
  cursor,
  adopted,
  selections,
  limit,
  label = "Mentions in document order",
  footer,
  onSelect,
  onAdopt,
}: {
  mentions: ReadonlyArray<Anchor>;
  cursor: number;
  adopted: ReadonlySet<string>;
  selections: ReadonlyArray<Evidence>;
  limit?: number;
  label?: string;
  /** Replaces the count and key line under the list. */
  footer?: ReactNode;
  /** A click on a mention makes it the current one. */
  onSelect?: (index: number) => void;
  /** Adopts a mention straight from its row ("Use as evidence"). */
  onAdopt?: (index: number) => void;
}) {
  const [all, setAll] = useState(false);
  if (mentions.length === 0 && selections.length === 0) {
    return (
      <p className="mt-2 text-xs text-ink-3">
        The protocol terms of this criterion do not occur in this report. Select text on the page to
        cite it.
      </p>
    );
  }
  return (
    <ol className="mt-2.5 grid gap-1" aria-label={label}>
      {mentions.map((mention, index) => {
        if (
          limit !== undefined &&
          !all &&
          index >= limit &&
          index !== cursor &&
          !adopted.has(mention.id)
        )
          return null;
        const page = mention.boxes[0]?.page ?? 0;
        const current = index === cursor;
        return (
          <li
            key={mention.id}
            aria-current={current || undefined}
            data-testid="mention"
            onClick={onSelect ? () => onSelect(index) : undefined}
            title={onSelect && !current ? "Show this passage" : undefined}
            className={`group grid grid-cols-[2.6rem_minmax(0,1fr)_auto] items-baseline gap-2 rounded-[2px] py-1 pr-2 pl-2 text-sm ${current ? "evidence-item" : onSelect ? "cursor-pointer hover:bg-sheet-2" : ""}`}
          >
            <span className="text-ink-2">p. {page}</span>
            <span className="line-clamp-2 text-ink-2">
              {tail(mention.quote.prefix)}
              <span className="font-medium text-ink">
                {mention.quote.exact.replace(/\s+/g, " ")}
              </span>
              {head(mention.quote.suffix)}
            </span>
            {adopted.has(mention.id) ? (
              <Mark term={ADOPTED} />
            ) : onAdopt ? (
              <button
                type="button"
                className={`rounded-[4px] px-2 text-sm text-petrol hover:bg-petrol-wash ${current ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  onAdopt(index);
                }}
              >
                Use as evidence
              </button>
            ) : (
              <span />
            )}
          </li>
        );
      })}
      {selections.map((selection) => (
        <li
          key={selection.id}
          className="grid grid-cols-[2.6rem_minmax(0,1fr)_auto] gap-2 py-1 pr-2 pl-2 text-sm"
        >
          <span className="text-ink-2">p. {selection.boxes[0]?.page}</span>
          <span className="line-clamp-2 font-medium">{selection.quote.replace(/\s+/g, " ")}</span>
          <Mark term={ADOPTED} />
        </li>
      ))}
      {limit !== undefined && mentions.length > limit ? (
        <li>
          <button
            type="button"
            className="py-1 pl-2 text-sm text-petrol hover:underline"
            aria-expanded={all}
            onClick={() => setAll((on) => !on)}
          >
            {all ? "Show fewer" : `Show ${mentions.length - limit} more`}
          </button>
        </li>
      ) : null}
      <li className="mt-1 flex items-center gap-3 text-sm text-ink-2">
        <span>
          {cursor < 0
            ? `${mentions.length} ${mentions.length === 1 ? "mention" : "mentions"}`
            : `${cursor + 1} of ${mentions.length}`}
        </span>
        {footer ?? (
          <span>
            <Key k="," /> <Key k="." /> to go through them, <Key k="Enter" /> to adopt
          </span>
        )}
      </li>
    </ol>
  );
}

// Context around a mention, cut at a word boundary.
const tail = (text: string) => {
  const flat = text.replace(/\s+/g, " ");
  if (flat.length <= 28) return flat;
  return `…${flat.slice(-28).replace(/^\S*\s/, "")}`;
};
const head = (text: string) => {
  const flat = text.replace(/\s+/g, " ");
  if (flat.length <= 28) return flat;
  return `${flat.slice(0, 28).replace(/\s\S*$/, "")}…`;
};
