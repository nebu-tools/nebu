"""Screening routes: the reviewer's queue, decide, undo, wrong document, adjudication, and
status.

Until the API has authentication (WP-15), the caller names themselves in the `X-Kittum-Reviewer`
header with their actor ID. The service enforces blinding against that ID: a reviewer gets only
their own assignments, no AI output before their own provisional decision, no sentinel or audit
flags, and only their own counts. The header is a stand-in, not a security boundary; anyone who
can reach the API can claim any actor ID.
"""

from contextlib import contextmanager
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Header, HTTPException, Query, status
from pydantic import Field

from kittum.api import AppContext, Context  # noqa: TC001 - FastAPI resolves it at runtime
from kittum.app import (
    AssignmentFullText,
    ConflictFullText,
    LifecycleError,
    NotLead,
    WrongDocument,
    ai_quote,
    ai_quotes,
    full_text,
    mark_wrong_document,
    mentions,
    open_screening,
    parse_sentinels,
    rejudge_screening,
    require_lead,
)
from kittum.core import Id, NotFoundError, Record
from kittum.documents import get_layer
from kittum.protocol import ProtocolError, Stage, compile
from kittum.runs import CommandIdReused
from kittum.screening import (
    AdjudicationItem,
    AdjudicationResult,
    BenchResult,
    BulkAction,
    BulkResult,
    BulkRow,
    DecideResult,
    Decision,
    DecisionTiming,
    InvalidDecision,
    NotAssigned,
    Phase,
    QueueItem,
    RecordPrompt,
    RevealSetting,
    ScopeStatus,
    Screening,
    ScreeningTable,
    Sentinel,
    StageInfo,
    StaleRevision,
    UndoResult,
    screening_table,
)

if TYPE_CHECKING:
    from collections.abc import Generator

router = APIRouter(prefix="/api/projects/{project_id}/screening", tags=["screening"])

Reviewer = Annotated[
    Id,
    Header(
        alias="X-Kittum-Reviewer",
        description="The caller's actor ID. A stand-in until the API has authentication.",
    ),
]
TopicId = Annotated[
    str | None, Query(description="Needed only when the scope is screened in several topics.")
]


class DecideRequest(Record):
    command_id: Id
    """Chosen by the client; a retry with the same ID returns the first result."""
    decision: Decision
    phase: Phase
    expected_etag: str
    """The `etag` the client last saw; a stale one is rejected with 409."""
    timing: DecisionTiming


class UndoRequest(Record):
    command_id: Id
    expected_etag: str
    """The `etag` the client last saw; a stale one is rejected with 409."""


class WrongDocumentRequest(Record):
    command_id: Id
    expected_etag: str
    """The `etag` the client last saw; a stale one is rejected with 409."""
    document_id: Id
    """The PDF the reviewer saw. If the record's full text is another one by now, 409."""
    note: str | None = None
    """What the PDF is instead, in the reviewer's words."""


class AdjudicateRequest(Record):
    command_id: Id
    expected_etag: str
    """The `etag` the client last saw; a stale one is rejected with 409."""
    adopted: str | None = None
    """A column label ("A", "B", ...) to adopt, or None with an own `decision`."""
    decision: Decision | None = None
    timing: DecisionTiming | None = None


class OpenStageRequest(Record):
    scope_id: str
    stage: Stage
    actor_id: Id
    """The methods lead who opens the stage."""
    reveal: RevealSetting = "on_disagreement"
    topic_id: str | None = None
    sentinels: tuple[Sentinel, ...] = ()
    """Records with known labels for the queues; a full-text stage without any draws them from
    the project's sentinel full texts. Mode S takes none."""
    screeners: tuple[Id, ...] | None = None
    """Mode S only: the pool of reviewers who share the records; every reviewer of the project
    if left out. The other modes take their screeners from the project's reviewers."""


class RejudgeRequest(Record):
    actor_id: Id
    """The methods lead who re-judges."""
    command_id: Id
    protocol_version_id: Id | None = None
    """A published version; the newest one if left out."""


class BenchRequest(Record):
    actor_id: Id
    """The methods lead who runs the bench."""
    command_id: Id
    source: dict[str, Any]
    """The draft protocol, as the form or the YAML editor holds it. It is compiled, not saved."""
    limit: Annotated[int, Field(ge=0, le=200)] = 50
    """At most this many settled records, besides the topic's known includes."""


class BulkDecideRequest(Record):
    command_id: Id
    """Chosen by the client; a retry with the same ID returns the first result."""
    rows: tuple[BulkRow, ...] = Field(min_length=1, max_length=5000)
    action: BulkAction
    reason_criterion_id: str | None = None
    """The criterion to exclude on, for `exclude`."""
    filter: str | None = Field(default=None, max_length=2000)
    """The table's filter when the rows were selected, in words, for the ledger."""
    timing: DecisionTiming
    """When the selection started (`shown_at`) and when it was decided."""


class SentinelFile(Record):
    text: str
    """A YAML or JSON list of sentinels, as `kittum project open-stage --sentinels` reads."""


def _screening(ctx: AppContext) -> Screening:
    if ctx.ledger is None:
        raise HTTPException(status_code=503, detail="no ledger is configured")
    return Screening.postgres(ctx.ledger, ctx.clock)


@contextmanager
def _errors() -> Generator[None]:
    try:
        yield
    except (NotFoundError, NotAssigned) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except (StaleRevision, CommandIdReused) as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except InvalidDecision as e:
        # FastAPI's validation-error shape, so clients read one 422 format.
        detail = [{"loc": [], "msg": str(e), "type": "invalid_decision"}]
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail) from e
    except NotLead as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except LifecycleError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


@router.get("/stages", operation_id="listScreeningStages")
def stages(project_id: Id, ctx: Context) -> list[StageInfo]:
    """Every open stage, with its mode, reveal setting, screeners, auditor, and adjudicators."""
    with ctx.db.transaction() as tx:
        return _screening(ctx).stages(tx, project_id)


@router.post("/stages", operation_id="openScreeningStage", status_code=201)
def open_stage(project_id: Id, body: OpenStageRequest, ctx: Context) -> StageInfo:
    """Open a scope at a stage with the project's people and enqueue the AI judge. Title and
    abstract screens every report of the corpus; full text every record included at title and
    abstract that has a full text."""
    with _errors(), ctx.db.transaction() as tx:
        # Whoever opens a stage hands over its sentinels: only a lead who screens nothing.
        require_lead(tx, project_id, body.actor_id)
        return open_screening(
            tx,
            ctx,
            project_id,
            body.scope_id,
            body.stage,
            actor_id=body.actor_id,
            reveal=body.reveal,
            topic_id=body.topic_id,
            sentinels=body.sentinels,
            screeners=body.screeners,
        )


@router.post("/sentinels/parse", operation_id="parseScreeningSentinels")
def parse_sentinels_route(project_id: Id, body: SentinelFile) -> list[Sentinel]:  # noqa: ARG001
    """Read a sentinel file for `openScreeningStage`; 422 with the line or entry at fault."""
    try:
        return list(parse_sentinels(body.text))
    except LifecycleError as e:
        detail = [{"loc": ["body", "text"], "msg": str(e), "type": "invalid_file"}]
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail) from e


@router.get("/assignments/{assignment_id}/full-text", operation_id="getScreeningAssignmentFullText")
def assignment_full_text(
    project_id: Id, assignment_id: Id, reviewer: Reviewer, ctx: Context
) -> AssignmentFullText:
    """The full text of one of the caller's full-text assignments, with the protocol-term
    mentions of each criterion in document order. After the caller's own provisional decision
    revealed the AI's reading, `ai_quote` places its verified quote on the page."""
    screening = _screening(ctx)
    with _errors(), ctx.db.transaction() as tx:
        ref, _, criteria = screening.assignment_source(tx, project_id, reviewer, assignment_id)
        found = full_text(tx, project_id, ref)
        if found is None:
            raise NotFoundError("this assignment has no full text")
        layer = get_layer(tx, found.layer_id, artifacts=ctx.artifacts)
        reveal = screening.own_reveal(tx, project_id, reviewer, assignment_id)
    return AssignmentFullText(
        document_id=found.document_id,
        layer_id=found.layer_id,
        page_count=found.page_count,
        licence=found.licence,
        mentions=mentions(layer, criteria),
        ai_quote=ai_quote(layer, reveal),
    )


@router.post(
    "/assignments/{assignment_id}/wrong-document", operation_id="markScreeningWrongDocument"
)
def wrong_document(
    project_id: Id, assignment_id: Id, body: WrongDocumentRequest, reviewer: Reviewer, ctx: Context
) -> WrongDocument:
    """The PDF of one of the caller's full-text assignments is not the record's report. The item
    leaves screening and the record has no full text again. Not an exclusion."""
    with _errors(), ctx.db.transaction() as tx:
        return mark_wrong_document(
            tx,
            ctx,
            project_id,
            command_id=body.command_id,
            reviewer_id=reviewer,
            assignment_id=assignment_id,
            expected_etag=body.expected_etag,
            document_id=body.document_id,
            note=body.note,
        )


@router.get("/queue", operation_id="getScreeningQueue")
def queue(
    project_id: Id,
    reviewer: Reviewer,
    ctx: Context,
    scope_id: str,
    stage: Stage,
    topic_id: TopicId = None,
    after: Annotated[Id | None, Query(description="The last assignment the client holds.")] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 5,
) -> list[QueueItem]:
    """The reviewer's next undecided assignments in queue order, after `after`. Items can appear
    behind `after`; re-read without it when `remaining` in the stage status is higher than the
    items held."""
    screening = _screening(ctx)
    with _errors(), ctx.db.transaction() as tx:
        return screening.queue(
            tx, project_id, reviewer, scope_id, stage, after=after, limit=limit, topic_id=topic_id
        )


@router.get("/table", operation_id="getScreeningTable")
def table(
    project_id: Id,
    reviewer: Reviewer,
    ctx: Context,
    scope_id: str,
    stage: Stage,
    topic_id: TopicId = None,
) -> ScreeningTable:
    """The stage as rows. A screener or auditor gets their own assignments in queue order, decided
    ones included, with no AI reading their own decision did not reveal and no sentinel or audit
    flags. The methods lead gets every item with every decision, the outcome, and the AI's
    reading. Anyone else is not assigned (404)."""
    with _errors(), ctx.db.transaction() as tx:
        return screening_table(tx, project_id, reviewer, scope_id, stage, topic_id=topic_id)


@router.post("/assignments/{assignment_id}/decide", operation_id="decideScreeningAssignment")
def decide(
    project_id: Id, assignment_id: Id, body: DecideRequest, reviewer: Reviewer, ctx: Context
) -> DecideResult:
    """A provisional decision, then a final one if the AI was revealed. In mode S a decision can
    ask for a second opinion (`decision.second_opinion`)."""
    screening = _screening(ctx)
    with _errors(), ctx.db.transaction() as tx:
        return screening.decide(
            tx,
            command_id=body.command_id,
            project_id=project_id,
            reviewer_id=reviewer,
            assignment_id=assignment_id,
            decision=body.decision,
            phase=body.phase,
            expected_etag=body.expected_etag,
            timing=body.timing,
        )


@router.post("/assignments/{assignment_id}/undo", operation_id="undoScreeningDecision")
def undo(
    project_id: Id, assignment_id: Id, body: UndoRequest, reviewer: Reviewer, ctx: Context
) -> UndoResult:
    screening = _screening(ctx)
    with _errors(), ctx.db.transaction() as tx:
        return screening.undo(
            tx,
            command_id=body.command_id,
            project_id=project_id,
            reviewer_id=reviewer,
            assignment_id=assignment_id,
            expected_etag=body.expected_etag,
        )


@router.get("/adjudications", operation_id="listScreeningAdjudications")
def adjudications(
    project_id: Id,
    reviewer: Reviewer,
    ctx: Context,
    scope_id: str,
    stage: Stage,
    topic_id: TopicId = None,
) -> list[AdjudicationItem]:
    """Open conflicts the caller did not screen. The AI column opens after the decision."""
    screening = _screening(ctx)
    with _errors(), ctx.db.transaction() as tx:
        return screening.adjudication_queue(
            tx, project_id, reviewer, scope_id, stage, topic_id=topic_id
        )


@router.get(
    "/adjudications/{conflict_id}/full-text", operation_id="getScreeningAdjudicationFullText"
)
def adjudication_full_text(
    project_id: Id, conflict_id: Id, reviewer: Reviewer, ctx: Context
) -> ConflictFullText:
    """The full text behind a full-text conflict the caller adjudicates, with the protocol-term
    mentions of each criterion in document order. Once the caller has adjudicated it,
    `ai_quotes` places the AI's verified quotes on the page."""
    screening = _screening(ctx)
    with _errors(), ctx.db.transaction() as tx:
        ref, _, criteria, ai = screening.conflict_source(tx, project_id, reviewer, conflict_id)
        found = full_text(tx, project_id, ref)
        if found is None:
            raise NotFoundError("this conflict has no full text")
        layer = get_layer(tx, found.layer_id, artifacts=ctx.artifacts)
    return ConflictFullText(
        document_id=found.document_id,
        layer_id=found.layer_id,
        page_count=found.page_count,
        licence=found.licence,
        mentions=mentions(layer, criteria),
        ai_quotes=ai_quotes(layer, ai),
    )


@router.post("/adjudications/{conflict_id}/decide", operation_id="decideScreeningAdjudication")
def adjudicate(
    project_id: Id, conflict_id: Id, body: AdjudicateRequest, reviewer: Reviewer, ctx: Context
) -> AdjudicationResult:
    screening = _screening(ctx)
    with _errors(), ctx.db.transaction() as tx:
        return screening.adjudicate(
            tx,
            command_id=body.command_id,
            project_id=project_id,
            adjudicator_id=reviewer,
            conflict_id=conflict_id,
            expected_etag=body.expected_etag,
            adopted=body.adopted,
            decision=body.decision,
            timing=body.timing,
        )


@router.get("/status", operation_id="getScreeningStatus")
def status_route(
    project_id: Id,
    reviewer: Reviewer,
    ctx: Context,
    scope_id: str,
    stage: Stage,
    topic_id: TopicId = None,
) -> ScopeStatus:
    """A screener's own counts, or the whole stage for anyone who does not screen it."""
    screening = _screening(ctx)
    with _errors(), ctx.db.transaction() as tx:
        return screening.status(tx, project_id, reviewer, scope_id, stage, topic_id=topic_id)


@router.post("/stages/{stage_id}/rejudge", operation_id="rejudgeScreeningStage")
def rejudge(project_id: Id, stage_id: Id, body: RejudgeRequest, ctx: Context) -> StageInfo:
    """Re-judge an open stage under a newer published protocol version that changes only what
    the AI reads (the topic's strictness and guidance, the criteria's keywords and examples).
    New readings replace the old for display; the old stay in the ledger and the disclosure.
    Human decisions stay as they are. 422 for a version that changes more."""
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, body.actor_id)
        return rejudge_screening(
            tx,
            ctx,
            project_id,
            stage_id,
            actor_id=body.actor_id,
            command_id=body.command_id,
            protocol_version_id=body.protocol_version_id,
        )


@router.post("/stages/{stage_id}/bench", operation_id="runScreeningBench", status_code=201)
def run_bench(project_id: Id, stage_id: Id, body: BenchRequest, ctx: Context) -> BenchResult:
    """The test bench: the stage's judge, with a draft protocol's instructions, on the topic's
    known includes among the stage's records and up to `limit` records people have settled. A
    job judges them; read the result with `getScreeningBench`. 422 for a draft that does not
    compile."""
    try:
        draft = compile(body.source)
    except ProtocolError as e:
        detail = [
            {"loc": ["body", "source", *i.path.split(".")], "msg": i.message, "type": "protocol"}
            for i in e.issues
        ]
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail) from e
    screening = _screening(ctx)
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, body.actor_id)
        bench_id = screening.request_bench(
            tx,
            command_id=body.command_id,
            project_id=project_id,
            actor_id=body.actor_id,
            stage_id=stage_id,
            protocol=draft,
            limit=body.limit,
        )
        return screening.bench(tx, project_id, body.actor_id, bench_id)


@router.get("/bench/{bench_id}", operation_id="getScreeningBench")
def get_bench(project_id: Id, bench_id: Id, reviewer: Reviewer, ctx: Context) -> BenchResult:
    """A bench run's flips against the current readings and the human decisions, known includes
    first. The methods lead's only."""
    with _errors(), ctx.db.transaction() as tx:
        return _screening(ctx).bench(tx, project_id, reviewer, bench_id)


@router.post("/stages/{stage_id}/bulk-decide", operation_id="bulkDecideScreening")
def bulk_decide(
    project_id: Id, stage_id: Id, body: BulkDecideRequest, reviewer: Reviewer, ctx: Context
) -> BulkResult:
    """Decide many of the caller's own records at once, in a topic with working documentation:
    include them, exclude them on one criterion, or accept the AI's proposal for each. One
    decision per record with `origin: bulk`, and one batch event with the filter. A complete
    topic refuses (422)."""
    with _errors(), ctx.db.transaction() as tx:
        return _screening(ctx).bulk_decide(
            tx,
            command_id=body.command_id,
            project_id=project_id,
            reviewer_id=reviewer,
            stage_id=stage_id,
            rows=body.rows,
            action=body.action,
            reason_criterion_id=body.reason_criterion_id,
            filter_description=body.filter,
            timing=body.timing,
        )


@router.get("/stages/{stage_id}/prompt", operation_id="getScreeningRecordPrompt")
def record_prompt(
    project_id: Id,
    stage_id: Id,
    reviewer: Reviewer,
    ctx: Context,
    assignment_id: Annotated[
        Id | None, Query(description="One of the caller's assignments (working topics).")
    ] = None,
    item_ref: Annotated[str | None, Query(description="Any record, for the methods lead.")] = None,
) -> RecordPrompt:
    """The prompt the AI judge reads a record with under the stage's protocol version."""
    with _errors(), ctx.db.transaction() as tx:
        return _screening(ctx).record_prompt(
            tx, project_id, reviewer, stage_id, assignment_id=assignment_id, item_ref=item_ref
        )
