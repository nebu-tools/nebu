// The protocol as the server stores it (`ReviewProtocol` dumped to JSON), read and changed only as
// far as the form shows it. Everything else in a document (outcome definitions, reference sets,
// extensions) passes through the form untouched; the YAML view edits it.
import type { AiMark, ProtocolRevision, ProtocolSource, QueryDialect } from "../../data/schema.ts";

export type Localized = Readonly<Record<string, string>>;
interface Comparator {
  readonly id: string;
  readonly text: Localized;
}
export interface Question {
  readonly id: string;
  readonly label: Localized;
  /** A few words that name the question where the full question does not fit. */
  readonly short_label?: string | null;
  readonly population: Localized;
  readonly intervention: Localized;
  readonly comparators: ReadonlyArray<Comparator>;
  readonly outcomes?: ReadonlyArray<string>;
}
export interface Criterion {
  readonly id: string;
  readonly slot: string;
  readonly polarity: string;
  readonly text: Localized;
  readonly decidable_at: ReadonlyArray<string>;
  readonly applies_to: ReadonlyArray<string>;
  /** A word or two for the screening strip. */
  readonly short_label?: string | null;
  /** The reason the PRISMA flow names for records excluded on it, if not its own words. */
  readonly exclusion_reason?: string | null;
}
export interface Source {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly platform?: string | null;
  readonly strategy?: string;
}
/** A topic's scopes: objects as the server stores them, question IDs as the form writes them. */
type Scope = string | { readonly id: string };
export interface Topic {
  readonly id: string;
  readonly label: Localized;
  readonly mode: string;
  readonly mode_rationale?: Localized | null;
  readonly validation_pack?: string | null;
  readonly stopping?: unknown;
  readonly audit?: {
    readonly sentinel_percent?: string;
    readonly random_audit_percent?: string;
    readonly census_of_disagreements?: boolean;
  };
  readonly scopes: ReadonlyArray<Scope>;
  readonly criteria: ReadonlyArray<Criterion>;
  readonly source_plan: { readonly sources: ReadonlyArray<Source> };
  /** The AI judge's strictness, the team's guidance, and the team's own prompt wording, if any;
   * left out while all are the default. */
  readonly judge?: {
    readonly strictness?: string;
    readonly guidance?: string | null;
    readonly system_prompt?: string | null;
    readonly user_template?: string | null;
  };
}
interface Outcome {
  readonly id: string;
  readonly category: string;
  readonly name: Localized;
}
export interface Doc {
  readonly title: Localized;
  readonly version_label: string;
  readonly default_language: string;
  readonly questions: ReadonlyArray<Question>;
  readonly outcomes: ReadonlyArray<Outcome>;
  readonly search_topics: ReadonlyArray<Topic>;
}

export const docOf = (r: ProtocolRevision) => r.document as unknown as Doc;

/** A protocol with one of everything it needs and every text empty, for a lead who writes it. */
export const blankDoc = (): Doc => ({
  version_label: "0.1",
  default_language: "en",
  title: { en: "" },
  questions: [
    {
      id: "q1",
      label: { en: "" },
      population: { en: "" },
      intervention: { en: "" },
      comparators: [],
    },
  ],
  outcomes: [{ id: "o1", category: "primary", name: { en: "" } }],
  search_topics: [
    {
      id: "studies",
      kind: "studies",
      label: { en: "Studies" },
      mode: "M1",
      scopes: ["q1"],
      audit: { sentinel_percent: "1", random_audit_percent: "10" },
      freshness: { max_age_months: 12 },
      source_plan: { sources: [PUBMED("medline")] },
      criteria: [
        {
          id: "C1",
          slot: "population",
          polarity: "include",
          text: { en: "" },
          decidable_at: ["title_abstract", "full_text"],
          applies_to: ["studies"],
        },
      ],
    } as Topic,
  ],
});

/**
 * The two ways a team works, as settings of a search topic. A preset only fills in the settings;
 * the methods text and the disclosure come from the settings, never from the preset's name.
 */
export const PRESETS = {
  documented: {
    label: "Documented SLR",
    sets: "two screeners with the AI as third, 1% sentinels, a 10% audit sample, and complete documentation",
    description:
      "Mode M1 with complete documentation: two people screen every record blind, the AI is a third screener, sentinels and an audit sample check the screening.",
  },
  targeted: {
    label: "Targeted search",
    sets: "a pool of screeners with second opinions, no sentinels or audit sample, and working documentation",
    description:
      "Mode S with working documentation: one person of a pool screens each record and asks a colleague for a second opinion when unsure. No auditor, no sentinels. The AI's reading may show before the decision.",
  },
} as const;
export type Preset = keyof typeof PRESETS;

/** The preset a topic's settings match, or null when they match neither (M2, M3, or an audit
 * plan of the lead's own): the form calls that "Custom". */
export const presetOf = (topic: Topic): Preset | null => {
  const sentinels = Number(topic.audit?.sentinel_percent ?? "0");
  const audit = Number(topic.audit?.random_audit_percent ?? "0");
  if (topic.mode === "M1" && sentinels === 1 && audit === 10) return "documented";
  if (topic.mode === "S" && sentinels === 0 && audit === 0) return "targeted";
  return null;
};

/** The topic with a preset's settings. A rationale stays: S needs one, and only the lead can
 * write it. */
export const withPreset = (topic: Topic, preset: Preset): Topic => ({
  ...topic,
  mode: preset === "documented" ? "M1" : "S",
  mode_rationale: preset === "documented" ? null : (topic.mode_rationale ?? null),
  validation_pack: null,
  stopping: null,
  audit: {
    ...topic.audit,
    census_of_disagreements: true,
    ...(preset === "documented"
      ? { sentinel_percent: "1", random_audit_percent: "10" }
      : { sentinel_percent: "0", random_audit_percent: "0" }),
  },
});

export const PUBMED = (id: string): Source => ({
  id,
  kind: "bibliographic",
  name: "MEDLINE",
  platform: "PubMed",
  strategy: "",
});
export const CTGOV = (id: string): Source => ({
  id,
  kind: "registry",
  name: "ClinicalTrials.gov",
  strategy: "",
});

/** The label after `label`, by its last number: "1.1" to "1.2", "1" to "2", "0.3" to "0.4". */
export const nextLabel = (label: string) => {
  const found = /^(.*?)(\d+)(\D*)$/.exec(label.trim());
  return found ? `${found[1]}${Number(found[2]) + 1}${found[3]}` : `${label.trim()}.1`;
};

/** Whether `label` comes after `before`, number by number: "1.2" after "1.1", "2" after "1.9".
 * Labels without numbers count as after when they differ. */
export const comesAfter = (label: string, before: string) => {
  const numbers = (x: string) => (x.match(/\d+/g) ?? []).map(Number);
  const a = numbers(label);
  const b = numbers(before);
  if (!a.length || !b.length) return label.trim() !== before.trim();
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
};

/** An ID not yet used in `taken`: `prefix` and the first free number. */
export const freshId = (prefix: string, taken: ReadonlyArray<string>) => {
  for (let n = 1; ; n++) if (!taken.includes(`${prefix}${n}`)) return `${prefix}${n}`;
};

/** What the server compiles: scopes as question IDs (it fills in their labels), and no empty
 * query, since a source without one is searched on its own platform. */
export const forSaving = (doc: Doc): ProtocolSource =>
  ({
    ...doc,
    search_topics: doc.search_topics.map((t) => ({
      ...t,
      scopes: t.scopes.map((s) => (typeof s === "string" ? s : s.id)),
      source_plan: {
        ...t.source_plan,
        sources: t.source_plan.sources.map((s) => {
          if (s.strategy?.trim()) return s;
          const { strategy: _, ...rest } = s;
          return rest;
        }),
      },
    })),
  }) as unknown as ProtocolSource;

/** The interface a strategy is written for, as the server decides it. */
export const dialectOf = (s: Source): QueryDialect | null => {
  const platform = (s.platform ?? "").toLowerCase();
  if (platform === "pubmed" || s.id.toLowerCase() === "pubmed") return "pubmed";
  const names = [s.id, platform, s.name].map((n) => n.toLowerCase());
  if (names.some((n) => ["europepmc", "europe_pmc", "europe pmc"].includes(n))) {
    return "europepmc";
  }
  return names.some((n) => ["clinicaltrials_gov", "ctgov", "clinicaltrials.gov"].includes(n))
    ? "ctgov"
    : null;
};

export const SOURCE_NAME: Record<QueryDialect, string> = {
  pubmed: "PubMed",
  europepmc: "Europe PMC",
  ctgov: "ClinicalTrials.gov",
};

export const strategyPath = (t: Topic, s: Source) =>
  `search_topics[${t.id}].source_plan.sources[${s.id}].strategy`;

/** The marks on a part: the field itself or anything inside it. */
export const marksOn = (marks: ReadonlyArray<AiMark>, part: string) =>
  marks.filter(
    (m) => m.path === part || m.path.startsWith(`${part}.`) || m.path.startsWith(`${part}[`),
  );

/** The value at a path in the notation of AI marks (`questions[q1].population`), or undefined. */
export const valueAt = (doc: unknown, path: string): unknown => {
  let node: unknown = doc;
  for (const m of path.matchAll(/([A-Za-z_][A-Za-z0-9_]*)|\[([^\]]+)\]/g)) {
    if (node === null || typeof node !== "object") return undefined;
    node = m[1]
      ? (node as Record<string, unknown>)[m[1]]
      : (node as ReadonlyArray<{ id?: string }>).find?.((i) => i?.id === m[2]);
  }
  return node;
};

/** "MEDLINE query", "criterion POP", "question nrt-vs-control", from a part's path. */
export const partName = (doc: Doc, part: string) => {
  for (const t of doc.search_topics) {
    for (const s of t.source_plan.sources) {
      if (strategyPath(t, s) === part) return `${s.name} query`;
    }
    for (const c of t.criteria)
      if (`search_topics[${t.id}].criteria[${c.id}]` === part) return `criterion ${c.id}`;
  }
  const q = doc.questions.find((x) => `questions[${x.id}]` === part);
  return q ? `question ${q.id}` : part;
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A source from the YAML view as the form can show it: the lists and texts the schema lets a
 * protocol leave out filled in empty, everything else kept as it is. The compiler judges the
 * rest when the lead saves. Returns why not when the shape is one the form cannot show: a list
 * given as text, an entry without an ID, or a value the form reads as a string (a source's name,
 * platform, and query, a choice, a text in one language) that is something else. */
export const toDoc = (source: unknown): { readonly doc: Doc } | { readonly problem: string } => {
  const problems: string[] = [];
  const list = (owner: Json, key: string, at: string): Json[] => {
    const value = owner[key] ?? [];
    if (!Array.isArray(value)) {
      problems.push(`${at}${key} must be a list.`);
      return [];
    }
    return value.map((item, i) => {
      if (!isObject(item)) problems.push(`${at}${key}[${i}] must be a mapping of fields.`);
      return isObject(item) ? item : {};
    });
  };
  /** What a value that must be a string is instead, in words. */
  const notText = (value: unknown) =>
    isObject(value)
      ? "must be plain text, not text per language."
      : Array.isArray(value)
        ? "must be text, not a list."
        : "must be text. Put the value in quotes.";
  const text = (owner: Json, key: string, at: string) => {
    const value = owner[key] ?? {};
    if (!isObject(value)) problems.push(`${at}${key} must give the text per language, as en: ...`);
    for (const [lang, words] of Object.entries(isObject(value) ? value : {}))
      if (typeof words !== "string") problems.push(`${at}${key}.${lang} ${notText(words)}`);
    return isObject(value) ? value : {};
  };
  /** Fields the form shows or reads as plain strings: absent or null is fine, anything else not. */
  const plain = (owner: Json, keys: ReadonlyArray<string>, at: string) => {
    for (const key of keys) {
      const value = owner[key];
      if (value !== undefined && value !== null && typeof value !== "string")
        problems.push(`${at}${key} ${notText(value)}`);
    }
  };
  const values = (owner: Json, key: string, at: string): unknown[] => {
    const value = owner[key] ?? [];
    if (!Array.isArray(value)) problems.push(`${at}${key} must be a list.`);
    return Array.isArray(value) ? value : [];
  };
  const withId = (item: Json, at: string) => {
    if (typeof item["id"] !== "string" || !item["id"])
      problems.push(`${at} needs an id for the form to show it.`);
  };
  if (!isObject(source)) return { problem: "The protocol must be a mapping of fields." };
  plain(source, ["version_label", "default_language"], "");
  const doc: Json = {
    ...source,
    title: text(source, "title", ""),
    questions: list(source, "questions", "").map((q, i) => {
      const at = `questions[${i}]`;
      withId(q, at);
      plain(q, ["short_label"], `${at}.`);
      if (q["outcomes"] !== undefined) values(q, "outcomes", `${at}.`);
      return {
        ...q,
        label: text(q, "label", `${at}.`),
        population: text(q, "population", `${at}.`),
        intervention: text(q, "intervention", `${at}.`),
        comparators: list(q, "comparators", `${at}.`).map((c, j) => {
          withId(c, `${at}.comparators[${j}]`);
          return { ...c, text: text(c, "text", `${at}.comparators[${j}].`) };
        }),
      };
    }),
    outcomes: list(source, "outcomes", "").map((o, i) => {
      withId(o, `outcomes[${i}]`);
      plain(o, ["category"], `outcomes[${i}].`);
      return { ...o, name: text(o, "name", `outcomes[${i}].`) };
    }),
    search_topics: list(source, "search_topics", "").map((t, i) => {
      const at = `search_topics[${i}]`;
      withId(t, at);
      plain(t, ["kind", "mode"], `${at}.`);
      const plan = t["source_plan"] ?? {};
      if (!isObject(plan)) problems.push(`${at}.source_plan must be a mapping of fields.`);
      const sourcePlan = isObject(plan) ? plan : {};
      return {
        ...t,
        label: text(t, "label", `${at}.`),
        scopes: values(t, "scopes", `${at}.`).map((scope, j) => {
          if (typeof scope !== "string" && !(isObject(scope) && typeof scope["id"] === "string"))
            problems.push(`${at}.scopes[${j}] must be a question's id.`);
          return scope;
        }),
        criteria: list(t, "criteria", `${at}.`).map((c, j) => {
          const cat = `${at}.criteria[${j}]`;
          withId(c, cat);
          plain(c, ["slot", "polarity", "short_label", "exclusion_reason"], `${cat}.`);
          return {
            polarity: "include",
            ...c,
            text: text(c, "text", `${cat}.`),
            decidable_at: values(c, "decidable_at", `${cat}.`),
            applies_to: values(c, "applies_to", `${cat}.`),
          };
        }),
        source_plan: {
          ...sourcePlan,
          sources: list(sourcePlan, "sources", `${at}.source_plan.`).map((s, j) => {
            const sat = `${at}.source_plan.sources[${j}]`;
            withId(s, sat);
            plain(s, ["kind", "name", "platform", "strategy"], `${sat}.`);
            return { ...s, name: s["name"] ?? "" };
          }),
        },
      };
    }),
  };
  return problems.length ? { problem: problems.join(" ") } : { doc: doc as unknown as Doc };
};
