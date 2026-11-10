import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { health } from "../data/api.ts";
import type { ProjectSummary } from "../data/schema.ts";
import { run } from "../data/workbench.ts";
import { formatDate } from "../lib/format.ts";
import { rememberedReviewer, rememberReviewer, ROLE_LABELS } from "../screens/project.tsx";
import { QueueRows, SCREEN_PATH, useQueues } from "../screens/setup/queues.tsx";
import type { Queue } from "../screens/setup/queues.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/Empty.tsx";
import { Page } from "../ui/Page.tsx";
import { failure, Field, FormDialog, TextInput } from "../ui/Form.tsx";
import { useKeys } from "../ui/keys.ts";

export const Route = createFileRoute("/")({
  loader: ({ context }) => run(context.workbench.projects()),
  component: Projects,
});

const STAGE_NAMES = { title_abstract: "Title and abstract", full_text: "Full text" } as const;

function Projects() {
  const projects = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const { workbench } = Route.useRouteContext();
  const [creating, setCreating] = useState(false);
  useKeys((event) => {
    if (event.key === "c" && workbench.live) {
      setCreating(true);
      return true;
    }
    const index = Number(event.key) - 1;
    const project = projects[index];
    if (!project) return false;
    void navigate({ to: "/p/$projectId", params: { projectId: project.id } });
    return true;
  });
  const create = workbench.live ? (
    <Button kind="primary" keys={["c"]} onClick={() => setCreating(true)}>
      Create a review
    </Button>
  ) : null;
  const open = projects.filter((p) => p.stages.length > 0).length;
  return (
    <div className="flex h-full flex-col bg-paper">
      <header className="flex h-10 flex-none items-center border-b border-rule bg-sheet px-4">
        <span className="text-sm font-semibold tracking-[-0.01em] text-petrol">Kittum</span>
      </header>
      <main className="min-h-0 flex-1">
        {projects.length === 0 ? (
          <EmptyState title="No reviews yet" actions={create}>
            Create a review to become its methods lead and set it up step by step, from the people
            to the first screening stage. For a complete example, run{" "}
            <code className="text-sm">kittum demo seed</code> on the server.
          </EmptyState>
        ) : (
          <Page
            title="Reviews"
            summary={
              <>
                {`${projects.length} ${projects.length === 1 ? "review" : "reviews"} on this server, ${open} with screening open.`}
                <span className="mt-0.5 block">
                  Kittum has no sign-in: pick who you are, and this browser remembers it.
                </span>
              </>
            }
            actions={create}
          >
            {/* The list is the sheet on the desk: the one raised surface of the page. */}
            <ol className="overflow-hidden rounded-[6px] bg-raised shadow-raised">
              {projects.map((project) => (
                <ProjectRow key={project.id} project={project} />
              ))}
            </ol>
          </Page>
        )}
        <CreateReview
          open={creating}
          onOpenChange={setCreating}
          onCreated={(projectId, leadId) => {
            rememberReviewer(projectId, leadId);
            void navigate({ to: "/p/$projectId/setup", params: { projectId } });
          }}
        />
      </main>
      <ServerStatus />
    </div>
  );
}

/** One review: its title once, who leads it and who you are in it, its open stage, and each
 * screener's progress. A known screener gets their own queue and a Resume button; on a browser
 * that does not know who is here, each screener's row offers to screen as them (there is no
 * sign-in: each person picks their name); the lead sees the progress without actions. */
function ProjectRow({ project }: { project: ProjectSummary }) {
  const { workbench } = Route.useRouteContext();
  const title = project.title ?? project.name;
  const lead = project.members.find((m) => m.roles.includes("lead"));
  const meId = rememberedReviewer(project.id);
  const me = project.members.find((m) => m.actor_id === meId) ?? null;
  const stages = project.stages;
  const latest = stages.some((s) => s.stage === "full_text") ? "full_text" : "title_abstract";
  const queues = useQueues(workbench, project);
  const current = (queues ?? []).filter((q) => q.stage === latest);
  const mine = me ? current.find((q) => q.actorId === me.actor_id) : undefined;
  const leads = Boolean(me?.roles.includes("lead")) && !mine;
  const shown = mine ? [mine] : current;
  const reviewerCount = project.members.filter((m) => m.roles.includes("reviewer")).length;
  // The team by role, beside the lead: the screeners listed on the right are some of them.
  const team = (["reviewer", "auditor", "adjudicator"] as const)
    .map((role) => {
      const n = project.members.filter((m) => m.roles.includes(role)).length;
      const name = ROLE_LABELS[role].toLowerCase();
      return n ? `${n} ${n === 1 ? name : `${name}s`}` : null;
    })
    .filter(Boolean)
    .join(", ");
  return (
    <li
      className="grid grid-cols-[minmax(0,640px)_minmax(0,1fr)] gap-x-12 border-b border-rule px-6 py-5 last:border-b-0"
      data-testid="review-row"
    >
      <div className="min-w-0">
        <Link
          to="/p/$projectId"
          params={{ projectId: project.id }}
          className="group inline-flex items-baseline gap-2 text-md font-semibold text-ink hover:text-petrol"
          title={project.title && project.title !== project.name ? project.name : undefined}
        >
          <span className="group-hover:underline">{title}</span>
          <span aria-hidden="true" className="text-ink-2 group-hover:text-petrol">
            ›
          </span>
        </Link>
        <p className="mt-1 text-sm text-ink-2">
          {me
            ? `Your role: ${me.roles.map((r) => ROLE_LABELS[r]).join(", ")}.`
            : lead
              ? `Led by ${lead.display_name}${team ? `, with ${team}` : ""}.`
              : "No methods lead yet."}{" "}
          {project.protocol
            ? `Protocol version ${project.protocol.version_label}, started ${formatDate(project.created_at)}.`
            : `No protocol yet, started ${formatDate(project.created_at)}.`}
        </p>
        <p className="mt-1.5 -ml-2 flex flex-wrap items-center gap-1">
          {(
            [
              ["/p/$projectId/setup", "Workflow"],
              ["/p/$projectId/protocol", "Protocol"],
              ["/p/$projectId/progress", "Progress"],
            ] as const
          ).map(([to, name]) => (
            <Link
              key={to}
              to={to}
              params={{ projectId: project.id }}
              className="inline-flex h-7 items-center rounded-[4px] px-2 text-xs font-medium text-petrol hover:bg-petrol-wash"
            >
              {name}
            </Link>
          ))}
        </p>
      </div>
      <div className="min-w-0 text-sm">
        {stages.length === 0 ? (
          <p className="text-ink-2">
            {project.protocol ? "Setting up; no screening stage is open yet." : "Setting up."}
          </p>
        ) : (
          <>
            <p className="font-medium">
              {STAGE_NAMES[latest]} screening is open
              {mine ? (
                <span className="font-normal text-ink-2">; this is your queue.</span>
              ) : current.length ? (
                <span className="font-normal text-ink-2">
                  {`; ${current.length} of ${reviewerCount} ${reviewerCount === 1 ? "reviewer screens" : "reviewers screen"} it.`}
                </span>
              ) : null}
            </p>
            {queues === null ? (
              <p className="mt-1 text-ink-2">Counting the queues.</p>
            ) : shown.length ? (
              <div className="mt-1.5">
                <QueueRows
                  caption={`${STAGE_NAMES[latest]} queues`}
                  queues={shown}
                  {...(leads
                    ? {}
                    : {
                        action: (q: Queue) =>
                          q.remaining ? (
                            <Link
                              to={SCREEN_PATH[q.stage]}
                              params={{ projectId: project.id }}
                              onClick={() => rememberReviewer(project.id, q.actorId)}
                              className={`inline-flex h-7 items-center rounded-[4px] border px-2.5 text-xs font-medium ${mine ? "border-petrol bg-petrol text-petrol-ink hover:brightness-110" : "border-rule-strong bg-sheet text-ink hover:border-ink-3"}`}
                            >
                              {mine ? "Resume screening" : `Screen as ${q.name}`}
                            </Link>
                          ) : q.screened ? (
                            <span className="text-ink-2">Done</span>
                          ) : null,
                      })}
                />
              </div>
            ) : (
              <p className="mt-1 text-ink-2">No records assigned yet.</p>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function CreateReview({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: string, leadId: string) => void;
}) {
  const { workbench } = Route.useRouteContext();
  const [name, setName] = useState("");
  const [lead, setLead] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (!name.trim() || !lead.trim()) {
      setError("Name the review and its methods lead.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await run(
        workbench.createProject({ name: name.trim(), leadName: lead.trim() }),
      );
      const [first] = project.members;
      if (!first) throw new Error("the review came back without its lead");
      onCreated(project.id, first.actor_id);
    } catch (e) {
      setError(failure(e, "The review was not created. Is the server running?"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create a review"
      description="You are its methods lead: you add the people, publish the protocol, run the searches, and open screening. Each step goes into the review's ledger."
      submit="Create the review"
      busy={busy}
      error={error}
      onSubmit={() => void create()}
    >
      <Field label="Review name" hint="A short name the team knows it by.">
        <TextInput
          autoFocus
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Nicotine replacement update 2026"
        />
      </Field>
      <Field label="Your name">
        <TextInput
          value={lead}
          onChange={(e) => setLead(e.currentTarget.value)}
          placeholder="Morgan Lee"
        />
      </Field>
    </FormDialog>
  );
}

function ServerStatus() {
  const { workbench } = Route.useRouteContext();
  const [status, setStatus] = useState<string | null>(
    workbench.live ? null : "Example data: no server behind these screens.",
  );
  useEffect(() => {
    if (!workbench.live) return;
    let live = true;
    // A proxy to a server that is not running can hang; give up after three seconds.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 3000),
    );
    Promise.race([health(), timeout]).then(
      (health) => live && setStatus(`Server ${health.status}, version ${health.version}.`),
      () => live && setStatus("The server is not reachable. Start it with `kittum serve`."),
    );
    return () => {
      live = false;
    };
  }, [workbench]);
  return (
    <footer className="flex flex-none gap-4 border-t border-rule px-4 py-2 text-2xs text-ink-3">
      <span>{status ?? "Checking the server."}</span>
      <span>
        AGPL-3.0-or-later.{" "}
        <a className="underline" href="https://github.com/sims1253/nebu/tree/main/kittum">
          Source
        </a>
      </span>
    </footer>
  );
}
