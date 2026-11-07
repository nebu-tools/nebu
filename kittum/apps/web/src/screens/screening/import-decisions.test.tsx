import * as Effect from "effect/Effect";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { Criterion, DecisionImportPreview } from "../../data/schema.ts";
import { WorkbenchError } from "../../data/workbench.ts";
import type { Workbench } from "../../data/workbench.ts";
import "../../styles.css";
import { ImportDecisions } from "./table/ImportDecisions.tsx";

const CRITERIA = [
  { id: "POP", text_en: "Adults who smoke", short_label: "Smokers" },
  { id: "INT", text_en: "Nicotine replacement", short_label: "NRT" },
] as unknown as ReadonlyArray<Criterion>;

const PREVIEW: DecisionImportPreview = {
  export_id: "0190a8c0-0000-7000-8000-000000000001",
  exported_at: "2026-11-07T14:02:00Z",
  exported_by: "Alex Reviewer",
  sha256: "a".repeat(64),
  rows: 3,
  preview: {
    changes: [
      {
        row: 2,
        ref: "r1",
        title: "Transdermal nicotine for ulcerative colitis",
        decision: { outcome: "exclude", reason_criterion_id: "POP", comment: "Not smokers" },
      },
    ],
    unchanged: 1,
    refused: [
      {
        row: 4,
        ref: "r3",
        title: "Nicotine patch versus placebo",
        decision: { outcome: "include" },
        refusal: "stale",
        message: "Decided differently in Kittum after the export (now Exclude on POP).",
      },
    ],
    preview_hash: "hash-1",
  },
};

let root: Root | undefined;
afterEach(() => root?.unmount());

function mountImport(workbench: Partial<Workbench>) {
  const container = document.createElement("div");
  container.style.position = "relative";
  container.style.height = "700px";
  document.body.replaceChildren(container);
  root = createRoot(container);
  const imported: string[] = [];
  root.render(
    <ImportDecisions
      workbench={workbench as Workbench}
      caller={{ projectId: "p1", as: "a1" }}
      stageId="s1"
      criteria={CRITERIA}
      onImported={(message) => imported.push(message)}
    />,
  );
  return imported;
}

const file = () =>
  new File([new Uint8Array([80, 75, 3, 4])], "mine.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

describe("importing decisions from a spreadsheet", () => {
  test("previews the file, then imports it as previewed", async () => {
    const sent: Array<{ previewHash: string; fileName: string; bytes: number[] }> = [];
    const imported = mountImport({
      previewDecisionImport: () => Effect.succeed(PREVIEW),
      importDecisions: ({ previewHash, fileName, data }) => {
        sent.push({ previewHash, fileName, bytes: [...data] });
        return Effect.succeed({
          batch_id: "b1",
          decided: 1,
          awaiting_final: 0,
          unchanged: 1,
          refused: 1,
          recorded_at: "2026-11-07T15:00:00Z",
        });
      },
    });

    await userEvent.upload(page.getByTestId("import-file"), file());
    const panel = page.getByTestId("import-panel");
    await expect.element(panel).toMatchTextContent("exported by Alex Reviewer");
    await expect
      .element(page.getByTestId("import-counts"))
      .toMatchTextContent("1 to decide1 unchanged1 refused");
    await expect.element(panel).toMatchTextContent("Exclude on 1 Smokers · “Not smokers”");
    await expect.element(panel).toMatchTextContent("Will be decided");
    await expect
      .element(panel)
      .toMatchTextContent(
        "Changed in Kittum: Decided differently in Kittum after the export (now Exclude on POP).",
      );

    await page.getByRole("button", { name: "Apply 1 decision" }).click();
    await expect.poll(() => imported).toEqual(["Imported 1 decision from mine.xlsx."]);
    expect(sent).toEqual([{ previewHash: "hash-1", fileName: "mine.xlsx", bytes: [80, 75, 3, 4] }]);
    expect(document.querySelector("[data-testid=import-panel]")).toBeNull();
  });

  test("keeps the preview when Kittum changed since, and previews again", async () => {
    let previews = 0;
    mountImport({
      previewDecisionImport: () => {
        previews += 1;
        return Effect.succeed(PREVIEW);
      },
      importDecisions: () =>
        Effect.fail(
          new WorkbenchError({
            reason: "conflict",
            message: "Kittum changed since the preview of this file. Preview it again.",
          }),
        ),
    });
    await userEvent.upload(page.getByTestId("import-file"), file());
    await page.getByRole("button", { name: "Apply 1 decision" }).click();
    await expect.element(page.getByRole("alert")).toMatchTextContent("Preview it again.");
    await page.getByRole("button", { name: "Preview again" }).click();
    await expect.poll(() => previews).toBe(2);
  });
});
