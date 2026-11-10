import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../styles.css";
import { exposureSentence } from "./disclosure.ts";
import type { Agreement, DisclosureStage } from "./disclosure.ts";
import { DisclosureSection } from "./Reports.tsx";

/** The text of an element, once it is on the page. */
const textOf = async (locator: ReturnType<typeof page.getByTestId>) => {
  await expect.element(locator).toBeInTheDocument();
  return (locator.element().textContent ?? "").replace(/\s+/g, " ");
};

const SAM = "0190a8c0-0000-7000-8000-00000000000a";
const JUN = "0190a8c0-0000-7000-8000-00000000000b";

const pair = (
  kind: Agreement["kind"],
  who: string,
  table: Agreement["table"],
  aiOnScreen: number,
  kappa = 0.49,
): Agreement => {
  const items = Object.values(table).reduce((a, b) => a + b, 0);
  return {
    kind,
    raters: [who === SAM ? "Reviewer 1" : "Reviewer 2", "AI"],
    actor_ids: [who, "ai"],
    items,
    agreed: table.include_include + table.exclude_exclude,
    table,
    kappa,
    pabak: 0.47,
    ai_on_screen: aiOnScreen,
  };
};

// A working topic whose title and abstract stage shows the AI's reading before the decision,
// then a full-text stage that never shows it. The disclosure must not call the first blind.
const STAGES: ReadonlyArray<DisclosureStage> = [
  {
    scope_id: "q-effect",
    stage: "title_abstract",
    mode: "S",
    reveal: "before",
    records: 59,
    records_read_by_ai: 59,
    ai_proposed_exclusions: 4,
    ai_own_reading_exclusions: 9,
    excluded: 27,
    excluded_with_ai_proposal: 4,
    excluded_after_ai_seen: 20,
    excluded_after_ai_rescreen: 0,
    reveals_shown: 0,
    revised_after_reveal: 0,
    first_decisions: { total: 59, ai_on_screen: 38 },
    agreement: [
      pair(
        "human_ai",
        SAM,
        { include_include: 7, include_exclude: 1, exclude_include: 4, exclude_exclude: 7 },
        12,
      ),
      pair(
        "human_ai_verified",
        SAM,
        { include_include: 8, include_exclude: 0, exclude_include: 9, exclude_exclude: 2 },
        12,
        -0.11,
      ),
      pair(
        "human_ai",
        JUN,
        { include_include: 1, include_exclude: 0, exclude_include: 0, exclude_exclude: 0 },
        1,
      ),
      {
        ...pair(
          "human_ai_verified",
          JUN,
          { include_include: 0, include_exclude: 0, exclude_include: 0, exclude_exclude: 0 },
          0,
        ),
      },
    ],
  },
  {
    scope_id: "q-effect",
    stage: "full_text",
    mode: "S",
    reveal: "never",
    records: 8,
    records_read_by_ai: 8,
    ai_proposed_exclusions: 0,
    excluded: 4,
    reveals_shown: 0,
    revised_after_reveal: 0,
    first_decisions: { total: 8, ai_on_screen: 0 },
    agreement: [],
  },
];

let root: Root | undefined;
afterEach(() => root?.unmount());

function mount(stages: ReadonlyArray<DisclosureStage>) {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  root.render(
    <DisclosureSection
      record={{ cutoff_seq: 176, prompts: [], stages }}
      files={[]}
      names={new Map([[SAM, "Sam Okafor"]])}
      scopeLabel={(id) => (id === "q-effect" ? "Do phone interventions help people stop?" : id)}
    />,
  );
}

describe("the AI-use disclosure", () => {
  test("says which decisions were made with the AI's reading on screen, from the stages", async () => {
    mount(STAGES);
    const summary = page.getByTestId("disclosure-summary");
    expect(await textOf(summary)).toContain("not independent");
    expect(await textOf(summary)).not.toContain("blind");
    // Blind and AI-visible first decisions per stage, in columns; no sentence repeats them.
    const cells = async (id: string) =>
      Promise.all(
        page
          .getByTestId(id)
          .all()
          .map((cell) => textOf(cell)),
      );
    expect(await cells("stage-blind")).toEqual(["21", "8"]);
    expect(await cells("stage-on-screen")).toEqual(["38", "0"]);
    expect(page.getByTestId("stage-exposure").all()).toHaveLength(0);
    expect(exposureSentence(STAGES[0]!)).toBe(
      "38 of 59 first decisions were made with the AI’s reading on screen; 21 blind, before the AI had read the record.",
    );
    // No internal codes in the text: the mode and the scope are words.
    const section = page.getByTestId("disclosure");
    const text = section.element().textContent ?? "";
    expect(text).not.toMatch(/q-effect|\bS\b|reveal before/);
    expect(text).toContain("AI shown before the decision");
    // Both readings' exclusion proposals in one table with people's exclusions, and the gap
    // between them stated once, in words, as something to look at.
    const stages = await textOf(page.getByTestId("disclosure-stages"));
    for (const column of ["AI proposals to exclude", "Raw", "Quote-checked", "Extra screen"])
      expect(stages).toContain(column);
    expect(page.getByTestId("disclosure-involvement").all()).toHaveLength(0);
    expect(await textOf(page.getByTestId("quote-unverified"))).toContain(
      "Title and abstract: 5 of the AI’s 9 exclusion proposals had no quote Kittum could find; only 4 count as quote-checked.",
    );
  });

  test("summarises agreement in one table whose rows open to their 2x2", async () => {
    mount(STAGES);
    const rows = page.getByTestId("disclosure-agreement");
    expect(await textOf(rows.nth(0))).toContain("Sam Okafor and the AI’s raw reading");
    expect(await textOf(rows.nth(0))).toContain("14 of 19");
    expect(await textOf(rows.nth(0))).toContain("AI on screen for 12");
    expect(await textOf(rows.nth(0).getByTestId("kappa"))).toContain("0.49");
    // Weak agreement is flagged as Progress flags it; one record is too little to read.
    expect(await textOf(rows.nth(1))).toContain("Below chance");
    expect(await textOf(rows.nth(2).getByTestId("too-little-data"))).toBe(
      "Too little data (1 record)",
    );
    // A pair with no record in common folds into one line; a reviewer the project does not
    // know keeps the published pseudonym.
    expect(rows.all()).toHaveLength(3);
    expect(await textOf(page.getByTestId("agreement-empty"))).toContain(
      "Reviewer 2: no records both decided yet",
    );
    expect(page.getByRole("table", { name: /against/ }).all()).toHaveLength(0);

    await userEvent.click(rows.nth(0).getByRole("button"));
    const matrix = page.getByRole("table", { name: "Sam Okafor against the AI’s raw reading" });
    await expect.element(matrix).toBeVisible();
    expect(await textOf(matrix)).toContain("Include71Exclude47");
  });

  test("calls every first decision blind only when every stage was blind", async () => {
    mount([STAGES[1]!]);
    expect(await textOf(page.getByTestId("disclosure-summary"))).toContain(
      "Every first decision was made blind",
    );
  });
});
