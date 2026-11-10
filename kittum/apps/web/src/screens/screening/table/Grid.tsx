// A dense grid in the manner of a spreadsheet: 30px rows, hairline rules, a sticky header with a
// ▾ menu per column (sort, "text contains", a checklist of values), resizable columns, and only
// the rows on screen rendered, so 20,000 records scroll as easily as 20. Columns that may grow
// share the room the others leave, so the grid fills its width. Where rows can be marked, a
// checkbox column comes first, with a header checkbox for every row in view.
import { Popover } from "@base-ui/react/popover";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { active, EMPTY, filtered, toggleSort, valuesOf } from "./grid.ts";
import type { Column, Filter, ViewState } from "./grid.ts";

const ROW = 30;
const HEADER = 34;

/** The height the grid needs for its rows: a sheet that holds a few rows ends at the last one
 * (a scrollbar's room included), and a long one scrolls inside its frame. */
export const gridHeight = (rows: number) => HEADER + (rows > 0 ? rows * ROW : 72) + 16;
const OVERSCAN = 12;
const MIN_WIDTH = 40;
const MARK = 40;
const SHOWN_VALUES = 300;

interface GridProps<R> {
  readonly rows: ReadonlyArray<R>;
  /** Every row, for the values a column's checklist offers. */
  readonly all: ReadonlyArray<R>;
  readonly columns: ReadonlyArray<Column<R>>;
  readonly state: ViewState;
  readonly onState: (update: (state: ViewState) => ViewState) => void;
  readonly selected: number | null;
  /** A click selects a row; with Shift or Ctrl (Cmd) it also marks rows for a bulk decision. */
  readonly onSelect: (
    index: number,
    mods?: { readonly shift: boolean; readonly toggle: boolean },
  ) => void;
  /** Rows marked for a bulk decision, by key. */
  readonly marked?: ReadonlySet<string>;
  readonly onOpen?: (index: number) => void;
  readonly rowKey: (row: R) => string;
  /** Marks a row, e.g. one the reviewer has decided. */
  readonly rowTone?: (row: R) => string;
  readonly label: string;
  /** What to show when no row passes the filters. */
  readonly empty?: ReactNode;
  /** Checkboxes that mark rows: one per row (Shift extends from the last one), and one in the
   * header for every row in view. */
  readonly markable?: {
    readonly onToggle: (index: number, shift: boolean) => void;
    readonly onAll: (on: boolean) => void;
    /** The row's name, for its checkbox's label. */
    readonly name: (row: R) => string;
  };
}

export function Grid<R>({
  rows,
  all,
  columns,
  state,
  onState,
  selected,
  onSelect,
  marked,
  onOpen,
  rowKey,
  rowTone,
  label,
  empty,
  markable,
}: GridProps<R>) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [room, setRoom] = useState(0);
  const byId = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const fixed = state.columns.flatMap((id) => {
    const column = byId.get(id);
    return column
      ? [{ column, width: state.widths[id] ?? column.width, set: id in state.widths }]
      : [];
  });
  // The room the columns leave goes to those that may grow, unless the reviewer sized them.
  const spare = Math.max(
    0,
    room - (markable ? MARK : 0) - fixed.reduce((sum, c) => sum + c.width, 0),
  );
  const shares = fixed.reduce((sum, c) => sum + (c.set ? 0 : (c.column.grow ?? 0)), 0);
  const shown = fixed.map((c) => ({
    column: c.column,
    width:
      c.set || !shares ? c.width : c.width + Math.floor((spare * (c.column.grow ?? 0)) / shares),
  }));
  const lead = markable ? MARK : 0;
  const total = lead + shown.reduce((sum, c) => sum + c.width, 0);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      setHeight(el.clientHeight);
      setRoom(el.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep the selected row in view, below the sticky header.
  useEffect(() => {
    const el = scroller.current;
    if (!el || selected === null) return;
    const top = selected * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight - HEADER)
      el.scrollTop = top + ROW - (el.clientHeight - HEADER);
  }, [selected]);

  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);

  return (
    <div
      ref={scroller}
      className="relative h-full overflow-auto bg-raised text-sm"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      role="grid"
      aria-label={label}
      aria-rowcount={rows.length + 1}
      aria-colcount={shown.length + (markable ? 1 : 0)}
      data-testid="grid"
    >
      <div
        role="row"
        aria-rowindex={1}
        className="sticky top-0 z-10 flex border-b border-rule-strong bg-sheet-2"
        style={{ width: total, height: HEADER }}
      >
        {markable ? (
          <div
            role="columnheader"
            className="flex flex-none items-center justify-center border-r border-rule-strong"
            style={{ width: MARK }}
          >
            <MarkAll
              all={rows.length > 0 && rows.every((r) => marked?.has(rowKey(r)))}
              some={rows.some((r) => marked?.has(rowKey(r)))}
              count={rows.length}
              onAll={markable.onAll}
            />
          </div>
        ) : null}
        {shown.map(({ column, width }) => (
          <HeaderCell
            key={column.id}
            column={column}
            width={width}
            state={state}
            onState={onState}
            all={all}
            columns={columns}
          />
        ))}
      </div>
      <div className="relative" style={{ width: total, height: rows.length * ROW }}>
        {rows.slice(first, last).map((row, offset) => {
          const index = first + offset;
          const isSelected = index === selected;
          const isMarked = marked?.has(rowKey(row)) ?? false;
          return (
            <div
              key={rowKey(row)}
              role="row"
              aria-rowindex={index + 2}
              aria-selected={isSelected}
              data-marked={isMarked || undefined}
              data-row={rowKey(row)}
              className={`absolute left-0 flex cursor-default border-b border-rule ${
                isSelected
                  ? "bg-marker-soft shadow-[inset_2px_0_0_var(--marker-edge)]"
                  : isMarked
                    ? "bg-petrol-wash shadow-[inset_2px_0_0_var(--petrol)]"
                    : `${rowTone?.(row) ?? ""} hover:bg-sheet-2`
              } ${isMarked && isSelected ? "outline outline-1 -outline-offset-1 outline-petrol" : ""}`}
              style={{ top: index * ROW, height: ROW, width: total }}
              onMouseDown={(e) => {
                if (e.shiftKey) e.preventDefault(); // no text selection on a range click
                onSelect(index, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
              }}
              onDoubleClick={() => onOpen?.(index)}
            >
              {markable ? (
                <div
                  role="gridcell"
                  className="flex flex-none items-center justify-center border-r border-rule"
                  style={{ width: MARK }}
                  // The checkbox marks; it does not select the row.
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-petrol"
                    checked={isMarked}
                    aria-label={`Select ${markable.name(row)}`}
                    onChange={() => undefined}
                    onClick={(e) => {
                      markable.onToggle(index, e.shiftKey);
                      // After a mouse click the table's keys work again (a focused checkbox
                      // would take them); from the keyboard, focus stays.
                      if (e.detail > 0) e.currentTarget.blur();
                    }}
                  />
                </div>
              ) : null}
              {shown.map(({ column, width }) => (
                <div
                  key={column.id}
                  role="gridcell"
                  className={`flex-none truncate border-r border-rule px-2 leading-[29px] ${
                    column.align === "right" ? "text-right tabular-nums" : ""
                  }`}
                  style={{ width }}
                  title={column.text(row) || undefined}
                >
                  {column.render ? column.render(row) : column.text(row)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <div className="sticky left-0 px-4 py-6 text-ink-2">
          {empty ?? "No rows match the filters."}
        </div>
      ) : null}
    </div>
  );
}

function HeaderCell<R>({
  column,
  width,
  state,
  onState,
  all,
  columns,
}: {
  column: Column<R>;
  width: number;
  state: ViewState;
  onState: (update: (state: ViewState) => ViewState) => void;
  all: ReadonlyArray<R>;
  columns: ReadonlyArray<Column<R>>;
}) {
  const place = state.sort.findIndex((s) => s.id === column.id);
  const sort = state.sort[place];
  const filter = state.filters[column.id];
  const resize = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const start = event.clientX;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const next = Math.max(MIN_WIDTH, Math.round(width + e.clientX - start));
      onState((s) => ({ ...s, widths: { ...s.widths, [column.id]: next } }));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  return (
    <div
      role="columnheader"
      aria-sort={sort ? (sort.desc ? "descending" : "ascending") : "none"}
      className={`group relative flex flex-none items-center border-r border-rule-strong ${
        sort ? "bg-petrol-wash" : ""
      }`}
      style={{ width }}
      data-column={column.id}
    >
      <button
        type="button"
        className={`flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-left font-semibold hover:text-ink ${
          sort ? "text-ink" : "text-ink-2"
        }`}
        title={`${column.header}. ${
          sort
            ? `Sorted ${sort.desc ? "descending" : "ascending"}. Click to ${sort.desc ? "stop sorting" : "reverse"}.`
            : "Click to sort."
        } Shift-click adds it to the sort.`}
        aria-label={`Sort by ${column.header}`}
        onClick={(e) => onState((s) => ({ ...s, sort: toggleSort(s.sort, column.id, e.shiftKey) }))}
      >
        <span className="truncate">{column.short ?? column.header}</span>
        {sort ? (
          <span
            className="flex flex-none items-center text-petrol"
            aria-hidden="true"
            data-testid={`sorted-${column.id}`}
          >
            {sort.desc ? "↓" : "↑"}
            {state.sort.length > 1 ? <sub className="text-[9px]">{place + 1}</sub> : null}
          </span>
        ) : (
          <span
            className={`hidden flex-none text-ink-3 ${column.compact ? "" : "group-hover:inline"}`}
            aria-hidden="true"
          >
            ↕
          </span>
        )}
      </button>
      <FilterMenu
        floating={column.compact ?? false}
        column={column}
        filter={filter}
        sorted={sort ? (sort.desc ? "desc" : "asc") : null}
        rows={() => filtered(all, columns, state.filters, column.id)}
        onFilter={(next) =>
          onState((s) => {
            const filters = { ...s.filters };
            if (next && active(next)) filters[column.id] = next;
            else delete filters[column.id];
            return { ...s, filters };
          })
        }
        onSort={(desc) =>
          onState((s) => ({
            ...s,
            sort:
              desc === null ? s.sort.filter((x) => x.id !== column.id) : [{ id: column.id, desc }],
          }))
        }
      />
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${column.header}`}
        className="absolute top-0 -right-[3px] z-10 h-full w-[6px] cursor-col-resize hover:bg-petrol/40"
        onPointerDown={resize}
        onDoubleClick={() =>
          onState((s) => {
            const widths = { ...s.widths };
            delete widths[column.id];
            return { ...s, widths };
          })
        }
      />
    </div>
  );
}

function FilterMenu<R>({
  floating,
  column,
  filter,
  sorted,
  rows,
  onFilter,
  onSort,
}: {
  floating: boolean;
  column: Column<R>;
  filter: Filter | undefined;
  sorted: "asc" | "desc" | null;
  rows: () => ReadonlyArray<R>;
  onFilter: (filter: Filter | undefined) => void;
  onSort: (desc: boolean | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const on = active(filter);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={`mr-1 flex h-[20px] w-[18px] flex-none items-center justify-center rounded-[3px] text-[11px] ${
          on ? "bg-petrol text-petrol-ink" : "text-ink-3 hover:bg-rule hover:text-ink"
        } ${
          floating && !on
            ? "absolute top-[6px] right-0 bg-sheet-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
            : ""
        }`}
        aria-label={`Filter and sort ${column.header}${on ? " (filtered)" : ""}`}
        data-testid={`filter-${column.id}`}
      >
        ▾
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={2} align="start" className="z-30">
          <Popover.Popup className="w-[280px] rounded-[3px] border border-rule-strong bg-sheet text-xs shadow-[0_8px_24px_rgb(0_0_0/0.16)] outline-none">
            {open ? (
              <FilterBody
                column={column}
                filter={filter}
                sorted={sorted}
                rows={rows()}
                onFilter={onFilter}
                onSort={(desc) => {
                  onSort(desc);
                  setOpen(false);
                }}
              />
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FilterBody<R>({
  column,
  filter,
  sorted,
  rows,
  onFilter,
  onSort,
}: {
  column: Column<R>;
  filter: Filter | undefined;
  sorted: "asc" | "desc" | null;
  rows: ReadonlyArray<R>;
  onFilter: (filter: Filter | undefined) => void;
  onSort: (desc: boolean | null) => void;
}) {
  const [search, setSearch] = useState("");
  const counts = useMemo(() => {
    const found = new Map<string, number>();
    for (const row of rows)
      for (const v of new Set(valuesOf(column, row))) found.set(v, (found.get(v) ?? 0) + 1);
    return [...found.entries()].sort(([a], [b]) =>
      a === EMPTY ? 1 : b === EMPTY ? -1 : a.localeCompare(b, undefined, { numeric: true }),
    );
  }, [rows, column]);
  const needle = search.trim().toLowerCase();
  const listed = needle ? counts.filter(([v]) => v.toLowerCase().includes(needle)) : counts;
  const kept = filter?.values ? new Set(filter.values) : null;
  const isKept = (v: string) => kept === null || kept.has(v);
  const contains = filter?.contains ?? "";
  const set = (values: Set<string> | null) => {
    const all = values !== null && counts.every(([v]) => values.has(v));
    onFilter({ values: values === null || all ? null : [...values], contains });
  };
  const toggle = (v: string) => {
    const next = new Set(kept ?? counts.map(([x]) => x));
    if (next.has(v)) next.delete(v);
    else next.add(v);
    set(next);
  };
  const allListed = listed.every(([v]) => isKept(v));
  return (
    <div className="grid gap-0" data-testid={`filter-menu-${column.id}`}>
      <div className="grid border-b border-rule py-1">
        <MenuButton on={sorted === "asc"} onClick={() => onSort(sorted === "asc" ? null : false)}>
          Sort ascending
        </MenuButton>
        <MenuButton on={sorted === "desc"} onClick={() => onSort(sorted === "desc" ? null : true)}>
          Sort descending
        </MenuButton>
      </div>
      <label className="grid gap-1 border-b border-rule px-2 py-1.5">
        <span className="text-2xs text-ink-3">Text contains</span>
        <input
          className="h-6 rounded-[2px] border border-rule-strong bg-sheet px-1.5 outline-none focus:border-petrol"
          value={contains}
          onChange={(e) =>
            onFilter({ values: filter?.values ?? null, contains: e.currentTarget.value })
          }
          aria-label={`${column.header} contains`}
        />
      </label>
      <div className="grid gap-1 px-2 pt-1.5">
        <input
          className="h-6 rounded-[2px] border border-rule-strong bg-sheet px-1.5 outline-none focus:border-petrol"
          placeholder="Search values"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          aria-label={`Search the values of ${column.header}`}
        />
        <label className="flex h-6 items-center gap-1.5 border-b border-rule">
          <input
            type="checkbox"
            checked={allListed}
            onChange={() => {
              const next = new Set(kept ?? counts.map(([x]) => x));
              for (const [v] of listed) {
                if (allListed) next.delete(v);
                else next.add(v);
              }
              set(next);
            }}
          />
          <span className="font-semibold">
            {needle ? `All ${listed.length} found` : "All values"}
          </span>
        </label>
      </div>
      <ul
        className="max-h-[260px] overflow-y-auto px-2 pb-1"
        aria-label={`Values of ${column.header}`}
      >
        {listed.slice(0, SHOWN_VALUES).map(([value, count]) => (
          <li key={value}>
            <label className="flex h-[22px] items-center gap-1.5">
              <input
                type="checkbox"
                aria-label={value}
                checked={isKept(value)}
                onChange={() => toggle(value)}
              />
              <span className={`min-w-0 flex-1 truncate ${value === EMPTY ? "text-ink-3" : ""}`}>
                {value}
              </span>
              <span className="text-ink-3 tabular-nums">{count}</span>
            </label>
          </li>
        ))}
        {listed.length > SHOWN_VALUES ? (
          <li className="py-1 text-ink-3">
            {listed.length - SHOWN_VALUES} more. Search to narrow the list.
          </li>
        ) : null}
      </ul>
      <div className="flex justify-end border-t border-rule px-2 py-1">
        <button
          type="button"
          className="px-1.5 py-0.5 text-petrol hover:underline disabled:text-ink-3 disabled:no-underline"
          disabled={!active(filter)}
          onClick={() => onFilter(undefined)}
        >
          Clear filter
        </button>
      </div>
    </div>
  );
}

function MenuButton({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`px-2 py-1 text-left hover:bg-sheet-2 ${on ? "font-semibold text-petrol" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MarkAll({
  all,
  some,
  count,
  onAll,
}: {
  all: boolean;
  some: boolean;
  count: number;
  onAll: (on: boolean) => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = some && !all;
  }, [some, all]);
  return (
    <input
      ref={box}
      type="checkbox"
      className="h-4 w-4 accent-petrol"
      checked={all}
      disabled={count === 0}
      aria-label={all ? "Deselect every row in view" : `Select all ${count} rows in view`}
      title={all ? "Deselect every row in view" : `Select all ${count} rows in view (a)`}
      onChange={() => onAll(!all)}
      onClick={(e) => {
        if (e.detail > 0) e.currentTarget.blur();
      }}
    />
  );
}
