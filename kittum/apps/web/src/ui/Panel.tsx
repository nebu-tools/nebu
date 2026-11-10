// Two levels of depth (DESIGN-RULES, round 7). A raised panel is the sheet a person works on,
// lifted off the page: one per screen, two at most. A recessed panel holds context, summaries,
// and folded detail, set into the page. Inside either, groups are flat: spacing and a small
// heading, no more boxes. Never put a raised panel inside a raised one. A panel can start
// folded; folded, it shows its title and one summary line.
import { useState } from "react";
import type { ReactNode } from "react";

export function Panel({
  title,
  summary,
  actions,
  children,
  fold,
  className,
  testId,
  level = "raised",
  id,
  label,
}: {
  title?: ReactNode;
  /** One line under the title; also what a folded panel shows. */
  summary?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** Folding: "open" or "closed" to start that way; omitted, the panel does not fold. */
  fold?: "open" | "closed";
  className?: string;
  testId?: string;
  /** "raised" for the working surface, "recessed" for context around it. */
  level?: "raised" | "recessed";
  /** An anchor to scroll to; the panel takes focus when a link jumps to it. */
  id?: string;
  /** The accessible name when the title is not plain text. */
  label?: string;
}) {
  const [open, setOpen] = useState(fold !== "closed");
  const head =
    title || summary || actions ? (
      <header className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 pt-4">
        <div className="min-w-0 flex-1">
          {title ? (
            fold ? (
              <button
                type="button"
                className="flex items-center gap-2 text-left text-md font-semibold"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
              >
                <span
                  aria-hidden="true"
                  className={`text-ink-3 transition-transform ${open ? "rotate-90" : ""}`}
                >
                  ›
                </span>
                {title}
              </button>
            ) : (
              <h2 className="text-md font-semibold">{title}</h2>
            )
          ) : null}
          {summary ? <p className="mt-0.5 text-sm text-ink-2">{summary}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
    ) : null;
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      aria-label={label}
      className={`outline-none ${level === "raised" ? "rounded-[6px] bg-raised shadow-raised" : "rounded-[4px] bg-sheet-2"} ${className ?? ""}`}
      data-testid={testId}
    >
      {head}
      {open && children ? <div className={head ? "px-5 pt-3 pb-5" : "p-5"}>{children}</div> : null}
      {!open && head ? <div className="pb-4" /> : null}
    </section>
  );
}
