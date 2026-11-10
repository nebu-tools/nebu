// Human words for Kittum's internal codes. Screens show these; IDs, slugs, and keys belong in
// hovers, exports, and the audit, never in the main text.

/** Screening modes as a methods lead would say them. */
export const MODE_LABELS: Record<string, { readonly short: string; readonly long: string }> = {
  M1: {
    short: "Two screeners, AI as third",
    long: "Two people screen every record blind. The AI reads every record as a third screener.",
  },
  M2: {
    short: "One screener, AI as second",
    long: "One person screens every record. The AI is the second screener.",
  },
  M3: {
    short: "Two screeners; the AI orders the queue; may stop early",
    long: "Two people screen in the AI's order and may stop early.",
  },
  S: {
    short: "Pool of screeners, second opinions",
    long: "One person of a pool screens each record and asks a colleague when unsure.",
  },
};

export const modeLabel = (mode: string | null | undefined) =>
  (mode && MODE_LABELS[mode]?.short) ?? mode ?? "";

/** When a screener sees the AI's reading. */
const REVEAL_LABELS: Record<string, string> = {
  never: "AI never shown",
  disagreement: "AI shown when it disagrees",
  on_disagreement: "AI shown when it disagrees",
  always: "AI shown after each decision",
  before: "AI shown before the decision",
};

export const revealLabel = (reveal: string | null | undefined) =>
  (reveal && REVEAL_LABELS[reveal]) ?? reveal ?? "";

const SOURCE_NAMES: Record<string, string> = {
  medline: "MEDLINE",
  pubmed: "PubMed",
  europepmc: "Europe PMC",
  europe_pmc: "Europe PMC",
  clinicaltrials_gov: "ClinicalTrials.gov",
  ctgov: "ClinicalTrials.gov",
  central: "Cochrane CENTRAL",
  embase: "Embase",
  scopus: "Scopus",
  wos: "Web of Science",
  openalex: "OpenAlex",
  crossref: "Crossref",
  unpaywall: "Unpaywall",
  pubtator: "PubTator 3",
  citation_search: "Citation search",
};

/** A search source's name, one name everywhere: the database's own name when Kittum knows it
 * ("MEDLINE", as the PRISMA figure names it, never the platform "PubMed"), else the name or
 * platform the lead gave, else the ID. */
export const sourceLabel = (id: string, given?: string | null) =>
  SOURCE_NAMES[id.toLowerCase()] || given?.trim() || id;

/** A snake_case or kebab-case key as words: "abstinence_12m" to "Abstinence 12m". */
export const keyWords = (key: string) => {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
};

/** A study's short name: its first author's surname and the year ("López-Durán 2025"), or null
 * when the record has neither. An author comes as "Surname Initials" ("van der Berg JM"),
 * "Surname, Given" ("Free, Caroline"), or several in one string ("Free C, Knight R"). */
export const studyLabel = (
  authors: ReadonlyArray<string> | null | undefined,
  year: number | string | null | undefined,
): string | null => {
  const surname = firstSurname(authors?.[0]);
  const parts = [surname, year ? String(year) : null].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
};

// Initials: "C", "JM", "J.M.", "J-M".
const INITIALS = /^(?:[A-Z][a-z]?\.?-?){1,4}$/;

const firstSurname = (raw: string | null | undefined): string | null => {
  // The first author is the text before the first comma: "Free C" in "Free C, Knight R", "Free"
  // in "Free, Caroline". A trailing word of initials is not part of the surname.
  const words = (raw?.split(",")[0] ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length > 1 && INITIALS.test(words.at(-1)!)) words.pop();
  return words.join(" ") || null;
};

// Trial registry IDs, with the page that shows each trial. The WHO's search portal covers the
// registries without a stable page of their own.
const REGISTRIES: ReadonlyArray<{ pattern: RegExp; url: (id: string) => string }> = [
  { pattern: /^NCT\d{8}$/i, url: (id) => `https://clinicaltrials.gov/study/${id.toUpperCase()}` },
  { pattern: /^ISRCTN\d+$/i, url: (id) => `https://www.isrctn.com/${id.toUpperCase()}` },
  { pattern: /^DRKS\d+$/i, url: (id) => `https://drks.de/search/en/trial/${id.toUpperCase()}` },
  {
    pattern: /^ACTRN\d+$/i,
    url: (id) => `https://www.anzctr.org.au/${id.toUpperCase()}.aspx`,
  },
  {
    pattern:
      /^(ChiCTR[\w-]+|CTRI\/[\d/]+|jRCT\w+|IRCT\w+|KCT\d+|PACTR\d+|TCTR\d+|UMIN\d+|NTR\d+|EUCTR[\w-]+|\d{4}-\d{6}-\d{2}(?:-\d{2})?)$/i,
    url: (id) => `https://trialsearch.who.int/Trial2.aspx?TrialID=${encodeURIComponent(id)}`,
  },
];

/** The page of a trial registry ID Kittum knows, or null. */
export const registryUrl = (id: string): string | null =>
  REGISTRIES.find((r) => r.pattern.test(id.trim()))?.url(id.trim()) ?? null;

/**
 * A trial registry entry, not an article: no DOI, and a registry ID Kittum knows or a registry
 * where the journal would be. Open access has nothing to give for it until the trial's results
 * are published. Progress, Retrieval, and Reports count these apart from the reports that need a
 * PDF, all by this rule.
 */
export const isRegistryOnly = (report: {
  readonly doi: string | null;
  readonly registry_ids: ReadonlyArray<string>;
  readonly journal?: string | null;
}): boolean =>
  !report.doi &&
  (report.registry_ids.some((id) => registryUrl(id) !== null) ||
    /clinicaltrials\.gov|isrctn|trial regist|clinical trials regist/i.test(report.journal ?? ""));
