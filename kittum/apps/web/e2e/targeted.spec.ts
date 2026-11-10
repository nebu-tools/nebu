// A targeted search (mode S, working documentation) on the real stack (see stack.ts): the review
// is set up through `kittum project`, then the lead opens title and abstract screening in the
// browser with a pool of two screeners and the AI's reading shown before the decision. One
// screener asks for a second opinion with f; the other sees that decision and its comment, and
// their exclusion settles the record.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

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

/** The example protocol as a targeted search: mode S with its reason, and no audit. */
const targeted = () => {
  const path = join(mkdtempSync(join(tmpdir(), "kittum-e2e-targeted-")), "targeted.yaml");
  const text = readFileSync(PROTOCOL, "utf8").replace(
    '    mode: M1\n    scopes: [nrt-vs-control, combination-vs-single]\n    audit:\n      sentinel_percent: "1"\n      random_audit_percent: "10"\n',
    '    mode: S\n    mode_rationale:\n      en: A confounder search for our own model.\n    scopes: [nrt-vs-control, combination-vs-single]\n    audit:\n      sentinel_percent: "0"\n      random_audit_percent: "0"\n',
  );
  expect(text).toContain("mode: S");
  writeFileSync(path, text);
  return path;
};

test("a targeted search: a pool screens, and a second opinion settles an unsure record", async ({
  browser,
}) => {
  const lead = cli("create", `Targeted ${new Date().toISOString()}`, "--lead", "Morgan Lee") as {
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
  const jun = (
    cli("add-member", pid, "Jun Park", "--role", "reviewer", ...by) as {
      actor_id: string;
    }
  ).actor_id;
  cli("add-member", pid, "Ola Berg", "--role", "reviewer", ...by);
  cli("publish-protocol", pid, targeted(), ...by);
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

  const page = await (await browser.newContext()).newPage();

  await test.step("the protocol says working documentation, and the presets fill the mode", async () => {
    await page.goto(`/p/${pid}/protocol?as=${lead.lead}`);
    await expect(page.getByTestId("documentation")).toContainText("Working documentation");
    await page.keyboard.press("v"); // a new version, in the form
    await page.getByRole("button", { name: /^Start from the published version/ }).click();
    const mode = page.getByTestId("mode");
    await expect(mode.getByRole("button", { name: "Targeted search" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(mode.getByLabel("Why this mode")).toHaveValue(
      "A confounder search for our own model.",
    );
    await mode.getByRole("button", { name: "Documented SLR" }).click();
    const modes = mode.getByRole("radiogroup", { name: "Screening mode" });
    await expect(modes.getByRole("radio", { checked: true })).toHaveValue("M1");
    await expect(mode.getByRole("button", { name: "Documented SLR" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(mode.getByLabel("Why this mode")).toHaveCount(0);
    await mode.getByRole("button", { name: "Targeted search" }).click();
    await expect(modes.getByRole("radio", { checked: true })).toHaveValue("S");
    await expect(modes.getByRole("radio", { name: /^Pool of screeners/ })).toBeChecked();
  });

  await test.step("the lead opens screening with a pool of two and the AI shown before", async () => {
    await page.goto(`/p/${pid}/setup?as=${lead.lead}`);
    const form = page.getByRole("form", { name: "Open a screening stage" });
    await expect(form.getByTestId("stage-documentation")).toContainText("Working documentation");
    await expect(form.getByLabel("Sentinel file")).toHaveCount(0);
    await form.getByRole("checkbox", { name: "Ola Berg" }).uncheck();
    await form.getByLabel("When reviewers see the AI's reading").selectOption({
      label: "Before the decision, once the AI has read the record. Only in a targeted search",
    });
    await form.getByRole("button", { name: "Open title and abstract screening" }).click();
    await expect(page.getByTestId("setup-notice")).toContainText(
      "The records are in the queues of Sam Okafor and Jun Park now",
    );
    const stages = (
      (await (await page.request.get(`/api/projects/${pid}`)).json()) as {
        stages: Array<{ mode: string; reveal: string; screeners: string[]; auditor_id: unknown }>;
      }
    ).stages;
    expect(stages).toEqual([
      expect.objectContaining({
        mode: "S",
        reveal: "before",
        screeners: [sam, jun],
        auditor_id: null,
      }),
    ]);
  });

  let unsure = "";
  await test.step("Sam is unsure about a record and asks for a second opinion", async () => {
    await page.goto(`/p/${pid}/screening/title-abstract?as=${sam}`);
    const title = page.getByTestId("record-title");
    await expect(title).toBeVisible({ timeout: 60_000 });
    // The worker reads as it goes; once it has, the reading is on screen before the decision.
    await expect(page.getByTestId("ai-before")).toBeVisible({ timeout: 90_000 });
    unsure = (await title.textContent()) ?? "";
    await page.keyboard.press("f");
    await page.keyboard.type("Are these patients smokers?");
    await page.keyboard.press("Enter");
    await page.keyboard.press("i");
    await expect(title).not.toHaveText(unsure);
  });

  await test.step("Jun sees Sam's decision and comment first, and settles the record", async () => {
    await page.goto(`/p/${pid}/screening/title-abstract?as=${jun}`);
    await expect(page.getByTestId("record-title")).toHaveText(unsure, { timeout: 30_000 });
    const asked = page.getByTestId("second-opinion");
    await expect(asked).toContainText("A colleague asks for your second opinion");
    await expect(asked).toContainText("Included");
    await expect(page.getByTestId("second-opinion-comment")).toHaveText(
      "“Are these patients smokers?”",
    );
    await page.keyboard.press("f"); // a second opinion asks no further one
    await expect(
      page.getByText("This is a second opinion. Your decision settles the record."),
    ).toBeVisible();
    await page.keyboard.press("e");
    await page.keyboard.press("1");
    await expect(page.getByTestId("record-title")).not.toHaveText(unsure);

    const progress = (await (
      await page.request.get(`/api/projects/${pid}/progress`, {
        headers: { "X-Kittum-Reviewer": lead.lead },
      })
    ).json()) as {
      stages: Array<{
        outcomes: Record<string, number>;
        status: { metrics: { second_opinions: Record<string, number> } };
      }>;
    };
    const [stage] = progress.stages;
    expect(stage?.outcomes["exclude"]).toBe(1);
    expect(stage?.status.metrics.second_opinions).toEqual({
      requested: 1,
      pending: 0,
      changed: 1,
      kept: 0,
    });
  });
  await page.context().close();
});
