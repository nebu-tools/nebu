// Decisions from a spreadsheet on the real stack (see stack.ts): in a targeted search (mode S) a
// screener exports their records from the table, decides some of them in the file as one would in
// Excel, and imports it. The preview lists what would be decided and what is refused; Apply
// records it, and the AI disclosure says how many decisions came from a spreadsheet.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { SERVER, stackEnv } from "./stack.ts";

const DEMO_DATA = join(SERVER, "src", "kittum", "app", "demo_data");
const PROTOCOL = join(SERVER, "..", "..", "examples", "protocols", "nicotine-replacement.yaml");

const cli = (...args: string[]) =>
  JSON.parse(
    execFileSync("uv", ["run", "kittum", "project", ...args], {
      cwd: SERVER,
      env: stackEnv(),
      encoding: "utf8",
    }),
  ) as Record<string, unknown>;

const targeted = (dir: string) => {
  const path = join(dir, "targeted.yaml");
  const text = readFileSync(PROTOCOL, "utf8").replace(
    '    mode: M1\n    scopes: [nrt-vs-control, combination-vs-single]\n    audit:\n      sentinel_percent: "1"\n      random_audit_percent: "10"\n',
    '    mode: S\n    mode_rationale:\n      en: A confounder search for our own model.\n    scopes: [nrt-vs-control, combination-vs-single]\n    audit:\n      sentinel_percent: "0"\n      random_audit_percent: "0"\n',
  );
  expect(text).toContain("mode: S");
  writeFileSync(path, text);
  return path;
};

// What a screener does in Excel: decide the first three records in the file, the third with an
// outcome Kittum does not know. openpyxl comes with the server.
const EDIT = `
import sys
from openpyxl import load_workbook
book = load_workbook(sys.argv[1])
sheet = book["Records"]
header = [c.value for c in sheet[1]]
col = {name: header.index(name) + 1 for name in ("Your decision", "Reason", "Comment")}
sheet.cell(row=2, column=col["Your decision"], value="Include")
sheet.cell(row=3, column=col["Your decision"], value="Exclude")
sheet.cell(row=3, column=col["Reason"], value=1)
sheet.cell(row=3, column=col["Comment"], value="Not about smokers")
sheet.cell(row=4, column=col["Your decision"], value="Maybe")
book.save(sys.argv[2])
`;

// KITTUM_E2E_SHOTS: a directory for screenshots of the steps, as in assist.spec.ts.
const SHOTS = process.env["KITTUM_E2E_SHOTS"];
const shoot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

test("decisions from a spreadsheet: export, edit, preview, import", async ({ browser }) => {
  const dir = mkdtempSync(join(tmpdir(), "kittum-e2e-spreadsheet-"));
  const lead = cli("create", `Spreadsheet ${new Date().toISOString()}`, "--lead", "Morgan Lee") as {
    project_id: string;
    lead: string;
  };
  const pid = lead.project_id;
  const by = ["--by", lead.lead];
  const sam = (
    cli("add-member", pid, "Sam Okafor", "--role", "reviewer", ...by) as { actor_id: string }
  ).actor_id;
  cli("publish-protocol", pid, targeted(dir), ...by);
  cli(
    "import-search",
    pid,
    join(DEMO_DATA, "central_export.ris"),
    "--topic",
    "TRIALS",
    "--source",
    "central",
    "--platform",
    "Cochrane Library (Wiley)",
    "--strategy",
    "#1 nicotine",
    "--format",
    "central",
    ...by,
  );
  cli("ingest", pid, ...by);
  cli("open-stage", pid, "nrt-vs-control", "title_abstract", "--reveal", "before", ...by);

  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const exported = join(dir, "exported.xlsx");
  const edited = join(dir, "kittum-working-edited.xlsx");

  await test.step("Sam exports the stage and decides three records in the file", async () => {
    await page.goto(`/p/${pid}/screening/table?as=${sam}`);
    await expect(page.getByRole("row").nth(1)).toBeVisible({ timeout: 30_000 });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export stage" }).click();
    await (await download).saveAs(exported);
    execFileSync("uv", ["run", "python", "-c", EDIT, exported, edited], {
      cwd: SERVER,
      env: stackEnv(),
    });
  });

  await test.step("the preview lists what would change and what is refused", async () => {
    await page.getByTestId("import-file").setInputFiles(edited);
    const panel = page.getByTestId("import-panel");
    await expect(panel).toContainText("exported by Sam Okafor");
    await expect(page.getByTestId("import-counts")).toContainText("2 to decide");
    await expect(page.getByTestId("import-counts")).toContainText("1 refused");
    await expect(panel).toContainText('Kittum knows no decision "Maybe"');
    await expect(panel).toContainText("Exclude on 1");
    await shoot(page, "spreadsheet-1-preview");
    // Nothing is recorded yet.
    await expect(page.getByTestId("row-count")).toContainText("0 decided");
  });

  await test.step("Apply records the two decisions", async () => {
    await page.getByRole("button", { name: "Apply 2 decisions" }).click();
    await expect(
      page.getByText("Imported 2 decisions from kittum-working-edited.xlsx."),
    ).toBeVisible();
    await expect(page.getByTestId("import-panel")).toHaveCount(0);
    await expect(page.getByTestId("row-count")).toContainText("2 decided");
    await shoot(page, "spreadsheet-2-imported");
  });

  await test.step("the AI disclosure counts them and says what Kittum cannot know", async () => {
    const rendered = (await (
      await page.request.post(`/api/projects/${pid}/reports/targets/ai_disclosure/render`, {
        data: { actor_id: lead.lead },
      })
    ).json()) as { artifact: { files: Array<{ path: string; sha256: string }> } };
    const md = rendered.artifact.files.find((f) => f.path === "ai_disclosure.md");
    const text = await (
      await page.request.get(`/api/projects/${pid}/reports/artifacts/${md?.sha256}`, {
        headers: { "X-Kittum-Reviewer": lead.lead },
      })
    ).text();
    expect(text).toContain("2 decisions came from 1 spreadsheet");
    expect(text).toContain("not who decided each row in it");
  });
  await page.context().close();
});
