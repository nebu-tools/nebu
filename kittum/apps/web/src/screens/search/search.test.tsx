// Search on the mock: two imported searches, a long PubMed query and a short Europe PMC one, and
// a known pool the searches found half of. The lead reads the counts in the summary, opens the
// missed papers from it, follows a missed paper to its DOI, and opens one query in full.
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { makeMockWorkbench } from "../../data/mock/index.ts";
import { PROTOCOL } from "../../data/mock/protocol.ts";
import type {
  PoolComparison,
  PoolEntry,
  SearchExecution,
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
const TOPIC = "T2-indirect";

const LONG_QUERY = Array.from(
  { length: 12 },
  (_, i) => `(smoking cessation[tiab] OR quit${i}*[tiab] OR "stop smoking"[tiab])`,
).join(" AND ");

const search = (
  id: string,
  source: string,
  platform: string,
  strategy: string,
  count: number,
): SearchExecution => ({
  id,
  kind: "file_import",
  plan: { source, platform, strategy, topic_id: TOPIC },
  query_translation: null,
  raw_artifact_hashes: ["a".repeat(64)],
  records: [],
  reported_count: count,
  retrieved_count: count,
  started_at: "2026-11-08T19:55:00Z",
  ended_at: "2026-11-08T19:55:00Z",
});

const SEARCHES = [
  // The server lists the newest first.
  search("s-2", "source1", "Europe PMC", 'TITLE_ABS:"smoking cessation" AND TITLE_ABS:app', 12),
  search("s-1", "medline", "PubMed", LONG_QUERY, 33),
];

const paper = (id: string, title: string, doi: string | null): PoolEntry => ({
  id,
  file_id: "f-1",
  record: {
    occurrence_id: id,
    ordinal: 0,
    provider_record_id: id,
    raw_hash: "0".repeat(64),
    source: "known",
    title,
    doi,
    year: 2014,
    authors: ["Abroms LC", "Boal AL"],
  } satisfies SourceRecord,
});

const POOL: PoolComparison = {
  topic_id: TOPIC,
  basis: "records",
  pool_size: 2,
  in_pool: 1,
  searched: 45,
  new: 44,
  found: [{ entry: paper("k-1", "Found trial", "10.1/found"), evidence: "DOI", refs: [] }],
  not_found: [
    {
      ...paper("k-2", "A Randomized Trial of Text2Quit", "10.1016/j.amepre.2014.04.010"),
      record: {
        ...paper("k-2", "A Randomized Trial of Text2Quit", "10.1016/j.amepre.2014.04.010").record,
        abstract: "Text2Quit sends text messages to people who want to quit smoking.",
      },
    },
  ],
  files: [
    {
      id: "f-1",
      entries: 2,
      file_hash: "b".repeat(64),
      file_name: "known papers.xlsx",
      format: "records-xlsx",
      imported_at: "2026-11-08T19:50:00Z",
      imported_by: LEAD,
      topic_id: TOPIC,
    },
  ],
};

function mountSearch() {
  const withdrawn: string[] = [];
  const workbench = {
    ...makeMockWorkbench(),
    protocol: () => Effect.succeed(PROTOCOL),
    searches: () => Effect.succeed(SEARCHES),
    knownPool: () => Effect.succeed(POOL),
    withdrawKnownPool: ({ fileId }: { fileId: string }) => {
      withdrawn.push(fileId);
      return Effect.succeed(POOL.files[0]);
    },
  } as unknown as Workbench;
  rememberReviewer(PROJECT, LEAD);
  const router = createAppRouter(
    workbench,
    createMemoryHistory({ initialEntries: [`/p/${PROJECT}/search`] }),
  );
  const container = document.createElement("div");
  container.style.height = "1000px";
  document.body.replaceChildren(container);
  const root = createRoot(container);
  root.render(<RouterProvider router={router} />);
  return { withdrawn, unmount: () => root.unmount() };
}

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  localStorage.clear();
});

describe("search", () => {
  test("the summary counts, the missed papers with their DOI, and a query in full", async () => {
    const app = mountSearch();
    unmount = app.unmount;

    const summary = page.getByTestId("search-summary");
    await expect.element(summary.getByTestId("pool-new")).toHaveTextContent("44");
    expect(summary.element().textContent).toContain("1 of 2known papers found (50%)");
    await expect
      .element(
        page.getByText(/^Check each missing paper against the queries before you build the corpus/),
      )
      .toBeVisible();
    // Database names, not the source IDs.
    expect(document.body.textContent).not.toMatch(/medline|source1/);

    // The strip has the counts; the pool's panel lists the papers, named as studies.
    const pool = page.getByTestId(`pool-${TOPIC}`);
    await expect.element(summary.getByTestId("pool-missed")).toHaveTextContent("1");
    await pool.getByRole("tab", { name: /Found/ }).click();
    await expect.element(pool.getByRole("list", { name: "Found by the search" })).toBeVisible();
    await summary.getByRole("button", { name: "Show the 1 missing" }).click();
    const missed = pool.getByRole("list", { name: "Not found by the search" });
    await expect.element(missed).toBeVisible();
    expect(missed.element().textContent).toContain("Abroms 2014 A Randomized Trial of Text2Quit");
    expect(pool.element().textContent).not.toMatch(/of 2 known papers/);
    await missed.getByRole("button", { name: "Show the abstract" }).click();
    await expect.element(missed.getByText(/^Text2Quit sends text messages/)).toBeVisible();
    await expect
      .element(missed.getByRole("link", { name: "DOI 10.1016/j.amepre.2014.04.010" }))
      .toHaveAttribute("href", "https://doi.org/10.1016/j.amepre.2014.04.010");

    // Taking a file out asks first.
    await pool.getByRole("button", { name: "Remove this file" }).click();
    expect(app.withdrawn).toEqual([]);
    await pool.getByRole("button", { name: "Remove it" }).click();
    await expect.poll(() => app.withdrawn).toEqual(["f-1"]);

    // Every query is cut to three lines and offers the same "View full query".
    const pubmed = page.getByRole("article", { name: "PubMed search" });
    const europe = page.getByRole("article", { name: "Europe PMC search" });
    await expect.element(pubmed.getByRole("button", { name: /View full query/ })).toBeVisible();
    await expect.element(europe.getByRole("button", { name: /View full query/ })).toBeVisible();
    expect(missed.element().textContent).toContain("Search the title in PubMed");
    // PubMed is the first search run, so it is selected: Enter opens its query.
    (document.activeElement as HTMLElement | null)?.blur();
    await press("Enter");
    await expect
      .element(pubmed.getByRole("button", { name: /Hide the full query/ }))
      .toHaveAttribute("aria-expanded", "true");
    await expect.element(pubmed.getByRole("button", { name: "Copy the query" })).toBeVisible();
  });
});
