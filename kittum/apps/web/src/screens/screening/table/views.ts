// Saved views of the table, per reviewer and stage, in this browser. A view is the table's state
// (columns, widths, filters, sort, quick search) under a name; the last state comes back too.
import type { ViewState } from "./grid.ts";

export interface SavedViews {
  /** The state the table was left in. */
  readonly last: ViewState | null;
  readonly named: Readonly<Record<string, ViewState>>;
}

const key = (projectId: string, actorId: string, stage: string) =>
  `kittum.table-views.${projectId}.${actorId}.${stage}`;

const isView = (v: unknown): v is ViewState =>
  typeof v === "object" &&
  v !== null &&
  Array.isArray((v as ViewState).columns) &&
  Array.isArray((v as ViewState).sort) &&
  typeof (v as ViewState).filters === "object" &&
  typeof (v as ViewState).widths === "object" &&
  typeof (v as ViewState).query === "string";

export const loadViews = (projectId: string, actorId: string, stage: string): SavedViews => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key(projectId, actorId, stage)) ?? "{}");
    if (typeof raw !== "object" || raw === null) return { last: null, named: {} };
    const { last, named } = raw as { last?: unknown; named?: Record<string, unknown> };
    return {
      last: isView(last) ? last : null,
      named: Object.fromEntries(Object.entries(named ?? {}).filter(([, v]) => isView(v))) as Record<
        string,
        ViewState
      >,
    };
  } catch {
    return { last: null, named: {} };
  }
};

export const storeViews = (
  projectId: string,
  actorId: string,
  stage: string,
  views: SavedViews,
) => {
  try {
    localStorage.setItem(key(projectId, actorId, stage), JSON.stringify(views));
  } catch {
    // A full or blocked storage loses the views, not the table.
  }
};
