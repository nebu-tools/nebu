"""The screening table (DESIGN.md, "Reviewer workbench"): one row per record of a stage, for a
spreadsheet-like view and the working export.

A screener or auditor gets their own assignments only, read through `screening_reviewer_table`,
which returns no other reviewer's rows, no AI reading their own provisional decision did not
reveal, no sentinel or audit flags, and no item reference: a reviewer's rows are named by their
assignment IDs. The methods lead (`sees_lead_data`) gets every item of the stage with every
human decision, the outcome, the AI's verified reading, and the item's flags. Anyone else, an
adjudicator who does not screen included, is not assigned: the table lists records, and an
adjudicator only ever sees the conflicts put to them.
"""

from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

from kittum.core import Id, Record
from kittum.people import members
from kittum.protocol import Stage
from kittum.screening import store
from kittum.screening.metrics import RecordOutcome, record_outcomes
from kittum.screening.types import NotAssigned, Outcome, RecordFacts, Reveal

if TYPE_CHECKING:
    from kittum.db import Tx

type AssignmentState = Literal["pending", "awaiting_final", "decided"]
type ItemFlag = Literal["sentinel", "audit", "rescreen"]


class TableDecision(Record):
    """One human's decision on a row: the reviewer's own, or, for the lead, each screener's and
    the auditor's. `state` says whether it is final yet."""

    reviewer_id: Id | None = None
    """Who decided. Empty in a reviewer's own rows."""
    name: str | None = None
    role: Literal["screener", "auditor"] | None = None
    state: AssignmentState
    outcome: Outcome | None = None
    reason_criterion_id: str | None = None
    comment: str | None = None
    decided_at: datetime | None = None


class TableRow(Record):
    ref: str
    """The row's stable reference: the assignment ID in a reviewer's table, the item reference
    (the corpus report ID) in the lead's."""
    assignment_id: Id | None = None
    """The reviewer's assignment, to decide it from the table. Empty for the lead."""
    etag: str | None = None
    position: int | None = None
    """The row's place in the reviewer's queue, from 1. The table's own sort never changes it."""
    title: str
    abstract: str
    authors: tuple[str, ...]
    journal: str | None
    year: int | None
    publication_types: tuple[str, ...]
    pmid: str | None
    doi: str | None
    registry_ids: tuple[str, ...]
    decisions: tuple[TableDecision, ...]
    """The reviewer's own decision (one entry), or every assignment's for the lead."""
    reveal: Reveal | None = None
    """The AI reading the reviewer's own provisional decision revealed. Reviewer's table only."""
    outcome: RecordOutcome = None
    """The record's outcome, for the lead: by consensus or adjudication, or in conflict."""
    outcome_reason: str | None = None
    """The criterion an excluded record fails: the adjudicator's, or the screeners' reasons."""
    ai_excludes: bool | None = None
    """The AI's verified reading, for the lead."""
    ai_not_met: tuple[str, ...] = ()
    """Criteria the AI's verified reading answered `not_met`, for the lead."""
    flags: tuple[ItemFlag, ...] = ()
    """Sentinel, audit sample, or extra screen. Lead's table only."""


class ScreeningTable(Record):
    stage_id: Id
    scope_id: str
    stage: Stage
    view: Literal["reviewer", "lead"]
    rows: tuple[TableRow, ...]


def _facts(row: dict[str, Any]) -> dict[str, Any]:
    facts = RecordFacts.model_validate(row["facts"])
    return {
        "title": row["title"],
        "abstract": row["text"],
        "authors": facts.authors,
        "journal": facts.journal,
        "year": facts.year,
        "publication_types": facts.publication_types,
        "pmid": facts.pmid,
        "doi": facts.doi,
        "registry_ids": facts.registry_ids,
    }


def screening_table(
    tx: Tx,
    project_id: Id,
    viewer_id: Id,
    scope_id: str,
    stage: Stage,
    *,
    topic_id: str | None = None,
) -> ScreeningTable:
    """The stage as the viewer may see it: a screener's or auditor's own rows in queue order, or
    every item for the methods lead. Raises `NotAssigned` for anyone else."""
    row = store.find_stage(tx, project_id, scope_id, stage, topic_id)
    if viewer_id in row["screeners"] or viewer_id == row["auditor_id"]:
        rows = _reviewer_rows(tx, row["id"], viewer_id)
        view: Literal["reviewer", "lead"] = "reviewer"
    elif store.sees_lead_data(tx, project_id, viewer_id):
        rows = _lead_rows(tx, project_id, row)
        view = "lead"
    else:
        raise NotAssigned(
            f"actor {viewer_id} neither screens this stage nor is a methods lead who sees it"
        )
    return ScreeningTable(
        stage_id=row["id"], scope_id=scope_id, stage=stage, view=view, rows=tuple(rows)
    )


def _reviewer_rows(tx: Tx, stage_id: Id, reviewer_id: Id) -> list[TableRow]:
    rows = tx.execute(
        "select * from screening_reviewer_table(%s, %s) order by position",
        (stage_id, reviewer_id),
    ).fetchall()
    return [
        TableRow(
            ref=str(r["assignment_id"]),
            assignment_id=r["assignment_id"],
            etag=r["etag"],
            position=r["position"],
            **_facts(r),
            decisions=(
                TableDecision(
                    state=r["state"],
                    outcome=r["outcome"],
                    reason_criterion_id=r["reason_criterion_id"],
                    comment=r["comment"],
                    decided_at=r["decided_at"],
                ),
            ),
            reveal=Reveal.model_validate(r["own_reveal"]) if r["own_reveal"] else None,
        )
        for r in rows
    ]


def _lead_rows(tx: Tx, project_id: Id, stage: dict[str, Any]) -> list[TableRow]:
    stage_id = stage["id"]
    names = {m.actor_id: m.display_name for m in members(tx, project_id)}
    outcomes = record_outcomes(tx, stage)
    by_item: dict[str, list[TableDecision]] = {}
    for a in tx.execute(
        "select a.item_ref, a.reviewer_id, a.role, a.state, d.outcome, d.reason_criterion_id,"
        " d.comment, d.decided_at"
        " from screening_assignment a"
        " left join screening_decision d"
        " on d.id = coalesce(a.final_decision_id, a.provisional_decision_id)"
        " where a.stage_id = %s order by a.role desc, a.reviewer_id",
        (stage_id,),
    ).fetchall():
        by_item.setdefault(a["item_ref"], []).append(
            TableDecision(
                reviewer_id=a["reviewer_id"],
                name=names.get(a["reviewer_id"]),
                role=a["role"],
                state=a["state"],
                outcome=a["outcome"],
                reason_criterion_id=a["reason_criterion_id"],
                comment=a["comment"],
                decided_at=a["decided_at"],
            )
        )
    adjudicated = {
        r["item_ref"]: r["reason_criterion_id"]
        for r in tx.execute(
            "select distinct on (c.item_ref) c.item_ref, j.reason_criterion_id"
            " from screening_conflict c join screening_adjudication j on j.conflict_id = c.id"
            " where c.stage_id = %s and c.state = 'resolved'"
            " order by c.item_ref, c.opened_at desc, c.id desc",
            (stage_id,),
        ).fetchall()
    }
    items = tx.execute(
        "select i.item_ref, i.kind, i.audit, i.rescreen, i.title, i.text, i.facts,"
        " r.excludes, r.criteria, r.rank"
        " from screening_item i left join screening_ai_reading r"
        " on r.stage_id = i.stage_id and r.item_ref = i.item_ref"
        " where i.stage_id = %s and i.withdrawn_event_id is null"
        " order by i.kind, r.rank nulls last, i.item_ref",
        (stage_id,),
    ).fetchall()
    out = []
    for i in items:
        ref = i["item_ref"]
        decisions = tuple(by_item.get(ref, ()))
        outcome = outcomes.get(ref)
        flags: list[ItemFlag] = []
        if i["kind"] == "sentinel":
            flags.append("sentinel")
        if i["audit"]:
            flags.append("audit")
        if i["rescreen"]:
            flags.append("rescreen")
        out.append(
            TableRow(
                ref=ref,
                **_facts(i),
                decisions=decisions,
                outcome=outcome,
                outcome_reason=_outcome_reason(outcome, adjudicated.get(ref), decisions),
                ai_excludes=i["excludes"],
                ai_not_met=tuple(
                    c["criterion_id"] for c in i["criteria"] or () if c["status"] == "not_met"
                ),
                flags=tuple(flags),
            )
        )
    return out


def _outcome_reason(
    outcome: RecordOutcome, adjudicated: str | None, decisions: tuple[TableDecision, ...]
) -> str | None:
    if outcome != "exclude":
        return None
    if adjudicated is not None:
        return adjudicated
    reasons = dict.fromkeys(
        d.reason_criterion_id
        for d in decisions
        if d.role == "screener" and d.state == "decided" and d.reason_criterion_id
    )
    return ", ".join(reasons) or None


__all__ = ["ScreeningTable", "TableDecision", "TableRow", "screening_table"]
