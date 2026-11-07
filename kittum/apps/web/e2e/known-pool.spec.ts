// Complete the pool on the real stack (see stack.ts): a targeted search is set up through
// `kittum project`, then the lead imports a second database's export in the new NBIB format and
// the customer's list of known papers as the topic's known pool, and sees what the search found
// of it, what it missed, and what is new. Once screening is open, the table marks the pool's
// records so a screener can filter them.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { SERVER, stackEnv } from "./stack.ts";

const DEMO_DATA = join(SERVER, "src", "kittum", "app", "demo_data");
const FIXTURES = join(SERVER, "tests", "search", "fixtures");
const PROTOCOL = join(SERVER, "..", "..", "examples", "protocols", "nicotine-replacement.yaml");
const SHOTS = process.env["KITTUM_E2E_SCREENSHOTS"];

const cli = (...args: string[]) =>
  JSON.parse(
    execFileSync("uv", ["run", "kittum", "project", ...args], {
      cwd: SERVER,
      env: stackEnv(),
      encoding: "utf8",
    }),
  ) as Record<string, unknown>;

const scratch = mkdtempSync(join(tmpdir(), "kittum-e2e-pool-"));

const targeted = () => {
  const path = join(scratch, "targeted.yaml");
  const text = readFileSync(PROTOCOL, "utf8").replace(
    '    mode: M1\n    scopes: [nrt-vs-control, combination-vs-single]\n    audit:\n      sentinel_percent: "1"\n      random_audit_percent: "10"\n',
    '    mode: S\n    mode_rationale:\n      en: Complete the customer\'s pool.\n    scopes: [nrt-vs-control, combination-vs-single]\n    audit:\n      sentinel_percent: "0"\n      random_audit_percent: "0"\n',
  );
  expect(text).toContain("mode: S");
  writeFileSync(path, text);
  return path;
};

/** The customer's list as Excel saves CSV in many locales: two papers of the CENTRAL search
 * (one by DOI, one by its title alone) and one the search missed. */
const knownPapers = () => {
  const path = join(scratch, "known papers.csv");
  writeFileSync(
    path,
    [
      "Title;Authors;Year;DOI",
      "Varenicline and Nicotine Replacement Therapy for Smokers Admitted to Hospitals;Weeks GR;2024;10.1001/jamanetworkopen.2024.18120",
      "Nicotine patch versus placebo patch for smoking cessation in adult smokers: a randomised controlled trial;Hartmann L;2019;",
      "Nicotine mouth spray for smoking cessation: a pilot trial;Tonnesen P;2012;",
      "",
    ].join("\n"),
  );
  return path;
};

test("complete the pool: the search's gaps, the new records, and the pool in the table", async ({
  browser,
}) => {
  const lead = cli("create", `Pool ${new Date().toISOString()}`, "--lead", "Morgan Lee") as {
    project_id: string;
    lead: string;
  };
  const pid = lead.project_id;
  const by = ["--by", lead.lead];
  const sam = (
    cli("add-member", pid, "Sam Okafor", "--role", "reviewer", ...by) as {
      actor_id: string;
    }
  ).actor_id;
  cli("publish-protocol", pid, targeted(), ...by);
  cli(
    "import-search",
    pid,
    join(DEMO_DATA, "central_export.ris"),
    ...["--topic", "TRIALS", "--source", "central", "--platform", "Cochrane Library (Wiley)"],
    ...["--strategy", "#1 nicotine", "--format", "central"],
    ...by,
  );

  const page = await (await browser.newContext()).newPage();
  await page.goto(`/p/${pid}/search?as=${lead.lead}`);
  const pool = page.getByTestId("pool-TRIALS");

  await test.step("the lead imports a PubMed citation manager file (NBIB)", async () => {
    await page.getByRole("button", { name: /Import a search file/ }).click();
    const dialog = page.getByRole("dialog", { name: "Import a search file" });
    await dialog.getByLabel("Source").fill("pubmed");
    await dialog.getByLabel("Platform").fill("PubMed");
    await dialog.getByLabel("Query").fill("lumacaftor[tiab]");
    await dialog.getByLabel("Search file").setInputFiles(join(FIXTURES, "pubmed_export.nbib"));
    await expect(dialog.getByLabel("File format")).toHaveValue("nbib");
    await dialog.getByRole("button", { name: "Import the search" }).click();
    await expect(page.getByTestId("search-notice")).toContainText(
      "Added the PubMed search with 2 records.",
    );
  });

  await test.step("the lead adds the customer's papers as the known pool", async () => {
    await expect(pool).toContainText("No known papers yet.");
    await pool.getByRole("button", { name: "Add known papers" }).click();
    const dialog = page.getByRole("dialog", { name: "Add known papers" });
    await dialog.getByLabel("Known papers file").setInputFiles(knownPapers());
    await expect(dialog.getByLabel("File format")).toHaveValue("records-csv");
    await dialog.getByRole("button", { name: "Add to the pool" }).click();
    await expect(pool.getByTestId("pool-found")).toHaveText("2");
    await expect(pool.getByTestId("pool-missed")).toHaveText("1");
    await expect(pool.getByTestId("pool-new")).toHaveText("7");
    await expect(pool).toContainText("new search records of 9, not in the pool");
    await expect(pool.getByRole("list", { name: "Not found by the search" })).toContainText(
      "Nicotine mouth spray for smoking cessation",
    );
    await expect(pool.getByRole("list", { name: "Pool files" })).toContainText(
      "known papers.csv, 3 papers",
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "known-pool.png"), fullPage: true });
  });

  cli("ingest", pid, ...by);
  cli("open-stage", pid, "nrt-vs-control", "title_abstract", "--reveal", "never", ...by);

  await test.step("the table marks the pool's records, for the lead and the screener", async () => {
    await page.goto(`/p/${pid}/screening/table?as=${lead.lead}`);
    const grid = page.getByTestId("grid");
    await expect(grid.getByRole("columnheader", { name: /In the known pool/ })).toBeVisible();
    await expect(grid.getByRole("gridcell", { name: "Yes", exact: true })).toHaveCount(2);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "known-pool-table-lead.png") });

    await page.goto(`/p/${pid}/screening/table?as=${sam}`);
    await expect(
      page.getByTestId("grid").getByRole("gridcell", { name: "Yes", exact: true }),
    ).toHaveCount(2);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, "known-pool-table-screener.png") });
  });
  await page.context().close();
});
