// Pieces every report section on the Reports screen shares: its heading line with the state of
// the report, its downloads, and the marks for whether the ledger behind it verifies.
import type { ReactNode } from "react";

import { NOT_DONE, Status, VERDICTS } from "../../ui/Status.tsx";
import type { Term } from "../../ui/Status.tsx";

/** A generated file, ready to download. */
export interface Download {
  readonly name: string;
  readonly url: string;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Not done, missing, or not known yet: the shared circle. */
export const OPEN_MARK: Term = NOT_DONE;

/** What the ledger check says about figures at a ledger event. */
export interface Integrity {
  /** The chain verifies at least through the event. */
  readonly verified: boolean;
  /** The first broken event, when the chain breaks at or before the event. */
  readonly breaksAt: number | null;
  /** Through which event the check passed, when it passed. */
  readonly checkedThrough: number | null;
}

/** The ledger check for figures at `seq`, from the project's ledger summary; null if unknown. */
export function integrityAt(
  ledger:
    | {
        readonly ok: boolean;
        readonly checked_through_seq?: number | null;
        readonly verify?: { readonly first_bad_seq?: number | null } | null;
      }
    | null
    | undefined,
  seq: number,
): Integrity | null {
  if (!ledger) return null;
  if (ledger.ok)
    return { verified: true, breaksAt: null, checkedThrough: ledger.checked_through_seq ?? null };
  const bad = ledger.verify?.first_bad_seq ?? null;
  // A break after the event leaves everything up to it intact.
  if (bad !== null && bad > seq) return { verified: true, breaksAt: null, checkedThrough: bad - 1 };
  return { verified: false, breaksAt: bad, checkedThrough: null };
}

/** The ledger mark beside a report's own checks: verified, or an unverified draft. */
export function IntegrityStatus({ integrity, seq }: { integrity: Integrity | null; seq: number }) {
  if (!integrity) return <Status term={OPEN_MARK}>Ledger not checked yet</Status>;
  return integrity.verified ? (
    <Status term={{ ...VERDICTS.met, label: "Ledger verified" }}>
      Ledger verified through event {Math.max(seq, integrity.checkedThrough ?? seq)}
    </Status>
  ) : (
    <span
      data-testid="unverified"
      title={`The ledger’s hash chain breaks at event ${integrity.breaksAt ?? "?"}, at or before this report’s event ${seq}. Kittum cannot vouch for its figures until the break is explained on the Audit screen.`}
    >
      <Status term={{ ...VERDICTS.not_met, label: "Unverified draft" }}>
        Unverified draft: the ledger breaks at event {integrity.breaksAt ?? "?"}
      </Status>
    </span>
  );
}

const KIND: Record<string, string> = {
  md: "Markdown",
  json: "JSON",
  csv: "CSV",
  svg: "SVG",
};

/** A generated file as a download button named by its format; the file name is in the hover. */
export function DownloadLink({ file }: { file: Download }) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return (
    <a
      href={file.url}
      download={file.name}
      title={file.name}
      className="inline-flex h-8 items-center rounded-[4px] border border-rule-strong bg-sheet px-3 text-sm font-medium whitespace-nowrap hover:border-ink-3 hover:bg-sheet-2"
    >
      Download {KIND[ext] ?? ext.toUpperCase()}
    </a>
  );
}

/** Downloads in reading order: the human formats first, the data last. */
export const byFormat = (files: ReadonlyArray<Download>) => {
  const order = ["svg", "md", "csv", "json"];
  const rank = (f: Download) => {
    const i = order.indexOf(f.name.split(".").pop()?.toLowerCase() ?? "");
    return i === -1 ? order.length : i;
  };
  return [...files].sort((a, b) => rank(a) - rank(b));
};

/** A report section's heading: its title, what it is (generated or a preview, at which event),
 * the ledger mark, and its actions. */
export function SectionHead({
  title,
  state,
  integrity,
  seq,
  children,
}: {
  title: string;
  state: ReactNode;
  integrity?: Integrity | null | undefined;
  seq: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-2">
          <span>{state}</span>
          {/* The header's ledger mark says a verified ledger once; a report says only a break. */}
          {integrity && !integrity.verified ? (
            <IntegrityStatus integrity={integrity} seq={seq} />
          ) : null}
        </p>
      </div>
      {children ? (
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

/** A generated report on the page: plain, set off by space; its figure or table is the sheet. */
export const SECTION = "mt-12 scroll-mt-16";
export const TH = "py-1.5 pr-4 text-left text-sm font-normal text-ink-2";
export const NUM = "py-2 pr-4 text-right tabular-nums";
