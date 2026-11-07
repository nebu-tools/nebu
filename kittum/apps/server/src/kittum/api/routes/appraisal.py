"""Risk-of-bias routes for the workbench: the reports to appraise, an appraisal beside its PDF,
answers with their quotes, and overrides with a reason.

A report can be appraised once it is included at full text and has a full text. Every call names
its caller in `X-Kittum-Reviewer` (a stand-in until the API has authentication) and shows a report
only to someone who may see its extraction (`kittum.app.visible_reports`): a lead who screens
nothing, or a member with no undecided screening assignment for it, since that a report is
appraised tells how the screeners decided. Anyone else gets 404.
"""

from contextlib import contextmanager
from typing import TYPE_CHECKING, Annotated

from fastapi import APIRouter, HTTPException
from pydantic import Field

from kittum.api import AppContext, Context  # noqa: TC001  FastAPI resolves them at runtime
from kittum.api.routes.projects import Viewer  # noqa: TC001  FastAPI resolves it at runtime
from kittum.app import (
    LifecycleError,
    RetrievalItem,
    check_extractable,
    full_text,
    retrieval,
    visible_reports,
)
from kittum.appraisal import (
    Answer,
    Appraisal,
    AppraisalError,
    Judgement,
    QuestionMentions,
    instruments,
    mentions,
)
from kittum.appraisal import answer as answer_question
from kittum.appraisal import appraisals as list_appraisals
from kittum.appraisal import get as get_appraisal
from kittum.appraisal import instrument as get_instrument
from kittum.appraisal import override as override_judgement
from kittum.appraisal import start as start_appraisal
from kittum.core import Id, NotFoundError, Record
from kittum.documents import get_layer
from kittum.extraction import ReviewLayer

if TYPE_CHECKING:
    from collections.abc import Generator

    from kittum.db import Tx

router = APIRouter(prefix="/api/projects/{project_id}/appraisal", tags=["appraisal"])


class InstrumentInfo(Record):
    id: str
    title: str
    source: str


class DomainJudgement(Record):
    id: str
    title: str
    judgement: Judgement | None
    overridden: bool


class AppraisalSummary(Record):
    id: Id
    instrument: str
    result: str
    judgement: Judgement | None
    overridden: bool
    domains: list[DomainJudgement]
    answered: int
    """Answered questions that apply."""
    open: int
    """Questions that apply or may apply and have no answer yet."""


class AppraisableReport(Record):
    report_id: Id
    study_id: Id
    study_label: str
    title: str
    year: int | None
    journal: str | None
    appraisals: list[AppraisalSummary]


class AppraisalScreen(Record):
    """An appraisal with its report's full text and the instrument's words found in it."""

    appraisal: Appraisal
    layer: ReviewLayer
    mentions: list[QuestionMentions]


class StartBody(Record):
    command_id: Id
    report_id: Id
    instrument: str = "rob2"
    result: Annotated[str, Field(min_length=1, max_length=500)]
    """The result or outcome appraised, e.g. "HbA1c at 12 months, ITT"."""


class AnswerBody(Record):
    command_id: Id
    question_id: str
    answer: Answer
    anchor_ids: tuple[Id, ...] = ()
    """Quotes from the report's full text (`POST /api/layers/{id}/anchors`)."""


class OverrideBody(Record):
    command_id: Id
    target: str
    """A domain ID ("D1" for RoB 2) or "overall"."""
    judgement: Judgement | None
    """None takes the override back."""
    reason: Annotated[str, Field(max_length=2000)] | None = None


@contextmanager
def _errors() -> Generator[None]:
    try:
        yield
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except (AppraisalError, LifecycleError) as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


def _label(item: RetrievalItem) -> str:
    return next(iter(item.registry_ids), None) or item.doi or item.title[:60]


def _included(item: RetrievalItem) -> bool:
    return item.full_text is not None and any(
        stages.get("full_text") == "include" for stages in item.outcomes.values()
    )


def _reports(tx: Tx, ctx: AppContext, project_id: Id, viewer: Id) -> list[RetrievalItem]:
    """The reports included at full text with a full text, that the viewer may see."""
    try:
        items = [i for i in retrieval(tx, project_id, ctx.screening()) if _included(i)]
    except LifecycleError:
        return []  # no corpus yet
    shown = visible_reports(tx, project_id, viewer, [i.report_id for i in items])
    return [i for i in items if i.report_id in shown]


def _report(tx: Tx, ctx: AppContext, project_id: Id, viewer: Id, report_id: Id) -> RetrievalItem:
    found = next(
        (i for i in _reports(tx, ctx, project_id, viewer) if i.report_id == report_id), None
    )
    if found is None or found.full_text is None:
        raise NotFoundError(f"report {report_id}")
    # The report is still included and its full text is the one the retrieval list names.
    check_extractable(
        tx, project_id, report_id, found.full_text.layer_id, ctx.screening(), ctx.artifacts
    )
    return found


def _visible(tx: Tx, project_id: Id, viewer: Id, appraisal_id: Id) -> Appraisal:
    """The appraisal, or not found for anyone who may not see its report."""
    appraisal = get_appraisal(tx, project_id, appraisal_id)
    if appraisal.report_id not in visible_reports(tx, project_id, viewer, [appraisal.report_id]):
        raise NotFoundError(f"appraisal {appraisal_id}")
    return appraisal


def _summary(a: Appraisal) -> AppraisalSummary:
    questions = [q for d in a.domains for q in d.questions]
    return AppraisalSummary(
        id=a.id,
        instrument=a.instrument,
        result=a.result,
        judgement=a.judgement,
        overridden=a.override is not None,
        domains=[
            DomainJudgement(
                id=d.id, title=d.title, judgement=d.judgement, overridden=d.override is not None
            )
            for d in a.domains
        ],
        answered=sum(1 for q in questions if q.applies == "yes" and q.answer is not None),
        open=sum(
            1
            for q in questions
            if q.applies == "pending" or (q.applies == "yes" and q.answer is None)
        ),
    )


@router.get("/instruments", operation_id="listAppraisalInstruments")
def list_instruments_route(project_id: Id) -> list[InstrumentInfo]:  # noqa: ARG001
    out = []
    for i in instruments():
        definition = get_instrument(i).definition
        out.append(InstrumentInfo(id=i, title=definition.title, source=definition.source))
    return out


@router.get("/reports", operation_id="listAppraisableReports")
def list_reports_route(project_id: Id, viewer: Viewer, ctx: Context) -> list[AppraisableReport]:
    """The reports included at full text with a full text that the viewer may see, in search
    order, each with its appraisals."""
    with _errors(), ctx.db.transaction() as tx:
        items = _reports(tx, ctx, project_id, viewer)
        by_report: dict[Id, list[AppraisalSummary]] = {}
        for a in list_appraisals(tx, project_id, report_ids=[i.report_id for i in items]):
            by_report.setdefault(a.report_id, []).append(_summary(a))
        return [
            AppraisableReport(
                report_id=i.report_id,
                study_id=i.study_id,
                study_label=_label(i),
                title=i.title,
                year=i.year,
                journal=i.journal,
                appraisals=by_report.get(i.report_id, []),
            )
            for i in items
        ]


@router.post("/appraisals", operation_id="startAppraisal", status_code=201)
def start_route(project_id: Id, body: StartBody, viewer: Viewer, ctx: Context) -> Appraisal:
    """A new appraisal of one result of an included report, on its full text. 409 if the report
    already has one of that result with that instrument. Retrying with the same `command_id`
    returns the same appraisal."""
    ledger = ctx.require_ledger()
    with _errors(), ctx.db.transaction() as tx:
        item = _report(tx, ctx, project_id, viewer, body.report_id)
        assert item.full_text is not None
        return start_appraisal(
            tx,
            ledger,
            command_id=body.command_id,
            project_id=project_id,
            report_id=item.report_id,
            study_id=item.study_id,
            document_id=item.full_text.document_id,
            study_label=_label(item),
            report_title=item.title,
            instrument_id=body.instrument,
            result=body.result,
            actor_id=viewer,
        )


@router.get("/appraisals/{appraisal_id}/screen", operation_id="getAppraisalScreen")
def screen_route(project_id: Id, appraisal_id: Id, viewer: Viewer, ctx: Context) -> AppraisalScreen:
    """The appraisal with its report's full text, and each question's words in it in document
    order (from the instrument, never from a model) for adopting quotes."""
    with _errors(), ctx.db.transaction() as tx:
        appraisal = _visible(tx, project_id, viewer, appraisal_id)
        found = full_text(tx, project_id, str(appraisal.report_id))
        if found is None or found.document_id != appraisal.document_id:
            raise LifecycleError(
                "The report's full text is no longer the PDF this appraisal was made on."
            )
        layer = get_layer(tx, found.layer_id, artifacts=ctx.artifacts)
        return AppraisalScreen(
            appraisal=appraisal,
            layer=ReviewLayer.model_validate(
                {
                    "id": layer.id,
                    "document_id": layer.document_id,
                    "recipe_hash": layer.recipe_hash,
                    "output_hash": layer.output_hash,
                    "text": layer.text,
                    "pages": [
                        {"page": p.number, "width": p.width, "height": p.height}
                        for p in layer.pages
                    ],
                }
            ),
            mentions=list(mentions(layer, appraisal.instrument)),
        )


@router.post("/appraisals/{appraisal_id}/answers", operation_id="answerAppraisalQuestion")
def answer_route(
    project_id: Id, appraisal_id: Id, body: AnswerBody, viewer: Viewer, ctx: Context
) -> Appraisal:
    """Answer one signalling question with its quotes; the domain's proposed judgement comes back
    with the appraisal. 409 with the reason if the question does not apply yet, the answer is not
    one of its options, or a quote is not in the appraised full text."""
    ledger = ctx.require_ledger()
    with _errors(), ctx.db.transaction() as tx:
        appraisal = _visible(tx, project_id, viewer, appraisal_id)
        found = full_text(tx, project_id, str(appraisal.report_id))
        return answer_question(
            tx,
            ledger,
            command_id=body.command_id,
            project_id=project_id,
            appraisal_id=appraisal_id,
            question_id=body.question_id,
            answer=body.answer,
            anchor_ids=body.anchor_ids,
            actor_id=viewer,
            full_text_document_id=found.document_id if found else None,
            artifacts=ctx.artifacts,
        )


@router.post("/appraisals/{appraisal_id}/overrides", operation_id="overrideAppraisalJudgement")
def override_route(
    project_id: Id, appraisal_id: Id, body: OverrideBody, viewer: Viewer, ctx: Context
) -> Appraisal:
    """Set a domain's or the overall judgement against the algorithm's, with a reason, or take
    an override back (`judgement` null)."""
    ledger = ctx.require_ledger()
    with _errors(), ctx.db.transaction() as tx:
        _visible(tx, project_id, viewer, appraisal_id)
        return override_judgement(
            tx,
            ledger,
            command_id=body.command_id,
            project_id=project_id,
            appraisal_id=appraisal_id,
            target=body.target,
            judgement=body.judgement,
            reason=body.reason,
            actor_id=viewer,
        )
