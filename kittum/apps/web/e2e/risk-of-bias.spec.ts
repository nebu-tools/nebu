// Risk of bias from the browser on a real trial PDF, on the real stack (see stack.ts). A small
// review is set up through `kittum project` and the API, and screened in the browser until both
// reviewers include the Lesotho trial at full text. The methods lead then appraises one result
// with RoB 2: adopts the instrument's mention of the allocation as a quote, answers with the
// number keys while each domain's judgement follows, judges the result against the algorithm with
// a reason, and finds the table among the reports. The auditor, whose audit screen of the trial
// is still open, sees nothing to appraise.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { includeAll } from "./screen.ts";
import { SERVER, stackEnv } from "./stack.ts";

const EXAMPLES = join(SERVER, "..", "..", "examples");
const FIXTURES = join(SERVER, "tests", "documents", "fixtures");
const PDF = join(FIXTURES, "gerber2026-lesotho-t2d-crct.pdf");
const SENTINEL_PDF = join(FIXTURES, "li2026-vitamin-c-kidney-biopsy-rct.pdf");
const SENTINELS = join(EXAMPLES, "sentinels", "nicotine-replacement.yaml");
const TRIAL = "Community health worker-led";
const RESULT = "HbA1c at 12 months, primary analysis set";

const cli = (...args: string[]) =>
  JSON.parse(
    execFileSync("uv", ["run", "kittum", "project", ...args], {
      cwd: SERVER,
      env: stackEnv(),
      encoding: "utf8",
    }),
  ) as Record<string, string>;

/** Screens a person's full texts: the trial included, the sentinel excluded on the population. */
const screenFullTexts = async (page: Page) => {
  const heading = page.getByRole("complementary", { name: "Criteria" }).getByRole("heading");
  const finished = page.getByRole("heading", { name: "Your available full-text queue is done" });
  const notice = page.getByTestId("fulltext-notice");
  const reveal = page.getByTestId("ai-reveal");
  for (;;) {
    await expect(heading.or(finished)).toBeVisible({ timeout: 60_000 });
    if (await finished.isVisible()) return;
    const title = (await heading.textContent()) ?? "";
    await page.keyboard.press(".");
    await page.keyboard.press("Enter");
    await expect(notice).toContainText("Adopted as evidence");
    const include = title.startsWith(TRIAL);
    for (const key of include ? ["i"] : ["e", "1"]) await page.keyboard.press(key);
    const done = include ? "Included" : "Excluded on 1 Population";
    await expect(reveal.or(notice.getByText(done))).toBeVisible();
    if (await reveal.isVisible()) await page.keyboard.press("Space");
    await expect(notice).toContainText(done);
    await expect(heading.or(finished)).not.toHaveText(title);
  }
};

test("the lead appraises a result of an included trial with RoB 2", async ({ browser }) => {
  // Two reviewers screen two stages in the browser before the appraisal starts.
  test.setTimeout(480_000);
  const created = cli("create", `Risk of bias ${new Date().toISOString()}`, "--lead", "Morgan Lee");
  const projectId = created["project_id"] ?? "";
  const leadId = created["lead"] ?? "";
  const by = ["--by", leadId];
  const person = (name: string, role: string) =>
    cli("add-member", projectId, name, "--role", role, ...by)["actor_id"] ?? "";
  const sam = person("Sam Okafor", "reviewer");
  const jun = person("Jun Park", "reviewer");
  const rita = person("Rita Nunes", "auditor");
  person("Elena Weiss", "adjudicator");
  cli(
    "publish-protocol",
    projectId,
    join(EXAMPLES, "protocols", "nicotine-replacement.yaml"),
    ...by,
  );
  cli(
    "import-search",
    projectId,
    join(SERVER, "src", "kittum", "app", "demo_data", "citation_search.ris"),
    "--topic",
    "TRIALS",
    "--source",
    "citation_search",
    "--platform",
    "Reference lists",
    "--strategy",
    "Backward citation search",
    "--format",
    "ris",
    ...by,
  );
  cli("ingest", projectId, ...by);
  cli("open-stage", projectId, "nrt-vs-control", "title_abstract", "--sentinels", SENTINELS, ...by);

  for (const id of [sam, jun]) {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`/p/${projectId}/screening/title-abstract?as=${id}`);
    await includeAll(page);
    await page.context().close();
  }

  const lead = await (await browser.newContext()).newPage();
  await lead.goto(`/p/${projectId}/risk-of-bias?as=${leadId}`);
  await expect(lead.getByText(/^No reports to appraise yet\./)).toBeVisible();

  await test.step("the trial's PDF arrives and both reviewers include it at full text", async () => {
    const headers = { "X-Kittum-Reviewer": leadId };
    const reports = (await (
      await lead.request.get(`/api/projects/${projectId}/full-texts`, { headers })
    ).json()) as Array<{ title: string; item_ref: string }>;
    const trial = reports.find((r) => r.title.startsWith(TRIAL))!;
    const pdf = { "Content-Type": "application/pdf" };
    const attached = await lead.request.post(
      `/api/projects/${projectId}/full-texts/${trial.item_ref}?actor_id=${leadId}`,
      { headers: pdf, data: readFileSync(PDF) },
    );
    expect(attached.status()).toBe(201);
    const sentinel = await lead.request.post(
      `/api/projects/${projectId}/full-text-sentinels?actor_id=${leadId}` +
        "&title=Vitamin%20C&expected_outcome=exclude",
      { headers: pdf, data: readFileSync(SENTINEL_PDF) },
    );
    expect(sentinel.status()).toBe(201);
    cli("open-stage", projectId, "nrt-vs-control", "full_text", ...by);
    for (const id of [sam, jun]) {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`/p/${projectId}/screening/full-text?as=${id}`);
      await screenFullTexts(page);
      await page.context().close();
    }
  });

  await test.step("the auditor, who has not screened her audit sample, sees nothing", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`/p/${projectId}/risk-of-bias?as=${rita}`);
    await expect(page.getByText(/^No reports to appraise yet\./)).toBeVisible();
    await page.context().close();
  });

  await test.step("the lead starts an appraisal of one result", async () => {
    await lead.reload();
    await expect(lead.getByTestId("rob-report")).toContainText(TRIAL);
    await lead.keyboard.press("n");
    const dialog = lead.getByRole("dialog", { name: "Appraise a result with RoB 2" });
    await dialog.getByLabel("Result").fill(RESULT);
    await dialog.getByRole("button", { name: "Start the appraisal" }).click();
    await expect(lead.getByRole("heading", { name: RESULT })).toBeVisible();
    await expect(lead.getByTestId("rob-overall")).toHaveText("Not yet");
  });

  const notice = lead.getByTestId("rob-notice");
  const answered = (q: string) => lead.getByTestId(`rob-answer-${q}`);
  await test.step("quotes and answers; each domain's judgement follows", async () => {
    // 1.1: the instrument's words find the randomization; the first mention is adopted.
    await lead.keyboard.press(".");
    await lead.keyboard.press("Enter");
    await expect(notice).toContainText("Adopted as evidence for 1.1");
    await lead.keyboard.press("1");
    await expect(answered("1.1")).toHaveText("Yes");
    await expect(lead.locator("[data-testid=rob-question][aria-current]")).toContainText("1.2");
    await lead.keyboard.press("2");
    await lead.keyboard.press("4");
    await expect(lead.getByTestId("rob-D1")).toContainText("Low");
    await lead.screenshot({ path: test.info().outputPath("rob-domain-1.png") });
    // An open-label trial without deviations because of the trial context: 2.4 and 2.5 are NA.
    for (const key of ["1", "1", "4"]) await lead.keyboard.press(key);
    await expect(lead.locator("[data-testid=rob-question][aria-current]")).toContainText("2.6");
    await expect(answered("2.4")).toHaveText("Not applicable");
    await lead.keyboard.press("1");
    await expect(lead.getByTestId("rob-D2")).toContainText("Low");
    // 3.1: outcome data for nearly all; D3 is low and 3.2 to 3.4 do not apply.
    await lead.keyboard.press("1");
    await expect(lead.getByTestId("rob-D3")).toContainText("Low");
    for (const key of ["4", "4", "4"]) await lead.keyboard.press(key);
    await expect(lead.getByTestId("rob-D4")).toContainText("Low");
    for (const key of ["1", "4"]) await lead.keyboard.press(key);
    await expect(lead.getByTestId("rob-D5")).toHaveText("Not yet");
    await lead.keyboard.press("4");
    await expect(lead.getByTestId("rob-D5")).toContainText("Low");
    await expect(lead.getByTestId("rob-overall")).toContainText("Low");
  });

  await test.step("the lead judges the result high against the algorithm, with a reason", async () => {
    await lead.keyboard.press("O");
    const form = lead.getByTestId("rob-override");
    await expect(form).toContainText("Judge the overall judgement yourself");
    await lead.keyboard.press("3");
    await form.getByLabel(/^Why\?/).fill("Cluster trial with few villages per arm.");
    await lead.keyboard.press("Enter");
    await expect(lead.getByTestId("rob-overall")).toContainText("High (yours, algorithm low)");
    await lead.screenshot({ path: test.info().outputPath("rob-override.png") });
    await lead.keyboard.press("Escape");
    await expect(lead.getByTestId("rob-appraisal")).toContainText(RESULT);
    await expect(lead.getByTestId("rob-appraisal").getByTestId("rob-overall")).toContainText(
      "High",
    );
    await lead.screenshot({ path: test.info().outputPath("rob-list.png") });
  });

  await test.step("the reports show the table from the ledger", async () => {
    await lead.keyboard.press("g");
    await lead.keyboard.press("r");
    // The report keys are the lead's: wait until the screen knows who is looking.
    await expect(lead.getByRole("button", { name: /^Generate the flow diagram/ })).toBeVisible();
    await lead.keyboard.press("b");
    const row = lead.getByTestId("risk-of-bias-table").locator("tbody tr");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(RESULT);
    await expect(row.locator("td").last()).toContainText("High †");
  });
});
