// Records, reports, and studies (DESIGN.md, "Corpus and identities"). Kittum proposes which
// records are duplicates and which reports belong to one study. The methods lead confirms each
// link, and every confirmation, merge, and split is a new identity revision with a ledger event.
// The screen counts what the searches returned, shows each study with its reports, the searches
// that found each record, and why linked records are together. Once the corpus is built, a worker
// enriches it from the open sources; the lead follows the run per source and opens any record to
// see where each of its fields came from.
import { useRouteContext } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  CorpusLink,
  CorpusReport,
  CorpusSearch,
  CorpusView,
  EnrichmentRun,
  LinkProposal,
  RecordEnrichment,
  RecordFlag,
  SourceRecord,
} from "../../data/schema.ts";
import { run, WorkbenchError } from "../../data/workbench.ts";
import { formatDate } from "../../lib/format.ts";
import { sourceLabel, studyLabel } from "../../lib/labels.ts";
import { Button } from "../../ui/Button.tsx";
import { EmptyState } from "../../ui/Empty.tsx";
import { useKeys } from "../../ui/keys.ts";
import { Page } from "../../ui/Page.tsx";
import { Panel } from "../../ui/Panel.tsx";
import { ACCEPTED, Mark } from "../../ui/Status.tsx";
import { usePoll } from "../../ui/poll.ts";
import { LEAD_ONLY, plural, useProject } from "../project.tsx";
import { BuildCorpus } from "../setup/BuildCorpus.tsx";
import {
  EnrichmentPanel,
  EnrichmentProblems,
  hasProblems,
  noticeName,
  PROBLEMS_ID,
  RecordDetail,
  runActive,
  wrongMatch,
} from "./Enrichment.tsx";
import type { RecordName } from "./Enrichment.tsx";

/** Search sources whose records are registry entries, not publications. */
const REGISTRIES = new Set(["ctgov", "clinicaltrials", "euctr", "ctis", "ictrp"]);

interface Located {
  readonly record: SourceRecord;
  readonly report: CorpusReport;
  /** The search that found the record, when the corpus view names it. */
  readonly search: CorpusSearch | undefined;
}

interface Study {
  readonly studyId: string;
  readonly reports: ReadonlyArray<CorpusReport>;
}

type LinkAction =
  | { readonly action: "confirm"; readonly proposalId: string }
  | { readonly action: "confirm_exact" }
  | {
      readonly action: "merge";
      readonly occurrenceIds: ReadonlyArray<string>;
      readonly relation: "same_record" | "same_report" | "same_study";
    }
  | {
      readonly action: "split";
      readonly occurrenceIds: ReadonlyArray<string>;
      readonly level: "report" | "study";
    };

type Target =
  | { readonly kind: "proposal"; readonly key: string; readonly proposal: LinkProposal }
  | {
      readonly kind: "record";
      readonly key: string;
      readonly located: Located;
      readonly study: Study;
    };

const recordCount = (study: Study) => study.reports.reduce((n, r) => n + r.records.length, 0);
const isRegistry = (report: CorpusReport) => report.records.every((r) => REGISTRIES.has(r.source));

export function StudiesScreen() {
  const { workbench } = useRouteContext({ from: "/p/$projectId" });
  const { project, me, seesLeadData, labels } = useProject();
  const lead = seesLeadData;
  const [corpus, setCorpus] = useState<CorpusView | null | undefined>(undefined);
  const [proposals, setProposals] = useState<ReadonlyArray<LinkProposal>>([]);
  const [searches, setSearches] = useState<number | null>(null);
  const [selected, setSelected] = useState(0);
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrichment, setEnrichment] = useState<EnrichmentRun | null>(null);
  const [flags, setFlags] = useState<ReadonlyMap<string, RecordFlag>>(new Map());
  const [enriching, setEnriching] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [showAllSingles, setShowAllSingles] = useState(false);
  const [showAllLinked, setShowAllLinked] = useState(false);
  /** The open record's enrichment, under the occurrence it belongs to. */
  const [detail, setDetail] = useState<{
    readonly id: string;
    readonly record: RecordEnrichment | null;
  } | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());

  const study = labels.study.toLowerCase();
  const studies_ = plural(labels.study).toLowerCase();
  const report_ = labels.report.toLowerCase();
  const reports_ = plural(labels.report).toLowerCase();

  const load = useCallback(
    () =>
      Promise.all([
        run(workbench.corpus({ projectId: project.id, as: me.actor_id })),
        run(workbench.proposals({ projectId: project.id, as: me.actor_id })),
      ]).then(
        ([view, found]) => {
          setCorpus(view);
          setProposals(found);
        },
        (e: unknown) =>
          setError(
            e instanceof WorkbenchError
              ? e.message
              : "Kittum could not load the corpus. Reload the page to try again.",
          ),
      ),
    [workbench, project.id, me.actor_id],
  );

  useEffect(() => {
    if (lead) void load();
  }, [load, lead]);

  const loadEnrichment = useCallback(
    () =>
      Promise.all([
        run(workbench.enrichment({ projectId: project.id, as: me.actor_id })),
        run(workbench.enrichmentFlags({ projectId: project.id, as: me.actor_id })),
      ]).then(
        ([latest, found]) => {
          setEnrichment(latest);
          setFlags(new Map(found.map((f) => [f.occurrence_id, f])));
        },
        (e: unknown) =>
          setEnrichError(
            e instanceof WorkbenchError ? e.message : "Kittum could not load the enrichment.",
          ),
      ),
    [workbench, project.id, me.actor_id],
  );
  useEffect(() => {
    if (lead && corpus) void loadEnrichment();
  }, [loadEnrichment, lead, corpus]);
  usePoll(lead && runActive(enrichment), () => void loadEnrichment());

  const enrich = async () => {
    setEnriching(true);
    setEnrichError(null);
    try {
      setEnrichment(
        await run(workbench.startEnrichment({ projectId: project.id, as: me.actor_id })),
      );
    } catch (e) {
      setEnrichError(
        e instanceof WorkbenchError ? e.message : "Kittum could not start the enrichment.",
      );
    } finally {
      setEnriching(false);
    }
  };

  // Before the corpus, the lead builds it here from the searches.
  useEffect(() => {
    if (!lead || corpus !== null) return;
    let live = true;
    run(workbench.searches({ projectId: project.id, as: me.actor_id })).then(
      (found) => live && setSearches(found.length),
      () => live && setSearches(0),
    );
    return () => {
      live = false;
    };
  }, [workbench, project.id, me.actor_id, lead, corpus]);

  const byOccurrence = useMemo(() => {
    const searchById = new Map((corpus?.searches ?? []).map((s) => [s.id, s]));
    const map = new Map<string, Located>();
    for (const report of corpus?.reports ?? []) {
      report.records.forEach((record, i) => {
        const searchId = report.search_ids?.[i];
        map.set(record.occurrence_id, {
          record,
          report,
          search: searchId ? searchById.get(searchId) : undefined,
        });
      });
    }
    return map;
  }, [corpus]);

  const studies = useMemo(() => {
    const map = new Map<string, CorpusReport[]>();
    for (const report of corpus?.reports ?? []) {
      map.set(report.study_id, [...(map.get(report.study_id) ?? []), report]);
    }
    return [...map].map(([studyId, reports]): Study => ({ studyId, reports }));
  }, [corpus]);

  const recordNames = useMemo(
    (): ReadonlyArray<RecordName> =>
      [...byOccurrence.values()].map(({ record }) => ({
        id: record.occurrence_id,
        title: record.title,
        label: studyLabel(record.authors, record.year),
      })),
    [byOccurrence],
  );

  const pending = proposals.filter((p) => (p.status ?? "pending") === "pending");
  const exact = pending.filter((p) => p.exact && p.relation === "same_record");
  const decided = proposals.filter((p) => p.status === "confirmed").length;
  const linked = studies.filter((s) => recordCount(s) > 1);
  const single = studies.filter((s) => recordCount(s) === 1);

  const targets = useMemo((): Target[] => {
    const recordTargets = (group: ReadonlyArray<Study>) =>
      group.flatMap((study) =>
        study.reports.flatMap((report) =>
          report.records.map((record): Target => ({
            kind: "record",
            key: record.occurrence_id,
            located: byOccurrence.get(record.occurrence_id) ?? {
              record,
              report,
              search: undefined,
            },
            study,
          })),
        ),
      );
    return [
      ...pending.map((proposal, i): Target => ({
        kind: "proposal",
        key: proposal.id ?? `proposal-${i}`,
        proposal,
      })),
      ...recordTargets(linked),
      ...recordTargets(single),
    ];
  }, [pending, linked, single, byOccurrence]);

  const current = targets[Math.min(selected, targets.length - 1)];
  const openRecord = current?.kind === "record" ? current.located.record : null;
  const openId = detailOpen ? openRecord?.occurrence_id : undefined;
  // The detail follows the selection; a finished run refreshes it.
  useEffect(() => {
    if (!openId) return;
    let live = true;
    run(
      workbench.recordEnrichment({ projectId: project.id, as: me.actor_id, occurrenceId: openId }),
    ).then(
      (found) => live && setDetail({ id: openId, record: found }),
      () => live && setDetail({ id: openId, record: null }),
    );
    return () => {
      live = false;
    };
  }, [workbench, project.id, me.actor_id, openId, enrichment?.status, enrichment?.id]);

  useEffect(() => {
    if (current) rows.current.get(current.key)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const act = async (action: LinkAction, done: string) => {
    if (!corpus) return;
    if (!lead) {
      setNotice("Only the methods lead confirms links.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await run(
        workbench.link({
          projectId: project.id,
          as: me.actor_id,
          revisionId: corpus.revision.id,
          ...action,
        }),
      );
      setMarked(new Set());
      setNotice(done);
      await load();
    } catch (e) {
      setNotice(e instanceof WorkbenchError ? e.message : "Kittum could not save the change.");
    } finally {
      setBusy(false);
    }
  };

  const startEnrichment = () => {
    if (!lead || !corpus || enriching) return;
    if (runActive(enrichment)) {
      setNotice("The enrichment is still running. Its progress shows above.");
      return;
    }
    void enrich();
  };

  const confirm = (proposal: LinkProposal) => {
    if (!proposal.id) return;
    void act({ action: "confirm", proposalId: proposal.id }, "Confirmed the link.");
  };

  const confirmExact = () => {
    if (exact.length === 0) {
      setNotice("No open duplicate has the same DOI, PMID, or PMCID.");
      return;
    }
    void act(
      { action: "confirm_exact" },
      `Confirmed ${exact.length} ${exact.length === 1 ? "duplicate" : "duplicates"}.`,
    );
  };

  const toggleMark = (key: string) =>
    setMarked((m) => {
      const next = new Set(m);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const merge = () => {
    if (marked.size < 2) {
      setNotice(`Mark two or more records with x, then press m to merge them into one ${study}.`);
      return;
    }
    // Records of one study are linked already, perhaps closer (one report found twice): a study
    // merge would add nothing but a revision that says it merged them.
    if (new Set([...marked].map((id) => byOccurrence.get(id)?.report.study_id)).size === 1) {
      setNotice(`These records are one ${study} already. Press s on a record to split it out.`);
      return;
    }
    void act(
      { action: "merge", occurrenceIds: [...marked], relation: "same_study" },
      `Merged ${marked.size} records into one ${study}.`,
    );
  };

  const split = (group: Study, located: Located) => {
    if (recordCount(group) < 2) {
      setNotice("This record is not linked to another record.");
      return;
    }
    // A study of several reports: take this record's report out of it. One report found twice:
    // take this record out of the report.
    const level = group.reports.length > 1 ? "study" : "report";
    void act(
      { action: "split", occurrenceIds: [located.record.occurrence_id], level },
      level === "study"
        ? `Moved the ${report_} into a ${study} of its own.`
        : `Moved the record into a ${report_} of its own.`,
    );
  };

  useKeys((event) => {
    if (event.key === "r" && lead && corpus && !enriching) {
      startEnrichment();
      return true;
    }
    if (event.key === "Escape" && detailOpen) {
      setDetailOpen(false);
      return true;
    }
    if (busy || !current) return false;
    switch (event.key) {
      case "o":
        if (current.kind !== "record") return false;
        setDetailOpen((open) => !open);
        return true;
      case "j":
      case "ArrowDown":
        setSelected((i) => Math.min(i + 1, targets.length - 1));
        return true;
      case "k":
      case "ArrowUp":
        setSelected((i) => Math.max(i - 1, 0));
        return true;
      case "Enter":
        // Enter on a focused button or link is that control's own.
        if (event.target instanceof HTMLElement && event.target.closest("button, a")) return false;
        if (current.kind !== "proposal" || !current.proposal.id) return false;
        confirm(current.proposal);
        return true;
      case "a":
        confirmExact();
        return true;
      case "x":
        if (current.kind !== "record") return false;
        toggleMark(current.key);
        return true;
      case "m":
        merge();
        return true;
      case "s":
        if (current.kind !== "record") return false;
        split(current.study, current.located);
        return true;
      default:
        return false;
    }
  });

  const rowRef = (key: string) => (el: HTMLElement | null) => {
    if (el) rows.current.set(key, el);
    else rows.current.delete(key);
  };
  const isCurrent = (key: string) => current?.key === key;
  const select = (key: string) => {
    const index = targets.findIndex((t) => t.key === key);
    if (index >= 0) setSelected(index);
  };
  const openRecordById = (key: string) => {
    select(key);
    setDetailOpen(true);
  };
  const relations: Record<LinkProposal["relation"], string> = {
    same_record: "Duplicate records",
    same_report: `Two records of one ${report_}`,
    same_study: `${plural(labels.report)} of one ${study}`,
  };

  const records = corpus?.reports.reduce((n, r) => n + r.records.length, 0) ?? 0;
  const duplicates = records - (corpus?.reports.length ?? 0);
  const currentRecord = current?.kind === "record" ? current : null;

  /** The actions on the selected record, beside it. */
  const recordActions = (key: string) => {
    if (!lead || currentRecord?.key !== key) return null;
    const linkedRecord = recordCount(currentRecord.study) > 1;
    return (
      <span className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" kind="quiet" keys={["x"]} disabled={busy} onClick={() => toggleMark(key)}>
          {marked.has(key)
            ? "Unmark"
            : linkedRecord
              ? `Merge with another ${study}…`
              : "Mark to merge"}
        </Button>
        {linkedRecord ? (
          <Button
            size="sm"
            kind="quiet"
            keys={["s"]}
            disabled={busy}
            onClick={() => split(currentRecord.study, currentRecord.located)}
          >
            Split out
          </Button>
        ) : null}
        <Button size="sm" kind="quiet" keys={["o"]} onClick={() => setDetailOpen((o) => !o)}>
          {detailOpen ? "Close the enrichment" : "Enrichment"}
        </Button>
      </span>
    );
  };

  const recordRow = (located: Located, titled = true) => {
    const key = located.record.occurrence_id;
    return (
      <StudyRecord
        key={key}
        located={located}
        titled={titled}
        current={isCurrent(key)}
        marked={marked.has(key)}
        rowRef={rowRef(key)}
        onSelect={() => select(key)}
        flag={flags.get(key)}
        actions={recordActions(key)}
      />
    );
  };
  const locate = (report: CorpusReport, record: SourceRecord): Located =>
    byOccurrence.get(record.occurrence_id) ?? { record, report, search: undefined };

  // Long lists of single-record studies fold; the selection unfolds them when it moves past.
  const singleShown =
    showAllSingles ||
    single.length <= FOLDED ||
    (currentRecord !== null && single.indexOf(currentRecord.study) >= FOLDED);
  const singles = singleShown ? single : single.slice(0, FOLDED);
  const linkedOpen =
    showAllLinked ||
    linked.length <= FOLDED ||
    (currentRecord !== null && linked.indexOf(currentRecord.study) >= FOLDED) ||
    linked
      .slice(FOLDED)
      .some((g) => g.reports.some((r) => r.records.some((x) => marked.has(x.occurrence_id))));
  const linkedShown = linkedOpen ? linked : linked.slice(0, FOLDED);

  if (!lead) {
    return (
      <section className="h-full overflow-y-auto bg-paper">
        <EmptyState title={plural(labels.study)} testId="lead-only">
          {LEAD_ONLY}
        </EmptyState>
      </section>
    );
  }

  const scrollTo = (id: string) => {
    const target = document.getElementById(id);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  };
  const openDuplicates = pending.filter((p) => p.relation === "same_record").length;
  const settled = enrichment && !runActive(enrichment) ? enrichment.sources : [];
  const mismatches = settled.filter(wrongMatch).reduce((n, s) => n + s.failed, 0);
  const failures = settled.filter((s) => !wrongMatch(s)).reduce((n, s) => n + s.failed, 0);
  // What needs the lead now, with a way to each; the figures are in the strip below.
  // What needs the lead now, set after the corpus sum with a way to each. A confirmed link is
  // no work, so it is not repeated here.
  const openWork = (
    <>
      {openDuplicates > 0 ? (
        <span className="text-sm text-unclear" data-testid="open-duplicates">
          Kittum proposes {openDuplicates}{" "}
          {openDuplicates === 1 ? "more duplicate" : "more duplicates"}.
        </span>
      ) : null}
      {pending.length > 0 ? (
        <SummaryLink onClick={() => scrollTo("proposals")}>
          Review {pending.length} proposed {pending.length === 1 ? "link" : "links"}
        </SummaryLink>
      ) : null}
      {mismatches > 0 ? (
        <SummaryLink tone="waits" onClick={() => scrollTo(PROBLEMS_ID)}>
          Check {mismatches} wrong {mismatches === 1 ? "match" : "matches"}
        </SummaryLink>
      ) : null}
      {failures > 0 ? (
        <SummaryLink tone="exclude" onClick={() => scrollTo(PROBLEMS_ID)}>
          {failures} enrichment {failures === 1 ? "failure" : "failures"}
        </SummaryLink>
      ) : null}
      {enrichment && enrichment.retracted > 0 ? (
        <span className="text-sm font-semibold text-exclude">
          {enrichment.retracted} retracted {enrichment.retracted === 1 ? "record" : "records"}
        </span>
      ) : null}
    </>
  );

  const openSearch = currentRecord?.located.search;
  const showDetail = detailOpen && openRecord !== null;
  return (
    <div
      className={`grid h-full min-h-0 grid-rows-[minmax(0,1fr)] ${showDetail ? "grid-cols-[minmax(0,1fr)_minmax(26rem,34rem)]" : "grid-cols-1"}`}
    >
      <Page
        kind="lead"
        title={plural(labels.study)}
        summary={corpus === null ? "The corpus is not built yet." : undefined}
      >
        {error ? (
          <p role="alert" className="text-exclude">
            {error}
          </p>
        ) : corpus === undefined ? (
          <p className="text-ink-2">Loading the corpus.</p>
        ) : corpus === null ? (
          <div className="max-w-[880px]">
            <BuildCorpus searches={searches} onBuilt={() => void load()} />
          </div>
        ) : (
          <>
            <CorpusCount
              searches={corpus.searches ?? []}
              records={records}
              duplicates={duplicates}
              reports={corpus.reports.length}
              studies={studies.length}
              eventSeq={corpus.revision.event_seq ?? 0}
              reportWord={[report_, reports_]}
              studyWord={[study, studies_]}
            >
              {openWork}
            </CorpusCount>

            <div className="mt-6">
              <EnrichmentPanel
                run={enrichment}
                busy={enriching}
                error={enrichError}
                canEnrich={!runActive(enrichment)}
                onEnrich={startEnrichment}
              />
            </div>

            {/* The sheet: the links and records the lead works on, in flat groups. */}
            <Panel className="mt-6">
              <div className="grid gap-10">
                {/* The open work first: what enrichment left to check, then links to confirm. */}
                {enrichment && hasProblems(enrichment) ? (
                  <EnrichmentProblems
                    run={enrichment}
                    records={recordNames}
                    flags={flags}
                    onOpenRecord={openRecordById}
                  />
                ) : null}
                {pending.length > 0 ? (
                  <Group
                    id="proposals"
                    title={
                      project.stages.length > 0 ? (
                        <span
                          className="cursor-help underline decoration-ink-3 decoration-dotted underline-offset-4"
                          title="Open screening keeps the links it started with. Links you confirm now count from the next stage."
                        >
                          Proposed links
                        </span>
                      ) : (
                        "Proposed links"
                      )
                    }
                    summary={`${pending.length} open${decided > 0 ? `, ${decided} confirmed` : ""}`}
                    actions={
                      exact.length > 0 ? (
                        <span data-testid="confirm-exact">
                          <Button
                            kind="primary"
                            keys={["a"]}
                            disabled={busy}
                            onClick={confirmExact}
                          >
                            Confirm all {exact.length}{" "}
                            {exact.length === 1 ? "duplicate" : "duplicates"} with the same DOI,
                            PMID, or PMCID
                          </Button>
                        </span>
                      ) : null
                    }
                  >
                    <ol aria-label="Proposed links" className="-mx-2 grid gap-1">
                      {pending.map((proposal, i) => {
                        const key = proposal.id ?? `proposal-${i}`;
                        const selected = isCurrent(key);
                        return (
                          <li
                            key={key}
                            ref={rowRef(key)}
                            data-testid="proposal"
                            aria-current={selected || undefined}
                            onClick={() => select(key)}
                            className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 rounded-[4px] py-2.5 pr-3 pl-4 ${selected ? "shadow-[inset_3px_0_0_var(--petrol)]" : ""}`}
                          >
                            <div className="min-w-0">
                              <p className="flex flex-wrap items-baseline gap-x-3">
                                <span className="font-semibold">
                                  {relations[proposal.relation]}
                                </span>{" "}
                                <span className="text-sm text-ink-2">
                                  {proposal.evidence.join(". ")}
                                </span>
                              </p>
                              <ul className="mt-1.5 grid gap-1">
                                {proposal.occurrence_ids.map((id) => (
                                  <RecordLine
                                    key={id}
                                    located={byOccurrence.get(id)}
                                    flag={flags.get(id)}
                                  />
                                ))}
                              </ul>
                            </div>
                            {proposal.id ? (
                              <Button
                                size="sm"
                                kind={selected ? "primary" : "secondary"}
                                {...(selected ? { keys: ["Enter"] } : {})}
                                disabled={busy}
                                onClick={() => confirm(proposal)}
                              >
                                Confirm the link
                              </Button>
                            ) : null}
                          </li>
                        );
                      })}
                    </ol>
                  </Group>
                ) : null}

                <Group
                  title={`${plural(labels.study)} with more than one record`}
                  summary={
                    linked.length === 0
                      ? `No ${study} has more than one record yet.`
                      : `${linked.length} ${linked.length === 1 ? study : studies_}, each confirmed`
                  }
                >
                  {linked.length > 0 ? (
                    <div className="-mx-5">
                      <LinkedHeader studyWord={study} />
                      <ol aria-label={`Linked ${studies_}`}>
                        {linkedShown.map((group) => {
                          const ids = group.reports.flatMap((r) =>
                            r.records.map((x) => x.occurrence_id),
                          );
                          const first = ids[0];
                          return (
                            <LinkedStudy
                              key={group.studyId}
                              group={group}
                              open={ids.some((id) => isCurrent(id) || marked.has(id))}
                              onOpen={() => first && select(first)}
                              links={corpus.links ?? []}
                              reportWord={[report_, reports_]}
                              locate={locate}
                              recordRow={recordRow}
                            />
                          );
                        })}
                      </ol>
                      {linked.length > FOLDED ? (
                        <div className="px-4 py-2">
                          <Button
                            kind="quiet"
                            size="sm"
                            onClick={() => setShowAllLinked((s) => !s)}
                          >
                            {linkedOpen ? "Show fewer" : `Show all ${linked.length}`}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </Group>

                <Group
                  title={`Single-record ${studies_}`}
                  summary={`${single.length} ${single.length === 1 ? study : studies_} found by one search`}
                >
                  <ol aria-label={`Single-record ${studies_}`} className="-mx-2 grid gap-0.5">
                    {singles.map((group) =>
                      group.reports.flatMap((report) =>
                        report.records.map((record) => recordRow(locate(report, record))),
                      ),
                    )}
                  </ol>
                  {single.length > FOLDED ? (
                    <Button
                      kind="quiet"
                      size="sm"
                      className="mt-2"
                      onClick={() => setShowAllSingles((s) => !s)}
                    >
                      {singleShown ? "Show fewer" : `Show all ${single.length}`}
                    </Button>
                  ) : null}
                </Group>
              </div>
            </Panel>
          </>
        )}
        {corpus && (marked.size > 0 || notice || busy) ? (
          <div className="sticky bottom-0 mt-6 flex items-center gap-4 rounded-[4px] border border-rule-strong bg-sheet px-4 py-2.5 text-sm shadow-[0_-4px_16px_rgb(0_0_0/0.06)]">
            {marked.size > 0 ? (
              <>
                <span className="font-medium">
                  {marked.size} {marked.size === 1 ? "record" : "records"} marked
                </span>
                <Button
                  kind="primary"
                  size="sm"
                  keys={["m"]}
                  disabled={busy || marked.size < 2}
                  onClick={merge}
                >
                  Merge into one {study}
                </Button>
                <Button kind="quiet" size="sm" onClick={() => setMarked(new Set())}>
                  Clear the marks
                </Button>
              </>
            ) : null}
            <span
              className="ml-auto truncate text-ink-2"
              aria-live="polite"
              data-testid="studies-notice"
            >
              {busy
                ? "Saving."
                : (notice ?? (marked.size === 1 ? "Mark one more record to merge." : null))}
            </span>
          </div>
        ) : null}
      </Page>
      {showDetail && openRecord ? (
        <aside
          aria-label="Enrichment of the selected record"
          className="overflow-y-auto border-l border-rule-strong bg-sheet px-6 pt-6 pb-16"
        >
          <div className="mb-4 flex justify-end">
            <Button kind="quiet" size="sm" keys={["Escape"]} onClick={() => setDetailOpen(false)}>
              Close
            </Button>
          </div>
          <RecordDetail
            record={detail?.id === openRecord.occurrence_id ? detail.record : undefined}
            searchSource={sourceLabel(openRecord.source, openSearch?.platform)}
          />
        </aside>
      ) : null}
    </div>
  );
}

/** A flat group inside the sheet: a small heading, one summary line, its content. */
function Group({
  id,
  title,
  summary,
  actions,
  children,
}: {
  id?: string;
  title: React.ReactNode;
  summary?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section id={id} tabIndex={id ? -1 : undefined} className="outline-none">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-semibold">{title}</h2>
          {summary ? <p className="mt-0.5 text-sm text-ink-2">{summary}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children ? <div className="mt-3">{children}</div> : null}
    </section>
  );
}

/** Lists longer than this fold behind "Show all". */
const FOLDED = 6;

function SummaryLink({
  tone,
  onClick,
  children,
}: {
  tone?: "exclude" | "waits";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`font-medium underline underline-offset-2 ${
        tone === "exclude" ? "text-exclude" : tone === "waits" ? "text-marker-edge" : "text-petrol"
      }`}
    >
      {children}
    </button>
  );
}

/** What deduplication made of the searches, as a sum. Each search's count is in the hover: the
 * Search screen lists the searches. */
function CorpusCount({
  searches,
  records,
  duplicates,
  reports,
  studies,
  eventSeq,
  reportWord: [report, reportsWord],
  studyWord: [study, studiesWord],
  children,
}: {
  searches: ReadonlyArray<CorpusSearch>;
  records: number;
  duplicates: number;
  reports: number;
  studies: number;
  eventSeq: number;
  reportWord: readonly [string, string];
  studyWord: readonly [string, string];
  /** The open work, set after the sum. */
  children?: React.ReactNode;
}) {
  const bySearch = searches
    .map((search) => `${sourceLabel(search.source, search.platform)} ${search.retrieved_count}`)
    .join(", ");
  return (
    <p
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-md"
      aria-label="Corpus figures"
      title={`As of ledger event ${eventSeq}`}
    >
      <Term value={records} testId="corpus-records" title={bySearch || undefined}>
        {records === 1 ? "record" : "records"} from the searches
      </Term>
      <Op>−</Op>
      <Term value={duplicates} testId="corpus-duplicates">
        {duplicates === 1 ? "duplicate" : "duplicates"}
      </Term>
      <Op>=</Op>
      <Term value={reports} testId="corpus-reports">
        {reports === 1 ? report : reportsWord}
      </Term>
      <Op>in</Op>
      <Term value={studies} testId="corpus-studies">
        {studies === 1 ? study : studiesWord}
      </Term>
      {children ? (
        <span className="ml-6 flex flex-wrap items-baseline gap-x-4">{children}</span>
      ) : null}
    </p>
  );
}

function Term({
  value,
  testId,
  title,
  children,
}: {
  value: number;
  testId: string;
  title?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5" title={title}>
      <span className="text-lg font-medium tabular-nums text-ink" data-testid={testId}>
        {value}
      </span>
      <span className="text-ink-2">{children}</span>
    </span>
  );
}

function Op({ children }: { children: React.ReactNode }) {
  return (
    <span aria-hidden className="text-lg text-ink-2">
      {children}
    </span>
  );
}

/** Why linked records are together, as one line: the evidence and who decided. */
function reason(link: CorpusLink) {
  if (link.linked_by === "merged_by_hand") {
    return link.evidence.length > 0
      ? `The methods lead merged them by hand. ${link.evidence.join(". ")}.`
      : "The methods lead merged them by hand.";
  }
  return `${link.evidence.join(". ")}. The methods lead confirmed it.`;
}

/** How two records matched, in a few words: the evidence up to its identifier ("Same DOI"). */
const matchName = (link: CorpusLink) => {
  if (link.linked_by === "merged_by_hand") return "Merged by hand";
  const [evidence] = link.evidence;
  if (!evidence) return "Confirmed";
  const words = evidence.split(" ");
  const cut = words.findIndex((w) => /\d/.test(w));
  return cut > 0 ? words.slice(0, cut).join(" ") : evidence;
};

const LINKED_COLUMNS = "grid-cols-[minmax(0,1fr)_7.5rem_11rem_8.5rem_8.5rem]";

/** The header of the linked studies' table. */
function LinkedHeader({ studyWord }: { studyWord: string }) {
  return (
    <div
      className={`grid ${LINKED_COLUMNS} gap-x-4 border-b border-rule-strong px-4 py-1.5 text-xs font-medium text-ink-2`}
      aria-hidden
    >
      <span>{studyWord.charAt(0).toUpperCase() + studyWord.slice(1)}</span>
      <span>Match</span>
      <span>Found by</span>
      <span>Status</span>
      <span />
    </div>
  );
}

/** A study of several records as one row: its name, how its records matched, the searches that
 * found them, and who confirmed it. Its reports and records open with the selection. */
function LinkedStudy({
  group,
  open,
  onOpen,
  links,
  reportWord: [, reportsWord],
  locate,
  recordRow,
}: {
  group: Study;
  open: boolean;
  onOpen: () => void;
  links: ReadonlyArray<CorpusLink>;
  reportWord: readonly [string, string];
  locate: (report: CorpusReport, record: SourceRecord) => Located;
  recordRow: (located: Located, titled?: boolean) => React.ReactNode;
}) {
  const inStudy = new Set(group.reports.flatMap((r) => r.records.map((x) => x.occurrence_id)));
  const ours = links.filter((l) => l.occurrence_ids.some((id) => inStudy.has(id)));
  const studyLinks = ours.filter((l) => l.relation === "same_study");
  const matches = [...new Set(ours.map(matchName))];
  const byHand = ours.some((l) => l.linked_by === "merged_by_hand");
  const found = [
    ...new Set(
      group.reports.flatMap((r) =>
        r.records.map((record) => {
          const { search } = locate(r, record);
          return sourceLabel(record.source, search?.platform);
        }),
      ),
    ),
  ];
  const first = group.reports[0]?.records[0];
  const label = first ? studyLabel(first.authors, first.year) : null;
  const registry = group.reports.some(isRegistry);
  return (
    <li
      className={`border-b border-rule last:border-b-0 ${open ? "bg-sheet-2/50" : ""}`}
      data-testid="linked-study"
      data-open={open || undefined}
    >
      <div className={`grid ${LINKED_COLUMNS} items-center gap-x-4 px-4 py-2 text-sm`}>
        {/* Two lines when folded; the whole title once the row is open. */}
        <span className={`min-w-0 leading-snug ${open ? "" : "line-clamp-2"}`} title={first?.title}>
          {label ? <span className="font-medium">{label}</span> : null}
          {label ? " " : null}
          {first?.title}
        </span>
        <span title={ours.flatMap((l) => l.evidence).join(". ")}>{matches.join(", ")}</span>
        <span data-testid="found-by">{found.join(", ")}</span>
        <span className="inline-flex items-center gap-1.5">
          <Mark term={{ ...ACCEPTED, label: byHand ? "Merged by hand" : "Confirmed" }} />
          {byHand ? "Merged by hand" : "Confirmed"}
        </span>
        <span className="text-right">
          {open ? null : (
            <Button size="sm" kind="quiet" onClick={onOpen}>
              Show {recordCount(group)} records
            </Button>
          )}
        </span>
      </div>
      <div hidden={!open} className="px-4 pb-3">
        {registry || group.reports.length > 1 ? (
          <p className="text-xs text-ink-2">
            {group.reports.length} {reportsWord}, {recordCount(group)} records
          </p>
        ) : null}
        {studyLinks.map((l) => (
          <Why key={`${l.revision_id}-${l.occurrence_ids.join()}`} label="Linked" inset>
            {reason(l)}
          </Why>
        ))}
        <ul className="mt-1 grid gap-2">
          {group.reports.map((r) => {
            const inReport = new Set(r.records.map((x) => x.occurrence_id));
            const reportLinks = links.filter(
              (l) =>
                l.relation !== "same_study" &&
                l.occurrence_ids.filter((id) => inReport.has(id)).length >= 2,
            );
            const [head] = r.records;
            return (
              <li
                key={r.report_id}
                data-testid="study-report"
                data-registry={isRegistry(r) || undefined}
              >
                {/* One report: the row above names it. Several: each report by its title. */}
                {group.reports.length > 1 ? (
                  <p className="pr-4 text-sm leading-snug">
                    {isRegistry(r) ? (
                      <>
                        <span className="mr-2 rounded-[3px] border border-rule-strong px-1.5 py-px text-xs font-medium text-ink-2">
                          Registry entry
                        </span>{" "}
                      </>
                    ) : null}
                    <span className="font-medium">{head?.title}</span>
                  </p>
                ) : null}
                {reportLinks.map((l) => (
                  <Why key={`${l.revision_id}-${l.occurrence_ids.join()}`} label="Merged" inset>
                    {reason(l)}
                  </Why>
                ))}
                <ul className="mt-1">
                  {r.records.map((record) => recordRow(locate(r, record), false))}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>
    </li>
  );
}

function Why({
  label,
  inset,
  children,
}: {
  label: string;
  inset?: boolean;
  children: React.ReactNode;
}) {
  return (
    <p
      data-testid="link-reason"
      className={`mt-1 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 pr-4 text-sm ${inset ? "" : "px-5"}`}
    >
      <span className="font-medium text-ink-2">{label}</span>
      <span className="text-ink-2">{children}</span>
    </p>
  );
}

function RecordLine({
  located,
  flag,
}: {
  located: Located | undefined;
  flag: RecordFlag | undefined;
}) {
  if (!located) {
    return <li className="text-sm text-ink-2">This record is not in the current revision.</li>;
  }
  const { record, search } = located;
  return (
    <li className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 text-sm">
      <span className="text-ink-2" title={`Source ID: ${record.source}`}>
        {sourceLabel(record.source, search?.platform)}
      </span>
      <span>
        <Flags flag={flag} />
        <Named record={record} />
        {ids(record) ? <span className="ml-2 text-ink-2">{ids(record)}</span> : null}
      </span>
    </li>
  );
}

/** What enrichment found that the lead must not miss: a retraction first, then other notices. */
function Flags({ flag }: { flag: RecordFlag | undefined }) {
  if (!flag || (!flag.retracted && flag.updates.length === 0)) return null;
  return (
    <span className="mr-2" data-testid="record-flag">
      {flag.retracted ? (
        <span className="mr-2 rounded-[3px] bg-exclude px-1.5 py-px text-xs font-semibold text-sheet">
          Retracted
        </span>
      ) : null}
      {flag.updates.map((kind) => (
        <span key={kind} className="mr-2 text-xs font-medium text-unclear">
          {noticeName(kind)}{" "}
        </span>
      ))}
    </span>
  );
}

/** One search result: the search that found it, then the record as that search returned it.
 * Under its report's title, a record shows its identifiers only. The selected record carries
 * its actions. */
function StudyRecord({
  located: { record, search },
  titled,
  current,
  marked,
  rowRef,
  onSelect,
  flag,
  actions,
}: {
  located: Located;
  titled: boolean;
  current: boolean;
  marked: boolean;
  rowRef: (el: HTMLElement | null) => void;
  onSelect: () => void;
  flag: RecordFlag | undefined;
  actions: React.ReactNode;
}) {
  return (
    <li
      ref={rowRef}
      aria-current={current || undefined}
      data-marked={marked || undefined}
      data-testid="study-record"
      onClick={onSelect}
      className={`grid min-h-9 grid-cols-[1.5rem_9rem_minmax(0,1fr)_auto] items-center gap-3 py-1.5 pr-3 pl-3 text-sm ${
        current ? "bg-petrol-wash/40 shadow-[inset_3px_0_0_var(--petrol)]" : ""
      } ${marked ? "bg-petrol-wash" : ""}`}
    >
      <span>
        {marked ? (
          <span
            className="inline-flex size-4 items-center justify-center rounded-[3px] bg-petrol text-2xs font-bold text-petrol-ink"
            aria-label="Marked"
            role="img"
          >
            ✓
          </span>
        ) : null}
      </span>
      <span
        data-testid="record-search"
        title={[
          `Source ID: ${record.source}`,
          search ? `Search run ${formatDate(search.started_at)}` : null,
        ]
          .filter(Boolean)
          .join(". ")}
      >
        {sourceLabel(record.source, search?.platform)}
      </span>
      <span>
        <Flags flag={flag} />
        {titled ? <Named record={record} /> : null}
        {titled && ids(record) ? " " : null}
        <span className="text-ink-2">{ids(record)}</span>
        {flag?.open_access ? (
          <>
            {" "}
            <span className="ml-2 text-xs font-medium text-include">Open-access location</span>
          </>
        ) : null}
      </span>
      <span>{actions}</span>
    </li>
  );
}

/** A record as a study is named, "Free 2011", then its title. */
function Named({ record }: { record: SourceRecord }) {
  const label = studyLabel(record.authors, record.year);
  return (
    <>
      {label ? <span className="font-medium">{label}</span> : null}
      {label ? " " : null}
      <span>{record.title}</span>
    </>
  );
}

/** A record's identifiers; its year is in its study name. */
const ids = (record: SourceRecord) =>
  [
    record.pmid ? `PMID ${record.pmid}` : null,
    record.pmcid ?? null,
    record.doi ? `DOI ${record.doi}` : null,
    ...(record.registry_ids ?? []),
  ]
    .filter(Boolean)
    .join(", ");
