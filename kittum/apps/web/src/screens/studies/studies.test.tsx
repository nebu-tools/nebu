// Studies on the mock with a small built corpus: a confirmed duplicate, a proposed study link,
// and an enrichment run in which OpenAlex failed for one record. The lead sees what needs work in
// the summary, follows the failure to the record it failed for, and works the links by keyboard.
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { makeMockWorkbench } from "../../data/mock/index.ts";
import type {
  CorpusView,
  EnrichmentRun,
  LinkProposal,
  RecordEnrichment,
  RecordFlag,
  SourceRecord,
} from "../../data/schema.ts";
import type { Workbench } from "../../data/workbench.ts";
import { createAppRouter } from "../../router.tsx";
import { press } from "../../test/app.tsx";
import { rememberReviewer } from "../project.tsx";
import "../../styles.css";

// The mock's methods lead, in a project without stages, so the lead sees every record.
const PROJECT = "zanidatamab-btc";
const LEAD = "0192f0c4-5a10-7d1e-9c3a-0000000000ff";

const record = (id: string, source: string, title: string, doi: string | null): SourceRecord => ({
  occurrence_id: id,
  ordinal: 0,
  provider_record_id: id,
  raw_hash: "0".repeat(64),
  source,
  title,
  doi,
  year: 2025,
  authors: ["Free C", "Knight R"],
});

const PAPER = "Text messaging for smoking cessation: a randomised trial";
const REGISTRY = "Text messaging trial registration";
const ORPHAN = "A record OpenAlex could not place";

const CORPUS: CorpusView = {
  revision: { id: "rev-1", project_id: PROJECT, event_seq: 19 },
  searches: [
    {
      id: "s-1",
      kind: "file_import",
      platform: "PubMed",
      retrieved_count: 4,
      source: "medline",
      started_at: "2026-11-08T19:55:00Z",
    },
    {
      id: "s-2",
      kind: "file_import",
      platform: "Europe PMC",
      retrieved_count: 1,
      source: "source1",
      started_at: "2026-11-08T19:56:00Z",
    },
  ],
  reports: [
    {
      report_id: "r-1",
      study_id: "st-1",
      relation: "same_record",
      records: [
        record("o-a", "medline", PAPER, "10.1/sms"),
        record("o-b", "source1", PAPER, "10.1/sms"),
      ],
      search_ids: ["s-1", "s-2"],
    },
    {
      report_id: "r-2",
      study_id: "st-2",
      relation: "standalone",
      records: [record("o-c", "medline", REGISTRY, null)],
      search_ids: ["s-1"],
    },
    {
      report_id: "r-3",
      study_id: "st-3",
      relation: "standalone",
      records: [record("o-d", "medline", ORPHAN, "10.1/orphan")],
      search_ids: ["s-1"],
    },
    {
      report_id: "r-4",
      study_id: "st-4",
      relation: "standalone",
      records: [record("o-e", "medline", "Another trial", "10.1/other")],
      search_ids: ["s-1"],
    },
  ],
  links: [
    {
      evidence: ["Same DOI 10.1/sms"],
      linked_by: "confirmed",
      occurrence_ids: ["o-a", "o-b"],
      relation: "same_record",
      revision_id: "rev-1",
    },
  ],
};

const PROPOSALS: ReadonlyArray<LinkProposal> = [
  {
    id: "p-1",
    evidence: ["Same NCT ID NCT01"],
    occurrence_ids: ["o-a", "o-c"],
    relation: "same_study",
    status: "pending",
  },
];

// OpenAlex answers for another work (a wrong match); Europe PMC is down (a failure).
const source = (name: string, failed = 0, kind: "other_work" | "http_error" = "other_work") => ({
  source: name,
  asked: 5,
  answered: 4 - failed,
  failed,
  last_failure: failed
    ? {
        source: name,
        reason: kind === "other_work" ? "other work" : "HTTP 503",
        kind,
        status: kind === "http_error" ? 503 : null,
        message: null,
      }
    : null,
});

const RUN: EnrichmentRun = {
  id: "run-1",
  identity_revision_id: "rev-1",
  status: "done",
  trigger: "corpus_built",
  records: 5,
  done: 5,
  retracted: 0,
  requested_at: "2026-11-08T19:57:00Z",
  requested_by: LEAD,
  finished_at: "2026-11-08T20:01:00Z",
  sources: [
    source("openalex", 1),
    source("europepmc", 1, "http_error"),
    source("crossref"),
    source("unpaywall"),
    source("pubtator"),
  ],
};

const ALL = ["openalex", "europepmc", "crossref", "unpaywall", "pubtator"];
const FLAGS: ReadonlyArray<RecordFlag> = ["o-a", "o-b", "o-c", "o-d", "o-e"].map((id) => ({
  occurrence_id: id,
  retracted: false,
  updates: [],
  open_access: false,
  sources: id === "o-d" ? ALL.filter((s) => s !== "openalex") : ALL,
}));

const enriched = (id: string): RecordEnrichment => ({
  occurrence_id: id,
  title: ORPHAN,
  abstract: null,
  clinical_trial_numbers: [],
  doi: "10.1/orphan",
  pmid: null,
  pmcid: null,
  enriched_at: "2026-11-08T20:00:00Z",
  entities: [],
  failures:
    id === "o-d"
      ? [
          {
            source: "openalex",
            reason: "other work",
            kind: "other_work",
            status: null,
            message: null,
          },
        ]
      : [],
  field_sources: [],
  oa_locations: [],
  retracted: false,
  retraction_notice_doi: null,
  search_source: "medline",
  updates: [],
});

function mountStudies() {
  const confirmed: string[] = [];
  const workbench: Workbench = {
    ...makeMockWorkbench(),
    corpus: () => Effect.succeed(CORPUS),
    proposals: () =>
      Effect.succeed(
        PROPOSALS.map((p) =>
          confirmed.includes(p.id ?? "") ? { ...p, status: "confirmed" as const } : p,
        ),
      ),
    enrichment: () => Effect.succeed(RUN),
    enrichmentFlags: () => Effect.succeed(FLAGS),
    recordEnrichment: ({ occurrenceId }) => Effect.succeed(enriched(occurrenceId)),
    link: (request) => {
      if ("proposalId" in request && request.proposalId) confirmed.push(request.proposalId);
      return Effect.succeed(CORPUS.revision);
    },
  } as Workbench;
  rememberReviewer(PROJECT, LEAD);
  const router = createAppRouter(
    workbench,
    createMemoryHistory({ initialEntries: [`/p/${PROJECT}/studies`] }),
  );
  const container = document.createElement("div");
  container.style.height = "1000px";
  document.body.replaceChildren(container);
  const root = createRoot(container);
  root.render(<RouterProvider router={router} />);
  return { confirmed, unmount: () => root.unmount() };
}

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  localStorage.clear();
});

describe("studies", () => {
  test("the summary, the enrichment problems traced to their records, and the links by keyboard", async () => {
    const app = mountStudies();
    unmount = app.unmount;

    // The strip is a sum; the summary names the open work, not the figures again.
    await expect.element(page.getByTestId("corpus-records")).toHaveTextContent("5");
    await expect.element(page.getByTestId("corpus-duplicates")).toHaveTextContent("1");
    await expect.element(page.getByTestId("corpus-reports")).toHaveTextContent("4");
    await expect.element(page.getByTestId("corpus-studies")).toHaveTextContent("4");
    await expect
      .element(page.getByRole("button", { name: "Review 1 proposed link" }))
      .toBeVisible();
    // A wrong match waits for the lead (amber); a failed call is a failure (red).
    await expect.element(page.getByRole("button", { name: "Check 1 wrong match" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "1 enrichment failure" })).toBeVisible();
    expect(document.body.textContent).not.toContain("ledger event");
    expect(document.body.textContent).not.toMatch(/medline|source1/);
    expect(document.body.textContent).not.toContain("Searches in the corpus");

    // The enrichment table is folded context; its one line still names the wrong match.
    const table = page.getByRole("button", { name: "Enrichment from the open sources" });
    await expect.element(table).toHaveAttribute("aria-expanded", "false");
    expect(page.getByTestId("enrichment").element().textContent).toContain("1 wrong match");

    // The wrong match and the failure are on the sheet, with the record and the repair.
    await page.getByRole("button", { name: "Check 1 wrong match" }).click();
    const problems = page.getByRole("region", { name: "Enrichment problems" });
    await expect.element(problems).toBeVisible();
    const text = problems.element().textContent ?? "";
    expect(text).toContain("1 wrong match from OpenAlex");
    expect(text).toContain("Europe PMC failed for 1 record");
    expect(text).toContain("Free 2025 " + ORPHAN);
    // Only the failed call can be retried; a wrong match needs a person.
    await expect
      .element(problems.getByRole("button", { name: "Retry the failed source" }))
      .toBeVisible();
    await problems.getByRole("button", { name: "Open the record" }).click();
    const detail = page.getByRole("complementary", { name: "Enrichment of the selected record" });
    await expect.element(detail).toBeVisible();
    expect(detail.element().textContent).toContain(ORPHAN);
    await press("Escape");
    await expect.element(detail).not.toBeInTheDocument();

    // The confirmed duplicate is one row: name, match, searches, status; its records are folded.
    const group = page.getByTestId("linked-study");
    const row = group.element().textContent ?? "";
    expect(row).toContain("Free 2025 " + PAPER);
    expect(row).toContain("Same DOI");
    expect(row).toContain("MEDLINE, Europe PMC");
    // The row names the study once: the folded group does not repeat its title.
    expect(row.split(PAPER).length - 1).toBe(1);
    expect(row).toContain("Confirmed");
    await expect
      .element(group.getByTestId("link-reason"))
      .toHaveTextContent("MergedSame DOI 10.1/sms. The methods lead confirmed it.");
    await expect.element(group.getByTestId("study-record").first()).not.toBeVisible();

    // From the top: the proposal, then the folded group's first record, which unfolds it.
    await press("k");
    await press("k");
    await press("k");
    await press("k");
    await press("k");
    await expect.element(page.getByTestId("proposal")).toHaveAttribute("aria-current", "true");
    await press("j");
    await expect.element(group.getByTestId("study-record").first()).toBeVisible();
    await expect.element(group.getByRole("button", { name: /Split out/ })).toBeVisible();
    await expect
      .element(group.getByRole("button", { name: /Merge with another study/ }))
      .toBeVisible();
    // No key footer: the selected row's buttons carry the keys.
    expect(document.querySelector("footer")).toBeNull();

    // Enter confirms the selected link; a click on its row selects it, as the keys do.
    await page.getByText("Same NCT ID NCT01").click();
    await press("Enter");
    await expect
      .element(page.getByTestId("studies-notice"))
      .toHaveTextContent("Confirmed the link.");
    expect(app.confirmed).toEqual(["p-1"]);
  });
});
