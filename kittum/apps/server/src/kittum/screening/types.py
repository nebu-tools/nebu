"""The values screening reads and answers, and its errors."""

from collections import Counter
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

from pydantic import Field

from kittum.core import Id, KittumError, Record
from kittum.judge import CriterionStatus, CriterionVerdict
from kittum.protocol import DocumentationLevel, ScreeningMode, Stage
from kittum.runs import CommandRejected
from kittum.stats import Interval, cohen_kappa, pabak

if TYPE_CHECKING:
    from collections.abc import Sequence

type Outcome = Literal["include", "exclude", "unclear", "insufficient_information"]
type Phase = Literal["provisional", "final"]
type RevealSetting = Literal["never", "on_disagreement", "always", "before"]
"""When a reviewer sees the AI's reading: never, after their own provisional decision if the AI
disagrees or always, or `before` the decision. `before` is allowed only in topics with working
documentation (mode S)."""
type ConflictKind = Literal[
    "human_disagreement",  # the screeners disagree on inclusion
    "exclusion_reason",  # at full text, both exclude on different criteria
    "audit_disagreement",  # the auditor's screen disagrees with the screeners
]
"""Why a record goes to adjudication. Only human decisions disagree here: an AI-only disagreement
becomes a blind extra screen in the audit stream instead (`RescreenReason`)."""
type RescreenReason = Literal[
    "ai_include",  # M1: the model saw no failing criterion, both humans excluded
    "ai_disagreement",  # M2: the AI disagrees with the lone human
]
type Highlight = tuple[int, int, str]
"""(start, end, tag): half-open code-point offsets; tags are `protocol:<criterion id>`."""
type WithdrawReason = Literal["wrong_document"]
"""Why an item left screening without a decision: the full text shown is not the record's
report. Not an exclusion."""


class StaleRevision(CommandRejected):
    """`expected_revision` is not the current revision: someone or something changed the item."""


class InvalidDecision(CommandRejected):
    """The decision breaks a rule: a missing criterion, a wrong phase, or an outcome of another
    stage."""


class NotAssigned(KittumError):
    """The assignment or conflict does not exist for this reviewer. Reported as not found."""


# Inputs


class RecordFacts(Record):
    """Bibliographic facts shown above the abstract."""

    pmid: str | None = None
    doi: str | None = None
    journal: str | None = None
    year: int | None = None
    publication_types: tuple[str, ...] = ()
    registry_ids: tuple[str, ...] = ()
    authors: tuple[str, ...] = ()


class ScreeningRecord(Record):
    """One item to screen: a report at title and abstract, or its parsed full text.

    `item_ref` names the record across modules (the corpus report ID); the judge's verdicts are
    keyed by it.
    """

    item_ref: str
    title: str
    text: str
    facts: RecordFacts = RecordFacts()


class Sentinel(Record):
    """A record with a known label, seeded invisibly into every screener's queue."""

    record: ScreeningRecord
    expected_outcome: Literal["include", "exclude"] = "include"


class StageSpec(Record):
    """What opening a stage needs. The protocol version decides the mode and the audit plan."""

    protocol_version_id: Id
    scope_id: str
    stage: Stage
    topic_id: str | None = None  # needed only when the scope is in several topics
    records: tuple[ScreeningRecord, ...] = Field(min_length=1)
    screeners: tuple[Id, ...] = Field(min_length=1)
    """Two in M1 and M3, one in M2. In S a pool of one or more: each record goes to one of them,
    split evenly in the seeded order, and a second opinion goes to another of them."""
    auditor_id: Id | None = None
    """Screens the random audit sample and the blind extra screens of AI-only disagreements; never
    one of the screeners. Required in M1, M2, and M3; S has none."""
    adjudicators: tuple[Id, ...] = ()
    """Who adjudicates the stage's conflicts (at least one in M1, M2, and M3; S has none). They
    see the adjudicator's view of `status`."""
    sentinels: tuple[Sentinel, ...] = ()
    reveal: RevealSetting = "on_disagreement"
    judge_config_id: str
    seed: str | None = None  # defaults to one derived from the protocol hash, scope, and stage


class StageInfo(Record):
    stage_id: Id
    project_id: Id
    scope_id: str
    stage: Stage
    topic_id: str
    mode: ScreeningMode
    documentation: DocumentationLevel
    reveal: RevealSetting
    protocol_hash: str
    judge_config_id: str
    screeners: tuple[Id, ...]
    auditor_id: Id | None
    adjudicators: tuple[Id, ...]


# The reviewer's side


class CriterionDecision(Record):
    """A reviewer's reading of one criterion at full text, with the evidence for it."""

    criterion_id: str
    status: CriterionStatus
    evidence_anchor_ids: tuple[Id, ...] = ()  # anchors from `kittum.documents`, opaque here


class Decision(Record):
    outcome: Outcome
    reason_criterion_id: str | None = None
    evidence_anchor_ids: tuple[Id, ...] = ()
    comment: str | None = None
    criteria: tuple[CriterionDecision, ...] = ()  # full text: one per criterion
    second_opinion: bool = False
    """Mode S: the screener is unsure and asks another screener of the pool, who sees this
    decision and its comment and settles the record. Only on a screener's own record, and only
    with a pool of two or more."""


class DecisionTiming(Record):
    """Client-side timing of one decision (DESIGN.md, "Metrics")."""

    shown_at: datetime
    first_key_at: datetime | None = None
    decided_at: datetime
    reveal_shown_at: datetime | None = None


class QuoteSpan(Record):
    """Where a verified quote of the AI is in the item: half-open code-point offsets into its
    `title` or its `text`. A full-text item's text is its layer's text, so text offsets are layer
    offsets."""

    part: Literal["title", "text"]
    start: int
    end: int


class Reveal(Record):
    """Shown after a provisional decision when the AI disagrees (or always, if set so)."""

    criterion_id: str
    status: CriterionStatus
    quote: str
    rationale: str
    quote_verified: bool = False
    """Whether the judge found the quote in the record. An unverified quote is the model's own
    words, never a passage of the record."""
    quote_span: QuoteSpan | None = None
    """Where the verified quote is, for highlighting it in place; None if it is unverified."""
    downgraded_from: CriterionStatus | None = None
    """What the model answered, if the judge's checks turned it into `unclear`."""


class QueueRecord(Record):
    """The record's facts as the queue shows them, with title highlights and abstract sections."""

    pmid: str | None
    doi: str | None
    journal: str | None
    year: int | None
    publication_types: tuple[str, ...]
    registry_ids: tuple[str, ...]
    authors: tuple[str, ...] = ()
    title_highlights: tuple[Highlight, ...]
    sections: tuple[tuple[str, int, int], ...]
    """Structured-abstract labels as (label, start, end) code-point ranges of `text`."""


class AiColumn(Record):
    excludes: bool
    criteria: tuple[CriterionVerdict, ...]
    quote_spans: dict[str, QuoteSpan]
    """Where each verified quote is in the record, by criterion ID."""


class AiProposal(Record):
    """What the AI proposes for a record: include, or exclude on one criterion.

    In a topic with complete documentation only a verified exclusion is a proposal to exclude
    (`Verdict.excludes`). In a working topic the model's own `not_met` with a quote is one too,
    even if the quote filter could not verify it; it is then marked `verified = False`, never
    quietly turned into an inclusion. A record whose text tried to instruct the model, or whose
    answer was invalid, has no proposal."""

    outcome: Literal["include", "exclude"]
    reason_criterion_id: str | None = None
    verified: bool = True
    """For an exclusion: whether the quote filter confirmed the quote."""
    quote: str | None = None
    rationale: str | None = None


class SecondOpinionContext(Record):
    """Mode S: the decision a screener of the pool asked a second opinion on. Shown to the second
    screener, because a second opinion is a consult, not a blind screen."""

    outcome: Outcome
    reason_criterion_id: str | None
    comment: str | None
    criteria: tuple[CriterionDecision, ...] = ()


class QueueItem(Record):
    """What a reviewer sees. Never contains AI output before their own provisional decision
    (unless the stage reveals `before`), sentinel or audit flags, or anything of another
    reviewer (except the decision a second opinion is asked on)."""

    assignment_id: Id
    stage: Stage
    scope_id: str
    title: str
    text: str
    highlights: tuple[Highlight, ...]
    etag: str
    """An opaque token for the item's current state; send it back as `expected_etag`."""
    record: QueueRecord
    phase: Phase
    """The phase the next decision must have: `final` after a reveal of this reviewer's own
    provisional decision, which then comes back in `reveal`."""
    reveal: Reveal | None
    ai: AiColumn | None = Field(default=None, exclude_if=lambda v: v is None)
    """The AI's reading before the decision: only in a stage that reveals `before`, and only once
    the AI has read the item. Left out of the response otherwise, so an item of a complete topic
    has no AI field at all."""
    second_opinion: SecondOpinionContext | None = Field(
        default=None, exclude_if=lambda v: v is None
    )
    """Set when this assignment is a second opinion: the decision it is asked on. Left out
    otherwise."""


class DecideResult(Record):
    phase: Phase
    """`final` when no reveal follows: the decision stands. `provisional` with a reveal: the
    reviewer keeps or revises with a `final` decision."""
    reveal: Reveal | None
    recorded_at: datetime
    etag: str


type BulkAction = Literal["include", "exclude", "accept_ai"]
"""What a bulk decision decides: include every selected record, exclude them all on one
criterion, or give each the outcome and reason the AI proposes for it."""
type DecisionOrigin = Literal["keyboard", "bulk", "spreadsheet"]
"""Where a decision came from: a key on one record, a bulk decision from the table, or a row of a
working export the reviewer edited in a spreadsheet and imported."""


class BulkRow(Record):
    assignment_id: Id
    expected_etag: str
    """The `etag` the client last saw for the row; a stale one rejects the whole batch."""
    proposal: AiProposal | None = None
    """For "accept the AI's proposals": the proposal the table showed. If a re-judge changed it
    since, the batch is stale."""


class BulkResult(Record):
    batch_id: Id
    decided: int
    """Records the batch decided; a reveal may leave some waiting for a final decision."""
    awaiting_final: int
    recorded_at: datetime


class SheetDecision(Record):
    """What the editable columns of a working export's row say: the decision, the criterion it
    excludes on, and a comment. Empty cells are `None`."""

    outcome: Outcome | None = None
    reason_criterion_id: str | None = None
    comment: str | None = None


class SheetExported(Record):
    """What a row showed when Kittum exported it, kept by Kittum beside the export."""

    state: Literal["pending", "awaiting_final", "decided"]
    decision: SheetDecision
    ai: bool = False
    """The file carried the AI's reading of the record."""


class SheetRow(Record):
    """One row of an edited working export, as `kittum.report` read it."""

    row: int
    """The row's number in the spreadsheet, for the reviewer to find it."""
    ref: str
    decision: SheetDecision
    problem: str | None = None
    """A cell Kittum could not read (an outcome or criterion it does not know), in words."""
    exported: SheetExported | None = None
    """The row as exported; empty when the export had no row with this Ref."""


type ImportRefusal = Literal[
    "unknown_ref",  # not a row of the export, or not a record of the stage
    "not_yours",  # another reviewer's assignment
    "duplicate",  # the Ref is in the file twice, with different decisions
    "unreadable",  # an outcome or criterion Kittum does not know
    "no_decision",  # a reason or comment without a decision
    "invalid",  # the decision breaks a rule of the stage
    "stale",  # decided differently in Kittum after the export
    "decided",  # decided in Kittum already; a change needs an undo there
    "second_opinion",  # a consult, decided in Kittum beside the first decision
    "withdrawn",  # the record left the screening
]
"""Why a row of an imported spreadsheet does not change anything."""


class ImportRow(Record):
    row: int
    ref: str
    title: str | None = None
    """The record's title, where the ref names one of the reviewer's records."""
    decision: SheetDecision
    """What the file says."""
    refusal: ImportRefusal | None = None
    message: str | None = None
    """Why the row is refused, in words."""


class ImportPreview(Record):
    """What importing a spreadsheet would do: nothing is recorded yet."""

    changes: tuple[ImportRow, ...]
    """Rows that would be decided, one decision each."""
    unchanged: int
    """Rows that change nothing: blank, as exported, or already so in Kittum."""
    refused: tuple[ImportRow, ...]
    preview_hash: str
    """Names the changes; applying needs it, so an import records what its preview showed."""


class ImportFile(Record):
    sha256: str
    """The uploaded file, in the artifact store."""
    name: str | None = None
    export_id: Id
    """The working export the file was made from."""


class ImportResult(Record):
    batch_id: Id
    decided: int
    """Records the import decided; a reveal may leave some waiting for a final decision."""
    awaiting_final: int
    unchanged: int
    refused: int
    recorded_at: datetime


class UndoResult(Record):
    etag: str
    recorded_at: datetime


class WithdrawResult(Record):
    recorded_at: datetime


class RecordPrompt(Record):
    """The prompt the AI judge reads one record with under the stage's protocol version: the
    instructions the topic sets, and the messages and schema exactly as `kittum.judge` renders
    them. The Audit screen shows the requests that were sent."""

    protocol_hash: str
    strictness: str
    guidance: str | None
    instructions_hash: str
    system: str
    user: str
    json_schema: dict[str, Any]


class KnownIncludes(Record):
    """How many of the topic's known includes (its reference set) the rows hold, and how many
    of them the AI proposes to exclude. A warning, never a block."""

    known: int
    read: int
    """Known includes the AI has read."""
    proposed_exclude: int


class BenchRow(Record):
    item_ref: str
    title: str
    known_include: bool
    human: Outcome | None
    """The record's settled human outcome, if any."""
    current: AiProposal | None
    """What the stage's current reading proposes."""
    draft: AiProposal | None
    """What the judge proposes with the draft's instructions; None until it has read it."""
    flip: bool
    """The draft proposes another outcome than the current reading."""
    against_human: bool
    """The draft proposes another outcome than the humans decided (unclear counts as include)."""


class BenchResult(Record):
    """A test bench run: the draft's readings against the current ones and the human
    decisions, known includes first, then flips."""

    bench_id: Id
    stage_id: Id
    protocol_hash: str
    state: Literal["running", "done", "failed"]
    error: str | None = None
    requested_at: datetime
    finished_at: datetime | None = None
    records: int
    known: int
    flips: int
    against_human: int
    known_proposed_exclude: int
    """Known includes the draft proposes to exclude."""
    rows: tuple[BenchRow, ...]


# Adjudication


class ReviewerColumn(Record):
    """One human's final decision, pseudonymized as A, B, ..."""

    label: str
    outcome: Outcome
    reason_criterion_id: str | None
    criteria: tuple[CriterionDecision, ...]
    evidence_anchor_ids: tuple[Id, ...]
    comment: str | None


class AdjudicationItem(Record):
    """A conflict for the adjudicator. The AI column is not here; it opens after the commit."""

    conflict_id: Id
    etag: str
    stage: Stage
    scope_id: str
    title: str
    text: str
    record: QueueRecord
    columns: tuple[ReviewerColumn, ...]


class AdjudicationResult(Record):
    outcome: Outcome
    reason_criterion_id: str | None
    recorded_at: datetime
    ai: AiColumn


# Status


class PairAgreement(Record):
    """Agreement on include against exclude, from the blind provisional decisions.

    `human_ai` compares with the model's own reading (no criterion it answered `not_met`);
    `human_ai_verified` with the reading the judge's filter verified (`Verdict.excludes`).
    """

    kind: Literal["human_human", "human_ai", "human_ai_verified"]
    raters: tuple[str, str]  # reviewer IDs, or "ai"
    items: int
    kappa: float | None  # None when undefined: no items, or one label throughout
    pabak: float | None
    # The 2x2 table over the same items, first rater's label then second's. The agreed records
    # are `include_include + exclude_exclude`; kappa covers every one of `items`.
    include_include: int = 0
    include_exclude: int = 0
    exclude_include: int = 0
    exclude_exclude: int = 0

    @classmethod
    def of(
        cls,
        kind: Literal["human_human", "human_ai", "human_ai_verified"],
        raters: tuple[str, str],
        a: Sequence[str],
        b: Sequence[str],
    ) -> PairAgreement:
        """Kappa, PABAK, and the 2x2 table for two raters' include or exclude labels, in order."""
        kappa = None
        if a:
            try:
                kappa = cohen_kappa(a, b)
            except ValueError:
                kappa = None  # one label throughout: kappa is undefined
        cells = Counter(zip(a, b, strict=True))
        return cls(
            kind=kind,
            raters=raters,
            items=len(a),
            kappa=kappa,
            pabak=pabak(a, b) if a else None,
            include_include=cells["include", "include"],
            include_exclude=cells["include", "exclude"],
            exclude_include=cells["exclude", "include"],
            exclude_exclude=cells["exclude", "exclude"],
        )

    @property
    def agreed(self) -> int:
        return self.include_include + self.exclude_exclude


class AuditStratum(Record):
    """Excluded records whose AI reading was, or was not, a verified exclusion."""

    ai_excludes: bool
    population: int
    sampled: int  # decided audit samples in the stratum
    relevant_found: int


class AuditGauge(Record):
    sentinels: int  # sentinel assignments
    sentinels_decided: int
    sentinels_correct: int
    audit_samples: int  # records sampled for audit
    audit_decided: int
    excluded_population: int
    """Records excluded without adjudication, other than the audit's own (plus, in M3, every
    record not yet screened)."""
    audit_relevant_found: int
    strata: tuple[AuditStratum, ...]
    elusion: Interval | None
    """Estimated relevant records among the excluded ones, stratified by the verified AI
    reading, with its one-sided 95% upper bound. None while a stratum with records has no
    decided audit sample."""


class StopStatus(Record):
    screened: int  # the fully screened prefix in AI order
    relevant: int
    remaining: int
    target_recall: float
    alpha: float
    p_value: float
    minimum_screened_percent: str
    minimum_met: bool
    pending_conflicts: int  # unresolved conflicts in the tested prefix
    verdict: Literal["stop", "continue", "pending_conflicts"]
    """`stop` when the test rejects, the minimum is met, and no conflict in the prefix is open;
    `pending_conflicts` withholds certification until they are adjudicated."""
    stop: bool  # verdict == "stop"
    method: str


class RescreenGauge(Record):
    """Blind extra screens that AI-only disagreements sent to the auditor. Lead's view only."""

    triggered: int
    pending: int
    upheld: int  # the auditor agreed with the screeners: their decision stands
    adjudicated: int  # the auditor disagreed: a human disagreement went to adjudication


class SecondOpinionGauge(Record):
    """Mode S: decisions a screener asked a second opinion on. The second screener saw the first
    decision, so these are consults, not independent screens."""

    requested: int
    pending: int
    changed: int  # the second screener decided otherwise on include against exclude
    kept: int


class StageMetrics(Record):
    mode: ScreeningMode
    documentation: DocumentationLevel
    reveal: RevealSetting
    conflicts_resolved: int
    reveals_shown: int
    revised_after_reveal: int
    agreement: tuple[PairAgreement, ...]
    audit: AuditGauge
    rescreens: RescreenGauge
    stop_test: StopStatus | None  # M3 only
    second_opinions: SecondOpinionGauge | None = None  # S only
    ai_shown_before: int = 0
    """Decisions made with the AI's reading on screen (reveal `before`)."""


class ScopeStatus(Record):
    """Progress of a scope and stage.

    A reviewer who screens or audits the stage sees only their own counts (`view == "reviewer"`,
    hidden items included, no conflicts, no metrics). An adjudicator of the stage sees the
    screening progress and, as `conflicts`, the adjudications pending for them, without
    metrics. Anyone else (the methods lead) sees the whole stage.
    """

    scope_id: str
    stage: Stage
    view: Literal["reviewer", "adjudicator", "lead"]
    screened: int
    remaining: int
    conflicts: int | None
    metrics: StageMetrics | None
