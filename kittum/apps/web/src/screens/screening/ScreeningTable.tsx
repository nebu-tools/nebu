// The screening table (DESIGN.md, "Reviewer workbench"): a stage as a spreadsheet. A reviewer
// sees their own records only, decided ones included, and an AI reading only where their own
// decision revealed it; the server leaves out everything else. The methods lead sees the whole
// stage. Filters, sort, and the quick search change what is on screen, never the queue order.
// A reviewer decides the selected row with the queue's keys, or opens it in the queue with Enter.
// In a topic with working documentation (mode S) the table is also where a screener decides many
// records at once: mark rows (Shift or Ctrl click, Shift+↑/↓, a for every row in view), then
// include them, exclude them on a criterion, or accept the AI's proposal for each. A screener
// there may also export their records, decide them in Excel, and import the file again. The
// server refuses bulk decisions and imports in complete topics.
import { Popover } from "@base-ui/react/popover";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type {
  AiProposal,
  BulkAction,
  Criterion,
  Decision,
  Outcome,
  ScreeningTable,
  StageInfo,
  TableDecision,
  TableRow,
} from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import type { Caller, Workbench } from "../../data/workbench.ts";
import { formatDateTime } from "../../lib/format.ts";
import { studyLabel } from "../../lib/labels.ts";
import { Button } from "../../ui/Button.tsx";
import { Help } from "../../ui/Help.tsx";
import { EmptyState } from "../../ui/Empty.tsx";
import { Key, KeyHint } from "../../ui/Key.tsx";
import { useKeys } from "../../ui/keys.ts";
import { usePoll } from "../../ui/poll.ts";
import { Mark, OUTCOMES, Status, VERDICTS, WAITS } from "../../ui/Status.tsx";
import type { Term } from "../../ui/Status.tsx";
import { useProject } from "../project.tsx";
import { AiReading } from "./AiReading.tsx";
import { ShowPrompt } from "./Prompt.tsx";
import { AiBefore, AskSecondOpinion, SecondOpinionAsked } from "./Targeted.tsx";
import { byKey, keyOf, numberOf, numbered, shortLabel } from "./criteria.ts";
import { haystack, matcher } from "./table/fuzzy.ts";
import type { Haystack } from "./table/fuzzy.ts";
import { active, describe, EMPTY, valuesOf, view } from "./table/grid.ts";
import type { Column, Filter, ViewState } from "./table/grid.ts";
import { Grid, gridHeight } from "./table/Grid.tsx";
import { ImportDecisions } from "./table/ImportDecisions.tsx";
import { loadViews, storeViews } from "./table/views.ts";
import type { SavedViews } from "./table/views.ts";

const PAGE = 20;

const STAGE_WORDS = { title_abstract: "Title and abstract", full_text: "Full text" } as const;

const own = (row: TableRow): TableDecision | undefined => row.decisions[0];

const records = (n: number) => `${n} ${n === 1 ? "record" : "records"}`;

/** The criterion's full rule, for a hover. */
const ruleOf = (criteria: ReadonlyArray<Criterion>, id: string | null | undefined) =>
  criteria.find((c) => c.id === id)?.text_en;

/** "Exclude · 3 Intervention not met": a decision with its criterion's number and short name. */
const decisionLabel = (d: TableDecision | undefined, criteria: ReadonlyArray<Criterion>) => {
  if (!d?.outcome) return "Not decided";
  const reason = d.reason_criterion_id ? ` on ${numbered(criteria, d.reason_criterion_id)}` : "";
  return `${OUTCOMES[d.outcome].label}${reason}`;
};

const decisionText = (d: TableDecision | undefined, criteria: ReadonlyArray<Criterion>) => {
  if (!d?.outcome) return "Not decided";
  const waiting = d.state === "awaiting_final" ? ", AI shown" : "";
  const asked = d.second_opinion ? ", second opinion asked" : "";
  return `${decisionLabel(d, criteria)}${waiting}${asked}`;
};

const ROLE_WORDS = { auditor: " (auditor)", second_opinion: " (second opinion)", screener: "" };

const who = (d: TableDecision) => `${d.name ?? "Someone"}${d.role ? ROLE_WORDS[d.role] : ""}`;

const OUTCOME_WORDS = { include: "Include", exclude: "Exclude", conflict: "Conflict" } as const;

const RECORD_TERMS: Record<keyof typeof OUTCOME_WORDS, Term> = {
  include: OUTCOMES.include,
  exclude: OUTCOMES.exclude,
  // A conflict waits for a person to settle it.
  conflict: { ...WAITS, label: "Conflict" },
};

/** The record's exclusion reasons, by number and short label. */
const reasonsOf = (row: TableRow, criteria: ReadonlyArray<Criterion>) =>
  (row.outcome_reason ?? "")
    .split(", ")
    .filter(Boolean)
    .map((id) => numbered(criteria, id))
    .join(", ");

/** The lead's one decision cell: the outcome, its criterion, and who decided. */
const leadWords = (row: TableRow, criteria: ReadonlyArray<Criterion>) => {
  const decided = row.decisions.filter((d) => d.outcome);
  if (!row.outcome) {
    const waiting = row.decisions.filter((d) => !d.outcome).map(who);
    return { main: "Not decided", by: waiting.length ? `waiting for ${waiting.join(", ")}` : "" };
  }
  if (row.outcome === "conflict")
    return {
      // The two decisions in order; who made them is in the By column.
      main: `Conflict: ${decided.map((d) => decisionLabel(d, criteria)).join(" / ")}`,
      by: decided.map(who).join(", "),
    };
  const reasons = reasonsOf(row, criteria);
  return {
    main: `${OUTCOME_WORDS[row.outcome]}${reasons ? ` on ${reasons}` : ""}`,
    by: decided.map(who).join(", "),
  };
};

/** Whether the people's decision goes the other way from the AI's proposal: the one in the "AI
 * proposes" column. That is the quote-checked reading, and in a working topic also an exclusion
 * whose quote Kittum did not find in the record ("no quote"); those count apart (`unchecked`). */
const disagrees = (row: TableRow, kind: ScreeningTable["view"]) => {
  const outcome = kind === "lead" ? row.outcome : own(row)?.outcome;
  if (outcome !== "include" && outcome !== "exclude") return false;
  // The AI proposes include unless it reads a criterion as failing.
  const ai =
    row.ai_proposal?.outcome ??
    (row.ai_excludes === true ? "exclude" : row.ai_excludes === false ? "include" : null);
  return ai !== null && ai !== outcome;
};

const unchecked = (p: AiProposal | null | undefined) => p?.verified === false;

/** A disagreement in full words: who decided what, and what the AI proposes. An exclusion whose
 * quote Kittum did not find counts apart. */
const against = (row: TableRow, kind: ScreeningTable["view"]): string => {
  if (!disagrees(row, kind)) return "";
  const who = kind === "lead" ? "People" : "You";
  const outcome = kind === "lead" ? row.outcome : own(row)?.outcome;
  // An include with an unclear criterion is not a firm include: counted apart.
  if (outcome === "exclude")
    return tentative(row) ? `${who} exclude, the AI is unclear` : `${who} exclude, the AI includes`;
  return unchecked(row.ai_proposal)
    ? `${who} include, the AI excludes with no quote`
    : `${who} include, the AI excludes`;
};

const AGAINST_HELP =
  "The decision goes the other way from the AI's proposal: the AI's checked reading (include, " +
  "or exclude on a criterion with a quote Kittum found in the record), or, counted apart, an " +
  "exclusion whose quote Kittum did not find.";

const QUOTE_NOT_FOUND =
  "The AI reads this criterion as not met, but Kittum did not find the words it quoted in the " +
  "record. Read the record before you accept it. Bulk actions leave it out unless you add it.";

/** Whether the rows say which records are in the topic's known pool (DESIGN.md, "Complete the
 * pool"). A complete topic's reviewer screens blind to it. */
const pooled = (table: ScreeningTable | null) =>
  table?.rows.some((r) => r.in_known_pool !== null && r.in_known_pool !== undefined) ?? false;

/** The criteria the AI reads as unclear: from the reading a reviewer sees, or the lead's list. */
const unclearOf = (row: TableRow): ReadonlyArray<string> =>
  row.ai
    ? row.ai.criteria.filter((c) => c.status === "unclear").map((c) => c.criterion_id)
    : (row.ai_unclear ?? []);

/** An include the AI proposes although it reads a criterion as unclear: not a clear include. */
const tentative = (row: TableRow) =>
  row.ai_proposal?.outcome === "include" && unclearOf(row).length > 0;

/** A proposal no bulk action takes: an exclusion with no quote, or an include with an unclear
 * criterion. A person reads each of those. */
const weak = (row: TableRow) => unchecked(row.ai_proposal) || tentative(row);

/** "3 exclusions with no quote and 2 includes with an unclear criterion left out". */
const leftOut = (rows: ReadonlyArray<TableRow>) => {
  const quote = rows.filter((r) => unchecked(r.ai_proposal)).length;
  const unclear = rows.length - quote;
  const parts = [
    quote ? `${quote} ${quote === 1 ? "exclusion" : "exclusions"} with no quote` : null,
    unclear
      ? `${unclear} ${unclear === 1 ? "include" : "includes"} with an unclear criterion`
      : null,
  ].filter(Boolean);
  return `${parts.join(" and ")} left out`;
};

/** What the AI proposes, as the "AI proposes" column says it: "Exclude · 2 Pretreated not met",
 * "Include, all criteria met", "Unclear: 1 Adults", "Exclude on 2 Pretreated", or
 * "No quote: exclude on 2 Pretreated". */
const proposalLabel = (row: TableRow, criteria: ReadonlyArray<Criterion>) => {
  const p = row.ai_proposal;
  if (!p) return "";
  if (p.outcome === "include") {
    const unclear = unclearOf(row);
    if (unclear.length) return `Unclear: ${unclear.map((id) => numbered(criteria, id)).join(", ")}`;
    return row.ai || row.ai_unclear ? "Include, all criteria met" : "Include";
  }
  const on = p.reason_criterion_id ? numbered(criteria, p.reason_criterion_id) : "";
  // The qualification comes first, so it stays in view when the cell is narrow.
  if (unchecked(p)) return on ? `No quote: exclude on ${on}` : "No quote: exclude";
  return on ? `Exclude on ${on}` : "Exclude";
};

/** The proposal as the column's checklist groups it: each exact reading. */
const proposalText = (row: TableRow, criteria: ReadonlyArray<Criterion>) =>
  proposalLabel(row, criteria);

/** The proposal's group, as the chips offer it: one for each clear proposal, one per unclear
 * criterion, one for two or more unclear criteria, and the exclusions with no quote. */
const bucketOf = (row: TableRow, criteria: ReadonlyArray<Criterion>) => {
  const unclear = tentative(row) ? unclearOf(row) : [];
  if (unclear.length > 1) return "Unclear: 2 or more criteria";
  return proposalLabel(row, criteria);
};

/** A group a bulk action takes: a clear include or an exclusion with a found quote. */
const together = (bucket: string) => bucket.startsWith("Include") || bucket.startsWith("Exclude");

/** "Exclude 4 records on 1 Population, as the AI proposes": a group's action, named in full. */
const proposalAction = (p: AiProposal, n: number, criteria: ReadonlyArray<Criterion>) =>
  p.outcome === "include"
    ? `Include ${records(n)}, as the AI proposes`
    : `Exclude ${records(n)}${
        p.reason_criterion_id ? ` on ${numbered(criteria, p.reason_criterion_id)}` : ""
      }, as the AI proposes`;

/** "López-Durán 2025": a study's name, its first author and year. */
const studyOf = (r: TableRow) => studyLabel(r.authors, r.year) ?? "";

// Reference managers' type codes, as words.
const PUBLICATION_TYPES: Record<string, string> = {
  JOUR: "Journal article",
  JFULL: "Journal article",
  ABST: "Abstract",
  BOOK: "Book",
  CHAP: "Book chapter",
  CONF: "Conference paper",
  CPAPER: "Conference paper",
  ELEC: "Web page",
  GEN: "Other",
  RPRT: "Report",
  THES: "Thesis",
};
/** The record's publication types in words, each once ("JOUR" and PubMed's "Journal Article"
 * are one type). */
const publicationTypes = (r: TableRow) => {
  const seen = new Set<string>();
  return r.publication_types
    .map((t) => PUBLICATION_TYPES[t] ?? t)
    .filter((t) => {
      const key = t.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

// The workbook's columns for the ones in view. The server knows its own set; a column it
// lacks maps to the ones that hold the same facts, or is left out (a study label, a dot).
const EXPORT_AS: Record<ScreeningTable["view"], Record<string, ReadonlyArray<string>>> = {
  reviewer: { ai_proposal: ["ai", "ai_quote", "ai_rationale"] },
  lead: {
    ai_proposal: ["ai_excludes", "ai_not_met"],
    lead_decision: ["outcome", "outcome_reason", "decisions"],
  },
};
const EXPORTABLE: Record<ScreeningTable["view"], ReadonlySet<string>> = {
  reviewer: new Set(
    "ref position title abstract ai ai_quote ai_rationale decision reason comment state decided_at second_opinion authors journal year publication_types pmid doi registry_ids".split(
      " ",
    ),
  ),
  lead: new Set(
    "ref title abstract outcome outcome_reason decisions ai_excludes ai_not_met flags authors journal year publication_types pmid doi registry_ids".split(
      " ",
    ),
  ),
};

const exportColumns = (kind: ScreeningTable["view"], ids: ReadonlyArray<string>) => {
  const out = new Set(
    ids.flatMap((id) => EXPORT_AS[kind][id] ?? [id]).filter((id) => EXPORTABLE[kind].has(id)),
  );
  return out.size ? [...out] : ["ref", "title"];
};

const firstAuthor = (authors: ReadonlyArray<string>) =>
  authors.length > 1 ? `${authors[0]} et al.` : (authors[0] ?? "");

const aiColumns = (
  kind: ScreeningTable["view"],
  criteria: ReadonlyArray<Criterion>,
  readWith: string | null,
): Column<TableRow>[] => [
  {
    id: "ai_proposal",
    // An older version's reading says so in the header, which stays in view while scrolling.
    header: readWith ? `AI proposes (version ${readWith})` : "AI proposes",
    width: 380,
    grow: 1,
    text: (r) => proposalText(r, criteria),
    render: (r) => <ProposalCell row={r} criteria={criteria} />,
  },
  {
    id: "ai_group",
    header: "AI proposal group",
    width: 240,
    text: (r) => (r.ai_proposal ? bucketOf(r, criteria) : ""),
  },
  {
    id: "ai_disagrees",
    header: "Against the AI",
    width: 136,
    text: (r) => against(r, kind),
    render: (r) => (disagrees(r, kind) ? <DisagreeFlag /> : null),
  },
  {
    id: "known_include",
    header: "Known include",
    short: "Known",
    width: 64,
    compact: true,
    text: (r) => (r.known_include ? "Known include" : ""),
    render: (r) => (r.known_include ? <Dot label="Known include" /> : null),
  },
];

function columnsFor(
  kind: ScreeningTable["view"],
  criteria: ReadonlyArray<Criterion>,
  pool: boolean,
  /** The protocol version the AI read with, when it is older than the published one. */
  readWith: string | null = null,
): ReadonlyArray<Column<TableRow>> {
  const common: Column<TableRow>[] = [
    { id: "title", header: "Title", width: 300, grow: 3, text: (r) => r.title },
    ...(pool
      ? [
          {
            id: "in_known_pool",
            header: "In the known pool",
            short: "Pool",
            width: 50,
            compact: true,
            text: (r: TableRow) => (r.in_known_pool ? "Yes" : "No"),
            render: (r: TableRow) =>
              r.in_known_pool ? <Dot label="Yes" /> : <Dot off label="No" />,
          },
        ]
      : []),
    {
      id: "authors",
      header: "Authors",
      width: 170,
      text: (r) => r.authors.join("; "),
      values: (r) => r.authors,
      render: (r) => firstAuthor(r.authors),
    },
    { id: "study", header: "Study", width: 170, text: studyOf },
    { id: "journal", header: "Journal", width: 160, text: (r) => r.journal ?? "" },
    {
      id: "year",
      header: "Year",
      width: 68,
      compact: true,
      align: "right",
      text: (r) => (r.year ? String(r.year) : ""),
      sortBy: (r) => r.year ?? null,
    },
    {
      id: "publication_types",
      header: "Publication types",
      width: 170,
      text: (r) => publicationTypes(r).join("; "),
      values: publicationTypes,
    },
    { id: "pmid", header: "PMID", width: 90, text: (r) => r.pmid ?? "" },
    { id: "doi", header: "DOI", width: 170, text: (r) => r.doi ?? "" },
    {
      id: "registry_ids",
      header: "Registry IDs",
      width: 120,
      text: (r) => r.registry_ids.join("; "),
      values: (r) => r.registry_ids,
    },
    { id: "abstract", header: "Abstract", width: 360, text: (r) => r.abstract },
    { id: "ref", header: "Ref", width: 120, text: (r) => r.ref },
  ];
  if (kind === "reviewer") {
    return [
      {
        id: "position",
        header: "#",
        width: 60,
        align: "right",
        text: (r) => String(r.position ?? ""),
        sortBy: (r) => r.position ?? null,
      },
      ...common,
      {
        id: "decision",
        header: "Your decision",
        width: 130,
        text: (r) => decisionText(own(r), criteria),
        values: (r) => [
          own(r)?.outcome ? OUTCOMES[own(r)?.outcome as Outcome].label : "Not decided",
        ],
        // A disagreement has its own ≠ AI column.
        render: (r) => <DecisionCell decision={own(r)} criteria={criteria} />,
      },
      {
        id: "reason",
        header: "Reason",
        width: 150,
        text: (r) => numbered(criteria, own(r)?.reason_criterion_id),
      },
      { id: "comment", header: "Comment", width: 160, text: (r) => own(r)?.comment ?? "" },
      {
        id: "decided_at",
        header: "Decided at",
        width: 150,
        text: (r) => {
          const at = own(r)?.decided_at;
          return at ? formatDateTime(at) : "";
        },
        sortBy: (r) => own(r)?.decided_at ?? null,
      },
      {
        id: "ai",
        header: "AI reading",
        width: 200,
        grow: 1,
        text: (r) => {
          if (r.reveal)
            return `${VERDICTS[r.reveal.status].label} on ${numbered(criteria, r.reveal.criterion_id)}`;
          // A stage that reveals `before` (mode S) shows the reading before the decision.
          if (!r.ai) return "";
          const notMet = r.ai.criteria.filter((c) => c.status === "not_met");
          return notMet.length
            ? `Not met: ${notMet.map((c) => numbered(criteria, c.criterion_id)).join(", ")}`
            : "No criterion fails";
        },
      },
      ...aiColumns(kind, criteria, readWith),
      {
        id: "second_opinion",
        header: "Second opinion",
        width: 170,
        text: (r) =>
          r.second_opinion
            ? `Asked of you on ${OUTCOMES[r.second_opinion.outcome].label}`
            : own(r)?.second_opinion
              ? "You asked for one"
              : "",
      },
    ];
  }
  return [
    ...common,
    {
      id: "lead_decision",
      header: "Decision",
      width: 280,
      text: (r) => {
        const { main, by } = leadWords(r, criteria);
        return by ? `${main}, by ${by}` : main;
      },
      // Grouped by outcome and criterion: with "Against the AI" and "Decided by" on, the chips
      // show a pattern such as one person excluding on one criterion where the AI includes.
      values: (r) => [leadWords(r, criteria).main],
      render: (r) => <LeadDecisionCell row={r} criteria={criteria} />,
    },
    {
      id: "outcome",
      header: "Outcome",
      width: 100,
      text: (r) => (r.outcome ? OUTCOME_WORDS[r.outcome] : ""),
    },
    {
      id: "outcome_reason",
      header: "Exclusion reason",
      width: 170,
      text: (r) => reasonsOf(r, criteria),
    },
    {
      id: "decisions",
      header: "Decided by",
      short: "By",
      width: 150,
      // A second opinion counts as its own entry, so the counts add up to the decisions.
      text: (r) =>
        r.decisions
          .filter((d) => d.outcome)
          .map(who)
          .join(", "),
      values: (r) => r.decisions.filter((d) => d.outcome).map(who),
      // Two people do not fit; the cell's hover names them.
      render: (r) => {
        const names = r.decisions.filter((d) => d.outcome).map(who);
        return names.length > 1 ? `${names.length} people` : (names[0] ?? "");
      },
    },
    {
      id: "ai_excludes",
      header: "AI excludes",
      width: 100,
      text: (r) =>
        r.ai_excludes === null || r.ai_excludes === undefined ? "" : r.ai_excludes ? "Yes" : "No",
    },
    {
      id: "ai_not_met",
      header: "AI reads as not met",
      width: 170,
      text: (r) => (r.ai_not_met ?? []).map((id) => numbered(criteria, id)).join(", "),
      values: (r) => (r.ai_not_met ?? []).map((id) => numbered(criteria, id)),
    },
    ...aiColumns(kind, criteria, readWith),
    {
      id: "flags",
      header: "Flags",
      width: 110,
      text: (r) => (r.flags ?? []).map((f) => FLAG_WORDS[f] ?? f).join(", "),
      values: (r) => (r.flags ?? []).map((f) => FLAG_WORDS[f] ?? f),
    },
  ];
}

const FLAG_WORDS: Record<string, string> = {
  sentinel: "Sentinel",
  audit: "Audit sample",
  rescreen: "Rescreen",
};

const DEFAULT_COLUMNS = {
  // The rest (authors, journal, publication types, IDs) are a click away in Columns, and in the
  // selected record's pane.
  // The study ("López-Durán 2025") holds the year; Year is in Columns.
  reviewer: [
    "title",
    "study",
    "in_known_pool",
    "decision",
    "ai_disagrees",
    "ai",
    "ai_proposal",
    "known_include",
    "second_opinion",
  ],
  lead: [
    "title",
    "study",
    "in_known_pool",
    "lead_decision",
    "ai_disagrees",
    "decisions",
    "ai_proposal",
    "known_include",
    "flags",
  ],
} as const;

/**
 * The columns a table opens with: the defaults for the view, without columns that are empty in
 * every row. What the AI says stays: its readings arrive while the table is open.
 */
const initial = (table: ScreeningTable, columns: ReadonlyArray<Column<TableRow>>): ViewState => {
  const working = table.documentation === "working";
  const keep = new Set([
    "title",
    "decision",
    "lead_decision",
    // What the AI says stays, for its readings arrive while the table is open.
    ...(working || table.view === "lead" ? ["ai_proposal"] : ["ai"]),
  ]);
  const byId = new Map(columns.map((c) => [c.id, c]));
  const shown = DEFAULT_COLUMNS[table.view].filter((id) => {
    const column = byId.get(id);
    if (!column) return false;
    // A working topic shows what the AI proposes; the reading as such only where it differs.
    if (id === "ai" && working) return false;
    if (keep.has(id)) return true;
    // A column that says the same in every row (empty, or one year for all) tells nothing
    // about any row; it stays in Columns.
    const first = table.rows[0] ? column.text(table.rows[0]) : "";
    return table.rows.some((r) => column.text(r) !== first);
  });
  return {
    columns: shown,
    widths: {},
    // The lead's table opens with the records that go against the AI first.
    sort:
      table.view === "lead" && shown.includes("ai_disagrees")
        ? [{ id: "ai_disagrees", desc: false }]
        : [],
    filters: {},
    query: "",
  };
};

/** A stored view, without columns this table does not have. */
const fit = (state: ViewState, columns: ReadonlyArray<Column<TableRow>>): ViewState => {
  const ids = new Set(columns.map((c) => c.id));
  return {
    ...state,
    columns: state.columns.filter((id) => ids.has(id)),
    sort: state.sort.filter((s) => ids.has(s.id)),
    filters: Object.fromEntries(Object.entries(state.filters).filter(([id]) => ids.has(id))),
  };
};

/** The quick filters above the grid: a column's values as chips, each with its count. */
/** The criterion a chip group's value names, for its full rule in a hover. */
const reasonFor = (column: string, r: TableRow) =>
  column === "ai_proposal" || column === "ai_group"
    ? tentative(r)
      ? unclearOf(r)[0]
      : r.ai_proposal?.reason_criterion_id
    : column === "decision"
      ? own(r)?.reason_criterion_id
      : column === "lead_decision"
        ? r.outcome_reason?.split(", ")[0]
        : null;

/** A chip group's value as the selection bar names it: "where the AI proposes Include". */
const GROUP_PHRASES: Record<string, (value: string) => string> = {
  ai_proposal: (v) => `where the AI proposes ${v}`,
  ai_group: (v) => `in “${v}”`,
  decision: (v) => (v === "Not decided" ? "still to decide" : `with your decision ${v}`),
  lead_decision: (v) => `with the outcome ${v}`,
  decisions: (v) => `decided by ${v}`,
  ai_disagrees: (v) => `where ${v.charAt(0).toLowerCase()}${v.slice(1)}`,
};

interface ChipGroup {
  readonly key: string;
  readonly column: string;
  readonly label: string;
  /** A "?" hover that says what the group is for. */
  readonly help?: string;
  /** Only these of the column's values. */
  readonly keep?: (value: string) => boolean;
  /** Behind "More filters", unless one of its chips is on. */
  readonly more?: boolean;
}

const chipGroups = (table: ScreeningTable): ReadonlyArray<ChipGroup> => {
  if (table.view === "reviewer")
    return [
      ...(table.documentation === "working" || table.rows.some((r) => r.ai_proposal)
        ? [
            {
              key: "together",
              column: "ai_group",
              label: "Decide together",
              help: "The AI's clear proposals: an include with every criterion met, or an exclusion with a quote Kittum found in the record. Pick one, check a few records, and decide the group in one step.",
              keep: (v: string) => v !== EMPTY && together(v),
            },
            {
              key: "each",
              column: "ai_group",
              label: "Read each",
              help: "Proposals a person reads one by one: an include with a criterion the AI reads as unclear, or an exclusion whose quote Kittum did not find.",
              keep: (v: string) => v !== EMPTY && !together(v),
            },
          ]
        : []),
      { key: "decision", column: "decision", label: "Your decision", more: true },
    ];
  return [
    { key: "against", column: "ai_disagrees", label: "Against the AI", help: AGAINST_HELP },
    { key: "outcome", column: "lead_decision", label: "Decision", more: true },
    { key: "by", column: "decisions", label: "Decided by", more: true },
  ];
};

const only = (filter: Filter | undefined) =>
  filter && !filter.contains.trim() && filter.values?.length === 1 ? filter.values[0] : null;

const stageKey = (s: StageInfo) => s.stage_id;

export function ScreeningTableScreen() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, protocol, criteriaFor, scopeLabel, seesLeadData, labels, scopes } =
    useProject();
  const stages = useMemo(
    () =>
      project.stages.filter(
        (s) => seesLeadData || s.screeners.includes(me.actor_id) || s.auditor_id === me.actor_id,
      ),
    [project.stages, seesLeadData, me.actor_id],
  );
  const [chosen, setChosen] = useState<string | null>(() =>
    stages[0] ? stageKey(stages[0]) : null,
  );
  const stage = stages.find((s) => stageKey(s) === chosen) ?? stages[0] ?? null;

  const caller = useMemo(
    () => ({ projectId: project.id, as: me.actor_id }),
    [project.id, me.actor_id],
  );
  const criteria = useMemo(
    () => (stage ? criteriaFor(stage.stage, stage.scope_id) : []),
    [criteriaFor, stage],
  );
  if (!stage) {
    return (
      <EmptyState
        title="No records to list"
        actions={
          <Link
            to="/p/$projectId/progress"
            params={{ projectId: project.id }}
            className="text-petrol hover:underline"
          >
            See the review&rsquo;s progress
          </Link>
        }
      >
        The table lists the records of a screening stage: a reviewer's own, or every record for the
        methods lead. No stage is open for you yet.
      </EmptyState>
    );
  }
  return (
    <StageTable
      key={stageKey(stage)}
      stage={stage}
      stages={stages}
      onStage={setChosen}
      workbench={workbench}
      caller={caller}
      criteria={criteria}
      labels={labels}
      published={
        protocol ? { hash: protocol.content_hash, label: protocol.protocol.version_label } : null
      }
      scopeName={scopeLabel(stage.scope_id)}
      // The question by its number where there are several; its words go in a hover.
      describeStage={(s) => {
        const n = scopes.findIndex((q) => q.id === s.scope_id);
        return scopes.length > 1 && n >= 0
          ? `${STAGE_WORDS[s.stage]}, question ${n + 1}`
          : STAGE_WORDS[s.stage];
      }}
      scopeHint={(s) => `${labels.scope}: ${scopeLabel(s.scope_id)}`}
    />
  );
}

function StageTable({
  stage,
  stages,
  onStage,
  workbench,
  caller,
  criteria,
  labels,
  published,
  scopeName,
  describeStage,
  scopeHint,
}: {
  stage: StageInfo;
  stages: ReadonlyArray<StageInfo>;
  onStage: (key: string) => void;
  workbench: Workbench;
  caller: Caller;
  criteria: ReadonlyArray<Criterion>;
  labels: Record<string, string>;
  /** The published protocol version, which a lead may re-judge the stage with. */
  published: { readonly hash: string; readonly label: string } | null;
  scopeName: string;
  describeStage: (s: StageInfo) => string;
  scopeHint: (s: StageInfo) => string;
}) {
  const navigate = useNavigate();
  const [table, setTable] = useState<ScreeningTable | null>(null);
  const [first, setFirst] = useState<ViewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  // Rows marked for a bulk decision (working topics), and where a Shift range starts.
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [bulkArmed, setBulkArmed] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  // Filters beyond the main chips (your decision; the lead's outcome and screener).
  const [moreFilters, setMoreFilters] = useState(false);
  const [reload, setReload] = useState(0);
  // Mode S, key f: the next decision on this row asks a colleague, with this comment.
  const [asking, setAsking] = useState<{
    ref: string;
    comment: string;
    typing: boolean;
  } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const shown = useRef<{
    ref: string | null;
    at: string;
    firstKey: string | null;
    reveal: string | null;
  }>({ ref: null, at: "", firstKey: null, reveal: null });

  useEffect(() => {
    let live = true;
    run(workbench.screeningTable({ ...caller, scopeId: stage.scope_id, stage: stage.stage }))
      .then((t) => {
        if (!live) return;
        setTable(t);
        // The defaults are fixed when the table first loads, so a reload does not move columns.
        setFirst((f) => f ?? initial(t, columnsFor(t.view, criteria, pooled(t))));
      })
      .catch(
        (e: unknown) =>
          live && setError(e instanceof WorkbenchError ? e.message : "The table could not load."),
      );
    return () => {
      live = false;
    };
  }, [workbench, caller, stage.scope_id, stage.stage, reload, criteria]);

  const kind = table?.view ?? "reviewer";
  const loaded = table !== null;
  const pool = pooled(table);
  // The version the AI read with, where the lead may re-judge with a newer one.
  const readWith =
    kind === "lead" && published && table && published.hash !== table.protocol_hash
      ? (table.protocol_version_label ?? "earlier")
      : null;
  const columns = useMemo(
    () => (loaded ? columnsFor(kind, criteria, pool, readWith) : []),
    [loaded, kind, criteria, pool, readWith],
  );

  // Views are kept per reviewer and stage, in this browser.
  const [views, setViews] = useState<SavedViews>(() =>
    loadViews(caller.projectId, caller.as, stage.stage_id),
  );
  // The view the table opens with: where the reviewer left it, until they change it.
  const [edited, setState] = useState<ViewState | null>(null);
  const [lastView] = useState(() => views.last);
  const defaults = first;
  const opening = useMemo(
    () => (loaded ? (lastView ? fit(lastView, columns) : defaults) : null),
    [loaded, lastView, columns, defaults],
  );
  const state = edited ?? opening;
  useEffect(() => {
    if (state) storeViews(caller.projectId, caller.as, stage.stage_id, { ...views, last: state });
  }, [state, views, caller.projectId, caller.as, stage.stage_id]);
  const [viewName, setViewName] = useState<string | null>(null);
  const onState = useCallback(
    (update: (s: ViewState) => ViewState) => {
      setState((s) => {
        const current = s ?? opening;
        return current ? update(current) : s;
      });
      setViewName(null);
    },
    [opening],
  );

  const query = useDeferredValue(state?.query ?? "");
  // Titles and abstracts never change under a row, so each is prepared once.
  const [hays] = useState(() => new Map<string, Haystack>());
  const hay = useCallback(
    (row: TableRow) => {
      let h = hays.get(row.ref);
      if (!h) {
        h = haystack([row.title, row.authors.join(" "), row.journal ?? ""], row.abstract);
        hays.set(row.ref, h);
      }
      return h;
    },
    [hays],
  );
  const filters = state?.filters;
  const sort = state?.sort;
  const match = useMemo(() => matcher(query), [query]);
  // A decision the AI's reading interrupted stays on screen until it is kept or changed, even
  // if the filters no longer match it.
  const held =
    table?.rows.find((r) => r.ref === selectedRef && own(r)?.state === "awaiting_final")?.ref ??
    null;
  const rows = useMemo(
    () =>
      table && filters && sort
        ? view(
            table.rows,
            columns,
            { columns: [], widths: {}, filters, sort, query },
            { match, hay, keep: (r) => r.ref === held },
          )
        : [],
    [table, columns, filters, sort, query, match, hay, held],
  );
  const selected = useMemo(() => {
    const index = rows.findIndex((r) => r.ref === selectedRef);
    return index >= 0 ? index : null;
  }, [rows, selectedRef]);
  const row = selected === null ? null : (rows[selected] ?? null);

  // The chips' counts: each group's values among the rows every other filter keeps.
  const groups = useMemo(() => (table ? chipGroups(table) : []), [table]);
  const chips = useMemo(() => {
    if (!table || !filters) return [];
    return groups.flatMap((group) => {
      const column = columns.find((c) => c.id === group.column);
      if (!column) return [];
      const others = { ...filters };
      delete others[group.column];
      const kept = view(
        table.rows,
        columns,
        { columns: [], widths: {}, filters: others, sort: [], query },
        { match, hay },
      );
      // Each value's count, and the full rule of the criterion it names, for a hover.
      const members = new Map<string, { count: number; rule: string | undefined }>();
      for (const r of kept)
        for (const v of new Set(valuesOf(column, r))) {
          if (v === EMPTY && group.column === "ai_disagrees") continue;
          if (group.keep && !group.keep(v)) continue;
          const seen = members.get(v);
          members.set(v, {
            count: (seen?.count ?? 0) + 1,
            rule: seen?.rule ?? ruleOf(criteria, reasonFor(group.column, r)),
          });
        }
      // Includes before exclusions; single unclear criteria before the bucket of several; the
      // exclusions with no quote last, then the empty one.
      const rank = (v: string) =>
        v === EMPTY
          ? 4
          : v.startsWith("No quote") || v.endsWith("no quote")
            ? 3
            : v.startsWith("Unclear: 2 or more")
              ? 2
              : v.startsWith("Exclude")
                ? 1
                : 0;
      const values = [...members.entries()].sort(
        ([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }),
      );
      // Before the first decision the row would hold one chip, "Not decided", for every record.
      if (group.key === "decision" && values.every(([v]) => v === "Not decided")) return [];
      const on = only(filters[group.column]);
      return [{ group, column, values, on: on && (!group.keep || group.keep(on)) ? on : null }];
    });
  }, [table, filters, groups, columns, query, match, hay, criteria]);

  const bulkable =
    kind === "reviewer" && stage.stage === "title_abstract" && table?.documentation === "working";
  // Rows can be marked where something acts on them: a bulk decision, or the lead's export.
  const selectable = bulkable || kind === "lead";

  const select = useCallback(
    (index: number, mods?: { readonly shift: boolean; readonly toggle: boolean }) => {
      const at = Math.max(0, Math.min(rows.length - 1, index));
      const next = rows[at];
      if (!next) return;
      if (selectable && mods?.shift) {
        // A range from the anchor (or the selected row) to this one, added to the marks.
        const from = rows.findIndex((r) => r.ref === (anchor ?? selectedRef ?? next.ref));
        const [lo, hi] = from < 0 ? [at, at] : [Math.min(from, at), Math.max(from, at)];
        setMarked((m) => new Set([...m, ...rows.slice(lo, hi + 1).map((r) => r.ref)]));
        if (!anchor) setAnchor(rows[from]?.ref ?? next.ref);
      } else if (selectable && mods?.toggle) {
        setMarked((m) => {
          const copy = new Set(m);
          if (copy.has(next.ref)) copy.delete(next.ref);
          else copy.add(next.ref);
          return copy;
        });
        setAnchor(next.ref);
      } else if (mods) {
        // A plain click opens the row; the marks stay, as ticked checkboxes do.
        setAnchor(next.ref);
      }
      setSelectedRef(next.ref);
      setArmed(false);
      setBulkArmed(false);
      if (shown.current.ref !== next.ref)
        shown.current = {
          ref: next.ref,
          at: new Date().toISOString(),
          firstKey: null,
          // When the AI's reading went on screen: a reveal, or the reading a stage shows before.
          reveal: next.reveal || next.ai ? new Date().toISOString() : null,
        };
    },
    [rows, selectable, anchor, selectedRef],
  );

  /** A row's checkbox: marks or unmarks it; with Shift, every row from the last one ticked. */
  const mark = (index: number, shift: boolean) => {
    const target = rows[index];
    if (!target) return;
    const from = anchor ? rows.findIndex((r) => r.ref === anchor) : -1;
    if (shift && from >= 0) {
      const [lo, hi] = [Math.min(from, index), Math.max(from, index)];
      const on = !marked.has(target.ref);
      setMarked((m) => {
        const copy = new Set(m);
        for (const r of rows.slice(lo, hi + 1)) {
          if (on) copy.add(r.ref);
          else copy.delete(r.ref);
        }
        return copy;
      });
    } else
      setMarked((m) => {
        const copy = new Set(m);
        if (copy.has(target.ref)) copy.delete(target.ref);
        else copy.add(target.ref);
        return copy;
      });
    setAnchor(target.ref);
  };

  /** Rows a bulk decision can take: the reviewer's own, not yet decided, no second opinions (a
   * consult is decided on its own). */
  const waiting = (r: TableRow) =>
    own(r)?.state === "pending" && !r.second_opinion && !!r.assignment_id && !!r.etag;
  const markedRows = useMemo(
    () => (table ? table.rows.filter((r) => marked.has(r.ref)) : []),
    [table, marked],
  );
  const decidable = markedRows.filter(waiting);
  // "Accept the AI's proposals" takes the clear ones; an exclusion with no quote or an include
  // with an unclear criterion only when added on purpose.
  const withProposal = decidable.filter((r) => r.ai_proposal && !weak(r));
  const markedWeak = decidable.filter(weak);

  // A group of the AI's proposals picked with a chip: the bar names it and its one action.
  const aiGroup = bulkable ? only(filters?.ai_group) : null;
  const groupRows = aiGroup && aiGroup !== EMPTY ? rows.filter(waiting) : [];
  const groupRow =
    aiGroup && aiGroup !== EMPTY
      ? (rows.find((r) => r.ai_proposal && bucketOf(r, criteria) === aiGroup) ?? null)
      : null;
  /** A row standing for the AI's proposal, if every marked record waiting for a decision has the
   * same one (an unchecked or unclear one is never the same as a clear one). */
  const common = (targets: ReadonlyArray<TableRow>) => {
    const head = targets[0];
    return head?.ai_proposal &&
      targets.every(
        (r) => r.ai_proposal && proposalText(r, criteria) === proposalText(head, criteria),
      )
      ? head
      : null;
  };
  const shared = decidable.length ? common(decidable) : null;
  // The named action takes only a clear proposal.
  const markedProposal = shared && !weak(shared) ? (shared.ai_proposal ?? null) : null;

  const bulkDecide = async (
    action: BulkAction,
    reason: string | null = null,
    chosen?: ReadonlyArray<TableRow>,
  ) => {
    if (!bulkable || busy || !table || !state) return;
    const targets = chosen ?? (action === "accept_ai" ? withProposal : decidable);
    if (targets.length === 0) {
      setNotice(
        action === "accept_ai"
          ? "None of the selected records has an AI proposal with a found quote."
          : "None of the selected records is waiting for a decision.",
      );
      return;
    }
    const now = new Date().toISOString();
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const result = await run(
        workbench.bulkDecide({
          ...caller,
          stageId: stage.stage_id,
          rows: targets.map((r) => ({
            assignment_id: r.assignment_id as string,
            expected_etag: r.etag as string,
            // The proposal on screen: if a re-judge changed it since, the server refuses.
            ...(action === "accept_ai" ? { proposal: r.ai_proposal ?? null } : {}),
          })),
          action,
          reasonCriterionId: action === "exclude" ? reason : null,
          filter: describe(columns, { ...state, query }, "All rows, in queue order"),
          timing: {
            shown_at: shown.current.at || now,
            first_key_at: now,
            decided_at: now,
            reveal_shown_at: null,
          },
        }),
      );
      const what =
        action === "include"
          ? "Included"
          : action === "exclude"
            ? `Excluded on ${numbered(criteria, reason)}`
            : "Gave the AI's proposals to";
      setMarked(new Set());
      setAnchor(null);
      setReload((n) => n + 1);
      setNotice(
        `${what} ${records(targets.length)}, one decision each and one batch in the ledger.` +
          (result.awaiting_final
            ? ` ${result.awaiting_final} wait for a final decision: the AI reads them differently.`
            : ""),
      );
    } catch (e) {
      setError(e instanceof WorkbenchError ? e.message : "The bulk decision was not recorded.");
    } finally {
      setBusy(false);
    }
  };

  // The lead's rows the AI has not read with the stage's version yet: unread ones, and after a
  // re-judge those still on the old version. The table is re-read until there are none.
  const renewing =
    kind === "lead" && table
      ? table.rows.filter((r) => r.ai_protocol_hash !== table.protocol_hash).length
      : 0;
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  usePoll(renewing > 0, refresh, 4000);

  const [rejudging, setRejudging] = useState(false);
  const rejudge = async () => {
    if (!published || rejudging) return;
    setRejudging(true);
    setError(null);
    try {
      await run(workbench.rejudgeStage({ ...caller, stageId: stage.stage_id }));
      setNotice(
        `The AI reads the stage again with version ${published.label}. Its new readings replace the old ones as they arrive; people's decisions stay.`,
      );
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof WorkbenchError ? e.message : "The stage was not re-judged.");
    } finally {
      setRejudging(false);
    }
  };

  const canDecide = kind === "reviewer" && stage.stage === "title_abstract";

  const patch = (ref: string, change: (r: TableRow) => TableRow) =>
    setTable((t) => (t ? { ...t, rows: t.rows.map((r) => (r.ref === ref ? change(r) : r)) } : t));

  const decide = async (target: TableRow, outcome: Outcome, reason: string | null = null) => {
    if (!canDecide || busy || !target.assignment_id || !target.etag) return;
    const current = own(target);
    // Mode S: a decision after f asks a colleague, with what the reviewer is unsure about.
    const ask = asking?.ref === target.ref && !asking.typing ? asking : null;
    if (ask) setAsking(null);
    const decision: Decision = {
      outcome,
      reason_criterion_id: outcome === "exclude" ? reason : null,
      evidence_anchor_ids: [],
      comment: ask ? ask.comment.trim() || null : (current?.comment ?? null),
      ...(ask ? { second_opinion: true } : {}),
    };
    const now = new Date().toISOString();
    const timing = shown.current.ref === target.ref ? shown.current : null;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      let etag = target.etag;
      let phase: "provisional" | "final" =
        current?.state === "awaiting_final" ? "final" : "provisional";
      if (current?.state === "decided") {
        // A decided row: take the decision back first, as the queue does with a reopened record.
        etag = (
          await run(
            workbench.undo({ ...caller, assignmentId: target.assignment_id, expectedEtag: etag }),
          )
        ).etag;
        phase = "provisional";
        // The take-back stands even if the new decision fails: the row is pending again.
        const pending = etag;
        patch(target.ref, (r) => ({ ...r, etag: pending, decisions: [{ state: "pending" }] }));
      }
      const result = await run(
        workbench.decide({
          ...caller,
          assignmentId: target.assignment_id,
          decision,
          phase,
          expectedEtag: etag,
          timing: {
            shown_at: timing?.at ?? now,
            first_key_at: timing?.firstKey ?? now,
            decided_at: now,
            reveal_shown_at:
              phase === "final" || (target.ai && !target.reveal) ? (timing?.reveal ?? now) : null,
          },
        }),
      );
      const revealed = result.phase === "provisional" && result.reveal;
      patch(target.ref, (r) => ({
        ...r,
        etag: result.etag,
        reveal: result.reveal ?? r.reveal ?? null,
        decisions: [
          {
            state: revealed ? "awaiting_final" : "decided",
            outcome: decision.outcome,
            reason_criterion_id: decision.reason_criterion_id,
            comment: decision.comment,
            decided_at: now,
            second_opinion: decision.second_opinion ?? false,
          },
        ],
      }));
      if (revealed) {
        shown.current = { ...shown.current, reveal: new Date().toISOString() };
        setNotice("The AI reads this record differently. Keep yours with Space, or change it.");
      } else if (selected !== null && selected + 1 < rows.length) {
        select(selected + 1);
      }
    } catch (e) {
      setError(
        e instanceof WorkbenchError ? e.message : "The decision was not recorded. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const takeBack = async (target: TableRow) => {
    const current = own(target);
    if (!canDecide || busy || !target.assignment_id || !target.etag || !current) return;
    if (current.state !== "decided") {
      setNotice(
        current.state === "awaiting_final"
          ? "The AI's reading is already shown. Keep your decision with Space, or change it."
          : "This record has no decision to take back.",
      );
      return;
    }
    setBusy(true);
    try {
      const { etag } = await run(
        workbench.undo({
          ...caller,
          assignmentId: target.assignment_id,
          expectedEtag: target.etag,
        }),
      );
      patch(target.ref, (r) => ({ ...r, etag, decisions: [{ state: "pending" }] }));
      setNotice("Decision taken back. The record is in your queue again.");
    } catch (e) {
      setError(e instanceof WorkbenchError ? e.message : "The decision was not taken back.");
    } finally {
      setBusy(false);
    }
  };

  /** Enter: the record in the keyboard queue, which starts there and keeps its own order. */
  const open = (target: TableRow) => {
    if (kind !== "reviewer") {
      setNotice("The queue is for the stage's reviewers. The methods lead reads the table.");
      return;
    }
    if (own(target)?.state === "decided") {
      setNotice("You decided this record. Change the decision here with i, e, or u.");
      return;
    }
    if (stage.stage !== "title_abstract") {
      setNotice("The full-text screen opens your next full text; it cannot open this one yet.");
      return;
    }
    const before = table?.rows.find((r) => r.position === (target.position ?? 0) - 1);
    void navigate({
      to: "/p/$projectId/screening/title-abstract",
      params: { projectId: caller.projectId },
      search: {
        scope: stage.scope_id,
        ...(before?.assignment_id ? { after: before.assignment_id } : {}),
      },
    });
  };

  const askSecondOpinion = (target: TableRow) => {
    if (target.second_opinion)
      setNotice("This is a second opinion. Your decision settles the record.");
    else setAsking({ ref: target.ref, comment: asking?.comment ?? "", typing: true });
  };

  const markAll = () => {
    setMarked(new Set(rows.map((r) => r.ref)));
    setNotice(`Selected all ${rows.length} rows in view.`);
  };

  const [exporting, setExporting] = useState<"view" | "stage" | "marked" | null>(null);
  const exportRows = async (which: "view" | "stage" | "marked", named = "") => {
    if (!table || !state) return;
    setExporting(which);
    setError(null);
    try {
      const bytes = await run(
        workbench.workingExport({
          ...caller,
          scopeId: stage.scope_id,
          stage: stage.stage,
          view:
            which === "view"
              ? {
                  refs: rows.map((r) => r.ref),
                  columns: exportColumns(kind, state.columns),
                  description: describe(
                    columns,
                    { ...state, query },
                    kind === "reviewer" ? "All rows, in queue order" : "All rows",
                  ),
                }
              : which === "marked"
                ? {
                    refs: markedRows.map((r) => r.ref),
                    columns: exportColumns(kind, state.columns),
                    description: `${markedRows.length} selected rows${named ? `: ${named}` : ""}`,
                  }
                : null,
        }),
      );
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `kittum-working-${stage.scope_id}-${stage.stage}${which === "stage" ? "" : `-${which}`}.xlsx`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice(
        `Exported ${
          which === "view"
            ? `${rows.length} rows in view`
            : which === "marked"
              ? `${markedRows.length} selected rows`
              : "the stage"
        }. The ledger records the export.`,
      );
    } catch (e) {
      setError(e instanceof WorkbenchError ? e.message : "The export failed.");
    } finally {
      setExporting(null);
    }
  };

  useKeys((event) => {
    if (!table || !state) return false;
    const key = event.key;
    // A held key repeats: it may move the selection, never decide record after record.
    if (event.repeat && !/^(Arrow|Page)/.test(key)) return true;
    if (shown.current.ref === row?.ref && !shown.current.firstKey && /^[iue1-9 ]$/.test(key))
      shown.current = { ...shown.current, firstKey: new Date().toISOString() };
    if (bulkArmed) {
      setBulkArmed(false);
      // Shift may still be held: read the digit from the key's position.
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1] ?? (/^[1-9]$/.test(key) ? key : null);
      if (digit) {
        const criterion = byKey(criteria, digit);
        if (criterion) void bulkDecide("exclude", criterion.id);
        else setNotice(`There is no criterion ${digit}.`);
        return true;
      }
      if (key === "Escape" || key === "E") return true;
    }
    if (bulkable && marked.size > 0) {
      switch (key) {
        case "I":
          void bulkDecide("include");
          return true;
        case "E":
          setBulkArmed(true);
          setNotice("Exclude the selected records on which criterion? Press its number.");
          return true;
        case "A":
          void bulkDecide("accept_ai");
          return true;
      }
    }
    if (armed) {
      setArmed(false);
      if (/^[1-9]$/.test(key) && row) {
        const criterion = byKey(criteria, key);
        if (criterion) void decide(row, "exclude", criterion.id);
        else
          setNotice(
            `There is no criterion ${key}. Press e, then ${criteria.map((c) => keyOf(criteria, c.id)).join(", ")}.`,
          );
        return true;
      }
      if (key === "Escape" || key === "e") return true;
    }
    if (selectable && event.shiftKey && (key === "ArrowDown" || key === "ArrowUp")) {
      // Shift+↑/↓ marks rows from the anchor, as a spreadsheet extends a selection.
      const from = selected ?? 0;
      if (selected !== null && marked.size === 0) setAnchor(rows[from]?.ref ?? null);
      select(selected === null ? 0 : from + (key === "ArrowDown" ? 1 : -1), {
        shift: true,
        toggle: false,
      });
      return true;
    }
    switch (key) {
      case "ArrowDown":
      case "j":
        select(selected === null ? 0 : selected + 1);
        return true;
      case "ArrowUp":
      case "k":
        select(selected === null ? 0 : selected - 1);
        return true;
      case "a":
        if (!selectable) return false;
        markAll();
        return true;
      case "p":
        if (kind === "lead" || table.documentation === "working") {
          setPromptOpen((o) => !o);
          return true;
        }
        return false;
      case "PageDown":
        select((selected ?? 0) + PAGE);
        return true;
      case "PageUp":
        select((selected ?? 0) - PAGE);
        return true;
      case "Home":
        select(0);
        return true;
      case "End":
        select(rows.length - 1);
        return true;
      case "/":
        search.current?.focus();
        search.current?.select();
        return true;
      case "Enter":
        if (row) open(row);
        return true;
      case "Escape":
        setNotice(null);
        setAsking(null);
        setMarked(new Set());
        setAnchor(null);
        return true;
    }
    if (!canDecide || !row) return false;
    switch (key) {
      case "i":
        void decide(row, "include");
        return true;
      case "u":
        void decide(row, "unclear");
        return true;
      case "e":
        setArmed(true);
        return true;
      case "f":
        if (stage.mode !== "S") return false;
        askSecondOpinion(row);
        return true;
      case " ": {
        const d = own(row);
        if (d?.state === "awaiting_final" && d.outcome)
          void decide(row, d.outcome, d.reason_criterion_id ?? null);
        else if (selected !== null) select(selected + 1);
        return true;
      }
      case "Backspace":
        void takeBack(row);
        return true;
      default:
        if (/^[1-9]$/.test(key)) {
          setNotice("To exclude, press e first, then the criterion number.");
          return true;
        }
        return false;
    }
  });

  if (error && !table) {
    return (
      <p role="alert" className="px-8 py-10 text-md text-exclude">
        {error}
      </p>
    );
  }
  if (!table || !state) return <p className="px-8 py-10 text-md text-ink-2">Loading the table.</p>;

  const decided = table.rows.filter((r) =>
    kind === "reviewer" ? own(r)?.state === "decided" : r.outcome,
  ).length;
  const filtering =
    Object.values(state.filters).some(active) || state.sort.length > 0 || state.query.trim() !== "";
  const clearAll = () => onState((s) => ({ ...s, filters: {}, sort: [], query: "" }));
  // The filters and sort in words; the lead's opening sort in the lead's words.
  const summary = describe(columns, state).replace(
    "sorted by Against the AI ascending",
    "disagreements with the AI first",
  );

  const pick = (columnId: string, value: string) =>
    onState((s) => {
      const filters = { ...s.filters };
      if (only(filters[columnId]) === value) delete filters[columnId];
      else filters[columnId] = { values: [value], contains: "" };
      return { ...s, filters };
    });

  // The marked rows by name: the first chip group whose value they all share.
  /** Rows by the name of their group: the first chip group whose value they all share. */
  const groupName = (named: ReadonlyArray<TableRow>) => {
    if (named.length === 0) return null;
    for (const { group, column } of chips) {
      const shared = named
        .map((r) => new Set(valuesOf(column, r)))
        .reduce((a, b) => new Set([...a].filter((v) => b.has(v))));
      const value = [...shared].find((v) => v !== EMPTY);
      if (value) return GROUP_PHRASES[group.column]?.(value) ?? value;
    }
    return null;
  };
  const markedGroup = groupName(markedRows);
  // "Select the 3 …" only where a chip, a filter, or the search narrows the rows.
  const narrowed = rows.length > 0 && rows.length < table.rows.length;

  return (
    <div
      className="grid h-full min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden bg-paper"
      data-testid="screening-table"
    >
      <header className="relative flex flex-wrap items-start gap-x-6 gap-y-2 bg-paper px-8 pt-6 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="flex-none text-xl font-semibold">Screening table</h1>
            {stages.length > 1 ? (
              <StageMenu
                stages={stages}
                current={stage}
                name={describeStage}
                hint={scopeHint}
                onStage={onStage}
              />
            ) : (
              <span className="text-md text-ink-2" title={scopeHint(stage)}>
                {describeStage(stage)}
              </span>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
            <span className="font-medium whitespace-nowrap text-ink" data-testid="row-count">
              {rows.length === table.rows.length
                ? `${table.rows.length} records`
                : `${rows.length} of ${table.rows.length} records`}
              {" · "}
              {kind === "reviewer" ? `${decided} decided` : `${decided} with an outcome`}
            </span>
            <span className="whitespace-nowrap">
              {kind === "reviewer" ? "Your records" : "Every record of the stage"}
            </span>
            {table.known_includes && table.known_includes.proposed_exclude > 0 ? (
              <span
                role="status"
                className="rounded-full bg-exclude-wash px-2 whitespace-nowrap text-exclude"
                data-testid="known-includes-warning"
                title="The topic's reference set lists these records as relevant. A warning, not a block."
              >
                The AI proposes to exclude {table.known_includes.proposed_exclude} of{" "}
                {table.known_includes.known} known includes
              </span>
            ) : null}
            {renewing > 0 ? (
              <span className="whitespace-nowrap" role="status" data-testid="renewing">
                {renewing} {renewing === 1 ? "record waits" : "records wait"} for the AI's reading
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ColumnChooser
            columns={columns}
            state={state}
            onState={onState}
            defaults={defaults?.columns ?? state.columns}
          />
          <ViewMenu
            views={views}
            current={viewName}
            onLoad={(name) => {
              const saved = views.named[name];
              if (!saved) return;
              setState(fit(saved, columns));
              setViewName(name);
            }}
            onSave={(name) => {
              const next = { ...views, named: { ...views.named, [name]: state } };
              setViews(next);
              storeViews(caller.projectId, caller.as, stage.stage_id, next);
              setViewName(name);
            }}
            onDelete={(name) => {
              const named = { ...views.named };
              delete named[name];
              const next = { ...views, named };
              setViews(next);
              storeViews(caller.projectId, caller.as, stage.stage_id, next);
              setViewName(null);
            }}
            onReset={() => {
              setState(initial(table, columns));
              setViewName(null);
            }}
          />
          <span className="mx-1 h-5 w-px bg-rule-strong" aria-hidden="true" />
          <Button size="sm" onClick={() => void exportRows("view")} disabled={exporting !== null}>
            {exporting === "view" ? "Exporting…" : "Export view"}
          </Button>
          <Button size="sm" onClick={() => void exportRows("stage")} disabled={exporting !== null}>
            {exporting === "stage" ? "Exporting…" : "Export stage"}
          </Button>
          {kind === "reviewer" &&
          table.documentation === "working" &&
          stage.stage === "title_abstract" ? (
            <ImportDecisions
              workbench={workbench}
              caller={caller}
              stageId={stage.stage_id}
              criteria={criteria}
              onImported={(message) => {
                setError(null);
                setNotice(message);
                setReload((n) => n + 1);
              }}
            />
          ) : null}
        </div>
      </header>
      <div className="flex items-start gap-x-6 px-8 pb-4">
        <label className="relative flex items-center">
          <span className="sr-only">Quick search</span>
          <input
            ref={search}
            type="search"
            placeholder="Search title, authors, journal, abstract"
            aria-label="Quick search"
            className="h-8 w-[320px] rounded-[4px] border border-rule-strong bg-sheet pr-8 pl-2.5 text-sm outline-none focus:border-petrol"
            value={state.query}
            onChange={(e) => {
              const q = e.currentTarget.value;
              onState((s) => ({ ...s, query: q }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" || e.key === "Enter") {
                e.currentTarget.blur();
                if (e.key === "Enter" && selected === null) select(0);
              }
            }}
          />
          <span className="pointer-events-none absolute right-2" aria-hidden="true">
            <Key k="/" />
          </span>
        </label>
        {/* The chips, one labelled row per group; the rest of the filters one click away. */}
        <div className="grid min-w-0 flex-1 gap-2">
          {chips.map(({ group, column, values, on }) =>
            values.length && (!group.more || moreFilters || on) ? (
              <div
                key={group.key}
                role="group"
                aria-label={group.label || column.header}
                className="flex min-h-8 flex-wrap items-center gap-1.5"
                data-testid={`chips-${group.key}`}
              >
                <span className="flex w-[132px] flex-none items-center gap-1.5 text-sm text-ink-2">
                  {group.help ? <Help text={group.help}>{group.label}</Help> : group.label}
                </span>
                {group.key === "each" ? (
                  <ReadEach values={values} on={on} onPick={(v) => pick(group.column, v)} />
                ) : (
                  values.map(([value, { count, rule }]) => (
                    <Chip
                      key={value}
                      label={value === EMPTY ? "None" : value}
                      on={on === value}
                      count={count}
                      rule={value.startsWith("No quote") ? QUOTE_NOT_FOUND : rule}
                      onClick={() => pick(group.column, value)}
                    >
                      <ChipLabel column={group.column} value={value} />
                    </Chip>
                  ))
                )}
              </div>
            ) : null,
          )}
        </div>
        <div className="flex min-h-8 flex-none flex-wrap items-center justify-end gap-3 text-sm text-ink-2">
          {chips.some(({ group, values }) => group.more && values.length) ? (
            <button
              type="button"
              className="text-petrol hover:underline"
              aria-expanded={moreFilters}
              onClick={() => setMoreFilters((m) => !m)}
            >
              {moreFilters ? "Fewer filters" : "More filters"}
            </button>
          ) : null}
          {filtering ? (
            <>
              <span className="max-w-[360px] truncate first-letter:uppercase" title={summary}>
                {summary}
              </span>
              {selectable && !groupRow && narrowed && !rows.every((r) => marked.has(r.ref)) ? (
                <Button size="sm" keys={["a"]} onClick={markAll} data-testid="select-filtered">
                  Select the {rows.length}
                  {groupName(rows) ? ` ${groupName(rows)}` : ""}
                </Button>
              ) : null}
              <button type="button" className="text-petrol hover:underline" onClick={clearAll}>
                Clear filters and sort
              </button>
            </>
          ) : null}
        </div>
      </div>
      {/* The page is paper; the table is the raised working surface, the selected record a second
          panel beside it. */}
      <div className="flex min-h-0 items-start gap-4 px-8 pt-1 pb-6">
        <section
          className="flex max-h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[6px] bg-raised shadow-raised"
          aria-label="Records"
          data-testid="table-panel"
        >
          {kind === "lead" && published && published.hash !== table.protocol_hash ? (
            <Outdated
              read={table.protocol_version_label ?? null}
              published={published.label}
              count={table.rows.length}
              busy={rejudging}
              onRejudge={() => void rejudge()}
            />
          ) : null}
          {selectable && marked.size > 0 ? (
            <div
              className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 bg-petrol-wash px-4 py-2 text-sm"
              role="toolbar"
              aria-label={bulkable ? "Bulk decision" : "Selected rows"}
              data-testid="bulk-bar"
            >
              <span className="font-semibold text-ink" data-testid="bulk-count">
                {bulkable
                  ? `${marked.size} selected · ${decidable.length} to decide`
                  : `${marked.size} selected`}
              </span>
              {markedGroup ? (
                <span className="text-ink-2" data-testid="bulk-group">
                  all {markedGroup}
                </span>
              ) : null}
              {bulkable ? (
                <>
                  {markedProposal ? (
                    <Button
                      kind={markedProposal.outcome === "exclude" ? "danger" : "primary"}
                      size="sm"
                      onClick={() => void bulkDecide("accept_ai")}
                      disabled={busy}
                    >
                      {proposalAction(markedProposal, decidable.length, criteria)}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    keys={["I"]}
                    onClick={() => void bulkDecide("include")}
                    disabled={busy || decidable.length === 0}
                  >
                    Include {decidable.length}
                  </Button>
                  <ExcludeMenu
                    criteria={criteria}
                    label={
                      bulkArmed ? "Now the criterion's number" : `Exclude ${decidable.length} on…`
                    }
                    keyName="E"
                    armed={bulkArmed}
                    disabled={busy || decidable.length === 0}
                    side="bottom"
                    testId="bulk-exclude-menu"
                    onExclude={(id) => void bulkDecide("exclude", id)}
                  />
                  {/* The named action above is the same as accepting the AI's proposals. */}
                  {markedProposal ? null : (
                    <Button
                      size="sm"
                      keys={["A"]}
                      onClick={() => void bulkDecide("accept_ai")}
                      disabled={busy}
                    >
                      Accept the AI's proposals ({withProposal.length})
                    </Button>
                  )}
                  {markedWeak.length > 0 ? (
                    <span
                      className="inline-flex items-center gap-2 rounded-[4px] bg-sheet px-2 py-0.5 shadow-[inset_0_0_0_1px_var(--rule-strong)]"
                      data-testid="bulk-unchecked"
                      title="Bulk actions on the AI's proposals leave these out: a person reads each."
                    >
                      <span className="text-ink-2">{leftOut(markedWeak)}</span>
                      <button
                        type="button"
                        className="text-petrol hover:underline"
                        onClick={() => void bulkDecide("accept_ai", null, markedWeak)}
                        disabled={busy}
                      >
                        Accept them too
                      </button>
                      <button
                        type="button"
                        className="text-petrol hover:underline"
                        onClick={() =>
                          setMarked((m) => {
                            const copy = new Set(m);
                            for (const r of markedWeak) copy.delete(r.ref);
                            return copy;
                          })
                        }
                      >
                        Deselect them
                      </button>
                    </span>
                  ) : null}
                </>
              ) : (
                <Button
                  size="sm"
                  onClick={() => void exportRows("marked", markedGroup ?? "")}
                  disabled={exporting !== null}
                >
                  {exporting === "marked"
                    ? "Exporting…"
                    : `Export the ${marked.size} selected rows`}
                </Button>
              )}
              <Button
                kind="quiet"
                size="sm"
                keys={["Escape"]}
                onClick={() => {
                  setMarked(new Set());
                  setAnchor(null);
                }}
              >
                Clear
              </Button>
              {bulkable ? (
                <Help text="Each record gets its own decision. The ledger records them as one batch, named by the filter in view." />
              ) : null}
            </div>
          ) : groupRow?.ai_proposal ? (
            <GroupBar
              row={groupRow}
              label={aiGroup ?? ""}
              inView={rows.length}
              waiting={groupRows.length}
              criteria={criteria}
              busy={busy}
              onDecide={() => void bulkDecide("accept_ai", null, groupRows)}
              onOneByOne={() => {
                const first = rows.findIndex(waiting);
                select(first >= 0 ? first : 0, { shift: false, toggle: false });
                setNotice(
                  "The first record is open on the right. Decide it, and the next one opens.",
                );
              }}
            />
          ) : null}
          {/* As tall as its rows, up to the room there is; then the rows scroll. */}
          <div className="min-h-0 flex-shrink" style={{ height: gridHeight(rows.length) }}>
            <Grid
              rows={rows}
              all={table.rows}
              columns={columns}
              state={state}
              onState={onState}
              selected={selected}
              onSelect={select}
              marked={marked}
              {...(selectable
                ? {
                    markable: {
                      onToggle: mark,
                      onAll: (on: boolean) =>
                        setMarked((m) => {
                          const copy = new Set(m);
                          for (const r of rows) {
                            if (on) copy.add(r.ref);
                            else copy.delete(r.ref);
                          }
                          return copy;
                        }),
                      name: (r: TableRow) => r.title,
                    },
                  }
                : {})}
              onOpen={(i) => {
                const target = rows[i];
                if (target) open(target);
              }}
              rowKey={(r) => r.ref}
              rowTone={(r) =>
                kind === "reviewer" && own(r)?.state === "decided" ? "text-ink-2" : ""
              }
              label={`${scopeName}, ${STAGE_WORDS[stage.stage]}`}
              empty={
                <span className="flex items-center gap-3">
                  No rows match the filters and the search.
                  <button type="button" className="text-petrol hover:underline" onClick={clearAll}>
                    Clear them
                  </button>
                </span>
              }
            />
          </div>
          <footer className="flex-none bg-sheet-2 text-sm">
            {error || notice ? (
              <p
                className={`px-4 py-1.5 ${error ? "text-exclude" : "text-ink"}`}
                aria-live="polite"
              >
                {error ? <span role="alert">{error}</span> : notice}
              </p>
            ) : null}
            {/* While e (or Shift+E) waits for a criterion, the criteria and their keys. */}
            {armed || bulkArmed ? (
              <ol
                aria-label="Criteria"
                className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-1.5 text-exclude"
              >
                <li>
                  {bulkArmed ? `Exclude the ${decidable.length} selected records on` : "Exclude on"}
                </li>
                {criteria.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-1.5 whitespace-nowrap"
                    title={c.text_en}
                  >
                    <Key k={keyOf(criteria, c.id)} on />
                    {shortLabel(c)}
                  </li>
                ))}
                <li className="text-ink-2">
                  <KeyHint keys={["Escape"]}>Cancel</KeyHint>
                </li>
              </ol>
            ) : null}
          </footer>
        </section>
        {row ? (
          <aside
            className="max-h-full min-h-0 w-[440px] flex-none overflow-y-auto rounded-[6px] bg-raised shadow-raised"
            aria-label="Selected record"
            data-testid="row-pane"
          >
            <RowPane
              row={row}
              kind={kind}
              criteria={criteria}
              labels={labels}
              onClose={() => setSelectedRef(null)}
              actions={
                canDecide ? (
                  <DecideButtons
                    row={row}
                    criteria={criteria}
                    armed={armed}
                    busy={busy}
                    secondOpinion={stage.mode === "S"}
                    onDecide={(outcome, reason) => void decide(row, outcome, reason)}
                    onAsk={() => askSecondOpinion(row)}
                    onTakeBack={() => void takeBack(row)}
                    onOpen={() => open(row)}
                  />
                ) : null
              }
              prompt={
                kind === "lead" || table.documentation === "working" ? (
                  <ShowPrompt
                    caller={caller}
                    stageId={stage.stage_id}
                    {...(kind === "lead"
                      ? { itemRef: row.ref }
                      : { assignmentId: row.assignment_id ?? null })}
                    open={promptOpen}
                    onToggle={() => setPromptOpen((o) => !o)}
                  />
                ) : null
              }
            >
              {asking?.ref === row.ref ? (
                <AskSecondOpinion
                  comment={asking.comment}
                  onComment={(comment) => setAsking({ ref: row.ref, comment, typing: true })}
                  onDone={() => setAsking((a) => a && { ...a, typing: false })}
                  onCancel={() => setAsking(null)}
                />
              ) : null}
            </RowPane>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function Dot({ label, off }: { label: string; off?: boolean }) {
  return (
    <span className="inline-flex items-center" title={label}>
      {off ? null : (
        <span className="inline-block h-2.5 w-2.5 rounded-full bg-petrol" aria-hidden="true" />
      )}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** The decision goes against the AI's proposal: a tag in the AI's tint, with what it compares. */
/** The decision goes against the AI's proposal. A decided record waits for nobody, so this is
 * a quiet neutral flag; amber is for what waits for a person (a conflict). Against an exclusion
 * with no quote, its outline is dashed. */
function DisagreeFlag() {
  // One mark; whether the AI gave a quote is said in the AI column.
  return (
    <span
      className="inline-flex flex-none items-center rounded-full border border-rule-strong px-1.5 text-xs leading-[18px] whitespace-nowrap text-ink-2"
      title={AGAINST_HELP}
    >
      ≠ AI
    </span>
  );
}

function NotDecided() {
  return (
    <span title="Not decided">
      <span className="text-rule-strong" aria-hidden="true">
        —
      </span>
      <span className="sr-only">Not decided</span>
    </span>
  );
}

function DecisionCell({
  decision,
  criteria,
}: {
  decision: TableDecision | undefined;
  criteria: ReadonlyArray<Criterion>;
}) {
  if (!decision?.outcome) return <NotDecided />;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Marked term={OUTCOMES[decision.outcome]} text={decisionLabel(decision, criteria)} />
      {decision.state === "awaiting_final" ? <Tag>AI shown</Tag> : null}
      {decision.second_opinion ? <Tag>second opinion asked</Tag> : null}
    </span>
  );
}

/** A status mark in its colour and the words beside it in ink, cut with an ellipsis when the
 * cell is narrow (the cell's hover holds the whole text). Only the mark carries the colour. */
function Marked({ term, text, muted }: { term: Term; text: string; muted?: boolean }) {
  return (
    <span className={`flex min-w-0 items-center gap-1.5 ${muted ? "text-ink-2" : "text-ink"}`}>
      <Mark term={term} />
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}

function LeadDecisionCell({
  row,
  criteria,
}: {
  row: TableRow;
  criteria: ReadonlyArray<Criterion>;
}) {
  // Who decided is in the By column, a disagreement in the ≠ AI column; the cell holds the
  // outcome and its reason.
  const { main, by } = leadWords(row, criteria);
  if (!row.outcome)
    return (
      <span className="truncate text-ink-2">
        <NotDecided /> {by}
      </span>
    );
  return <Marked term={RECORD_TERMS[row.outcome]} text={main} />;
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-sheet-2 px-1.5 text-2xs whitespace-nowrap text-ink-2 shadow-[inset_0_0_0_1px_var(--rule-strong)]">
      {children}
    </span>
  );
}

function ProposalCell({ row, criteria }: { row: TableRow; criteria: ReadonlyArray<Criterion> }) {
  const proposal = row.ai_proposal;
  if (!proposal) return null;
  if (unchecked(proposal))
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-ink-2" title={QUOTE_NOT_FOUND}>
        <NoQuoteMark />
        <span className="min-w-0 truncate">{proposalLabel(row, criteria)}</span>
      </span>
    );
  // An unclear include has the question mark; the criterion's rule is in the column's hover.
  return (
    <Marked
      term={tentative(row) ? OUTCOMES.unclear : OUTCOMES[proposal.outcome]}
      text={proposalLabel(row, criteria)}
    />
  );
}

/** The mark of an exclusion whose quote Kittum did not find: a grey cross in a dashed circle,
 * weaker than a checked exclusion's red cross. (The question mark means unclear only.) */
function NoQuoteMark() {
  return (
    <span
      className="mark border border-dashed border-ink-3 bg-transparent text-ink-2"
      title={QUOTE_NOT_FOUND}
      aria-hidden="true"
    >
      ×
    </span>
  );
}

/** A "?" that explains, on hover or focus. */
const UNCLEAR = "Unclear: ";
const NO_QUOTE = "No quote: exclude on ";

/** The groups a person reads one by one, as two counted selectors instead of a row of chips:
 * the unclear includes by criterion (and the bucket of two or more), and the exclusions with no
 * quote by criterion. Picking one shows that group, as a chip does. */
function ReadEach({
  values,
  on,
  onPick,
}: {
  values: ReadonlyArray<readonly [string, { readonly count: number }]>;
  on: string | null;
  onPick: (value: string) => void;
}) {
  const selector = (label: string, prefix: string, empty: string) => {
    const options = values.filter(([v]) => v.startsWith(prefix));
    if (options.length === 0) return null;
    const total = options.reduce((sum, [, { count }]) => sum + count, 0);
    const current = on && on.startsWith(prefix) ? on : "";
    return (
      <label className="flex items-center gap-2 text-sm">
        <span className="sr-only">{label}</span>
        <select
          aria-label={label}
          className={`h-7 rounded-full border px-2.5 text-sm ${
            current
              ? "border-petrol bg-petrol text-petrol-ink"
              : "border-rule-strong bg-sheet text-ink"
          }`}
          value={current}
          onChange={(e) => {
            // The first option clears the group this selector picked.
            const value = e.currentTarget.value;
            if (value) onPick(value);
            else if (current) onPick(current);
          }}
        >
          <option value="">
            {empty} ({total})
          </option>
          {options.map(([v, { count }]) => (
            <option key={v} value={v}>
              {v.slice(prefix.length)} ({count})
            </option>
          ))}
        </select>
      </label>
    );
  };
  return (
    <>
      {selector("Unclear on criterion", UNCLEAR, "Unclear on a criterion…")}
      {selector("No quote, exclude on criterion", NO_QUOTE, "No quote found…")}
    </>
  );
}

/** A quick filter with its count, and the full rule of the criterion it names in a hover. Chips
 * filter; selecting the records they show is the "Select these" button's job. */
function Chip({
  label,
  on,
  count,
  rule,
  onClick,
  children,
}: {
  /** The value in words, for screen readers. */
  label: string;
  on: boolean;
  count: number;
  rule: string | undefined;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${label} (${count})`}
      onClick={onClick}
      disabled={count === 0 && !on}
      title={rule}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-sm whitespace-nowrap disabled:opacity-50 ${
        on
          ? "border-petrol bg-petrol text-petrol-ink"
          : "border-rule-strong bg-sheet text-ink hover:border-ink-3"
      }`}
    >
      {children}
      <span
        className={`rounded-full px-1.5 text-xs leading-[18px] tabular-nums ${
          on ? "bg-petrol-ink/20" : "bg-sheet-2 text-ink-2 shadow-[inset_0_0_0_1px_var(--rule)]"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

/** A group of the AI's proposals, picked with a chip: what it holds and its one action. An
 * exclusion whose quote Kittum did not find is never decided in bulk: a person reads each. */
function GroupBar({
  row,
  label,
  inView,
  waiting,
  criteria,
  busy,
  onDecide,
  onOneByOne,
}: {
  /** A record of the group, standing for its proposal. */
  row: TableRow;
  label: string;
  inView: number;
  waiting: number;
  criteria: ReadonlyArray<Criterion>;
  busy: boolean;
  onDecide: () => void;
  onOneByOne: () => void;
}) {
  const proposal = row.ai_proposal as AiProposal;
  // A group of proposals a person must read: no quote found, or an unclear criterion.
  const open = weak(row);
  return (
    <div
      className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 bg-petrol-wash px-4 py-2 text-sm"
      role="region"
      aria-label="Group"
      data-testid="group-bar"
    >
      <span className="text-ink">
        <span className="font-semibold">{records(inView)}</span> in “{label}”,{" "}
        {waiting === 0 ? "all decided" : `${waiting} to decide`}
      </span>
      {waiting > 0 && !open ? (
        <Button
          kind={proposal.outcome === "exclude" ? "danger" : "primary"}
          size="sm"
          onClick={onDecide}
          disabled={busy}
        >
          {proposal.outcome === "exclude"
            ? `Exclude these ${waiting} on ${numbered(criteria, proposal.reason_criterion_id)}`
            : `Include these ${waiting}`}
        </Button>
      ) : null}
      {waiting > 0 ? (
        <Button kind={open ? "primary" : "secondary"} size="sm" onClick={onOneByOne}>
          Screen them one by one
        </Button>
      ) : null}
      {open && waiting > 0 ? (
        <span className="text-ink-2">
          {unchecked(proposal)
            ? "Kittum did not find the AI's quote in these records, so a person reads each."
            : "The AI reads a criterion as unclear in these records, so a person reads each."}
        </span>
      ) : null}
    </div>
  );
}

/** The AI read the stage with an older protocol version than the one published: a person decides
 * whether it reads every record again. Amber, as it waits for one. */
function Outdated({
  read,
  published,
  count,
  busy,
  onRejudge,
}: {
  read: string | null;
  published: string;
  count: number;
  busy: boolean;
  onRejudge: () => void;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <div
      className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 bg-marker-soft px-4 py-2 text-sm shadow-[inset_3px_0_0_var(--marker-edge)]"
      role="status"
      data-testid="outdated"
    >
      <Mark term={WAITS} />
      {asking ? (
        <>
          <span className="text-ink">
            Re-judge {records(count)} with version {published}? The AI reads each again; its new
            readings replace the old ones as they arrive. People's decisions stay.
          </span>
          <Button size="sm" onClick={onRejudge} disabled={busy}>
            {busy ? "Re-judging…" : `Re-judge ${records(count)}`}
          </Button>
          <Button kind="quiet" size="sm" onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span className="text-ink">
            The AI proposals here come from{" "}
            {read ? `protocol version ${read}` : "an earlier protocol version"}. The current
            protocol is version {published}; a new reading may change the AI column for these{" "}
            {records(count)}.
          </span>
          <Button size="sm" onClick={() => setAsking(true)}>
            Re-judge with version {published}…
          </Button>
        </>
      )}
    </div>
  );
}

function ChipLabel({ column, value }: { column: string; value: string }) {
  if (value === EMPTY) return <span>{column.startsWith("ai_") ? "Not read yet" : "None"}</span>;
  if (column === "ai_disagrees") return <span>{value}</span>;
  if (value.startsWith("No quote"))
    return (
      <span className="inline-flex items-center gap-1.5 text-ink-2">
        <NoQuoteMark />
        {value}
      </span>
    );
  const outcome = /^(Include|Exclude|Unclear|Conflict)/.exec(value)?.[1];
  const term =
    outcome === "Conflict"
      ? RECORD_TERMS.conflict
      : outcome
        ? OUTCOMES[outcome.toLowerCase() as "include" | "exclude" | "unclear"]
        : null;
  return term ? (
    <span className="inline-flex items-center gap-1.5">
      <Mark term={term} />
      {value}
    </span>
  ) : (
    <span>{value}</span>
  );
}

/** The stage and question, as a compact menu; the question's words in each item. */
function StageMenu({
  stages,
  current,
  name,
  hint,
  onStage,
}: {
  stages: ReadonlyArray<StageInfo>;
  current: StageInfo;
  name: (s: StageInfo) => string;
  hint: (s: StageInfo) => string;
  onStage: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label="Stage"
        title={hint(current)}
        className={`${TRIGGER} h-8 border-rule-strong text-sm text-ink`}
      >
        <span>{name(current)}</span>
        <span aria-hidden="true" className="text-ink-2">
          ▾
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start" className="z-30">
          <Popover.Popup className={`${POPUP} w-[440px] py-1`} data-testid="stage-menu">
            {stages.map((s) => (
              <button
                key={s.stage_id}
                type="button"
                aria-pressed={s.stage_id === current.stage_id}
                className={`grid w-full gap-0.5 px-3 py-2 text-left hover:bg-sheet-2 ${
                  s.stage_id === current.stage_id ? "bg-petrol-wash" : ""
                }`}
                onClick={() => {
                  onStage(s.stage_id);
                  setOpen(false);
                }}
              >
                <span className="font-medium text-ink">{name(s)}</span>
                <span className="line-clamp-2 text-xs text-ink-2">{hint(s)}</span>
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const TRIGGER =
  "inline-flex h-7 flex-none items-center gap-2 rounded-[4px] border bg-sheet px-2.5 text-xs font-medium whitespace-nowrap hover:bg-sheet-2 disabled:cursor-not-allowed disabled:opacity-50";

function ExcludeMenu({
  criteria,
  label,
  keyName,
  armed,
  disabled,
  side,
  testId,
  onExclude,
}: {
  criteria: ReadonlyArray<Criterion>;
  label: string;
  keyName: string;
  armed: boolean;
  disabled: boolean;
  side: "top" | "bottom";
  testId: string;
  onExclude: (criterionId: string) => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        className={`${TRIGGER} ${armed ? "border-exclude text-exclude" : "border-rule-strong text-ink"}`}
        disabled={disabled}
      >
        <span>{label}</span>
        <span className="inline-flex opacity-80" aria-hidden="true">
          <Key k={keyName} className="key-on-button" />
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} side={side} className="z-30">
          <Popover.Popup className={`${POPUP} w-[300px] py-1`} data-testid={testId}>
            {criteria.map((c) => (
              <button
                key={c.id}
                type="button"
                className="flex h-8 w-full items-center gap-2 px-2.5 text-left hover:bg-sheet-2"
                title={c.text_en}
                onClick={() => onExclude(c.id)}
              >
                <Key k={keyOf(criteria, c.id)} />
                <span className="truncate">{shortLabel(c)}</span>
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The selected record's decision, as buttons; each names its key. */
function DecideButtons({
  row,
  criteria,
  armed,
  busy,
  secondOpinion,
  onDecide,
  onAsk,
  onTakeBack,
  onOpen,
}: {
  row: TableRow;
  criteria: ReadonlyArray<Criterion>;
  armed: boolean;
  busy: boolean;
  secondOpinion: boolean;
  onDecide: (outcome: Outcome, reason: string | null) => void;
  onAsk: () => void;
  onTakeBack: () => void;
  onOpen: () => void;
}) {
  const d = own(row);
  if (!row.assignment_id) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="row-actions">
      {d?.state === "awaiting_final" && d.outcome ? (
        <Button
          kind="primary"
          size="sm"
          keys={[" "]}
          onClick={() => onDecide(d.outcome as Outcome, d.reason_criterion_id ?? null)}
          disabled={busy}
        >
          Keep {decisionLabel(d, criteria)}
        </Button>
      ) : null}
      <Button size="sm" keys={["i"]} onClick={() => onDecide("include", null)} disabled={busy}>
        Include
      </Button>
      <ExcludeMenu
        criteria={criteria}
        label={armed ? `Now 1 to ${criteria.length}` : "Exclude on…"}
        keyName="e"
        armed={armed}
        disabled={busy}
        side="bottom"
        testId="exclude-menu"
        onExclude={(id) => onDecide("exclude", id)}
      />
      <Button size="sm" keys={["u"]} onClick={() => onDecide("unclear", null)} disabled={busy}>
        Unclear
      </Button>
      {secondOpinion && !row.second_opinion && d?.state !== "decided" ? (
        <Button kind="quiet" size="sm" keys={["f"]} onClick={onAsk} disabled={busy}>
          Ask a second opinion
        </Button>
      ) : null}
      {d?.state === "decided" ? (
        <Button kind="quiet" size="sm" keys={["Backspace"]} onClick={onTakeBack} disabled={busy}>
          Take back
        </Button>
      ) : (
        <Button kind="quiet" size="sm" keys={["Enter"]} onClick={onOpen}>
          Open in the queue
        </Button>
      )}
    </div>
  );
}

function PaneSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    // Inside the record's sheet, groups are separated by space and a small heading, not rules.
    <section className="px-5 pt-4 pb-1" aria-label={title}>
      <h3 className="text-xs font-semibold text-ink-2">{title}</h3>
      {children}
    </section>
  );
}

function RowPane({
  row,
  kind,
  criteria,
  labels,
  actions,
  prompt,
  onClose,
  children,
}: {
  row: TableRow;
  kind: "reviewer" | "lead";
  criteria: ReadonlyArray<Criterion>;
  labels: Record<string, string>;
  onClose: () => void;
  /** The decision buttons, where the viewer decides this record. */
  actions?: ReactNode;
  /** "Show the prompt", where the viewer may see what the AI reads. */
  prompt?: ReactNode;
  /** The second-opinion prompt, while the reviewer writes it. */
  children?: ReactNode;
}) {
  const authors =
    row.authors.length > 3
      ? `${row.authors.slice(0, 3).join(", ")} et al.`
      : row.authors.join(", ");
  // The study by its name ("López-Durán 2025") with the journal; the full title under it.
  const kicker = [studyOf(row), row.journal].filter(Boolean).join(" · ");
  const ids = [row.pmid ? `PMID ${row.pmid}` : null, row.doi ? `DOI ${row.doi}` : null]
    .filter(Boolean)
    .join(" · ");
  const d = own(row);
  const revealIndex = row.reveal
    ? criteria.findIndex((c) => c.id === row.reveal?.criterion_id)
    : -1;
  const revealed = row.reveal ? criteria[revealIndex] : undefined;
  const before = kind === "reviewer" && row.ai && !row.reveal;
  const types = publicationTypes(row);
  return (
    <article className="pb-6" data-testid="row-detail">
      <header className="px-5 pt-4 pb-3">
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-2" title={kicker}>
            {kicker}
          </p>
          <KeyHint keys={["ArrowUp", "ArrowDown"]}>Move</KeyHint>
          <Button kind="quiet" size="sm" onClick={onClose} aria-label="Close the record">
            Close
          </Button>
        </div>
        <h2 className="mt-1 text-md font-semibold text-balance">{row.title}</h2>
        {authors ? <p className="mt-1 text-sm text-ink-2">{authors}</p> : null}
        {ids ? <p className="mt-0.5 text-xs text-ink-2">{ids}</p> : null}
        {row.in_known_pool || row.known_include || disagrees(row, kind) ? (
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
            {row.in_known_pool ? <span>In the known pool</span> : null}
            {row.known_include ? <span>Known include</span> : null}
            {disagrees(row, kind) ? <DisagreeFlag /> : null}
          </p>
        ) : null}
        {/* Publication types are neutral facts: plain text, not badges. */}
        {types.length ? <p className="mt-1 text-xs text-ink-2">{types.join("; ")}</p> : null}
      </header>
      <PaneSection title={kind === "reviewer" ? "Your decision" : "Decisions"}>
        {kind === "reviewer" ? (
          <div className="mt-1.5 text-md">
            {d?.outcome ? (
              <DecisionCell decision={d} criteria={criteria} />
            ) : (
              <span className="text-ink-2">Not decided yet</span>
            )}
            {d?.decided_at ? (
              <span className="ml-2 text-sm text-ink-2">{formatDateTime(d.decided_at)}</span>
            ) : null}
            {d?.comment ? <p className="mt-1 text-sm text-ink-2">“{d.comment}”</p> : null}
          </div>
        ) : (
          <>
            {row.outcome ? (
              <p className="mt-1.5 text-md font-semibold">
                <Status term={RECORD_TERMS[row.outcome]}>{leadWords(row, criteria).main}</Status>
              </p>
            ) : null}
            <ul className="mt-1.5 grid gap-1.5 text-sm">
              {row.decisions.map((x, i) => (
                <li key={`${x.reviewer_id ?? i}-${x.role ?? ""}`} className="grid gap-0.5">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium text-ink">{who(x)}</span>
                    {x.outcome ? (
                      <DecisionCell decision={x} criteria={criteria} />
                    ) : (
                      <span className="text-ink-2">Not decided yet</span>
                    )}
                    {x.decided_at ? (
                      <span className="text-ink-2">{formatDateTime(x.decided_at)}</span>
                    ) : null}
                  </span>
                  {x.comment ? <span className="text-ink-2">“{x.comment}”</span> : null}
                </li>
              ))}
            </ul>
          </>
        )}
        {actions}
      </PaneSection>
      {row.second_opinion || children || before ? (
        <div className="mt-2">
          {row.second_opinion ? (
            <SecondOpinionAsked asked={row.second_opinion} criteria={criteria} labels={labels} />
          ) : null}
          {children}
          {before && row.ai ? (
            <AiBefore ai={row.ai} criteria={criteria} labels={labels} marked={null} />
          ) : null}
        </div>
      ) : null}
      {row.reveal ? (
        <PaneSection title="The AI's reading">
          <div className="evidence-item mt-1.5 rounded-[3px] px-3 py-2">
            <AiReading
              compact
              criterion={{
                number: revealed ? numberOf(criteria, revealed.id) : null,
                label: revealed ? shortLabel(revealed) : row.reveal.criterion_id,
                text: revealed?.text_en ?? null,
              }}
              status={row.reveal.status}
              downgradedFrom={row.reveal.downgraded_from}
              rationale={row.reveal.rationale}
              quote={row.reveal.quote || null}
              verified={row.reveal.quote_verified ?? false}
              markedAt={null}
              marked={false}
            />
          </div>
        </PaneSection>
      ) : null}
      {row.ai_proposal && !before ? (
        <PaneSection title="AI proposes">
          <div data-testid="row-proposal" className="mt-1.5 grid gap-1.5">
            <p className="text-md font-semibold">
              <ProposalCell row={row} criteria={criteria} />
            </p>
            {unchecked(row.ai_proposal) ? (
              <p className="text-sm text-ink-2" data-testid="row-no-quote">
                Kittum did not find the AI's quote in the record, so this exclusion is not checked.
                Read the abstract before you accept it; bulk actions leave it out.
              </p>
            ) : tentative(row) ? (
              <p className="text-sm text-ink-2" data-testid="row-unclear">
                The AI reads{" "}
                {unclearOf(row)
                  .map((id) => numbered(criteria, id))
                  .join(", ")}{" "}
                as unclear, so this is not a clear include. Read the abstract before you accept it;
                bulk actions leave it out.
              </p>
            ) : null}
            {row.ai_proposal.rationale ? (
              <p className="text-sm text-ink-2">{row.ai_proposal.rationale}</p>
            ) : null}
            {row.ai_proposal.quote ? (
              <blockquote
                className={`rounded-[3px] px-3 py-1.5 text-sm ${
                  unchecked(row.ai_proposal)
                    ? "text-ink-2 shadow-[inset_3px_0_0_var(--rule-strong)]"
                    : "evidence-item"
                }`}
              >
                “{row.ai_proposal.quote}”
              </blockquote>
            ) : null}
          </div>
        </PaneSection>
      ) : null}
      {kind === "lead" && row.ai?.criteria.length ? (
        <PaneSection title="The AI's reading, criterion by criterion">
          <ul className="mt-1.5 grid gap-1 text-sm">
            {row.ai.criteria.map((c) => (
              <li
                key={c.criterion_id}
                className="flex items-center gap-2"
                title={c.rationale ?? undefined}
              >
                <Mark term={VERDICTS[c.status]} />
                <span className="min-w-0 truncate">{numbered(criteria, c.criterion_id)}</span>
                <span className="ml-auto flex-none text-ink-2">{VERDICTS[c.status].label}</span>
              </li>
            ))}
          </ul>
        </PaneSection>
      ) : null}
      <PaneSection title="Abstract">
        <p className="mt-1.5 text-md leading-[26px] whitespace-pre-line text-ink">
          {row.abstract || <span className="text-ink-2">This record has no abstract.</span>}
        </p>
      </PaneSection>
      {prompt ? <div className="mt-2">{prompt}</div> : null}
    </article>
  );
}

const POPUP =
  "rounded-[4px] border border-rule-strong bg-sheet text-sm shadow-[0_8px_24px_rgb(0_0_0/0.16)] outline-none";

function ColumnChooser({
  columns,
  state,
  onState,
  defaults,
}: {
  columns: ReadonlyArray<Column<TableRow>>;
  state: ViewState;
  onState: (update: (s: ViewState) => ViewState) => void;
  defaults: ReadonlyArray<string>;
}) {
  const shown = new Set(state.columns);
  return (
    <Popover.Root>
      <Popover.Trigger className={`${TRIGGER} border-rule-strong text-ink`}>
        <span>Columns</span>
        <span className="rounded-full bg-sheet-2 px-1.5 text-ink-2 tabular-nums">
          {state.columns.length} of {columns.length}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="end" className="z-30">
          <Popover.Popup className={`${POPUP} w-[280px] py-1`} data-testid="column-chooser">
            <p className="px-3 pt-1 pb-1.5 text-xs text-ink-2">Show these columns</p>
            {columns.map((c) => (
              <label key={c.id} className="flex h-8 items-center gap-2 px-3 hover:bg-sheet-2">
                <input
                  type="checkbox"
                  checked={shown.has(c.id)}
                  onChange={() =>
                    onState((s) => {
                      if (s.columns.includes(c.id)) {
                        if (s.columns.length === 1) return s;
                        return { ...s, columns: s.columns.filter((id) => id !== c.id) };
                      }
                      // Back in the place it has among all columns.
                      const order = columns.map((x) => x.id);
                      const next = [...s.columns, c.id].sort(
                        (a, b) => order.indexOf(a) - order.indexOf(b),
                      );
                      return { ...s, columns: next };
                    })
                  }
                />
                {c.header}
              </label>
            ))}
            <button
              type="button"
              className="mt-1 w-full border-t border-rule px-3 py-2 text-left text-petrol hover:bg-sheet-2"
              onClick={() => onState((s) => ({ ...s, columns: [...defaults], widths: {} }))}
            >
              Show the default columns
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ViewMenu({
  views,
  current,
  onLoad,
  onSave,
  onDelete,
  onReset,
}: {
  views: SavedViews;
  current: string | null;
  onLoad: (name: string) => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const names = Object.keys(views.named).sort((a, b) => a.localeCompare(b));
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={`${TRIGGER} max-w-[220px] border-rule-strong text-ink`}>
        <span className="truncate">{current ? `View: ${current}` : "Saved views"}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="end" className="z-30">
          <Popover.Popup className={`${POPUP} w-[300px] py-1`} data-testid="view-menu">
            {names.length === 0 ? (
              <p className="px-3 py-1.5 text-ink-2">No saved views yet.</p>
            ) : (
              <ul>
                {names.map((n) => (
                  <li key={n} className="flex h-8 items-center hover:bg-sheet-2">
                    <button
                      type="button"
                      className={`min-w-0 flex-1 truncate px-3 text-left ${n === current ? "font-semibold text-petrol" : ""}`}
                      onClick={() => {
                        onLoad(n);
                        setOpen(false);
                      }}
                    >
                      {n}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete the view ${n}`}
                      className="px-3 text-ink-2 hover:text-exclude"
                      onClick={() => onDelete(n)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="mt-1 flex gap-1.5 border-t border-rule px-3 pt-2"
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = name.trim();
                if (!trimmed) return;
                onSave(trimmed);
                setName("");
                setOpen(false);
              }}
            >
              <input
                className="h-7 min-w-0 flex-1 rounded-[4px] border border-rule-strong bg-sheet px-2 outline-none focus:border-petrol"
                placeholder="Name this view"
                aria-label="View name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
              />
              <Button kind="quiet" size="sm" type="submit">
                Save
              </Button>
            </form>
            <button
              type="button"
              className="mt-1 w-full px-3 py-2 text-left text-ink-2 hover:bg-sheet-2"
              onClick={() => {
                onReset();
                setOpen(false);
              }}
            >
              Reset to the default view
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
