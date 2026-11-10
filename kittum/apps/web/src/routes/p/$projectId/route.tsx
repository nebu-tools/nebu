import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { createFileRoute, Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import type { Member, ProjectSummary, Role } from "../../../data/schema.ts";
import { run } from "../../../data/workbench.ts";
import {
  derive,
  ProjectContext,
  rememberedReviewer,
  rememberReviewer,
  ROLE_LABELS,
} from "../../../screens/project.tsx";
import type { ProjectState } from "../../../screens/project.tsx";
import { Key } from "../../../ui/Key.tsx";
import { Mark, VERDICTS } from "../../../ui/Status.tsx";
import { useKeys } from "../../../ui/keys.ts";
import { useTheme } from "../../../ui/theme.ts";

export const Route = createFileRoute("/p/$projectId")({
  loader: async ({ context, params }): Promise<Omit<ProjectState, "me">> => {
    const [projects, protocol] = await Promise.all([
      run(context.workbench.projects()),
      run(context.workbench.protocol(params.projectId)),
    ]);
    const project = projects.find((p) => p.id === params.projectId);
    if (!project) throw new Error(`There is no review with the ID ${params.projectId}.`);
    return { project, projects, protocol };
  },
  component: ProjectLayout,
});

type Section =
  | "setup"
  | "adjudication"
  | "protocol"
  | "search"
  | "studies"
  | "retrieval"
  | "screening/title-abstract"
  | "screening/full-text"
  | "screening/table"
  | "extraction"
  | "risk-of-bias"
  | "progress"
  | "reports"
  | "audit";

// Who acts on which stage: the screens a person screens on, the lead's own pages.
const LEAD: ReadonlyArray<Role> = [];
const SCREENS: ReadonlyArray<Role> = ["reviewer", "auditor"];

const NAV: ReadonlyArray<{
  section: Section;
  label: string;
  chord: string;
  group: string;
  /** The roles that act on this stage; the methods lead sees every stage. None: everyone. */
  roles?: ReadonlyArray<Role>;
  /** Shown only to a methods lead who screens nothing, as the server answers only them. */
  lead?: boolean;
}> = [
  { section: "setup", label: "Workflow", chord: "u", group: "Set up", roles: LEAD },
  { section: "protocol", label: "Protocol", chord: "p", group: "Set up" },
  { section: "search", label: "Search", chord: "s", group: "Set up", roles: LEAD },
  { section: "studies", label: "Studies", chord: "d", group: "Set up", roles: LEAD },
  {
    section: "screening/title-abstract",
    label: "Title and abstract",
    chord: "t",
    group: "Screen",
    roles: SCREENS,
  },
  { section: "screening/table", label: "Table", chord: "k", group: "Screen", roles: SCREENS },
  { section: "retrieval", label: "Retrieval", chord: "v", group: "Screen", roles: LEAD },
  {
    section: "screening/full-text",
    label: "Full text",
    chord: "f",
    group: "Screen",
    roles: SCREENS,
  },
  {
    section: "adjudication",
    label: "Adjudication",
    chord: "a",
    group: "Screen",
    roles: ["adjudicator"],
  },
  {
    section: "extraction",
    label: "Extraction",
    chord: "x",
    group: "Appraise",
    roles: ["reviewer"],
  },
  { section: "risk-of-bias", label: "Risk of bias", chord: "b", group: "Appraise", roles: LEAD },
  { section: "progress", label: "Progress", chord: "o", group: "Report" },
  { section: "reports", label: "Reports", chord: "r", group: "Report" },
  { section: "audit", label: "Audit", chord: "l", lead: true, group: "Report" },
];

const path = (section: Section) => `/p/$projectId/${section}` as const;

function ProjectLayout() {
  const loaded = Route.useLoaderData();
  const [actorId, setActorId] = useState(() => {
    // `?as=<actor ID>` signs in for this tab, so a link can open the workbench as someone.
    const asked = new URLSearchParams(window.location.search).get("as");
    if (asked) rememberReviewer(loaded.project.id, asked);
    return rememberedReviewer(loaded.project.id);
  });
  const me = loaded.project.members.find((m) => m.actor_id === actorId) ?? null;
  const choose = (member: Member | null) => {
    rememberReviewer(loaded.project.id, member?.actor_id ?? null);
    setActorId(member?.actor_id ?? null);
  };
  const state = useMemo(() => (me ? { ...loaded, me } : null), [loaded, me]);
  if (!state) return <IdentityPicker project={loaded.project} onChoose={choose} />;
  return <Layout state={state} onSwitch={() => choose(null)} />;
}

function Layout({ state, onSwitch }: { state: ProjectState; onSwitch: () => void }) {
  const navigate = useNavigate();
  const { seesLeadData } = derive(state);
  const isLead = state.me.roles.includes("lead");
  const nav = NAV.filter(
    (n) =>
      (!n.lead || seesLeadData) &&
      (isLead || !n.roles || n.roles.some((r) => state.me.roles.includes(r))),
  );
  const groups = new Set(nav.map((n) => n.group)).size;
  const [chord, setChord] = useState(false);
  const [help, setHelp] = useState(false);
  const { theme, toggle } = useTheme();

  useKeys(
    (event) => {
      if (chord) {
        setChord(false);
        const target = nav.find((n) => n.chord === event.key);
        if (target)
          void navigate({ to: path(target.section), params: { projectId: state.project.id } });
        return true;
      }
      if (event.key === "g") {
        setChord(true);
        return true;
      }
      if (event.key === "h") {
        setHelp(true);
        return true;
      }
      return false;
    },
    { first: true },
  );

  return (
    <ProjectContext value={state}>
      <div className="flex h-full flex-col">
        <header className="flex h-10 flex-none items-center gap-3 border-b border-rule bg-sheet px-3">
          <Link to="/" className="px-1 text-sm font-semibold tracking-[-0.01em] text-petrol">
            Kittum
          </Link>
          <ProjectSwitcher state={state} />
          <nav
            aria-label="Review stages"
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
          >
            {nav.map((item, index) => (
              <span key={item.section} className="flex items-center">
                {/* Each group of stages starts with its name, after a rule; a role that sees one
                group needs no names. */}
                {groups > 1 && (index === 0 || nav[index - 1]?.group !== item.group) ? (
                  <span className="flex items-center" aria-hidden="true">
                    {index > 0 ? (
                      <span className="mx-2 h-4 w-px self-center bg-rule-strong" />
                    ) : null}
                    <span className="mr-1 text-xs whitespace-nowrap text-ink-3">{item.group}</span>
                  </span>
                ) : null}
                <Link
                  to={path(item.section)}
                  params={{ projectId: state.project.id }}
                  // A hidden bold copy of the label reserves the active item's width, so the
                  // row does not shift when the active item changes.
                  data-label={item.label}
                  className="narrow inline-flex flex-col items-center rounded-[3px] px-1 py-1 text-sm whitespace-nowrap text-ink-2 after:invisible after:block after:h-0 after:overflow-hidden after:font-medium after:content-[attr(data-label)] hover:text-ink data-[status=active]:bg-petrol-wash data-[status=active]:font-medium data-[status=active]:text-petrol"
                  title={`g then ${item.chord}`}
                >
                  {item.label}
                </Link>
              </span>
            ))}
          </nav>
          {chord ? (
            <span className="text-xs text-ink-3" aria-live="polite">
              <Key k="g" /> then a stage key
            </span>
          ) : null}
          {seesLeadData ? (
            <LedgerMark projectId={state.project.id} actorId={state.me.actor_id} />
          ) : null}
          <Identity member={state.me} onSwitch={onSwitch} />
          <button
            type="button"
            onClick={toggle}
            className="flex-none rounded-[3px] px-1.5 py-1 text-sm text-ink-2 hover:bg-sheet-2 hover:text-ink"
            aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
            title={theme === "dark" ? "Use the light theme" : "Use the dark theme"}
          >
            {/* A half-filled circle: the font has no such glyph, so it is drawn. */}
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M7 1.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
            </svg>
          </button>
          <KeysDialog open={help} onOpenChange={setHelp} />
        </header>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </ProjectContext>
  );
}

function ProjectSwitcher({ state }: { state: ProjectState }) {
  const navigate = useNavigate();
  return (
    <Menu.Root>
      <Menu.Trigger className="flex max-w-[360px] min-w-0 flex-none items-baseline gap-2 rounded-[3px] px-2 py-1 text-left hover:bg-sheet-2 data-[popup-open]:bg-sheet-2">
        <span className="max-w-[300px] truncate text-sm font-semibold" title={state.project.name}>
          {state.project.name}
        </span>
        <svg
          width="9"
          height="6"
          viewBox="0 0 9 6"
          aria-hidden="true"
          className="self-center text-ink-3"
        >
          <path d="M1 1l3.5 3.5L8 1" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="start" className="z-20">
          <Menu.Popup className="w-[460px] rounded-[4px] border border-rule-strong bg-sheet py-1 shadow-[0_8px_24px_rgb(0_0_0/0.14)] outline-none">
            {state.projects.map((project) => (
              <Menu.Item
                key={project.id}
                onClick={() =>
                  void navigate({
                    to: "/p/$projectId/screening/title-abstract",
                    params: { projectId: project.id },
                  })
                }
                className="grid cursor-default grid-cols-[1fr_auto] gap-x-3 px-3 py-2 outline-none data-[highlighted]:bg-petrol-wash"
              >
                <span className="text-sm font-semibold">{project.name}</span>
                <span className="text-xs text-ink-3">
                  {project.id === state.project.id ? "Open" : ""}
                </span>
                <span className="col-span-2 text-xs text-ink-2">
                  {project.title ?? "No protocol yet"}
                </span>
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const KEYS: ReadonlyArray<{
  screen: string;
  keys: ReadonlyArray<readonly [ReadonlyArray<string>, string]>;
}> = [
  {
    screen: "Everywhere",
    keys: [
      [["g", "t"], "Go to a stage: u, p, s, d, v, t, f, k, a, x, b, o, r, and l for Audit"],
      [["h"], "Show these keys"],
    ],
  },
  {
    screen: "Workflow (the methods lead)",
    keys: [
      [["j", "k"], "Next and previous step"],
      [["Enter"], "Go to the step's screen"],
      [["a"], "Add a person"],
      [["b"], "Build the corpus, once the searches are in"],
    ],
  },
  {
    screen: "Protocol, Search, Retrieval (the methods lead)",
    keys: [
      [["v"], "Write a new protocol version"],
      [[",", "."], "Previous and next revision of the protocol"],
      [["r"], "Restore the older revision on screen as the newest"],
      [["Ctrl", "Enter"], "Save the form as a revision, or check the YAML"],
      [["1–9", "a"], "Tick a suggested change, accept the ticked ones"],
      [["i", "n"], "Import a search file, run a live search"],
      [["j", "k"], "Search: move between the searches"],
      [["Enter"], "Search: show or fold the selected search's full query"],
      [["u", "s"], "Upload a full text, add a full-text sentinel"],
      [["o", "r"], "Fetch open-access PDFs, retry the sources that failed"],
      [["b", "e"], "Upload many PDFs, export the reports without a PDF"],
    ],
  },
  {
    screen: "Studies (the methods lead)",
    keys: [
      [["j", "k"], "Move between records"],
      [["Enter"], "Confirm the selected proposed link"],
      [["a"], "Confirm every duplicate with the same DOI, PMID, or PMCID"],
      [["x", "m"], "Mark records, then merge them into one study"],
      [["s"], "Split the record out of its study or report"],
      [["o", "r"], "Open the record's enrichment, enrich again"],
    ],
  },
  {
    screen: "Title and abstract",
    keys: [
      [["i"], "Include"],
      [["e", "1–9"], "Exclude on a criterion"],
      [["u"], "Unclear"],
      [["Backspace"], "Undo the last decision"],
      [["f"], "Ask for a second opinion, in a pool of screeners"],
      [[" "], "Keep your decision and go to the next record"],
      [["p"], "Read the prompt the AI read this record with; p or Esc returns"],
    ],
  },
  {
    screen: "Table",
    keys: [
      [["↑", "↓"], "Select a record; Page Up, Page Down, Home, End jump"],
      [["/"], "Quick search in title, authors, journal, and abstract"],
      [["Enter"], "Open the record in the queue"],
      [["i", "e", "u"], "Decide the selected record, as in the queue. After e, press 1 to 9"],
      [[" "], "Keep your decision after the AI's reading, or go to the next record"],
      [["Backspace"], "Take back the decision on the selected record"],
    ],
  },
  {
    screen: "Full text",
    keys: [
      [["↑", "↓"], "Choose the active criterion"],
      [[",", "."], "Previous or next mention"],
      [["Enter"], "Adopt the mention or selection as evidence"],
      [["y", "n", "?"], "Met, not met, unclear, if you want a verdict"],
      [["i"], "Include, which says every criterion is met"],
      [["e", "1–9"], "Exclude on the criterion the report fails"],
      [["x", "1–9"], "Insufficient information on a criterion"],
      [["w"], "The PDF is the wrong document"],
      [["q"], "Show the AI's quote on the page, once it is shown"],
    ],
  },
  {
    screen: "Adjudication",
    keys: [
      [["1", "2"], "Adopt reviewer A's or B's decision"],
      [["i", "e", "u"], "Your own decision. After e, press 1 to 9 for the criterion"],
      [[",", "."], "Previous or next criterion of the AI's reading, after you decide"],
      [["q"], "Show the AI's quote again, after you decide"],
      [[" "], "Next conflict, after you decide"],
    ],
  },
  {
    screen: "Reports (the methods lead)",
    keys: [
      [["p"], "Generate the PRISMA flow diagram"],
      [["a"], "Generate the AI-use disclosure"],
      [["e"], "Generate the extracted values"],
      [["b"], "Generate the risk-of-bias table"],
      [["s"], "Seal the handover bundle"],
    ],
  },
  {
    screen: "Audit (the methods lead)",
    keys: [
      [["1", "2", "3"], "Trace a count, check the chain, look back to an event"],
      [[",", "."], "Previous and next PRISMA count"],
      [["j", "k"], "Next and previous record of the count"],
      [["v"], "Check the whole chain again"],
      [["c"], "Sign a checkpoint at the head"],
      [["p"], "Render and keep the reports at the chosen event"],
    ],
  },
  {
    screen: "Extraction",
    keys: [
      [["Tab"], "Next field; Shift+Tab goes back"],
      [["Enter"], "Accept, once the source was on screen"],
      [["1", "2"], "Pick a path when they disagree"],
      [["e"], "Edit from a selection on the page"],
      [["j", "k"], "Move between fields or runs"],
      [["o"], "Accept despite a failed check"],
      [["a"], "Accept the validated standard fields (press twice)"],
      [["n"], "Request a run (the methods lead, on the runs screen)"],
    ],
  },
];

function KeysDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger className="rounded-[3px] px-2 py-1 text-sm text-ink-2 hover:text-ink">
        Keys <Key k="h" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 bg-[rgb(10_20_24/0.32)]" />
        <Dialog.Popup className="fixed top-16 left-1/2 w-[560px] -translate-x-1/2 rounded-[4px] border border-rule-strong bg-sheet p-6 shadow-[0_16px_40px_rgb(0_0_0/0.2)] outline-none">
          <Dialog.Title className="text-lg font-semibold">Keys</Dialog.Title>
          <Dialog.Description className="mt-1 text-ink-2">
            Every action has a key. The mouse is for the page.
          </Dialog.Description>
          <div className="mt-4 grid gap-4">
            {KEYS.map((group) => (
              <section key={group.screen}>
                <h3 className="text-xs font-semibold text-ink-3">{group.screen}</h3>
                <dl className="mt-1 grid grid-cols-[120px_1fr] gap-x-4 gap-y-1">
                  {group.keys.map(([keys, label]) => (
                    <div key={label} className="contents">
                      <dt className="flex gap-0.5">
                        {keys.map((k) => (
                          <Key key={k} k={k} />
                        ))}
                      </dt>
                      <dd className="text-ink-2">{label}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Identity({ member, onSwitch }: { member: Member; onSwitch: () => void }) {
  return (
    <button
      type="button"
      onClick={onSwitch}
      data-testid="identity"
      title={`${member.roles.map((r) => ROLE_LABELS[r]).join(", ")}. There is no sign-in yet: choose who you are. Anyone who can reach the server can act as anyone.`}
      aria-label={`Acting as ${member.display_name}, ${member.roles.map((r) => ROLE_LABELS[r]).join(", ")}. Switch person`}
      className="flex flex-none items-baseline gap-2 rounded-[3px] px-2 py-1 text-sm whitespace-nowrap hover:bg-sheet-2"
    >
      <span className="font-medium">{member.display_name}</span>
      {/* The roles are in the hover and for screen readers; the bar keeps its width. */}
      <span className="sr-only">{member.roles.map((r) => ROLE_LABELS[r]).join(", ")}</span>
    </button>
  );
}

/** Who is at the workbench. Authentication is not built; the picker says so. */
function IdentityPicker({
  project,
  onChoose,
}: {
  project: ProjectSummary;
  onChoose: (member: Member) => void;
}) {
  useKeys((event) => {
    const member = project.members[Number(event.key) - 1];
    if (!member) return false;
    onChoose(member);
    return true;
  });
  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-[720px] px-8 pt-20 pb-12">
        <Link to="/" className="text-sm font-semibold text-petrol">
          Kittum
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-[-0.01em]">Who is screening?</h1>
        <p className="mt-2 max-w-[60ch] text-ink-2">
          {project.name}. Kittum has no sign-in yet, so choose yourself. The server keeps each
          person&rsquo;s queue blind to the others&rsquo;, but anyone who can reach it can act as
          anyone: run it only where every user is trusted.
        </p>
        <ol className="mt-8 border-y border-rule" aria-label="People on this review">
          {project.members.map((member, index) => (
            <li key={member.actor_id} className="border-b border-rule last:border-b-0">
              <button
                type="button"
                onClick={() => onChoose(member)}
                className="grid w-full grid-cols-[28px_1fr_auto] items-baseline gap-x-4 px-2 py-3.5 text-left hover:bg-sheet focus-visible:bg-sheet"
              >
                <Key k={String(index + 1)} />
                <span className="text-md font-semibold">{member.display_name}</span>
                <span className="text-xs text-ink-2">
                  {member.roles.map((r) => ROLE_LABELS[r]).join(", ")}
                </span>
              </button>
            </li>
          ))}
        </ol>
        {project.members.length === 0 ? (
          <p className="mt-4 text-ink-2">
            This review has no people yet. Its methods lead adds them under Setup.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The ledger's state on every lead screen: a quiet check while it verifies, a red mark that
 * opens the audit when it does not. */
function LedgerMark({ projectId, actorId }: { projectId: string; actorId: string }) {
  const { workbench } = Route.useRouteContext();
  // Checked again on every screen change, so a new check on Audit shows here too.
  const path = useLocation({ select: (l) => l.pathname });
  const [ledger, setLedger] = useState<{ ok: boolean; seq: number | null } | null>(null);
  useEffect(() => {
    let live = true;
    run(workbench.ledger({ projectId, as: actorId })).then(
      (l) =>
        live &&
        setLedger({
          ok: l.ok,
          seq: l.ok ? (l.checked_through_seq ?? null) : (l.verify?.first_bad_seq ?? null),
        }),
      () => live && setLedger(null),
    );
    return () => {
      live = false;
    };
  }, [workbench, projectId, actorId, path]);
  if (!ledger) return null;
  return (
    <Link
      to="/p/$projectId/audit"
      params={{ projectId }}
      data-testid="ledger-mark"
      className={`flex flex-none items-center gap-1.5 rounded-[3px] px-2 py-1 text-xs whitespace-nowrap ${
        ledger.ok ? "text-ink-2 hover:text-ink" : "bg-exclude-wash font-semibold text-exclude"
      }`}
      title={
        ledger.ok
          ? `Every ledger event up to ${ledger.seq ?? "the last"} matches its hash. Open the audit.`
          : `The ledger's hash chain breaks at event ${ledger.seq ?? "?"}. Open the audit.`
      }
    >
      <Mark term={ledger.ok ? VERDICTS.met : VERDICTS.not_met} />
      {ledger.ok ? (
        <span>
          Ledger<span className="sr-only"> verified</span>
        </span>
      ) : (
        "Ledger break"
      )}
    </Link>
  );
}
