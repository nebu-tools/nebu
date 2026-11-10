// Reports (DESIGN.md, "Reports"): rendered from the ledger, never typed. One word for each
// action: a preview is computed now and kept nowhere (the cards' figures, the disclosure below
// them); Generate keeps a report's files and records the render in the ledger; Download saves a
// generated file. Each output says whether its last render is current, and every figure says
// whether the ledger behind it verifies: a report over a broken hash chain is an unverified
// draft. The server refuses anyone but the methods lead.
import { Dialog } from "@base-ui/react/dialog";
import { Link, useRouteContext } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type {
  AppraisableReport,
  AsOf,
  LedgerSummary,
  Milestone,
  PrismaFlow,
  RenderedReport,
  RetrievalItem,
  RunListing,
  SealedBundle,
} from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { formatDateTime } from "../../lib/format.ts";
import { isRegistryOnly, revealLabel } from "../../lib/labels.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/Empty.tsx";
import { useKeys } from "../../ui/keys.ts";
import { Page } from "../../ui/Page.tsx";
import { JUDGEMENTS, Status, VERDICTS, WAITS } from "../../ui/Status.tsx";
import type { Term } from "../../ui/Status.tsx";
import { LEAD_ONLY, useProject } from "../project.tsx";
import { DisclosureSection } from "./Disclosure.tsx";
import type { Disclosure } from "./Disclosure.tsx";
import { seenBefore, split, STAGES } from "./disclosure.ts";
import type { DisclosureStage } from "./disclosure.ts";
import {
  byFormat,
  DownloadLink,
  integrityAt,
  IntegrityStatus,
  OPEN_MARK,
  plural,
  SECTION,
  SectionHead,
  TH,
} from "./parts.tsx";
import type { Download, Integrity } from "./parts.tsx";

export { DisclosureSection };

/** The PRISMA counts as data beside the diagram, in flow order. */
const ROWS: ReadonlyArray<readonly [keyof PrismaFlow & string, string]> = [
  ["records_identified", "Records identified"],
  ["duplicates_removed", "Duplicates removed"],
  ["records_screened", "Records screened"],
  ["records_excluded", "Records excluded"],
  ["records_awaiting_screening", "Records not yet screened"],
  ["reports_sought", "Reports sought for retrieval"],
  ["reports_assessed", "Reports assessed for eligibility"],
  ["reports_excluded", "Reports excluded"],
  ["reports_included", "Reports included"],
  ["studies_included", "Studies included"],
];

/** Work a flow still has open, as words. */
const OPEN: ReadonlyArray<readonly [keyof PrismaFlow & string, string, string]> = [
  ["records_awaiting_screening", "record not yet screened", "records not yet screened"],
  ["records_unresolved", "record in conflict", "records in conflict"],
  ["reports_not_retrieved", "report without a full text", "reports without a full text"],
  ["reports_awaiting_assessment", "report not yet assessed", "reports not yet assessed"],
  [
    "reports_awaiting_classification",
    "report with insufficient information",
    "reports with insufficient information",
  ],
  ["reports_unresolved", "report in conflict", "reports in conflict"],
  [
    "records_outside_identity",
    "record found after the corpus was built",
    "records found after the corpus was built",
  ],
];

/** The open work of flows, as words. With the registry records known, the reports not
 * retrieved split into articles that need a PDF and registry records with no article yet, in the
 * words Retrieval and Progress use. */
const openWork = (flows: ReadonlyArray<PrismaFlow>, registry?: ReadonlySet<string> | null) =>
  OPEN.flatMap(([key, one, many]) => {
    const n = flows.reduce((sum, f) => sum + Number(f[key] ?? 0), 0);
    if (!n) return [];
    if (key !== "reports_not_retrieved" || !registry) return [plural(n, one, many)];
    const entries = flows
      .flatMap((f) => f.members["reports_not_retrieved"] ?? [])
      .filter((ref) => registry.has(ref)).length;
    return [
      n - entries ? plural(n - entries, "article needs a PDF", "articles need a PDF") : null,
      entries
        ? plural(entries, "registry record, no article yet", "registry records, no article yet")
        : null,
    ].filter((x) => x !== null);
  });

/** A PRISMA diagram: its SVG to inline, and the file to download. */
interface Diagram {
  readonly download: Download;
  readonly markup: string;
}

interface Extracted {
  readonly cutoff_seq: number;
  readonly values: ReadonlyArray<{
    readonly acceptance_id: string;
    readonly study: string;
    readonly field: string;
    readonly value: string | null;
    readonly unit: string | null;
    readonly produced_by: "janus" | "llm" | "manual_edit";
    readonly pages: ReadonlyArray<number>;
    readonly quote: string | null;
    readonly accepted_by: string;
  }>;
}

/** The risk-of-bias rows, as the `risk_of_bias` target writes them: one per result and domain. */
interface RiskOfBias {
  readonly cutoff_seq: number;
  readonly rows: ReadonlyArray<{
    readonly appraisal_id: string;
    readonly study: string;
    readonly result: string;
    readonly domain: string;
    readonly domain_title?: string;
    readonly judgement: "low" | "some_concerns" | "high" | null;
    readonly override_reason: string | null;
  }>;
}

/** What the landing page knows before anything is generated; each part may fail on its own. */
interface Overview {
  readonly asOf?: AsOf | null;
  readonly milestones?: ReadonlyArray<Milestone> | null;
  readonly runs?: ReadonlyArray<RunListing> | null;
  readonly appraisable?: ReadonlyArray<AppraisableReport> | null;
  readonly ledger?: LedgerSummary | null;
  /** Every report with its identifiers, to tell registry records from articles. */
  readonly reports?: ReadonlyArray<RetrievalItem> | null;
}

type Target = "prisma" | "ai_disclosure" | "extraction" | "risk_of_bias";
const TARGETS: ReadonlyArray<Target> = ["prisma", "ai_disclosure", "extraction", "risk_of_bias"];

const PRODUCED_BY = { janus: "Janus", llm: "LLM", manual_edit: "Edited by hand" } as const;

/** When a target was last generated, and whether anything but reports happened since. */
type Freshness =
  | { readonly kind: "unknown" }
  | { readonly kind: "never" }
  | { readonly kind: "current" | "outdated"; readonly at: Milestone; readonly newer: number };

function freshness(
  milestones: Overview["milestones"],
  head: number | undefined,
  matches: (m: Milestone) => boolean,
): Freshness {
  if (!milestones || head === undefined) return { kind: "unknown" };
  const at = milestones.filter(matches).at(-1);
  if (!at) return { kind: "never" };
  // Renders and seals after it change no figure; any other event may.
  const reports = milestones.filter(
    (m) => m.seq > at.seq && (m.kind === "report" || m.kind === "seal"),
  ).length;
  const newer = Math.max(0, head - at.seq - reports);
  return { kind: newer === 0 ? "current" : "outdated", at, newer };
}

const rendered = (target: Target) => (m: Milestone) =>
  m.kind === "report" && m.label === `${target} report rendered`;

export function ReportsScreen() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, seesLeadData, scopeLabel } = useProject();
  const lead = seesLeadData;
  const caller = { projectId: project.id, as: me.actor_id };
  const names = new Map(project.members.map((m) => [m.actor_id, m.display_name]));
  const [overview, setOverview] = useState<Overview>({});
  const [flows, setFlows] = useState<ReadonlyArray<{
    flow: PrismaFlow;
    svg: Diagram | null;
  }> | null>(null);
  const [disclosure, setDisclosure] = useState<{
    record: Disclosure;
    files: ReadonlyArray<Download>;
  } | null>(null);
  const [extracted, setExtracted] = useState<{
    record: Extracted;
    files: ReadonlyArray<Download>;
  } | null>(null);
  const [rob, setRob] = useState<{
    record: RiskOfBias;
    files: ReadonlyArray<Download>;
  } | null>(null);
  const [bundle, setBundle] = useState<SealedBundle | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ id: string; n: number } | null>(null);
  // The files of each target's last render, from its ledger event: downloadable again without
  // generating anything.
  const [stored, setStored] = useState<Partial<Record<Target, ReadonlyArray<StoredFile>>>>({});
  // The disclosure preview opens on request: "All outputs" shows the outputs, nothing more.
  const [previewOpen, setPreviewOpen] = useState(false);

  // What each output holds now, and when it was last generated: counted, not kept.
  const settle = <A,>(p: Promise<A>) => p.catch(() => null);
  /** After a render or a seal: the ledger has a new event, and the cards say so. */
  const reload = () => {
    void settle(run(workbench.milestones(caller))).then((milestones) =>
      setOverview((o) => ({ ...o, milestones })),
    );
    void settle(run(workbench.asOf({ ...caller, cutoffSeq: null }))).then((asOf) =>
      setOverview((o) => ({ ...o, asOf })),
    );
  };
  useEffect(() => {
    if (!lead) return;
    let live = true;
    const part =
      <K extends keyof Overview>(key: K) =>
      (value: Overview[K]) => {
        if (live) setOverview((o) => ({ ...o, [key]: value }));
      };
    void settle(run(workbench.asOf({ ...caller, cutoffSeq: null }))).then(part("asOf"));
    void settle(run(workbench.milestones(caller))).then(part("milestones"));
    void settle(run(workbench.extractionRuns(caller))).then(part("runs"));
    void settle(run(workbench.appraisableReports(caller))).then(part("appraisable"));
    void settle(run(workbench.ledger(caller))).then(part("ledger"));
    void settle(run(workbench.fullTexts(caller))).then(part("reports"));
    return () => {
      live = false;
    };
    // The caller is the project and the person; nothing else changes what the page counts.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [lead, workbench, project.id, me.actor_id]);

  useEffect(() => {
    const milestones = overview.milestones;
    if (!milestones) return;
    let live = true;
    for (const target of TARGETS) {
      const at = milestones.filter(rendered(target)).at(-1);
      if (!at) continue;
      void settle(run(workbench.ledgerEvents({ ...caller, afterSeq: at.seq - 1, limit: 1 }))).then(
        (page) => {
          const event = page?.events[0];
          const files =
            event?.seq === at.seq ? (event.payload as { files?: StoredFile[] }).files : undefined;
          if (live && files) setStored((s) => ({ ...s, [target]: files }));
        },
      );
    }
    return () => {
      live = false;
    };
    // The caller is the project and the person, as above.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [overview.milestones, workbench]);

  /** Downloads one file of a stored render. */
  const fetchFile = async (file: StoredFile) => {
    try {
      const bytes = await run(workbench.reportFile({ ...caller, sha256: file.sha256 }));
      const type = file.media_type.split(";")[0] ?? "application/octet-stream";
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
      const link = document.createElement("a");
      link.href = url;
      link.download = file.path.split("/").pop() ?? file.path;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof WorkbenchError ? e.message : "Kittum could not download the file.");
    }
  };

  // A generated report scrolls into view.
  useEffect(() => {
    if (shown) document.getElementById(shown.id)?.scrollIntoView?.({ block: "start" });
  }, [shown]);
  const show = (id: string) => setShown((s) => ({ id, n: (s?.n ?? 0) + 1 }));

  // Object URLs for the generated files live as long as the screen shows them. Each collection
  // revokes only its own URLs, so generating one report leaves the other's downloads working.
  useEffect(
    () => () => {
      for (const f of flows ?? []) if (f.svg) URL.revokeObjectURL(f.svg.download.url);
    },
    [flows],
  );
  useEffect(
    () => () => {
      for (const f of disclosure?.files ?? []) URL.revokeObjectURL(f.url);
    },
    [disclosure],
  );
  useEffect(
    () => () => {
      for (const f of extracted?.files ?? []) URL.revokeObjectURL(f.url);
    },
    [extracted],
  );
  useEffect(
    () => () => {
      for (const f of rob?.files ?? []) URL.revokeObjectURL(f.url);
    },
    [rob],
  );

  const act = async <A,>(what: string, failed: string, task: () => Promise<A>) => {
    setBusy(what);
    setError(null);
    try {
      const done = await task();
      reload();
      return done;
    } catch (e) {
      setError(e instanceof WorkbenchError ? e.message : failed);
      return null;
    } finally {
      setBusy(null);
    }
  };

  /** Generates a target and fetches every file it wrote. */
  const generate = async (target: Target) => {
    const done: RenderedReport = await run(workbench.renderReport({ ...caller, target }));
    return Promise.all(
      done.artifact.files.map(async (f) => {
        const bytes = await run(workbench.reportFile({ ...caller, sha256: f.sha256 }));
        const type = f.media_type.split(";")[0] ?? "application/octet-stream";
        const name = f.path.split("/").pop() ?? f.path;
        return {
          path: f.path,
          bytes,
          download: { name, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type })) },
        };
      }),
    );
  };
  const json = <T,>(bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as T;

  const generatePrisma = () =>
    act("Generating the PRISMA flow", "Kittum could not generate the PRISMA flow.", async () => {
      const files = await generate("prisma");
      setFlows(
        files
          .filter((f) => f.path.endsWith(".json"))
          .map((f) => {
            URL.revokeObjectURL(f.download.url); // the counts show on screen, not as a file
            const svg = files.find((d) => d.path === f.path.replace(/\.json$/, ".svg"));
            return {
              flow: json<PrismaFlow>(f.bytes),
              svg: svg
                ? { download: svg.download, markup: new TextDecoder().decode(svg.bytes) }
                : null,
            };
          }),
      );
      show("report-prisma");
    });

  const generateDisclosure = () =>
    act(
      "Generating the AI-use disclosure",
      "Kittum could not generate the AI-use disclosure.",
      async () => {
        const files = await generate("ai_disclosure");
        const record = files.find((f) => f.path.endsWith(".json"));
        if (record) {
          setDisclosure({
            record: json<Disclosure>(record.bytes),
            files: files.map((f) => f.download),
          });
          show("report-disclosure");
        }
      },
    );

  const generateExtracted = () =>
    act(
      "Generating the extracted values",
      "Kittum could not generate the extracted values.",
      async () => {
        const files = await generate("extraction");
        const record = files.find((f) => f.path.endsWith(".json"));
        if (record) {
          setExtracted({
            record: json<Extracted>(record.bytes),
            files: files.map((f) => f.download),
          });
          show("report-extracted");
        }
      },
    );

  const generateRob = () =>
    act(
      "Generating the risk-of-bias table",
      "Kittum could not generate the risk-of-bias table.",
      async () => {
        const files = await generate("risk_of_bias");
        const record = files.find((f) => f.path.endsWith(".json"));
        if (record) {
          setRob({
            record: json<RiskOfBias>(record.bytes),
            files: files.map((f) => f.download),
          });
          show("report-rob");
        }
      },
    );

  const seal = () =>
    act("Sealing the handover bundle", "Kittum could not seal the bundle.", async () => {
      setBundle(await run(workbench.sealBundle(caller)));
      show("report-bundle");
    });

  // What can be done now. Unknown counts leave an action enabled: the server has the last word.
  const head = overview.asOf?.head_seq;
  const preview = overview.asOf?.disclosure as Disclosure | undefined;
  const ledger = overview.ledger;
  const broken = ledger ? !ledger.ok : false;
  const brokenAt = ledger && !ledger.ok ? (ledger.verify?.first_bad_seq ?? null) : null;
  const accepted = overview.runs?.reduce((n, r) => n + r.accepted, 0);
  const appraisals = overview.appraisable?.flatMap((r) => r.appraisals).length;
  const registry = overview.reports
    ? new Set(overview.reports.filter(isRegistryOnly).map((r) => r.item_ref))
    : null;
  const open = openWork(overview.asOf?.flows ?? [], registry);
  const blocked = {
    extraction: accepted === 0 ? "No value is accepted yet." : null,
    rob: appraisals === 0 ? "No result is appraised yet." : null,
    bundle: broken ? "Kittum does not seal a ledger whose hash chain breaks." : null,
  };
  const integrity = (seq: number) => integrityAt(ledger, seq);
  const state = {
    prisma: freshness(overview.milestones, head, rendered("prisma")),
    ai_disclosure: freshness(overview.milestones, head, rendered("ai_disclosure")),
    extraction: freshness(overview.milestones, head, rendered("extraction")),
    risk_of_bias: freshness(overview.milestones, head, rendered("risk_of_bias")),
    bundle: freshness(overview.milestones, head, (m) => m.kind === "seal"),
  };
  // Generate is outlined on every row; the one filled button is the last step, sealing.
  const kind = (target: keyof typeof state) => (target === "bundle" ? "primary" : "secondary");

  useKeys((event) => {
    if (!lead || busy) return false;
    const action = {
      p: generatePrisma,
      a: generateDisclosure,
      e: blocked.extraction ? null : generateExtracted,
      b: blocked.rob ? null : generateRob,
      s: blocked.bundle ? null : seal,
    }[event.key];
    if (!action) return false;
    void action();
    return true;
  });

  if (!lead)
    return (
      <div className="h-full overflow-y-auto">
        <EmptyState
          title="Reports are the methods lead’s"
          actions={
            <Link
              to="/p/$projectId/progress"
              params={{ projectId: project.id }}
              className="text-petrol underline decoration-petrol/40 underline-offset-2"
            >
              See your progress
            </Link>
          }
        >
          Reports show every reviewer&rsquo;s decisions and the AI&rsquo;s readings. {LEAD_ONLY}
        </EmptyState>
      </div>
    );

  return (
    <Page
      kind="lead"
      title="Reports"
      summary={
        <>
          {head === undefined
            ? "Figures from the ledger."
            : `Figures from the ledger at event ${head}.`}
        </>
      }
    >
      {broken ? (
        <div
          role="alert"
          className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[4px] border border-exclude/50 bg-exclude-wash px-4 py-3 text-md text-exclude"
          data-testid="reports-unverified"
        >
          <Status term={{ ...VERDICTS.not_met, label: "Ledger breaks" }}>
            The ledger&rsquo;s hash chain breaks at event {brokenAt ?? "?"}.
          </Status>
          <span className="text-ink">
            Every report that covers it is an unverified draft until the break is explained.
          </span>
          <Link
            to="/p/$projectId/audit"
            params={{ projectId: project.id }}
            className="ml-auto font-medium text-petrol underline decoration-petrol/40 underline-offset-2"
          >
            Open the audit
          </Link>
        </div>
      ) : null}
      <p className="min-h-5 text-sm" aria-live="polite">
        {error ? (
          <span role="alert" className="text-exclude">
            {error}
          </span>
        ) : busy ? (
          <span className="text-ink-2">{busy}.</span>
        ) : null}
      </p>
      <Switcher
        sections={[
          ["report-outputs", "All outputs"],
          ...(flows?.length ? [["report-prisma", "PRISMA flow"] as const] : []),
          ...(disclosure || (previewOpen && preview?.stages?.length)
            ? [
                [
                  "report-disclosure",
                  disclosure ? "AI-use disclosure" : "AI-use disclosure (preview)",
                ] as const,
              ]
            : []),
          ...(extracted ? [["report-extracted", "Extracted values"] as const] : []),
          ...(rob ? [["report-rob", "Risk of bias"] as const] : []),
          ...(bundle ? [["report-bundle", "Handover bundle"] as const] : []),
        ]}
      />
      <div id="report-outputs" className="mt-4 scroll-mt-16">
        <section
          className="rounded-[6px] bg-raised px-5 py-4 shadow-raised"
          data-testid="report-outputs-panel"
        >
          <h2 className="text-md font-semibold">Outputs</h2>
          <p className="mt-0.5 text-sm text-ink-2">
            Preview keeps nothing. Generate keeps a report’s files and records it in the ledger.
            Download gets the files of the last one generated.
          </p>
          <table className="mt-3 w-full text-md" aria-label="Outputs">
            <thead>
              <tr className="border-b border-rule">
                <th className={TH}>Output</th>
                <th className={TH}>Now</th>
                <th className={TH}>Last generated</th>
                <th className={TH}>
                  <span className="sr-only">Preview</span>
                </th>
                <th className={TH}>
                  <span className="sr-only">Generate</span>
                </th>
                <th className={TH}>
                  <span className="sr-only">Download</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <OutputRow
                id="prisma"
                title="PRISMA 2020 flow"
                what="One flow diagram per question, as SVG, with the counts behind it."
                now={<PrismaNow asOf={overview.asOf} scopeLabel={scopeLabel} registry={registry} />}
                state={<FreshnessLine f={state.prisma} integrity={integrity} />}
                stored={stored.prisma}
                fetchFile={fetchFile}
              >
                <Button
                  kind={kind("prisma")}
                  keys={["p"]}
                  disabled={!!busy}
                  onClick={generatePrisma}
                  aria-label="Generate the flow diagram"
                >
                  Generate
                </Button>
              </OutputRow>
              <OutputRow
                id="ai_disclosure"
                title="AI-use disclosure"
                what="Which decisions were blind, what the AI proposed, agreement, and every prompt."
                now={<DisclosureNow asOf={overview.asOf} scopeLabel={scopeLabel} />}
                state={<FreshnessLine f={state.ai_disclosure} integrity={integrity} />}
                stored={stored.ai_disclosure}
                fetchFile={fetchFile}
                preview={
                  !disclosure && preview?.stages?.length ? (
                    <Button
                      aria-expanded={previewOpen}
                      aria-label="Preview the disclosure"
                      onClick={() => {
                        setPreviewOpen(true);
                        show("report-disclosure");
                      }}
                    >
                      Preview
                    </Button>
                  ) : null
                }
              >
                <Button
                  kind={kind("ai_disclosure")}
                  keys={["a"]}
                  disabled={!!busy}
                  onClick={generateDisclosure}
                  aria-label="Generate the disclosure"
                >
                  Generate
                </Button>
              </OutputRow>
              <OutputRow
                id="extraction"
                title="Extracted values"
                what="Every accepted value with its page and quote, as CSV and JSON."
                now={<ExtractionNow runs={overview.runs} />}
                state={<FreshnessLine f={state.extraction} integrity={integrity} />}
                stored={stored.extraction}
                fetchFile={fetchFile}
              >
                {blocked.extraction ? (
                  <Blocked
                    reason={blocked.extraction}
                    to="/p/$projectId/extraction"
                    go="Open Extraction"
                    projectId={project.id}
                  />
                ) : (
                  <Button
                    kind={kind("extraction")}
                    keys={["e"]}
                    disabled={!!busy}
                    onClick={generateExtracted}
                    aria-label="Generate the values table"
                  >
                    Generate
                  </Button>
                )}
              </OutputRow>
              <OutputRow
                id="risk_of_bias"
                title="Risk of bias"
                what="One row per appraised result, one column per domain, as CSV."
                now={<RiskOfBiasNow appraisable={overview.appraisable} />}
                state={<FreshnessLine f={state.risk_of_bias} integrity={integrity} />}
                stored={stored.risk_of_bias}
                fetchFile={fetchFile}
              >
                {blocked.rob ? (
                  <Blocked
                    reason={blocked.rob}
                    to="/p/$projectId/risk-of-bias"
                    go="Open Risk of bias"
                    projectId={project.id}
                  />
                ) : (
                  <Button
                    kind={kind("risk_of_bias")}
                    keys={["b"]}
                    disabled={!!busy}
                    onClick={generateRob}
                    aria-label="Generate the risk-of-bias table"
                  >
                    Generate
                  </Button>
                )}
              </OutputRow>
            </tbody>
          </table>
        </section>
        <section
          className="mt-5 flex flex-wrap items-start gap-x-10 gap-y-3 rounded-[4px] bg-sheet-2 px-5 py-4"
          data-testid="report-card-bundle"
        >
          <div className="min-w-[16rem]">
            <h2 className="text-md font-semibold">Handover bundle</h2>
            <p className="mt-0.5 text-sm text-ink-2">
              The last step: every report, the ledger, and the stored files, signed with the
              server’s key.
            </p>
          </div>
          <div className="text-sm">
            <BundleChecklist ledger={ledger} open={open} asOf={overview.asOf} />
          </div>
          <div className="text-sm" data-testid="report-state">
            <FreshnessLine f={state.bundle} integrity={integrity} noun="Sealed" />
          </div>
          <div className="ml-auto">
            <Button
              kind={kind("bundle")}
              keys={["s"]}
              disabled={!!busy || !!blocked.bundle}
              title={blocked.bundle ?? undefined}
              onClick={seal}
            >
              {open.length ? "Seal a draft bundle" : "Seal the bundle"}
            </Button>
          </div>
        </section>
      </div>

      {flows?.map(({ flow, svg }, i) => (
        <PrismaSection
          key={`${flow.topic_id}-${flow.scope_id}`}
          anchor={i === 0 ? "report-prisma" : undefined}
          flow={flow}
          svg={svg}
          scope={scopeLabel(flow.scope_id)}
          integrity={integrity(flow.cutoff_seq)}
          registry={registry}
        />
      ))}
      {disclosure ? (
        <DisclosureSection
          record={disclosure.record}
          files={disclosure.files}
          names={names}
          scopeLabel={scopeLabel}
          integrity={integrity(disclosure.record.cutoff_seq)}
        />
      ) : previewOpen && preview?.stages?.length ? (
        <DisclosureSection
          record={preview}
          files={[]}
          names={names}
          scopeLabel={scopeLabel}
          integrity={integrity(preview.cutoff_seq)}
          state={`Preview at ledger event ${preview.cutoff_seq}, kept nowhere. Generate it to keep it and download its files.`}
          actions={
            <Button disabled={!!busy} onClick={generateDisclosure}>
              Generate the disclosure
            </Button>
          }
        />
      ) : null}
      {extracted ? (
        <ExtractedSection
          record={extracted.record}
          files={extracted.files}
          integrity={integrity(extracted.record.cutoff_seq)}
        />
      ) : null}
      {rob ? (
        <RiskOfBiasSection
          record={rob.record}
          files={rob.files}
          integrity={integrity(rob.record.cutoff_seq)}
        />
      ) : null}
      {bundle ? <BundleSection bundle={bundle} /> : null}
    </Page>
  );
}

/** A bar that stays at the top while the reports below scroll, to jump between them; the report
 * in view is marked. */
function Switcher({ sections }: { sections: ReadonlyArray<readonly [string, string]> }) {
  const bar = useRef<HTMLElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const [stuck, setStuck] = useState(false);
  const ids = sections.map(([id]) => id).join(" ");
  useEffect(() => {
    const scroller = bar.current?.closest(".overflow-y-auto");
    if (!scroller) return;
    const update = () => {
      const top = (bar.current?.getBoundingClientRect().bottom ?? 0) + 24;
      let current: string | null = null;
      for (const id of ids.split(" ")) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= top) current = id;
      }
      setActive(current);
      setStuck(scroller.scrollTop > 60);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [ids]);
  return (
    <nav
      ref={bar}
      aria-label="Reports on this page"
      className="sticky top-0 z-10 -mt-2 flex flex-wrap items-center gap-1 bg-paper/95 py-2 backdrop-blur"
    >
      {/* Scrolled down, the page title scrolls away; the bar keeps its name. */}
      <span className={`mr-3 text-md font-semibold ${stuck ? "" : "hidden"}`} aria-hidden="true">
        Reports
      </span>
      {sections.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-current={active === id ? "location" : undefined}
          onClick={() => document.getElementById(id)?.scrollIntoView?.({ block: "start" })}
          className={`h-7 rounded-[4px] px-2.5 text-sm font-medium ${
            active === id
              ? "text-ink underline decoration-petrol decoration-2 underline-offset-[6px]"
              : "text-petrol hover:bg-petrol-wash"
          }`}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

// The landing page: one row per output in one raised panel, then the bundle as the last step.

/** A file of a stored render, as its `report.rendered` event lists it. */
interface StoredFile {
  readonly path: string;
  readonly sha256: string;
  readonly media_type: string;
}

function OutputRow({
  id,
  title,
  what,
  now,
  state,
  stored,
  fetchFile,
  preview,
  children,
}: {
  id: string;
  title: string;
  what: string;
  now: ReactNode;
  state: ReactNode;
  /** The files of the last render, to download without generating again. */
  stored: ReadonlyArray<StoredFile> | undefined;
  fetchFile: (file: StoredFile) => Promise<void>;
  /** Preview, where the output has one. */
  preview?: ReactNode;
  /** Generate, or where to go when it cannot work yet. */
  children: ReactNode;
}) {
  const files = (stored ?? []).filter((f) => !(id === "prisma" && f.path.endsWith(".json")));
  const kind = (f: StoredFile) => f.path.split(".").pop()?.toUpperCase() ?? "";
  const many = (f: StoredFile) => files.filter((g) => kind(g) === kind(f)).length > 1;
  return (
    <tr
      className="border-b border-rule align-top last:border-b-0"
      data-testid={`report-card-${id}`}
    >
      <td className="py-3 pr-6 whitespace-nowrap">
        <span className="font-medium">{title}</span>{" "}
        <abbr
          title={what}
          className="inline-flex size-[18px] cursor-help items-center justify-center rounded-full border border-rule-strong text-2xs font-semibold text-ink-2 no-underline"
        >
          ?
        </abbr>
      </td>
      <td className="py-3 pr-6 text-sm">{now}</td>
      <td className="py-3 pr-6 text-sm" data-testid="report-state">
        {state}
      </td>
      {/* Fixed columns, so each action sits at the same place on every row. */}
      <td className="w-px py-3 pr-2 text-right">{preview}</td>
      <td className="w-px py-3 pr-2 text-right">{children}</td>
      <td className="w-px py-3 text-right">
        {files.length ? (
          <details className="relative inline-block text-left">
            <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-[4px] border border-rule-strong bg-sheet px-3 text-sm font-medium whitespace-nowrap hover:border-ink-3 hover:bg-sheet-2">
              Download <span aria-hidden="true">▾</span>
            </summary>
            <ul className="absolute right-0 z-20 mt-1 min-w-[12rem] rounded-[4px] bg-raised py-1 shadow-raised">
              {files.map((f) => (
                <li key={f.sha256}>
                  <button
                    type="button"
                    title={f.path}
                    onClick={() => void fetchFile(f)}
                    className="block w-full px-3 py-1.5 text-left text-sm whitespace-nowrap hover:bg-sheet-2"
                  >
                    {many(f)
                      ? `${KIND_NAMES[kind(f)] ?? kind(f)}: ${f.path.split("/").pop()}`
                      : (KIND_NAMES[kind(f)] ?? kind(f))}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </td>
    </tr>
  );
}

const KIND_NAMES: Record<string, string> = { MD: "Markdown", JSON: "JSON", CSV: "CSV", SVG: "SVG" };

/** "Current", "Outdated", "Not generated yet", or an unverified draft, with when. */
function FreshnessLine({
  f,
  integrity,
  noun = "Generated",
}: {
  f: Freshness;
  integrity: (seq: number) => Integrity | null;
  noun?: string;
}) {
  if (f.kind === "unknown") return <span className="text-ink-2">&nbsp;</span>;
  if (f.kind === "never")
    return (
      <Status term={OPEN_MARK}>{noun === "Sealed" ? "Not sealed yet" : "Not generated yet"}</Status>
    );
  const when = `${noun} at event ${f.at.seq}, ${formatDateTime(f.at.recorded_at)}`;
  const check = integrity(f.at.seq);
  const term: Term =
    check && !check.verified
      ? { ...VERDICTS.not_met, label: "Unverified draft" }
      : f.kind === "current"
        ? { ...VERDICTS.met, label: "Current" }
        : { ...WAITS, label: "Outdated" };
  return (
    <div>
      <Status term={term}>
        {check && !check.verified
          ? "Unverified draft"
          : f.kind === "current"
            ? "Current"
            : `Newer ledger activity: ${plural(f.newer, "event", "events")} since`}
      </Status>
      <span className="mt-0.5 block text-ink-2">{when}.</span>
    </div>
  );
}

/** An action that cannot work yet: where to go instead, as a button; why, on hover. */
function Blocked({
  reason,
  to,
  go,
  projectId,
}: {
  reason: string;
  to: "/p/$projectId/extraction" | "/p/$projectId/risk-of-bias";
  go: string;
  projectId: string;
}) {
  return (
    <Link
      to={to}
      params={{ projectId }}
      title={reason}
      className="inline-flex h-8 items-center rounded-[4px] border border-rule-strong bg-sheet px-3 text-sm font-medium whitespace-nowrap text-ink hover:border-ink-3 hover:bg-sheet-2"
    >
      {go}
    </Link>
  );
}

function Pending({ value, failed }: { value: unknown; failed: string }) {
  return <span className="text-ink-2">{value === undefined ? "Counting." : failed}</span>;
}

/** The flow now, in one line, and its open work in a second. */
function PrismaNow({
  asOf,
  scopeLabel,
  registry,
}: {
  registry: ReadonlySet<string> | null;
  asOf: AsOf | null | undefined;
  scopeLabel: (id: string) => string;
}) {
  if (!asOf) return <Pending value={asOf} failed="Kittum could not count the flow just now." />;
  if (asOf.flows.length === 0)
    return <span className="text-ink-2">No protocol is published yet.</span>;
  const open = openWork(asOf.flows, registry);
  const failing = asOf.flows.flatMap((f) => f.checks).filter((c) => !c.holds).length;
  const only = asOf.flows.length === 1 ? asOf.flows[0] : undefined;
  return (
    <>
      <span className="block">
        {only
          ? `${only.records_identified} identified, ${only.records_screened} screened, ${plural(only.studies_included, "study", "studies")} included`
          : asOf.flows
              .map(
                (f) =>
                  `${scopeLabel(f.scope_id)}: ${plural(f.studies_included, "study", "studies")}`,
              )
              .join("; ")}
      </span>
      {failing ? (
        <span className="block text-exclude">
          {plural(failing, "sum does", "sums do")} not add up.
        </span>
      ) : null}
      {open.length ? <span className="block text-ink-2">Open: {open.join(", ")}</span> : null}
    </>
  );
}

function DisclosureNow({
  asOf,
  scopeLabel,
}: {
  asOf: AsOf | null | undefined;
  scopeLabel: (id: string) => string;
}) {
  if (!asOf) return <Pending value={asOf} failed="Kittum could not read the stages just now." />;
  const stages = ((asOf.disclosure as { stages?: DisclosureStage[] }).stages ?? []).filter(
    (s) => s.records > 0,
  );
  if (stages.length === 0)
    return <span className="text-ink-2">No screening stage is open yet.</span>;
  const scopes = new Set(stages.map((s) => s.scope_id)).size;
  return (
    <>
      {stages.map((s) => {
        const counts = split(s);
        const name = scopes > 1 ? `${STAGES[s.stage]}, ${scopeLabel(s.scope_id)}` : STAGES[s.stage];
        return (
          <span key={`${s.stage}-${s.scope_id}`} className="block">
            {name}:{" "}
            {!counts
              ? revealLabel(s.reveal)
              : seenBefore(s)
                ? `${counts.onScreen} of ${counts.total} decided with the AI’s reading on screen`
                : `all ${counts.total} decided blind`}
          </span>
        );
      })}
    </>
  );
}

function ExtractionNow({ runs }: { runs: ReadonlyArray<RunListing> | null | undefined }) {
  if (!runs) return <Pending value={runs} failed="Kittum could not list the runs just now." />;
  if (runs.length === 0) return <span className="text-ink-2">No extraction run yet.</span>;
  const accepted = runs.reduce((n, r) => n + r.accepted, 0);
  const fields = runs.reduce((n, r) => n + r.fields, 0);
  const reports = new Set(runs.map((r) => r.run.report_id)).size;
  return (
    <span>
      {accepted} of {fields} fields accepted in {plural(runs.length, "run", "runs")} on{" "}
      {plural(reports, "report", "reports")}
    </span>
  );
}

function RiskOfBiasNow({
  appraisable,
}: {
  appraisable: ReadonlyArray<AppraisableReport> | null | undefined;
}) {
  if (!appraisable)
    return <Pending value={appraisable} failed="Kittum could not list the reports just now." />;
  if (appraisable.length === 0)
    return <span className="text-ink-2">No report is included at full text yet.</span>;
  const appraisals = appraisable.flatMap((r) => r.appraisals);
  const judged = appraisals.filter((a) => a.judgement !== null).length;
  const started = appraisable.filter((r) => r.appraisals.length > 0).length;
  return (
    <span>
      {started} of {plural(appraisable.length, "included report", "included reports")} appraised,{" "}
      {judged} of {plural(appraisals.length, "result", "results")} judged
    </span>
  );
}

/** What sealing needs, each with its state: the ledger, the open work, and the signing key. */
function BundleChecklist({
  ledger,
  open,
  asOf,
}: {
  ledger: LedgerSummary | null | undefined;
  open: ReadonlyArray<string>;
  asOf: AsOf | null | undefined;
}) {
  return (
    <ul className="space-y-1.5" data-testid="bundle-checklist">
      <li>
        {!ledger ? (
          <Status term={OPEN_MARK}>Ledger not checked yet</Status>
        ) : ledger.ok ? (
          <Status term={{ ...VERDICTS.met, label: "Ledger verified" }}>
            Ledger verified through event {ledger.checked_through_seq ?? "?"}
          </Status>
        ) : (
          <Status term={{ ...VERDICTS.not_met, label: "Ledger breaks" }}>
            Ledger breaks at event {ledger.verify?.first_bad_seq ?? "?"}
          </Status>
        )}
      </li>
      <li>
        {asOf === undefined ? (
          <Status term={OPEN_MARK}>Open work not counted yet</Status>
        ) : open.length ? (
          <>
            <Status term={{ ...WAITS, label: "Open work" }}>Open: {open.join(", ")}</Status>
            <span className="mt-0.5 block pl-6 text-ink-2">Sealing now makes a draft bundle.</span>
          </>
        ) : (
          <Status term={{ ...VERDICTS.met, label: "Nothing open" }}>
            Nothing open in the flow
          </Status>
        )}
      </li>
      <li>
        <Status term={OPEN_MARK}>Signing key: checked when you seal</Status>
      </li>
    </ul>
  );
}

// The generated reports.

/**
 * The rendered SVG, inlined in the page so its text uses the workbench's font (an SVG shown as
 * an image cannot reach the page's web fonts and falls back to whatever the system has).
 */
/** The figure as a PNG, drawn in the browser at twice its size on a white page. An SVG drawn as
 * an image cannot reach the page's web fonts, so the PNG uses the fallback font the SVG names. */
async function downloadPng(markup: string, name: string) {
  const source = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("the figure did not load"));
      image.src = source;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth * scale;
    canvas.height = image.naturalHeight * scale;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.scale(scale, scale);
    context.drawImage(image, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(png);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  } finally {
    URL.revokeObjectURL(source);
  }
}

function InlineSvg({ markup, className }: { markup: string; className: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parsed = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
    if (parsed.nodeName !== "svg") return;
    host.current?.replaceChildren(document.importNode(parsed, true));
  }, [markup]);
  return (
    <div ref={host} className={`${className} [&_text]:font-sans`} data-testid="prisma-diagram" />
  );
}

/**
 * One scope's PRISMA flow. It opens fitted to the screen, so the final box shows; "Full width"
 * draws it as wide as the column, and a click opens it larger still. Beside it: whether the
 * ledger verifies, whether the sums add up, what is still open, and the counts as data.
 */
function PrismaSection({
  anchor,
  flow,
  svg,
  scope,
  integrity,
  registry,
}: {
  anchor?: string | undefined;
  flow: PrismaFlow;
  svg: Diagram | null;
  scope: string;
  integrity: Integrity | null;
  registry: ReadonlySet<string> | null;
}) {
  const [large, setLarge] = useState(false);
  const [fit, setFit] = useState(true);
  const alt = `PRISMA 2020 flow diagram for ${scope}`;
  const file = svg ? { ...svg.download, name: `prisma-${flow.scope_id}.svg` } : null;
  const failing = flow.checks.filter((c) => !c.holds);
  const open = openWork([flow], registry);
  const size = fit
    ? "[&>svg]:h-auto [&>svg]:max-h-[calc(100vh-14rem)] [&>svg]:w-auto [&>svg]:max-w-full"
    : "[&>svg]:h-auto [&>svg]:w-full";
  return (
    <section id={anchor} className={SECTION} data-testid="prisma-flow" data-scope={flow.scope_id}>
      <SectionHead
        title="PRISMA 2020 flow"
        state={`Generated at ledger event ${flow.cutoff_seq}`}
        seq={flow.cutoff_seq}
      >
        {svg ? (
          <div
            role="group"
            aria-label="Diagram size"
            className="flex rounded-[4px] border border-rule-strong"
          >
            {(
              [
                [true, "Fit to screen"],
                [false, "Full width"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={label}
                type="button"
                aria-pressed={fit === value}
                onClick={() => setFit(value)}
                className={`h-8 px-3 text-sm font-medium ${
                  fit === value ? "bg-petrol-wash text-petrol" : "text-ink-2 hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        {file && svg ? (
          <>
            <DownloadLink file={file} />
            <Button
              title="A raster copy at twice the figure’s size, for slides and word processors. It uses a system font."
              onClick={() => void downloadPng(svg.markup, file.name.replace(/\.svg$/, ".png"))}
            >
              Download PNG
            </Button>
          </>
        ) : null}
      </SectionHead>
      <ul
        className="mt-3 flex flex-wrap items-start gap-x-8 gap-y-1 text-md"
        aria-label="Checks"
        data-testid="prisma-checks"
      >
        <li>
          <IntegrityStatus integrity={integrity} seq={flow.cutoff_seq} />
        </li>
        <li>
          {failing.length === 0 ? (
            <Status term={{ ...VERDICTS.met, label: "Arithmetic checks pass" }}>
              Arithmetic checks: {flow.checks.length} of {flow.checks.length} passed
            </Status>
          ) : (
            <span
              title={failing.map((c) => `${c.name}: ${c.expected} against ${c.actual}`).join("; ")}
            >
              <Status term={{ ...VERDICTS.not_met, label: "Arithmetic checks fail" }}>
                Arithmetic checks: {flow.checks.length - failing.length} of {flow.checks.length}{" "}
                passed
              </Status>
            </span>
          )}
        </li>
        <li>
          {open.length ? (
            <Status term={{ ...OPEN_MARK, label: "Still open" }}>
              Still open: {open.join(", ")}
            </Status>
          ) : (
            <Status term={{ ...VERDICTS.met, label: "Nothing open" }}>
              Nothing is open in this flow
            </Status>
          )}
        </li>
      </ul>
      <div className="mt-4">
        {svg && file ? (
          <Dialog.Root open={large} onOpenChange={setLarge}>
            <Dialog.Trigger
              className="mx-auto block max-w-full cursor-zoom-in rounded-[6px] bg-white p-3 shadow-raised"
              aria-label={`Enlarge the ${alt}`}
            >
              <InlineSvg markup={svg.markup} className={size} />
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Backdrop className="fixed inset-0 bg-[rgb(10_20_24/0.5)]" />
              <Dialog.Popup className="fixed inset-4 overflow-auto rounded-[4px] bg-white p-4 outline-none">
                <Dialog.Title className="sr-only">{alt}</Dialog.Title>
                <div className="flex items-center justify-end gap-3 pb-2">
                  <DownloadLink file={file} />
                  <Dialog.Close className="inline-flex h-8 items-center rounded-[4px] px-3 text-sm font-medium text-petrol hover:bg-petrol-wash">
                    Close
                  </Dialog.Close>
                </div>
                <InlineSvg
                  markup={svg.markup}
                  className="mx-auto w-[1400px] [&>svg]:h-auto [&>svg]:w-full"
                />
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        ) : (
          <p className="text-md text-ink-2">Kittum wrote no diagram for this flow.</p>
        )}
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-ink-2 hover:text-ink">The counts as data</summary>
        <dl className="mt-2 grid max-w-[36rem] grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 tabular-nums">
          {ROWS.map(([key, label]) => (
            <div key={key} className="contents">
              <dt className="text-ink-2">{label}</dt>
              <dd className="text-right font-semibold" data-testid={`prisma-${key}`}>
                {String(flow[key] ?? "")}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

/** The accepted extraction values, one row per study and field, with both files to download. */
function ExtractedSection({
  record,
  files,
  integrity,
}: {
  record: Extracted;
  files: ReadonlyArray<Download>;
  integrity: Integrity | null;
}) {
  return (
    <section id="report-extracted" className={SECTION} data-testid="extracted">
      <SectionHead
        title="Extracted values"
        state={`Generated at ledger event ${record.cutoff_seq}`}
        integrity={integrity}
        seq={record.cutoff_seq}
      >
        {byFormat(files).map((f) => (
          <DownloadLink key={f.name} file={f} />
        ))}
      </SectionHead>
      <p className="mt-3 text-md text-ink-2">
        {record.values.length === 0
          ? "Nobody has accepted an extracted value yet."
          : `${plural(record.values.length, "accepted value", "accepted values")}, one row per study and field. The sealed bundle carries the same files.`}
      </p>
      {record.values.length > 0 ? (
        <table className="mt-3 w-full text-md" data-testid="extracted-values">
          <thead>
            <tr className="border-b border-rule">
              <th className={TH}>Study</th>
              <th className={TH}>Field</th>
              <th className={`${TH} text-right`}>Value</th>
              <th className={`${TH} pl-4`}>From</th>
              <th className={TH}>Source</th>
              <th className={TH}>Accepted by</th>
            </tr>
          </thead>
          <tbody>
            {record.values.map((v) => (
              <tr key={v.acceptance_id} className="border-b border-rule align-baseline">
                <td className="py-2 pr-4">{v.study}</td>
                <td className="pr-4">{v.field}</td>
                <td className="pr-4 text-right font-semibold tabular-nums">
                  {v.value ?? "Empty"}
                  {v.unit ? <span className="font-normal text-ink-2"> {v.unit}</span> : null}
                </td>
                <td className="pr-4 pl-4">{PRODUCED_BY[v.produced_by]}</td>
                <td className="max-w-[32rem] pr-4 text-sm text-ink-2">
                  {v.pages.length ? `Page ${v.pages.join(", ")}. ` : ""}
                  {v.quote ? `"${v.quote}"` : ""}
                </td>
                <td>{v.accepted_by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function RiskOfBiasSection({
  record,
  files,
  integrity,
}: {
  record: RiskOfBias;
  files: ReadonlyArray<Download>;
  integrity: Integrity | null;
}) {
  const domains = [...new Set(record.rows.map((r) => r.domain))].filter((d) => d !== "overall");
  const titles = new Map(record.rows.map((r) => [r.domain, r.domain_title]));
  const results = [...new Set(record.rows.map((r) => r.appraisal_id))].map((id) =>
    record.rows.filter((r) => r.appraisal_id === id),
  );
  const overridden = record.rows.some((r) => r.override_reason);
  return (
    <section id="report-rob" className={SECTION} data-testid="risk-of-bias">
      <SectionHead
        title="Risk of bias"
        state={`Generated at ledger event ${record.cutoff_seq}`}
        integrity={integrity}
        seq={record.cutoff_seq}
      >
        {byFormat(files).map((f) => (
          <DownloadLink key={f.name} file={f} />
        ))}
      </SectionHead>
      {results.length === 0 ? (
        <p className="mt-3 text-md text-ink-2">Nobody has appraised a result yet.</p>
      ) : (
        <>
          <table className="mt-4 w-full text-md" data-testid="risk-of-bias-table">
            <thead>
              <tr className="border-b border-rule">
                <th className={TH}>Study</th>
                <th className={TH}>Result</th>
                {domains.map((d) => (
                  <th key={d} className={TH} title={titles.get(d)}>
                    {d}
                  </th>
                ))}
                <th className={TH}>Overall</th>
              </tr>
            </thead>
            <tbody>
              {results.map((rows) => (
                <tr key={rows[0]?.appraisal_id} className="border-b border-rule align-middle">
                  <td className="py-2 pr-4">{rows[0]?.study}</td>
                  <td className="pr-4">{rows[0]?.result}</td>
                  {[...domains, "overall"].map((d) => {
                    const row = rows.find((r) => r.domain === d);
                    return (
                      <td key={d} className="pr-4" title={row?.override_reason ?? undefined}>
                        {row?.judgement ? (
                          <Status term={JUDGEMENTS[row.judgement]}>
                            {JUDGEMENTS[row.judgement].label}
                            {row.override_reason ? " †" : ""}
                          </Status>
                        ) : (
                          <Status term={OPEN_MARK}>Not yet</Status>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ink-2">
            {domains.map((d) => (
              <span key={d}>
                {d}: {titles.get(d) ?? d}
              </span>
            ))}
            {overridden ? (
              <span>† Judged against the algorithm; the reason is in the CSV and on hover.</span>
            ) : null}
          </p>
        </>
      )}
    </section>
  );
}

function BundleSection({ bundle }: { bundle: SealedBundle }) {
  return (
    <section id="report-bundle" className={SECTION} data-testid="bundle">
      <SectionHead
        title="Handover bundle sealed"
        state={`Sealed at ledger event ${bundle.cutoff_seq}`}
        seq={bundle.cutoff_seq}
      />
      <dl className="mt-3 grid grid-cols-[10rem_minmax(0,1fr)] gap-y-1 text-md">
        <dt className="text-ink-2">On the server at</dt>
        <dd className="break-all" data-testid="bundle-path">
          {bundle.path}
        </dd>
        <dt className="text-ink-2">At ledger event</dt>
        <dd className="tabular-nums">{bundle.cutoff_seq}</dd>
      </dl>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-ink-2 hover:text-ink">
          Manifest hash and signing key
        </summary>
        <dl className="mt-1 grid grid-cols-[10rem_minmax(0,1fr)] gap-y-1">
          <dt className="text-ink-2">Manifest</dt>
          <dd className="break-all text-ink-2">{bundle.manifest_hash}</dd>
          <dt className="text-ink-2">Signing key</dt>
          <dd className="break-all text-ink-2">{bundle.key_id}</dd>
        </dl>
      </details>
      <p className="mt-3 text-md text-ink-2">
        Anyone can check the bundle offline with <code>kittum verify {bundle.path}</code>. Add the
        public key of this key ID to confirm who signed it.
      </p>
    </section>
  );
}
