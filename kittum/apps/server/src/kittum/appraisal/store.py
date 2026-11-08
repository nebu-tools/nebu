"""Appraisals: rows, ledger events, and what the screen and the reports read.

One appraisal per report, instrument, and result. Each answer is a new row and an
`appraisal.answered` event that carries the quotes and the domain's proposed judgement at that
moment; each override a new row and an `appraisal.overridden` event. The newest row per question,
domain, or overall judgement is the current one, so reading as of a ledger cutoff is a filter on
the rows' `event_seq`.
"""

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, LiteralString

from kittum.appraisal.forms import (
    Answer,
    Applies,
    Condition,
    InstrumentDefinition,
    Judgement,
    applicability,
    propose,
)
from kittum.core import Id, KittumError, NotFoundError, Record, Span, find_quote, new_id
from kittum.documents import Anchor, get_anchor, get_layer, make_anchor
from kittum.ledger import EventDraft

if TYPE_CHECKING:
    from kittum.appraisal.forms import DomainAlgorithm, OverallRule
    from kittum.db import Tx
    from kittum.documents import Layer
    from kittum.ledger import AuditEvent, Ledger

STARTED = "appraisal.started"
ANSWERED = "appraisal.answered"
OVERRIDDEN = "appraisal.overridden"
OVERALL = "overall"

MAX_MENTIONS = 40
"""Per question; a word on every page helps nobody."""


class AppraisalError(KittumError):
    """The request does not fit the appraisal: the reason is for the reviewer."""


@dataclass(frozen=True)
class Instrument:
    """A registered instrument: its form, and the algorithms that propose judgements."""

    definition: InstrumentDefinition
    algorithms: dict[str, DomainAlgorithm] = field(default_factory=dict)
    """Domain ID -> algorithm; a domain without one gets its judgement from a human only."""
    overall: OverallRule | None = None
    """None: the overall judgement is a human's only."""


class Override(Record):
    judgement: Judgement
    reason: str
    actor_id: Id
    recorded_at: datetime


class QuestionView(Record):
    id: str
    label: str
    text: str
    options: tuple[Answer, ...]
    condition: Condition | None
    applies: Applies
    answer: Answer | None
    """The newest answer. The algorithm ignores it while the question does not apply."""
    evidence: tuple[Anchor, ...]
    answered_by: Id | None
    answered_at: datetime | None


class DomainView(Record):
    id: str
    title: str
    questions: tuple[QuestionView, ...]
    proposed: Judgement | None
    """The algorithm's judgement; None until every applicable question has an answer."""
    override: Override | None
    judgement: Judgement | None
    """The override, or else the proposal."""


class Appraisal(Record):
    id: Id
    project_id: Id
    report_id: Id
    study_id: Id
    document_id: Id
    study_label: str
    report_title: str
    instrument: str
    instrument_title: str
    result: str
    """The result or outcome appraised, in the reviewer's words."""
    created_by: Id
    created_at: datetime
    domains: tuple[DomainView, ...]
    proposed: Judgement | None
    """The overall rule over the domain judgements; None until every domain has one."""
    override: Override | None
    judgement: Judgement | None


class QuestionMentions(Record):
    question_id: str
    terms: tuple[str, ...]
    mentions: tuple[Anchor, ...]


_instruments: dict[str, Instrument] = {}


def register(instrument: Instrument) -> None:
    if instrument.definition.id in _instruments:
        raise ValueError(f"instrument {instrument.definition.id!r} is already registered")
    _instruments[instrument.definition.id] = instrument


def instrument(instrument_id: str) -> Instrument:
    found = _instruments.get(instrument_id)
    if found is None:
        raise AppraisalError(f"There is no instrument {instrument_id!r}.")
    return found


def registered() -> tuple[str, ...]:
    return tuple(_instruments)


# Reading


_ROWS: dict[str, LiteralString] = {
    "appraisal_answer": "select * from appraisal_answer where appraisal_id = %s"
    " and (%s::bigint is null or event_seq <= %s::bigint) order by event_seq",
    "appraisal_override": "select * from appraisal_override where appraisal_id = %s"
    " and (%s::bigint is null or event_seq <= %s::bigint) order by event_seq",
}


def _rows(tx: Tx, table: str, appraisal_id: Id, cutoff_seq: int | None) -> list[dict[str, Any]]:
    return tx.execute(_ROWS[table], (appraisal_id, cutoff_seq, cutoff_seq)).fetchall()


def _override(row: dict[str, Any] | None) -> Override | None:
    if row is None or row["judgement"] is None:
        return None
    return Override(
        judgement=row["judgement"],
        reason=row["reason"],
        actor_id=row["actor_id"],
        recorded_at=row["recorded_at"],
    )


def _view(tx: Tx, row: dict[str, Any], cutoff_seq: int | None) -> Appraisal:
    found = instrument(row["instrument"])
    answers = {r["question_id"]: r for r in _rows(tx, "appraisal_answer", row["id"], cutoff_seq)}
    overrides = {r["target"]: r for r in _rows(tx, "appraisal_override", row["id"], cutoff_seq)}
    domains = []
    for domain in found.definition.domains:
        given: dict[str, Answer] = {
            q.id: answers[q.id]["answer"] for q in domain.questions if q.id in answers
        }
        applies = applicability(domain, given)
        proposed = propose(domain, given, found.algorithms.get(domain.id))
        override = _override(overrides.get(domain.id))
        domains.append(
            DomainView(
                id=domain.id,
                title=domain.title,
                questions=tuple(
                    QuestionView(
                        id=q.id,
                        label=q.label,
                        text=q.text,
                        options=q.options,
                        condition=q.condition,
                        applies=applies[q.id],
                        answer=given.get(q.id),
                        evidence=tuple(get_anchor(tx, a) for a in answers[q.id]["anchor_ids"])
                        if q.id in answers
                        else (),
                        answered_by=answers[q.id]["actor_id"] if q.id in answers else None,
                        answered_at=answers[q.id]["recorded_at"] if q.id in answers else None,
                    )
                    for q in domain.questions
                ),
                proposed=proposed,
                override=override,
                judgement=override.judgement if override else proposed,
            )
        )
    judgements = tuple(d.judgement for d in domains)
    rule = found.overall
    proposed = (
        rule(tuple(j for j in judgements if j is not None))
        if rule is not None and None not in judgements
        else None
    )
    override = _override(overrides.get(OVERALL))
    return Appraisal(
        id=row["id"],
        project_id=row["project_id"],
        report_id=row["report_id"],
        study_id=row["study_id"],
        document_id=row["document_id"],
        study_label=row["study_label"],
        report_title=row["report_title"],
        instrument=row["instrument"],
        instrument_title=found.definition.title,
        result=row["result"],
        created_by=row["created_by"],
        created_at=row["created_at"],
        domains=tuple(domains),
        proposed=proposed,
        override=override,
        judgement=override.judgement if override else proposed,
    )


def get(tx: Tx, project_id: Id, appraisal_id: Id, *, cutoff_seq: int | None = None) -> Appraisal:
    row = tx.execute(
        "select * from appraisal where id = %s and project_id = %s", (appraisal_id, project_id)
    ).fetchone()
    if row is None or (cutoff_seq is not None and row["event_seq"] > cutoff_seq):
        raise NotFoundError(f"appraisal {appraisal_id}")
    return _view(tx, row, cutoff_seq)


def appraisals(
    tx: Tx,
    project_id: Id,
    *,
    report_ids: list[Id] | None = None,
    cutoff_seq: int | None = None,
) -> list[Appraisal]:
    """The project's appraisals, as of the cutoff if one is given, by study, report, and result."""
    rows = tx.execute(
        "select * from appraisal where project_id = %s"
        " and (%s::uuid[] is null or report_id = any(%s::uuid[]))"
        " and (%s::bigint is null or event_seq <= %s::bigint)"
        " order by study_label, report_title, result, id",
        (project_id, report_ids, report_ids, cutoff_seq, cutoff_seq),
    ).fetchall()
    return [_view(tx, row, cutoff_seq) for row in rows]


def mentions(layer: Layer, instrument_id: str) -> tuple[QuestionMentions, ...]:
    """Each question's words in the report, in document order, as unsaved anchors. They come
    from the instrument, never from a model: a word at the start of a word ("conceal" finds
    "concealed"), case-insensitive unless the word is an abbreviation in capitals."""
    out = []
    for domain in instrument(instrument_id).definition.domains:
        for q in domain.questions:
            spans: dict[int, Span] = {}
            for term in q.terms:
                words = r"\s+".join(re.escape(w) for w in term.split())
                flags = 0 if term.isupper() else re.IGNORECASE
                for m in re.finditer(rf"(?<![\w-]){words}[\w-]*", layer.text, flags):
                    spans.setdefault(m.start(), Span(m.start(), m.end()))
            ordered = [spans[k] for k in sorted(spans)][:MAX_MENTIONS]
            out.append(
                QuestionMentions(
                    question_id=q.id,
                    terms=q.terms,
                    mentions=tuple(make_anchor(layer, s) for s in ordered),
                )
            )
    return tuple(out)


# Writing


def _event(
    tx: Tx, ledger: Ledger, project_id: Id, actor_id: Id, kind: str, payload: dict[str, Any]
) -> AuditEvent:
    return ledger.append(
        tx,
        EventDraft(
            project_id=project_id,
            type=kind,
            schema_version=1,
            actor_id=actor_id,
            payload=payload,
        ),
    )


_DONE: dict[str, LiteralString] = {
    "appraisal": "select * from appraisal where command_id = %s",
    "appraisal_answer": "select * from appraisal_answer where command_id = %s",
    "appraisal_override": "select * from appraisal_override where command_id = %s",
}


def _done(tx: Tx, table: str, command_id: Id) -> dict[str, Any] | None:
    return tx.execute(_DONE[table], (command_id,)).fetchone()


def _lock(tx: Tx, project_id: Id, appraisal_id: Id) -> dict[str, Any]:
    """The appraisal's row, locked: its answers and overrides are written one at a time."""
    row = tx.execute(
        "select * from appraisal where id = %s and project_id = %s for update",
        (appraisal_id, project_id),
    ).fetchone()
    if row is None:
        raise NotFoundError(f"appraisal {appraisal_id}")
    return row


def start(
    tx: Tx,
    ledger: Ledger,
    *,
    command_id: Id,
    project_id: Id,
    report_id: Id,
    study_id: Id,
    document_id: Id,
    study_label: str,
    report_title: str,
    instrument_id: str,
    result: str,
    actor_id: Id,
) -> Appraisal:
    """A new appraisal of one result of a report, on the report's full text. The caller checks
    that the report is included and that `document_id` is its full text."""
    done = _done(tx, "appraisal", command_id)
    if done is not None:
        return _view(tx, done, None)
    found = instrument(instrument_id)
    result = " ".join(result.split())
    if not result:
        raise AppraisalError("Name the result or outcome you appraise.")
    clash = tx.execute(
        "select id from appraisal where project_id = %s and report_id = %s and instrument = %s"
        " and result = %s",
        (project_id, report_id, instrument_id, result),
    ).fetchone()
    if clash is not None:
        raise AppraisalError(f"This report already has a {found.definition.title} of {result!r}.")
    appraisal_id = new_id()
    event = _event(
        tx,
        ledger,
        project_id,
        actor_id,
        STARTED,
        {
            "item_ref": str(report_id),
            "appraisal_id": str(appraisal_id),
            "study_id": str(study_id),
            "document_id": str(document_id),
            "instrument": instrument_id,
            "result": result,
        },
    )
    tx.execute(
        "insert into appraisal (id, project_id, report_id, study_id, document_id, study_label,"
        " report_title, instrument, result, created_by, command_id, event_id, event_seq,"
        " created_at) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            appraisal_id,
            project_id,
            report_id,
            study_id,
            document_id,
            study_label,
            report_title,
            instrument_id,
            result,
            actor_id,
            command_id,
            event.event_id,
            event.seq,
            event.recorded_at,
        ),
    )
    return get(tx, project_id, appraisal_id)


def _checked_anchors(
    tx: Tx, document_id: Id, anchor_ids: tuple[Id, ...], artifacts: Any
) -> list[Anchor]:
    """The anchors, each on the appraised document and with its quote found in its layer."""
    anchors = []
    layers: dict[Id, Layer] = {}
    for anchor_id in dict.fromkeys(anchor_ids):
        try:
            anchor = get_anchor(tx, anchor_id)
        except NotFoundError as e:
            raise AppraisalError(f"There is no quote {anchor_id}.") from e
        if anchor.document_id != document_id:
            raise AppraisalError("A quote comes from another document than the one appraised.")
        layer = layers.get(anchor.layer_id) or get_layer(tx, anchor.layer_id, artifacts=artifacts)
        layers[layer.id] = layer
        at = find_quote(anchor.quote.exact, layer.text)
        if not any(s.start < anchor.end and anchor.start < s.end for s in at):
            raise AppraisalError(f"Kittum did not find the quote {anchor.quote.exact!r} there.")
        anchors.append(anchor)
    return anchors


def answer(
    tx: Tx,
    ledger: Ledger,
    *,
    command_id: Id,
    project_id: Id,
    appraisal_id: Id,
    question_id: str,
    answer: Answer,
    anchor_ids: tuple[Id, ...],
    actor_id: Id,
    full_text_document_id: Id | None,
    artifacts: Any,
) -> Appraisal:
    """Answer one signalling question, with the quotes that support the answer. Answering again
    replaces the answer and its quotes. `full_text_document_id` is the report's full text now:
    an appraisal of a PDF the report no longer has takes no more answers."""
    done = _done(tx, "appraisal_answer", command_id)
    if done is not None:
        return get(tx, project_id, done["appraisal_id"])
    row = _lock(tx, project_id, appraisal_id)
    if full_text_document_id != row["document_id"]:
        raise AppraisalError(
            "The report's full text is no longer the PDF this appraisal was made on."
        )
    current = _view(tx, row, None)
    domain = next(
        (d for d in current.domains if any(q.id == question_id for q in d.questions)), None
    )
    if domain is None:
        raise AppraisalError(f"There is no question {question_id} in {current.instrument_title}.")
    question = next(q for q in domain.questions if q.id == question_id)
    if answer not in question.options:
        raise AppraisalError(f"Question {question_id} has no answer {answer!r}.")
    if question.applies == "pending":
        assert question.condition is not None
        missing = ", ".join(question.condition.questions)
        raise AppraisalError(f"Answer {missing} first: they decide whether {question_id} applies.")
    if question.applies == "no":
        raise AppraisalError(f"Question {question_id} does not apply given the answers so far.")
    anchors = _checked_anchors(tx, row["document_id"], anchor_ids, artifacts)
    given = {q.id: q.answer for q in domain.questions if q.answer is not None}
    given[question_id] = answer
    definition = next(
        d for d in instrument(row["instrument"]).definition.domains if d.id == domain.id
    )
    algorithm = instrument(row["instrument"]).algorithms.get(domain.id)
    event = _event(
        tx,
        ledger,
        project_id,
        actor_id,
        ANSWERED,
        {
            "item_ref": str(row["report_id"]),
            "appraisal_id": str(appraisal_id),
            "instrument": row["instrument"],
            "result": row["result"],
            "domain_id": domain.id,
            "question_id": question_id,
            "answer": answer,
            "anchor_ids": [str(a.id) for a in anchors],
            "quotes": [a.quote.exact for a in anchors],
            "proposed": propose(definition, given, algorithm),
        },
    )
    tx.execute(
        "insert into appraisal_answer (id, appraisal_id, project_id, question_id, answer,"
        " anchor_ids, actor_id, command_id, event_id, event_seq, recorded_at)"
        " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            new_id(),
            appraisal_id,
            project_id,
            question_id,
            answer,
            [a.id for a in anchors],
            actor_id,
            command_id,
            event.event_id,
            event.seq,
            event.recorded_at,
        ),
    )
    return get(tx, project_id, appraisal_id)


def override(
    tx: Tx,
    ledger: Ledger,
    *,
    command_id: Id,
    project_id: Id,
    appraisal_id: Id,
    target: str,
    judgement: Judgement | None,
    reason: str | None,
    actor_id: Id,
) -> Appraisal:
    """Set a domain's judgement, or the overall one (`target` "overall"), against the
    algorithm's, with a reason. A null judgement takes the override back."""
    done = _done(tx, "appraisal_override", command_id)
    if done is not None:
        return get(tx, project_id, done["appraisal_id"])
    row = _lock(tx, project_id, appraisal_id)
    current = _view(tx, row, None)
    targets: dict[str, Override | None] = {d.id: d.override for d in current.domains}
    targets[OVERALL] = current.override
    if target not in targets:
        raise AppraisalError(f"There is no domain {target!r} in {current.instrument_title}.")
    reason = " ".join((reason or "").split()) or None
    if judgement is not None and reason is None:
        raise AppraisalError("An override needs a reason.")
    if judgement is None and targets[target] is None:
        raise AppraisalError("There is no override to take back.")
    event = _event(
        tx,
        ledger,
        project_id,
        actor_id,
        OVERRIDDEN,
        {
            "item_ref": str(row["report_id"]),
            "appraisal_id": str(appraisal_id),
            "instrument": row["instrument"],
            "result": row["result"],
            "target": target,
            "judgement": judgement,
            "proposed": (
                current.proposed
                if target == OVERALL
                else next(d.proposed for d in current.domains if d.id == target)
            ),
            "reason": reason,
        },
    )
    tx.execute(
        "insert into appraisal_override (id, appraisal_id, project_id, target, judgement, reason,"
        " actor_id, command_id, event_id, event_seq, recorded_at)"
        " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            new_id(),
            appraisal_id,
            project_id,
            target,
            judgement,
            reason,
            actor_id,
            command_id,
            event.event_id,
            event.seq,
            event.recorded_at,
        ),
    )
    return get(tx, project_id, appraisal_id)
