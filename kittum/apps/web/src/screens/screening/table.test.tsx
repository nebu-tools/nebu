import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { mount, press } from "../../test/app.tsx";
import { distance, haystack, matcher } from "./table/fuzzy.ts";

const TABLE = "/p/ivosidenib-cca/screening/table";

const count = () => page.getByTestId("row-count");
const firstRow = () => page.getByRole("row").nth(1);

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

    // The reviewer's own 28 records, in queue order, with nothing decided yet.
    await expect.element(count()).toMatchTextContent("28 records · 0 decided");
    await expect.element(firstRow()).toMatchTextContent("ClarIDHy");

    // Quick search: as written in title or abstract, and with a typo in a title.
    const search = page.getByLabelText("Quick search");
    await userEvent.fill(search, "ivosidenib");
    await expect.element(count()).toMatchTextContent("4 of 28 records");
    await userEvent.fill(search, "futibatinb");
    await expect.element(count()).toMatchTextContent("1 of 28 records");
    await expect.element(firstRow()).toMatchTextContent("Futibatinib");
    await userEvent.fill(search, "");

    // The ▾ menu of a column: a checklist of its values.
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
    // The next row is BILCAP. Including it shows the AI's disagreement in the pane, and Space
    // keeps the decision, as in the queue.
    await expect.element(page.getByTestId("row-detail")).toMatchTextContent("BILCAP");
    await press("i");
    await expect.element(page.getByTestId("row-detail")).toMatchTextContent("Not met");
    await expect.element(count()).toMatchTextContent("1 decided");
    await press(" ");
    await expect.element(count()).toMatchTextContent("2 decided");
    expect(app.workbench.decisions.at(-1)?.phase).toBe("final");

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
