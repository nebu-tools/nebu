// The table's state, apart from React: columns, per-column filters, multi-column sort, and the
// quick search, applied to rows in that order. A saved view is this state.
import type { ReactNode } from "react";

import type { Haystack } from "./fuzzy.ts";

export const EMPTY = "(empty)";

export interface Column<R> {
  readonly id: string;
  readonly header: string;
  /** Default width in pixels. */
  readonly width: number;
  /** What the cell says, and what "text contains" and sorting read. */
  readonly text: (row: R) => string;
  /** The values the filter checklist offers; a cell may hold several (publication types). */
  readonly values?: (row: R) => ReadonlyArray<string>;
  /** Sorts by this instead of the text: numbers, or an order of its own. */
  readonly sortBy?: (row: R) => number | string | null;
  readonly render?: (row: R) => ReactNode;
  readonly align?: "right";
}

export interface Filter {
  /** The values kept; null keeps every value. */
  readonly values: ReadonlyArray<string> | null;
  /** Kept only if the cell's text contains this, ignoring case. */
  readonly contains: string;
}

export interface Sort {
  readonly id: string;
  readonly desc: boolean;
}

export interface ViewState {
  /** Visible columns, in order. */
  readonly columns: ReadonlyArray<string>;
  readonly widths: Readonly<Record<string, number>>;
  readonly sort: ReadonlyArray<Sort>;
  readonly filters: Readonly<Record<string, Filter>>;
  readonly query: string;
}

export const valuesOf = <R>(column: Column<R>, row: R): ReadonlyArray<string> => {
  if (column.values) {
    const values = column.values(row);
    return values.length ? values : [EMPTY];
  }
  return [column.text(row) || EMPTY];
};

export const active = (filter: Filter | undefined) =>
  filter !== undefined && (filter.values !== null || filter.contains.trim() !== "");

const keeps = <R>(column: Column<R>, filter: Filter, row: R) => {
  if (filter.values !== null) {
    const kept = new Set(filter.values);
    if (!valuesOf(column, row).some((v) => kept.has(v))) return false;
  }
  const needle = filter.contains.trim().toLowerCase();
  return needle === "" || column.text(row).toLowerCase().includes(needle);
};

/** Rows that pass every filter but `except`'s: what a column's checklist offers. */
export const filtered = <R>(
  rows: ReadonlyArray<R>,
  columns: ReadonlyArray<Column<R>>,
  filters: ViewState["filters"],
  except?: string,
): R[] => {
  const applied = columns.filter((c) => c.id !== except && active(filters[c.id]));
  if (applied.length === 0) return [...rows];
  return rows.filter((row) => applied.every((c) => keeps(c, filters[c.id] as Filter, row)));
};

const compare = (a: number | string | null, b: number | string | null) => {
  // Empty cells last, whichever the direction.
  if (a === null || a === "") return b === null || b === "" ? 0 : 1;
  if (b === null || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
};

/**
 * The rows in view: filtered, matched against the quick search, and sorted. Without a sort, a
 * quick search puts the best matches first; otherwise rows keep the order they came in.
 */
export const view = <R>(
  rows: ReadonlyArray<R>,
  columns: ReadonlyArray<Column<R>>,
  state: ViewState,
  search: { readonly match: ((h: Haystack) => number) | null; readonly hay: (row: R) => Haystack },
): R[] => {
  let out = filtered(rows, columns, state.filters);
  let scores: Map<R, number> | null = null;
  if (search.match) {
    const match = search.match;
    scores = new Map();
    out = out.filter((row) => {
      const score = match(search.hay(row));
      if (score > 0) scores?.set(row, score);
      return score > 0;
    });
  }
  const byId = new Map(columns.map((c) => [c.id, c]));
  const sorts = state.sort.flatMap((s) => {
    const column = byId.get(s.id);
    return column ? [{ column, desc: s.desc }] : [];
  });
  if (sorts.length === 0) {
    const ranked = scores;
    if (ranked) out.sort((a, b) => (ranked.get(b) ?? 0) - (ranked.get(a) ?? 0));
    return out;
  }
  const keyed = out.map((row, index) => ({
    row,
    index,
    keys: sorts.map(({ column }) => (column.sortBy ? column.sortBy(row) : column.text(row))),
  }));
  keyed.sort((a, b) => {
    for (const [i, { desc }] of sorts.entries()) {
      const x = a.keys[i] ?? null;
      const y = b.keys[i] ?? null;
      const empty = x === null || x === "" || y === null || y === "";
      const order = compare(x, y);
      if (order !== 0) return desc && !empty ? -order : order;
    }
    return a.index - b.index;
  });
  return keyed.map((k) => k.row);
};

/** Click: sort by this column alone, then reverse, then not at all. Shift-click: add it to the
 * sort, or turn it around within it. */
export const toggleSort = (
  sort: ReadonlyArray<Sort>,
  id: string,
  add: boolean,
): ReadonlyArray<Sort> => {
  const current = sort.find((s) => s.id === id);
  if (add) {
    if (!current) return [...sort, { id, desc: false }];
    return current.desc
      ? sort.filter((s) => s.id !== id)
      : sort.map((s) => (s.id === id ? { id, desc: true } : s));
  }
  if (!current || sort.length > 1) return [{ id, desc: false }];
  return current.desc ? [] : [{ id, desc: true }];
};

/** The filters and sort in words, for the export's cover sheet. */
export const describe = <R>(
  columns: ReadonlyArray<Column<R>>,
  state: ViewState,
  unchanged = "All rows",
): string => {
  const name = (id: string) => columns.find((c) => c.id === id)?.header ?? id;
  const parts: string[] = [];
  for (const [id, filter] of Object.entries(state.filters)) {
    if (!active(filter)) continue;
    const kept =
      filter.values === null
        ? null
        : filter.values.length <= 5
          ? filter.values.join(", ")
          : `${filter.values.length} values`;
    const words = [
      kept === null ? null : `is ${kept}`,
      filter.contains.trim() ? `contains "${filter.contains.trim()}"` : null,
    ].filter(Boolean);
    parts.push(`${name(id)} ${words.join(" and ")}`);
  }
  if (state.query.trim()) parts.push(`quick search "${state.query.trim()}"`);
  const sorted = state.sort.map((s) => `${name(s.id)} ${s.desc ? "descending" : "ascending"}`);
  if (sorted.length) parts.push(`sorted by ${sorted.join(", then ")}`);
  return parts.length ? parts.join("; ") : unchanged;
};
