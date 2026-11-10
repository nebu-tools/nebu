import * as Effect from "effect/Effect";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { ScreeningTable, StageInfo, TableRow } from "../../data/schema.ts";
import type { Workbench } from "../../data/workbench.ts";
import { hold, mount, press } from "../../test/app.tsx";
import { distance, haystack, matcher } from "./table/fuzzy.ts";

const TABLE = "/p/ivosidenib-cca/screening/table";

const count = () => page.getByTestId("row-count");
const firstRow = () => page.getByRole("row").nth(1);
const selectedRow = () =>
  document.querySelector("[role=row][aria-selected=true]")?.textContent ?? "";

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  localStorage.clear();
});

describe("quick search", () => {
  const clarIdhy = haystack(
    [
      "Ivosidenib in IDH1-mutant cholangiocarcinoma (ClarIDHy)",
      "Abou-Alfa GK; Macarulla T",
      "Lancet Oncol",
    ],
    "Patients were randomly assigned 2:1 to ivosidenib or placebo; median survival was 10.3 months.",
  );

  test("finds a typo in the title, authors, or journal, and the abstract as written", () => {
    expect(matcher("ivosidinib")?.(clarIdhy)).toBeGreaterThan(0);
    expect(matcher("macarula lancet")?.(clarIdhy)).toBeGreaterThan(0);
    expect(matcher("abou-alfa")?.(clarIdhy)).toBeGreaterThan(0);
    expect(matcher("placebo")?.(clarIdhy)).toBeGreaterThan(0);
    // Every word must match; a typo in the abstract alone is not enough.
    expect(matcher("ivosidenib pembrolizumab")?.(clarIdhy)).toBe(0);
    expect(matcher("placbo")?.(clarIdhy)).toBe(0);
    // Short words allow no typo: "RCT" is not "ACT".
    expect(matcher("act")?.(haystack(["An RCT"], ""))).toBe(0);
    // Accents and case do not matter.
    expect(matcher("SÖDERBERG")?.(haystack(["Soderberg L"], ""))).toBeGreaterThan(0);
    // Title matches rank above abstract matches.
    expect(matcher("ivosidenib")?.(clarIdhy)).toBeGreaterThan(matcher("placebo")?.(clarIdhy) ?? 0);
    expect(matcher("  ")).toBeNull();
  });

  test("counts a swap of neighbouring letters as one edit", () => {
    expect(distance("cholangiocarcinoma", "cholangiocracinoma", 2)).toBe(1);
    expect(distance("gemcitabine", "gemcitibane", 2)).toBe(2);
    expect(distance("abc", "xyz", 1)).toBe(2);
  });
});

describe("screening table", () => {
  test("filters, searches, sorts, decides a row by keyboard, and opens one in the queue", async () => {
    const app = mount(TABLE);
    unmount = app.unmount;

    // The reviewer's own 28 records, in queue order, with nothing decided yet. The record pane
    // opens only with a record selected.
    await expect.element(count()).toMatchTextContent("28 records · 0 decided");
    await expect.element(firstRow()).toMatchTextContent("ClarIDHy");
    await expect.element(page.getByTestId("row-pane")).not.toBeInTheDocument();

    // Quick search: as written in title or abstract, and with a typo in a title.
    const search = page.getByLabelText("Quick search");
    await userEvent.fill(search, "ivosidenib");
    await expect.element(count()).toMatchTextContent("4 of 28 records");
    await userEvent.fill(search, "futibatinb");
    await expect.element(count()).toMatchTextContent("1 of 28 records");
    await expect.element(firstRow()).toMatchTextContent("Futibatinib");
    await userEvent.fill(search, "");

    // Year and Journal are optional columns (the Study column names the year); the ▾ menu of a
    // column is a checklist of its values.
    await page.getByRole("button", { name: /^Columns/ }).click();
    const chooser = page.getByTestId("column-chooser");
    await chooser.getByRole("checkbox", { name: "Year" }).click();
    await chooser.getByRole("checkbox", { name: "Journal" }).click();
    await press("Escape");
    await page.getByTestId("filter-year").click();
    const menu = page.getByTestId("filter-menu-year");
    await menu.getByRole("checkbox", { name: "All values" }).click();
    await expect.element(count()).toMatchTextContent("0 of 28 records");
    await menu.getByRole("checkbox", { name: "2020" }).click();
    await expect.element(count()).toMatchTextContent("2 of 28 records");
    await menu.getByRole("button", { name: "Clear filter" }).click();
    await press("Escape");
    await expect.element(count()).toMatchTextContent("28 records");

    // "Text contains" on the journal, then sorting by year, oldest first.
    await page.getByTestId("filter-journal").click();
    await page.getByLabelText("Journal contains").fill("lancet");
    await press("Escape");
    await expect.element(count()).toMatchTextContent("of 28 records");
    await page.getByRole("button", { name: "Sort by Year" }).click();
    await expect.element(firstRow()).toMatchTextContent("2016");

    // Decide the selected row with the queue's keys; the selection moves on.
    await firstRow().click();
    await expect.element(page.getByTestId("row-detail")).toMatchTextContent("Nanoliposomal");
    await press("e");
    await press("1");
    await expect.element(count()).toMatchTextContent("1 decided");
    expect(app.workbench.decisions.map((d) => [d.assignmentId, d.decision.outcome])).toEqual([
      ["asg-ta-26615328", "exclude"],
    ]);
    // The next row is BILCAP. With only undecided records in view, including it shows the AI's
    // disagreement in the pane; the row stays until Space keeps the decision, as in the queue.
    await expect.element(page.getByTestId("row-detail")).toMatchTextContent("BILCAP");
    await page.getByTestId("filter-decision").click();
    const decisions = page.getByTestId("filter-menu-decision");
    await decisions.getByRole("checkbox", { name: "Exclude" }).click();
    await press("Escape");
    await press("i");
    await expect.element(page.getByTestId("row-detail")).toMatchTextContent("Not met");
    await expect.poll(selectedRow).toContain("BILCAP");
    await expect.element(count()).toMatchTextContent("1 decided");
    await press(" ");
    await expect.element(count()).toMatchTextContent("2 decided");
    expect(app.workbench.decisions.at(-1)?.phase).toBe("final");
    await expect
      .element(page.getByRole("row").filter({ hasText: "BILCAP" }))
      .not.toBeInTheDocument();
    // A held key decides one record, not every record it repeats over.
    const before = app.workbench.decisions.length;
    await hold("u", 4);
    await expect.element(count()).toMatchTextContent("3 decided");
    expect(app.workbench.decisions.length).toBe(before + 1);
    await page.getByTestId("filter-decision").click();
    await decisions.getByRole("button", { name: "Clear filter" }).click();
    await press("Escape");

    // The view stays where the reviewer left it, in this browser.
    app.unmount();
    unmount = mount(TABLE).unmount;
    await expect.element(firstRow()).toMatchTextContent("2016");
    await expect.element(count()).toMatchTextContent("of 28 records");
  });

  test("opens the selected record in the queue, which keeps its own order", async () => {
    const app = mount(TABLE);
    unmount = app.unmount;
    await expect.element(count()).toMatchTextContent("28 records");
    // The eighth record of the queue.
    await page
      .getByRole("row")
      .filter({ hasText: "Nanoliposomal irinotecan with fluorouracil" })
      .click();
    await press("Enter");
    await expect
      .element(page.getByTestId("record-title"))
      .toMatchTextContent("Nanoliposomal irinotecan with fluorouracil");
    // The queue goes on from there. (NAPOLI-1 is a pancreatic trial: excluded on population.)
    await press("e");
    await press("1");
    await expect
      .element(page.getByTestId("record-title"))
      .toMatchTextContent("Comparison of second-line");
  });
});

type Writable = { -readonly [K in keyof Workbench]: Workbench[K] };

/** The mock's table, changed row by row: a working topic's proposals, or the lead's view. */
const reshape = (
  workbench: Workbench,
  change: (table: ScreeningTable) => Partial<ScreeningTable>,
  row: (r: TableRow, index: number) => Partial<TableRow>,
) => {
  const writable = workbench as unknown as Writable;
  const base = writable.screeningTable;
  writable.screeningTable = (request) =>
    Effect.map(base(request), (t) => ({
      ...t,
      ...change(t),
      rows: t.rows.map((r, i) => ({ ...r, ...row(r, i) })),
    }));
  const sent: Array<Parameters<Workbench["bulkDecide"]>[0]> = [];
  writable.bulkDecide = (request) => {
    sent.push(request);
    return Effect.succeed({
      batch_id: "0190a8c0-0000-7000-8000-00000000000b",
      decided: request.rows.length,
      awaiting_final: 0,
      recorded_at: "2026-11-08T19:55:00Z",
    });
  };
  return sent;
};

describe("acting on a group", () => {
  test("a working topic's screener picks the AI's exclusions on one criterion and decides them in one batch", async () => {
    const app = mount(TABLE);
    unmount = app.unmount;
    // Every third record the AI excludes on criterion 1, three of them on a quote Kittum did not
    // find; it includes the rest, five of them with criterion 4 unclear.
    const reading = (unclear: boolean) => ({
      excludes: false,
      quote_spans: {},
      criteria: [
        {
          criterion_id: "C_DES_RCT",
          status: unclear ? ("unclear" as const) : ("met" as const),
          quote: null,
          quote_verified: false,
          rationale: unclear ? "The abstract does not say how arms were assigned." : "",
        },
      ],
    });
    const sent = reshape(
      app.workbench,
      () => ({ documentation: "working" }),
      (_, i) => ({
        ...(i % 3 === 0 ? {} : { ai: reading(i % 4 === 1) }),
        ai_proposal:
          i % 3 === 0
            ? {
                outcome: "exclude",
                reason_criterion_id: "C_POP_ADV_BTC",
                rationale: "Pancreatic cancer, not biliary tract cancer.",
                quote: "metastatic pancreatic ductal adenocarcinoma",
                verified: i > 20 ? false : true,
              }
            : { outcome: "include" },
      }),
    );
    await expect.element(count()).toMatchTextContent("28 records · 0 decided");
    // The proposal reads as the decision and the criterion's number and short name; one whose
    // quote Kittum did not find says so, in grey.
    await expect
      .element(page.getByRole("gridcell", { name: "Exclude on 1 Advanced BTC" }).first())
      .toBeVisible();
    await expect
      .element(page.getByRole("gridcell", { name: "No quote: exclude on 1 Advanced BTC" }).first())
      .toBeVisible();

    // A row's checkbox selects it without opening it; selected rows that share a proposal get
    // that proposal as a named action.
    await page.getByRole("row").nth(8).getByRole("checkbox").click();
    await page
      .getByRole("row")
      .nth(9)
      .getByRole("checkbox")
      .click({ modifiers: ["Shift"] });
    await expect
      .element(page.getByTestId("bulk-count"))
      .toHaveTextContent("2 selected · 2 to decide");
    await expect.element(page.getByTestId("row-pane")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Include 2 records, as the AI proposes" }))
      .toBeVisible();
    await press("Escape");
    await expect.element(page.getByTestId("bulk-bar")).not.toBeInTheDocument();

    // Every row selected: accepting the AI's proposals leaves out the three with no quote and
    // the five includes with an unclear criterion, unless the screener adds them.
    await page.getByRole("checkbox", { name: "Select all 28 rows in view" }).click();
    await expect
      .element(page.getByTestId("bulk-count"))
      .toHaveTextContent("28 selected · 28 to decide");
    await expect
      .element(page.getByTestId("bulk-unchecked"))
      .toMatchTextContent(
        "3 exclusions with no quote and 5 includes with an unclear criterion left out",
      );
    await expect
      .element(page.getByRole("button", { name: /^Accept the AI's proposals \(20\)/ }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /as the AI proposes/ }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Deselect them" }).click();
    await expect
      .element(page.getByTestId("bulk-count"))
      .toHaveTextContent("20 selected · 20 to decide");
    await press("Escape");

    // The chips count each group in two rows: what can be decided together, and what a person
    // reads one by one, as two counted selectors (the unclear includes by criterion, and the
    // exclusions with no quote).
    const chips = page.getByTestId("chips-together");
    const unclearOn = page.getByRole("combobox", { name: "Unclear on criterion" });
    const noQuote = page.getByRole("combobox", { name: "No quote, exclude on criterion" });
    await expect
      .element(chips.getByRole("button", { name: "Include, all criteria met (13)" }))
      .toBeVisible();
    await expect.element(noQuote).toMatchTextContent("1 Advanced BTC (3)");
    await expect.element(unclearOn).toMatchTextContent("4 RCT (5)");

    // An include with an unclear criterion is a group of its own: a person reads each.
    await userEvent.selectOptions(unclearOn, "Unclear: 4 RCT");
    await expect.element(count()).toMatchTextContent("5 of 28 records");
    const unclearBar = page.getByTestId("group-bar");
    await expect.element(unclearBar).toMatchTextContent("criterion as unclear");
    await expect
      .element(unclearBar.getByRole("button", { name: /^Include these/ }))
      .not.toBeInTheDocument();
    await userEvent.selectOptions(unclearOn, "");
    await expect.element(count()).toMatchTextContent("28 records");
    // The clear includes have the group's action.
    await chips.getByRole("button", { name: "Include, all criteria met (13)" }).click();
    await expect
      .element(unclearBar.getByRole("button", { name: "Include these 13" }))
      .toBeVisible();
    await chips.getByRole("button", { name: "Include, all criteria met (13)" }).click();

    // A group with no quote offers only to screen its records one by one.
    await userEvent.selectOptions(noQuote, "No quote: exclude on 1 Advanced BTC");
    const bar = page.getByTestId("group-bar");
    await expect.element(bar).toMatchTextContent("3 to decide");
    await expect
      .element(bar.getByRole("button", { name: /^Exclude these/ }))
      .not.toBeInTheDocument();
    await bar.getByRole("button", { name: "Screen them one by one" }).click();
    await expect.element(page.getByTestId("row-no-quote")).toBeVisible();
    await page.getByRole("button", { name: "Close the record" }).click();

    // A checked group: the bar names the group and its one action.
    await chips.getByRole("button", { name: "Exclude on 1 Advanced BTC (7)" }).click();
    await expect.element(count()).toMatchTextContent("7 of 28 records");
    await expect.element(bar).toMatchTextContent("7 records in “Exclude on 1 Advanced BTC”");
    await bar.getByRole("button", { name: "Exclude these 7 on 1 Advanced BTC" }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]?.action).toBe("accept_ai");
    expect(sent[0]?.rows).toHaveLength(7);
    expect(
      sent[0]?.rows.every(
        (r) => r.proposal?.reason_criterion_id === "C_POP_ADV_BTC" && r.proposal.verified,
      ),
    ).toBe(true);
    expect(sent[0]?.filter).toBe("AI proposal group is Exclude on 1 Advanced BTC");
    await expect.element(page.getByText(/^Gave the AI's proposals to 7 records/)).toBeVisible();
  });
});

describe("the methods lead's table", () => {
  test("a decision cell and a By column, the disagreements as chips, an outdated reading, and no empty columns", async () => {
    const app = mount(TABLE);
    unmount = app.unmount;
    // Every fourth record is included, which the AI excludes as not an RCT; the rest are
    // excluded on criterion 1, as the AI proposes. Jun Park and Sam Okafor take turns. The AI
    // read them with version 1.1.
    reshape(
      app.workbench,
      () => ({ view: "lead", documentation: "complete", protocol_version_label: "1.1" }),
      (r, i) => ({
        assignment_id: null,
        etag: null,
        position: null,
        ai_protocol_hash: "0".repeat(64),
        outcome: i % 4 === 0 ? "include" : "exclude",
        outcome_reason: i % 4 === 0 ? null : "C_POP_ADV_BTC",
        flags: [],
        decisions: [
          {
            state: "decided",
            name: i % 2 ? "Jun Park" : "Sam Okafor",
            role: "screener",
            reviewer_id: "0190a8c0-0000-7000-8000-0000000000aa",
            outcome: i % 4 === 0 ? "include" : "exclude",
            reason_criterion_id: i % 4 === 0 ? null : "C_POP_ADV_BTC",
            decided_at: "2026-11-08T18:55:00Z",
          },
        ],
        ai_proposal:
          i % 4 === 0
            ? { outcome: "exclude", reason_criterion_id: "C_DES_RCT", verified: true }
            : { outcome: "exclude", reason_criterion_id: "C_POP_ADV_BTC", verified: true },
        reveal: null,
        title: r.title,
      }),
    );
    await expect.element(count()).toMatchTextContent("28 records · 28 with an outcome");
    // The outcome and its reason in one cell, who decided in the next; empty and repeated
    // columns stay hidden.
    await expect
      .element(page.getByRole("gridcell", { name: "Exclude on 1 Advanced BTC" }).first())
      .toBeVisible();
    await expect.element(page.getByRole("gridcell", { name: "Jun Park" }).first()).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Sort by Against the AI", exact: true }))
      .toBeVisible();
    for (const hidden of ["Flags", "Outcome", "Exclusion reason", "Known include", "Year"])
      await expect
        .element(page.getByRole("button", { name: `Sort by ${hidden}`, exact: true }))
        .not.toBeInTheDocument();

    // The AI's reading is older than the published protocol: the notice says which version it
    // read, and the re-judge asks before it runs.
    const rejudged: string[] = [];
    (app.workbench as unknown as Writable).rejudgeStage = (request) => {
      rejudged.push(request.stageId);
      return Effect.succeed({} as StageInfo);
    };
    const outdated = page.getByTestId("outdated");
    await expect
      .element(outdated)
      .toMatchTextContent("The AI proposals here come from protocol version 1.1");
    await outdated.getByRole("button", { name: /^Re-judge with version/ }).click();
    expect(rejudged).toEqual([]);
    await outdated.getByRole("button", { name: "Re-judge 28 records" }).click();
    await expect.poll(() => rejudged.length).toBe(1);
    await expect
      .element(page.getByText(/^The AI reads the stage again with version/))
      .toBeVisible();

    // The disagreements: a quiet flag in their own column, first in the table, and a chip in
    // full words; who made them shows in the next chips.
    await expect.element(page.getByTestId("sorted-ai_disagrees")).toHaveTextContent("↑");
    await expect.element(firstRow()).toMatchTextContent("≠ AI");
    await expect.element(firstRow()).toMatchTextContent("Include");
    await page.getByRole("button", { name: "People include, the AI excludes (7)" }).click();
    await expect.element(count()).toMatchTextContent("7 of 28 records");
    // Who made them is one click away, under More filters.
    await page.getByRole("button", { name: "More filters" }).click();
    await expect
      .element(page.getByTestId("chips-by").getByRole("button", { name: "Sam Okafor (7)" }))
      .toBeVisible();
    await page.getByRole("row").nth(1).click();
    const detail = page.getByTestId("row-detail");
    await expect.element(detail).toMatchTextContent("Sam Okafor");
    await expect.element(detail).toMatchTextContent("Exclude on 4 RCT");

    // The lead selects the group and exports it.
    const exported: Array<Parameters<Workbench["workingExport"]>[0]> = [];
    (app.workbench as unknown as Writable).workingExport = (request) => {
      exported.push(request);
      return Effect.succeed(new Uint8Array([80, 75, 3, 4]));
    };
    await page
      .getByRole("button", { name: /^Select the 7 where people include, the AI excludes/ })
      .click();
    await expect.element(page.getByTestId("bulk-count")).toHaveTextContent("7 selected");
    await page.getByRole("button", { name: "Export the 7 selected rows" }).click();
    await expect.poll(() => exported.length).toBe(1);
    expect(exported[0]?.view?.refs).toHaveLength(7);
    // Only columns the workbook knows travel; the AI and decision cells map to theirs.
    expect(exported[0]?.view?.columns).not.toContain("ai_proposal");
    expect(exported[0]?.view?.columns).not.toContain("lead_decision");
    expect(exported[0]?.view?.columns).toContain("outcome");
    expect(exported[0]?.view?.description).toBe(
      "7 selected rows: where people include, the AI excludes",
    );
    await press("Escape");

    // Sorting shows its direction in the header.
    await page.getByRole("button", { name: "Sort by Study" }).click();
    await expect.element(page.getByTestId("sorted-study")).toHaveTextContent("↑");
    await page.getByRole("button", { name: "Sort by Study" }).click();
    await expect.element(page.getByTestId("sorted-study")).toHaveTextContent("↓");
  });
});
