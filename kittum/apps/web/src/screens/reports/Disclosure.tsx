// The AI-use disclosure on the Reports screen: who saw the AI's reading when, what the AI
// proposed and how it was involved in people's exclusions, agreement, and every prompt. The same
// component shows the preview (computed now, kept nowhere) and the generated report.
import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { MODE_LABELS, modeLabel, revealLabel } from "../../lib/labels.ts";
import {
  exposureHeadline,
  exposureSentence,
  kappaFlag,
  pairSides,
  split,
  STAGES,
  TOO_FEW,
} from "./disclosure.ts";
import type { Agreement, DisclosureStage } from "./disclosure.ts";
import { Status, WAITS } from "../../ui/Status.tsx";
import { byFormat, DownloadLink, NUM, plural, SECTION, SectionHead, TH } from "./parts.tsx";
import type { Download, Integrity } from "./parts.tsx";

interface PromptCard {
  readonly role: "judge" | "assistant" | "extraction";
  readonly label: string;
  readonly prompt_version: string | null;
  readonly prompt_hash: string | null;
  readonly recipe_id: string | null;
  readonly model: Record<string, unknown>;
  readonly request_settings: Record<string, unknown>;
  readonly system_prompt: string | null;
  readonly user_prompt_template: string | null;
  readonly first_user_prompt: string | null;
  readonly json_schema: unknown;
  readonly request_sha256: string | null;
  readonly request_form: string | null;
  readonly calls: number;
}

/** The disclosure record, as the `ai_disclosure` target writes it (the parts shown here). */
export interface Disclosure {
  readonly cutoff_seq: number;
  readonly prompts: ReadonlyArray<PromptCard>;
  readonly stages: ReadonlyArray<DisclosureStage>;
}

const ROLES = { judge: "AI judge", assistant: "Protocol assistant", extraction: "Extraction" };

const fixed = (n: number | null) => (n === null ? "Not defined" : n.toFixed(2));

const GROUP = "border-l border-rule px-2 pb-0.5 text-center font-medium";
/** The first column of a group, set off from the one before. */
const START = "border-l border-rule pl-3";

/** The table's short column names: each defined on its header, and all of them in one place
 * that opens on request. */
const DEFINITIONS = {
  raw: ["Raw", "The model’s own exclusions: it answered not met on a criterion."],
  checked: [
    "Quote-checked",
    "Of the raw exclusions, those whose quote Kittum found in the record. A quote that matches does not show the AI read it correctly.",
  ],
  alsoChecked: [
    "AI agreed (checked)",
    "People excluded the record, and the AI’s quote-checked reading excluded it too.",
  ],
  seen: ["After seeing the AI", "People excluded the record after a person saw the AI’s reading."],
  extra: ["Extra screen", "The AI’s disagreement sent the record to a blind extra screen."],
  visible: ["With AI visible", "A first decision made with the AI’s reading on screen."],
} as const;

/** A term with its definition on hover, as Progress marks one. */
const HELP = "cursor-help underline decoration-ink-3 decoration-dotted underline-offset-2";

/** A column header with its definition on hover. */
function Defined({ term: [name, meaning] }: { term: readonly [string, string] }) {
  return (
    <abbr title={meaning} className={HELP}>
      {name}
    </abbr>
  );
}

const KAPPA =
  "Cohen’s kappa: agreement beyond chance. 1 is perfect, 0 is what chance gives. Below 0.4 is flagged.";
const PABAK =
  "Prevalence- and bias-adjusted kappa: kappa as if include and exclude were equally common. Below 0.4 is flagged.";

/** The AI-use disclosure, generated (with its files) or as a preview (files empty). */
export function DisclosureSection({
  record,
  files,
  names,
  scopeLabel,
  integrity,
  state,
  actions,
}: {
  record: Disclosure;
  files: ReadonlyArray<Download>;
  names: ReadonlyMap<string, string>;
  scopeLabel: (id: string) => string;
  integrity?: Integrity | null;
  /** What this is: "Generated at ledger event 179", or a preview line. */
  state?: ReactNode;
  actions?: ReactNode;
}) {
  const scopes = new Set(record.stages.map((s) => s.scope_id));
  const stageName = (s: DisclosureStage) =>
    scopes.size > 1 ? `${STAGES[s.stage]}, ${scopeLabel(s.scope_id)}` : STAGES[s.stage];
  return (
    <section id="report-disclosure" className={SECTION} data-testid="disclosure">
      <SectionHead
        title="AI-use disclosure"
        state={state ?? `Generated at ledger event ${record.cutoff_seq}`}
        integrity={integrity}
        seq={record.cutoff_seq}
      >
        {actions}
        {byFormat(files).map((f) => (
          <DownloadLink key={f.name} file={f} />
        ))}
      </SectionHead>

      {/* The text that goes into the paper is the sheet; the controls and prompts stay on the desk. */}
      <div
        className="mt-4 rounded-[6px] bg-raised px-6 py-5 shadow-raised"
        data-testid="disclosure-sheet"
      >
        <p className="max-w-[100ch] text-md" data-testid="disclosure-summary">
          {exposureHeadline(record.stages)}
        </p>
        <Unverified stages={record.stages} stageName={stageName} />
        <details className="mt-3 text-sm text-ink-2" data-testid="disclosure-glossary">
          <summary className="cursor-pointer hover:text-ink">How to read these counts</summary>
          <dl className="mt-2 grid max-w-[120ch] grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            {Object.values(DEFINITIONS).map(([term, meaning]) => (
              <div key={term} className="contents">
                <dt className="font-medium text-ink">{term}</dt>
                <dd>{meaning}</dd>
              </div>
            ))}
            <dt className="font-medium text-ink">Overlap</dt>
            <dd>The four exclusion columns overlap: one record can count in several.</dd>
          </dl>
        </details>
        <table className="mt-3 w-full text-md" data-testid="disclosure-stages">
          <thead>
            <tr className="text-sm text-ink-2">
              <th />
              <th colSpan={2} className={GROUP}>
                Records
              </th>
              <th colSpan={2} className={`${GROUP} bg-sheet-2`}>
                AI proposals to exclude
              </th>
              <th colSpan={4} className={GROUP}>
                Excluded by people
              </th>
              <th colSpan={2} className={GROUP}>
                First decisions
              </th>
            </tr>
            <tr className="border-b border-rule">
              <th className={TH}>Stage, screening, and when people saw the AI</th>
              <th className={`${TH} ${START} text-right`}>All</th>
              <th className={`${TH} text-right`}>Read by the AI</th>
              <th className={`${TH} ${START} bg-sheet-2 text-right`}>
                <Defined term={DEFINITIONS.raw} />
              </th>
              <th className={`${TH} bg-sheet-2 text-right`}>
                <Defined term={DEFINITIONS.checked} />
              </th>
              <th className={`${TH} ${START} text-right`}>All</th>
              <th className={`${TH} max-w-[9rem] text-right`}>
                <Defined term={DEFINITIONS.alsoChecked} />
              </th>
              <th className={`${TH} text-right`}>
                <Defined term={DEFINITIONS.seen} />
              </th>
              <th className={`${TH} text-right`}>
                <Defined term={DEFINITIONS.extra} />
              </th>
              <th className={`${TH} ${START} text-right`}>Blind</th>
              <th className={`${TH} text-right`}>
                <Defined term={DEFINITIONS.visible} />
              </th>
            </tr>
          </thead>
          <tbody>
            {record.stages.map((s) => {
              const counts = split(s);
              const known = (n: number | undefined) => n ?? "Not recorded";
              // The columns say who decided blind; a sentence adds only what they cannot: how
              // often Kittum showed the AI's reading after a decision, and what changed.
              const after = s.reveal === "always" || s.reveal === "on_disagreement";
              return (
                <Fragment key={`${s.stage}-${s.scope_id}`}>
                  <tr className={`align-baseline ${after ? "" : "border-b border-rule"}`}>
                    <td className="py-2 pr-4">
                      <span className="font-medium">{stageName(s)}</span>
                      <span className="block text-sm text-ink-2">
                        <span title={MODE_LABELS[s.mode]?.long}>{modeLabel(s.mode)}</span>;{" "}
                        {revealLabel(s.reveal)}
                      </span>
                    </td>
                    <td className={`${NUM} ${START}`}>{s.records}</td>
                    <td className={NUM}>{s.records_read_by_ai}</td>
                    <td className={`${NUM} ${START} bg-sheet-2 font-semibold`}>
                      {known(s.ai_own_reading_exclusions)}
                    </td>
                    <td className={`${NUM} bg-sheet-2 font-semibold`}>
                      {s.ai_proposed_exclusions}
                    </td>
                    <td className={`${NUM} ${START}`}>{s.excluded}</td>
                    <td className={NUM}>{known(s.excluded_with_ai_proposal)}</td>
                    <td className={NUM}>{known(s.excluded_after_ai_seen)}</td>
                    <td className={NUM}>{known(s.excluded_after_ai_rescreen)}</td>
                    <td className={`${NUM} ${START}`} data-testid="stage-blind">
                      {counts ? counts.blind : "Not recorded"}
                    </td>
                    <td className={NUM} data-testid="stage-on-screen">
                      {counts ? counts.onScreen : "Not recorded"}
                    </td>
                  </tr>
                  {after ? (
                    <tr className="border-b border-rule">
                      <td
                        colSpan={11}
                        className="pb-2 text-sm text-ink-2"
                        data-testid="stage-exposure"
                      >
                        {exposureSentence(s)}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>

        <h3 className="mt-8 text-md font-semibold">Agreement</h3>
        <p className="mt-1 max-w-[110ch] text-sm text-ink-2">
          First decisions on the records both sides decided, people against each other and against
          the AI&rsquo;s raw and quote-checked readings. Open a row for its table.
        </p>
        <table className="mt-3 w-full text-md" data-testid="agreement-table">
          <thead>
            <tr className="border-b border-rule">
              <th className={TH}>Pair</th>
              <th className={`${TH} text-right`}>Records</th>
              <th className={`${TH} text-right`}>Agreed</th>
              <th className={`${TH} text-right`}>
                <abbr title={KAPPA} className={HELP}>
                  Kappa
                </abbr>
              </th>
              <th className={`${TH} text-right`}>
                <abbr title={PABAK} className={HELP}>
                  PABAK
                </abbr>
              </th>
            </tr>
          </thead>
          {record.stages.map((s) => (
            <tbody key={`${s.stage}-${s.scope_id}-agreement`}>
              <tr>
                <th colSpan={5} className="pt-4 pb-1 text-left text-sm font-semibold">
                  {stageName(s)}
                  {sharedExposure(s) ? (
                    <>
                      {" "}
                      <ExposureTag
                        label={sharedExposure(s)!}
                        title={EXPOSURE_TITLES[sharedExposure(s)!] ?? ""}
                      />
                    </>
                  ) : null}
                </th>
              </tr>
              {s.agreement.length === 0 ? (
                <tr className="border-b border-rule">
                  <td colSpan={5} className="py-2 text-ink-2">
                    No pair to compare: one person screens each record.
                  </td>
                </tr>
              ) : (
                <>
                  {s.agreement
                    .filter((a) => a.items > 0)
                    .map((a) => (
                      <AgreementRows
                        key={`${a.kind}-${(a.actor_ids ?? a.raters).join()}`}
                        agreement={a}
                        names={names}
                        tagged={!sharedExposure(s)}
                      />
                    ))}
                  <EmptyPairs pairs={s.agreement.filter((a) => a.items === 0)} names={names} />
                </>
              )}
            </tbody>
          ))}
        </table>
      </div>

      <details className="mt-6 rounded-[4px] bg-sheet-2 px-4 py-3" data-testid="disclosure-prompts">
        <summary className="cursor-pointer text-md font-semibold">
          Prompts{" "}
          <span className="font-normal text-ink-2">
            {record.prompts.length === 0
              ? "(none sent yet)"
              : `(${plural(record.prompts.length, "AI role", "AI roles")}, read from the first request each sent)`}
          </span>
        </summary>
        {record.prompts.length === 0
          ? null
          : record.prompts.map((card, i) => {
              const label = card.label.replace(/, scope (.+)$/, (_, id: string) =>
                scopes.size > 1 ? `, ${scopeLabel(id)}` : "",
              );
              // Two cards for one role and stage (a re-judge, or a new protocol) are told apart by
              // what differs: the prompt's version, else its hash; and always their call counts.
              const twins = record.prompts.filter(
                (c) => c.role === card.role && c.label === card.label,
              );
              const differs = (key: (c: PromptCard) => string | null) =>
                new Set(twins.map(key)).size > 1 ? key(card) : null;
              const which =
                differs((c) => c.prompt_version) ??
                differs((c) => c.prompt_hash?.slice(0, 8) ?? null);
              const suffix =
                twins.length > 1
                  ? [which ? `prompt ${which}` : null, plural(card.calls, "call", "calls")]
                      .filter(Boolean)
                      .join(", ")
                  : null;
              return (
                <PromptDetails
                  key={`${card.role}-${card.label}-${i}`}
                  card={card}
                  label={suffix ? `${label}, ${suffix}` : label}
                />
              );
            })}
      </details>
    </section>
  );
}

/** Where the AI's raw reading proposed exclusions that Kittum could not back with a quote: the
 * proposals a person should look at before relying on them. Stated, not judged wrong. */
function Unverified({
  stages,
  stageName,
}: {
  stages: ReadonlyArray<DisclosureStage>;
  stageName: (s: DisclosureStage) => string;
}) {
  const gaps = stages.flatMap((s) => {
    const raw = s.ai_own_reading_exclusions;
    return raw !== undefined && raw > s.ai_proposed_exclusions
      ? [{ s, raw, checked: s.ai_proposed_exclusions }]
      : [];
  });
  if (gaps.length === 0) return null;
  return (
    <ul className="mt-3 max-w-[100ch] space-y-1 text-md" data-testid="quote-unverified">
      {gaps.map(({ s, raw, checked }) => (
        <li key={`${s.stage}-${s.scope_id}`}>
          <Status term={{ ...WAITS, label: "Quote not found" }}>
            {stageName(s)}: {raw - checked} of the AI&rsquo;s {raw} exclusion proposals had no quote
            Kittum could find; only {checked} count as quote-checked.
          </Status>
        </li>
      ))}
    </ul>
  );
}

/** Kappa's flag, worded and coloured as on Progress. */
function KappaFlag({ kappa, measure = "Kappa" }: { kappa: number | null; measure?: string }) {
  const flag = kappaFlag(kappa);
  if (!flag) return null;
  return (
    <span
      className={`ml-1.5 rounded-full px-2 py-px text-xs font-medium ${
        flag === "below"
          ? "bg-exclude-wash text-exclude"
          : "bg-sheet-2 text-ink-2 shadow-[inset_0_0_0_1px_var(--rule-strong)]"
      }`}
      title={
        flag === "below"
          ? `${measure} below 0: the two agree less often than chance would make them.`
          : `${measure} below 0.4: weak agreement beyond chance.`
      }
    >
      {flag === "below" ? "Below chance" : "Low"}
    </span>
  );
}

const EXPOSURE_TITLES: Record<string, string> = {
  Blind: "Every decision in these pairs was made before Kittum showed any AI output.",
  "AI on screen": "Every decision in these pairs was made with the AI’s reading on screen.",
};

/** "Blind" or "AI on screen" when every pair of a stage with records shares it, else null: the
 * stage's heading says it once instead of every row. */
const sharedExposure = (s: DisclosureStage) => {
  const kinds = new Set(
    s.agreement
      .filter((a) => a.items > 0)
      .map((a) =>
        (a.ai_on_screen ?? 0) === 0
          ? "Blind"
          : a.ai_on_screen === a.items
            ? "AI on screen"
            : "mixed",
      ),
  );
  const [only] = kinds;
  return kinds.size === 1 && only !== "mixed" ? only! : null;
};

/** A neutral tag: were the people's decisions blind? */
function ExposureTag({ label, title }: { label: string; title: string }) {
  return (
    <span
      className="ml-1.5 rounded-[3px] border border-rule-strong px-1.5 py-px text-xs font-normal text-ink-2"
      title={title}
    >
      {label}
    </span>
  );
}

/** The tag after one pair, when its stage's pairs differ. */
function Exposure({ agreement: a }: { agreement: Agreement }) {
  const seen = a.ai_on_screen ?? 0;
  return (
    <ExposureTag
      label={seen ? (seen === a.items ? "AI on screen" : `AI on screen for ${seen}`) : "Blind"}
      title={
        seen
          ? `On ${seen} of the ${a.items} records a person decided with the AI’s reading on screen.`
          : "Every decision in this pair was made before Kittum showed any AI output."
      }
    />
  );
}

function AgreementRows({
  agreement: a,
  names,
  tagged,
}: {
  agreement: Agreement;
  names: ReadonlyMap<string, string>;
  tagged: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [first, second] = pairSides(a, names);
  const pseudonyms = a.kind === "human_human" ? a.raters.join(" and ") : a.raters[0];
  const lower = a.kind === "human_human" ? second : `t${second.slice(1)}`;
  const few = a.items < TOO_FEW;
  const cell = "px-3 py-1.5 text-right tabular-nums";
  return (
    <>
      <tr
        className="cursor-pointer border-b border-rule hover:bg-sheet"
        data-testid="disclosure-agreement"
        // The whole row opens its table; the button keeps it reachable by keyboard.
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("button")) setOpen((o) => !o);
        }}
      >
        <td className="py-1 pr-4">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-2 rounded-[3px] py-1 text-left hover:text-petrol focus-visible:outline-2 focus-visible:outline-petrol"
            title={`${pseudonyms} in the published disclosure`}
          >
            <span aria-hidden="true" className="w-3 text-ink-2">
              {open ? "▾" : "▸"}
            </span>
            <span className="underline decoration-rule-strong decoration-dotted underline-offset-4">
              {first} and {lower}
            </span>
          </button>
          {tagged ? (
            <>
              {" "}
              <Exposure agreement={a} />
            </>
          ) : null}
        </td>
        <td className={NUM}>{a.items}</td>
        <td className={NUM}>
          {a.agreed} of {a.items}{" "}
          <span className="text-ink-2">({Math.round((100 * a.agreed) / a.items)}%)</span>
        </td>
        {few ? (
          <td
            colSpan={2}
            className="py-2 pr-4 text-right text-ink-2"
            data-testid="too-little-data"
            title={`Kappa ${fixed(a.kappa)}, PABAK ${fixed(a.pabak)}, over ${plural(a.items, "record", "records")}: too few to read.`}
          >
            Too little data ({plural(a.items, "record", "records")})
          </td>
        ) : (
          <>
            <td className={NUM}>
              <span data-testid="kappa">{fixed(a.kappa)}</span> <KappaFlag kappa={a.kappa} />
            </td>
            <td className={NUM}>
              <span data-testid="pabak">{fixed(a.pabak)}</span>{" "}
              <KappaFlag kappa={a.pabak} measure="PABAK" />
            </td>
          </>
        )}
      </tr>
      {open ? (
        <tr className="border-b border-rule bg-sheet">
          <td colSpan={5} className="px-8 py-3">
            <table className="text-sm" aria-label={`${first} against ${lower}`}>
              <thead className="text-ink-2">
                <tr>
                  <th />
                  <th colSpan={2} className="px-3 text-center font-normal">
                    {second}
                  </th>
                </tr>
                <tr>
                  <th className="px-3 text-left font-normal">{first}</th>
                  <th className="px-3 text-right font-normal">Include</th>
                  <th className="px-3 text-right font-normal">Exclude</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-rule">
                  <th className="px-3 text-left font-normal text-ink-2">Include</th>
                  <td className={`${cell} bg-sheet-2 font-semibold`}>{a.table.include_include}</td>
                  <td className={cell}>{a.table.include_exclude}</td>
                </tr>
                <tr className="border-t border-rule">
                  <th className="px-3 text-left font-normal text-ink-2">Exclude</th>
                  <td className={cell}>{a.table.exclude_include}</td>
                  <td className={`${cell} bg-sheet-2 font-semibold`}>{a.table.exclude_exclude}</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-2 text-sm text-ink-2">
              Agreed on {a.agreed} of {a.items} records, the shaded cells. Kappa and PABAK cover all{" "}
              {a.items}, agreed or not.
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Pairs with no record in common, folded into one line that opens to the list. */
function EmptyPairs({
  pairs,
  names,
}: {
  pairs: ReadonlyArray<Agreement>;
  names: ReadonlyMap<string, string>;
}) {
  const [open, setOpen] = useState(false);
  if (pairs.length === 0) return null;
  const people = [...new Set(pairs.map((a) => pairSides(a, names)[0]))];
  return (
    <>
      <tr className="border-b border-rule" data-testid="agreement-empty">
        <td colSpan={5} className="py-1 text-ink-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-2 rounded-[3px] py-1 text-left hover:text-petrol"
          >
            <span aria-hidden="true" className="w-3">
              {open ? "▾" : "▸"}
            </span>
            {pairs.every((a) => a.kind !== "human_human")
              ? `${people.join(" and ")}: no records both decided yet`
              : `No records both decided yet: ${plural(pairs.length, "pair", "pairs")} with ${people.join(", ")}`}
          </button>
        </td>
      </tr>
      {open
        ? pairs.map((a) => {
            const [first, second] = pairSides(a, names);
            return (
              <tr
                key={`${a.kind}-${(a.actor_ids ?? a.raters).join()}`}
                className="border-b border-rule"
              >
                <td colSpan={5} className="py-1.5 pl-5 text-sm text-ink-2">
                  {first} and {a.kind === "human_human" ? second : `t${second.slice(1)}`}
                </td>
              </tr>
            );
          })
        : null}
    </>
  );
}

function Text({ label, children }: { label: string; children: string }) {
  return (
    <div className="mt-3">
      <h4 className="text-sm font-medium text-ink-2">{label}</h4>
      <pre className="mt-1 max-h-96 overflow-auto rounded-[3px] bg-sheet-2 p-2.5 text-xs leading-relaxed whitespace-pre-wrap">
        {children}
      </pre>
    </div>
  );
}

function PromptDetails({ card, label }: { card: PromptCard; label: string }) {
  const model = card.model;
  const facts: ReadonlyArray<readonly [string, unknown]> = [
    ["Recipe", card.recipe_id],
    ["Model", model["repository"] ?? model["model_as_sent"]],
    ["Revision", model["revision"] ?? "Not recorded for this role"],
    ["Serving", model["serving"]],
    ["Endpoint", (model["endpoints"] as string[] | undefined)?.join(", ")],
    [
      "Model as reported by the server",
      (model["reported_model_identities"] as string[] | undefined)?.join(", "),
    ],
    ["Server options from the recipe", model["extra_body"]],
    ["Prompt version", card.prompt_version],
    ["Calls", card.calls],
  ];
  return (
    <details className="mt-2 border-b border-rule pb-2" data-testid="prompt-card">
      <summary className="cursor-pointer py-1 text-md">
        <span className="font-medium">{ROLES[card.role]}</span>
        {label.startsWith(ROLES[card.role]) ? "" : `, ${label}`}
      </summary>
      <dl className="mt-2 grid grid-cols-[minmax(10rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-sm">
        {facts
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .filter(([, v]) => typeof v !== "object" || Object.keys(v as object).length > 0)
          .map(([name, v]) => (
            <div key={name} className="contents">
              <dt className="text-ink-2">{name}</dt>
              <dd className="break-all tabular-nums">
                {typeof v === "object" ? JSON.stringify(v) : String(v)}
              </dd>
            </div>
          ))}
      </dl>
      {card.request_sha256 === null ? (
        <p className="mt-2 text-sm text-ink-2">
          Kittum has no stored request for this role, so it cannot show the prompts.
        </p>
      ) : (
        <>
          {Object.keys(card.request_settings).length > 0 ? (
            <Text label="Request settings as sent">
              {JSON.stringify(card.request_settings, null, 2)}
            </Text>
          ) : null}
          {card.system_prompt !== null ? (
            <Text label="System prompt">{card.system_prompt}</Text>
          ) : null}
          {card.user_prompt_template !== null ? (
            <Text label="User prompt template. Kittum fills in the parts in braces for each record.">
              {card.user_prompt_template}
            </Text>
          ) : null}
          {card.first_user_prompt !== null ? (
            <Text label="User prompt of the first call, as sent">{card.first_user_prompt}</Text>
          ) : null}
          {card.json_schema ? (
            <Text label="JSON schema the answer must follow">
              {JSON.stringify(card.json_schema, null, 2)}
            </Text>
          ) : null}
        </>
      )}
    </details>
  );
}
