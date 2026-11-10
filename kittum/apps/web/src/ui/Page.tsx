// The three page shells. Every screen uses one, so content starts at the same place everywhere.
//   data: full width with a 32px gutter, for tables and lists of records;
//   lead: a 1616px column with a 32px gutter, for the lead's pages (setup, protocol, reports);
//   reading: a document and a side rail, filling the screen (the screen builds its own columns).
import type { ReactNode } from "react";

export function Page({
  kind = "lead",
  title,
  summary,
  actions,
  children,
  testId,
}: {
  kind?: "data" | "lead";
  /** The screen's one heading. */
  title: ReactNode;
  /** One line under the heading: the state in counts. */
  summary?: ReactNode;
  /** Buttons at the right of the heading. */
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="h-full overflow-y-auto" data-testid={testId}>
      <div className={`px-8 pt-6 pb-12 ${kind === "lead" ? "mx-auto max-w-[1616px]" : ""}`}>
        <header className="flex flex-wrap items-start gap-x-6 gap-y-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold">{title}</h1>
            {summary ? <p className="mt-1 text-sm text-ink-2">{summary}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
        <div className="mt-5">{children}</div>
      </div>
    </div>
  );
}
