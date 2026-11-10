// One pattern for empty and finished states: what is done or empty, for whom and where, the
// figures that matter, and where to go next. Nothing is being worked on, so there is no sheet:
// the state sits on the page, left-aligned with every other page's content.
import type { ReactNode } from "react";

export function EmptyState({
  title,
  children,
  figures,
  actions,
  testId,
}: {
  title: string;
  /** One or two sentences: what this state means. */
  children?: ReactNode;
  /** Label and value pairs. */
  figures?: ReadonlyArray<readonly [string, ReactNode]>;
  /** Links or buttons to the next step. */
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="max-w-[720px] px-8 py-10" data-testid={testId}>
      <h1 className="text-xl font-semibold">{title}</h1>
      {children ? <div className="mt-2 text-md text-ink-2">{children}</div> : null}
      {figures?.length ? (
        <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-10 gap-y-2 text-md">
          {figures.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-2">{label}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {actions ? <div className="mt-8 flex flex-wrap items-center gap-3">{actions}</div> : null}
    </div>
  );
}
