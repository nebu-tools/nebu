"""The screening table (DESIGN.md, "Reviewer workbench"): one row per record of a stage, for a
spreadsheet-like view and the working export.

A screener or auditor gets their own assignments only, read through `screening_reviewer_table`,
which returns no other reviewer's rows, no AI reading their own provisional decision did not
reveal, no sentinel or audit flags, and no item reference: a reviewer's rows are named by their
assignment IDs. The methods lead (`sees_lead_data`) gets every item of the stage with every
human decision, the outcome, the AI's verified reading, and the item's flags. Anyone else, an
adjudicator who does not screen included, is not assigned: the table lists records, and an
adjudicator only ever sees the conflicts put to them.

Each row says what the AI proposes (`rules.proposal`) where the viewer may see the AI's reading:
the lead always, a reviewer where the stage shows the reading before the decision. In a topic
with working documentation an unverified `not_met` is a proposal too, marked so. The topic's
known includes (its reference set) are marked for the lead and in working topics, and the table
says how many of them, and of the topic's known pool, the AI proposes to exclude: a warning,
not a block. A complete topic's
reviewer never learns which records are known includes, as they are what sentinels are made of.
"""

import unicodedata
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal

from kittum.core import Id, Record
from kittum.corpus import known_pool_refs, latest_revision, reports
from kittum.judge import CriterionVerdict
from kittum.people import members
from kittum.protocol import (
    DocumentationLevel,
    ScreeningMode,
    Stage,
    documentation_level,
    get_version,
)
from kittum.screening import store
from kittum.screening.metrics import RecordOutcome, record_outcomes
from kittum.screening.rules import Reading, known_include_refs, proposal, topic_for
from kittum.screening.service import _ai_before
from kittum.screening.types import (
    AiColumn,
    AiProposal,
    KnownIncludes,
    NotAssigned,
    Outcome,
    RecordFacts,
    Reveal,
    SecondOpinionContext,
)

if TYPE_CHECKING:
    from kittum.db import Tx

type AssignmentState = Literal["pending", "awaiting_final", "decided"]
type ItemFlag = Literal["sentinel", "audit", "rescreen"]


class TableDecision(Record):
    """One human's decision on a row: the reviewer's own, or, for the lead, each screener's, the
    auditor's, and a second opinion's. `state` says whether it is final yet."""

    reviewer_id: Id | None = None
    """Who decided. Empty in a reviewer's own rows."""
    name: str | None = None
    role: Literal["screener", "auditor", "second_opinion"] | None = None
    state: AssignmentState
    outcome: Outcome | None = None
    reason_criterion_id: str | None = None
    comment: str | None = None
    decided_at: datetime | None = None
    second_opinion: bool = False
    """Mode S: the decision asks another screener of the pool for a second opinion."""


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
    ai: AiColumn | None = None
    """The AI's reading before the decision, in a stage that reveals `before`, once the AI has
    read the record. Reviewer's table only; empty in every other stage."""
    second_opinion: SecondOpinionContext | None = None
    """Mode S: this row is a second opinion, asked on this decision. Reviewer's table only."""
    outcome: RecordOutcome = None
    """The record's outcome, for the lead: by consensus or adjudication, or in conflict."""
    outcome_reason: str | None = None
    """The criterion an excluded record fails: the adjudicator's, or the screeners' reasons."""
    ai_excludes: bool | None = None
    """The AI's verified reading, for the lead."""
    ai_not_met: tuple[str, ...] = ()
    """Criteria the AI's verified reading answered `not_met`, for the lead."""
    ai_unclear: tuple[str, ...] = ()
    """Criteria the AI's verified reading answered `unclear`, for the lead: an include the AI
    proposes with one of these is not a clear include."""
    flags: tuple[ItemFlag, ...] = ()
    """Sentinel, audit sample, or extra screen. Lead's table only."""
    in_known_pool: bool | None = None
    """The record is a paper of the topic's known pool. Empty when the topic has no pool, and in
    a reviewer's table of a complete-documentation topic, which screens blind to the pool."""
    ai_proposal: AiProposal | None = None
    """What the AI proposes: for the lead, and in a reviewer's table where `ai` is shown."""
    ai_protocol_hash: str | None = None
    """The protocol version the AI's reading was made under, for the lead: after a re-judge,
    rows still on the old version are waiting for their new reading."""
    known_include: bool = False
    """One of the topic's known includes. For the lead, and in topics with working
    documentation."""


class ScreeningTable(Record):
    stage_id: Id
    scope_id: str
    stage: Stage
    view: Literal["reviewer", "lead"]
    documentation: DocumentationLevel
    reveal: str
    protocol_hash: str
    """The protocol version the stage reads with now; a re-judge moves it."""
    protocol_version_label: str | None = None
    """That version's label ("1.0"), so the lead's table can say which version the AI read."""
    rows: tuple[TableRow, ...]
    known_includes: KnownIncludes | None = None
    """How many known includes the rows hold and how many the AI proposes to exclude, where the
    viewer may see both."""


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
    documentation = documentation_level(ScreeningMode(row["mode"]))
    if viewer_id in row["screeners"] or viewer_id == row["auditor_id"]:
        rows = _reviewer_rows(tx, row["id"], viewer_id, documentation)
        view: Literal["reviewer", "lead"] = "reviewer"
    elif store.sees_lead_data(tx, project_id, viewer_id):
        rows = _lead_rows(tx, project_id, row, documentation)
        view = "lead"
    else:
        raise NotAssigned(
            f"actor {viewer_id} neither screens this stage nor is a methods lead who sees it"
        )
    spelled = _spelled_authors(tx, project_id)
    rows = [_respelled(r, spelled.get(r.ref)) for r in rows]
    # Known includes: the topic's reference set and its known pool (the papers the team has).
    shown = view == "lead" or documentation == "working"
    pool = known_pool_refs(tx, project_id, row["topic_id"]) if shown else None
    known_includes = None
    protocol = get_version(tx, project_id, row["protocol_version_id"]).version.protocol
    if shown:
        topic = topic_for(protocol, row["scope_id"], row["topic_id"])
        known = known_include_refs(topic.reference_set, {r.ref: r.facts for r in rows})
        pooled = {r.ref for r in rows if pool is not None and r.ref in pool}
        rows = [
            r.row.model_copy(
                update={
                    "known_include": r.ref in known,
                    **({"in_known_pool": r.ref in pooled} if pool is not None else {}),
                }
            )
            for r in rows
        ]
        marked = [r for r in rows if r.known_include or r.in_known_pool]
        if marked:
            known_includes = KnownIncludes(
                known=len(marked),
                read=sum(r.ai_proposal is not None for r in marked),
                proposed_exclude=sum(
                    r.ai_proposal is not None and r.ai_proposal.outcome == "exclude" for r in marked
                ),
            )
    else:
        rows = [r.row for r in rows]
    return ScreeningTable(
        stage_id=row["id"],
        scope_id=scope_id,
        stage=stage,
        view=view,
        documentation=documentation,
        reveal=row["reveal"],
        protocol_hash=row["protocol_hash"],
        protocol_version_label=protocol.version_label,
        rows=tuple(rows),
        known_includes=known_includes,
    )


@dataclass(frozen=True)
class _Row:
    ref: str  # the item reference, kept on the server
    facts: RecordFacts
    row: TableRow


def _folded(authors: tuple[str, ...]) -> tuple[str, ...]:
    """Author names without accents or case, to tell one spelling of a list from another."""
    return tuple(
        "".join(c for c in unicodedata.normalize("NFKD", a) if not unicodedata.combining(c))
        .casefold()
        .strip()
        for a in authors
    )


def _spelled_authors(tx: Tx, project_id: Id) -> dict[str, tuple[str, ...]]:
    """Each report's author list as its records spell it with the most accents ("López-Durán"
    where one export wrote "Lopez-Duran"), as the corpus and studies screens show it."""
    revision = latest_revision(tx, project_id)
    if revision is None:
        return {}
    out: dict[str, tuple[str, ...]] = {}
    for report in reports(tx, project_id, revision.id):
        lists = [tuple(r.authors) for r in report.records if r.authors]
        if lists:
            out[str(report.report_id)] = max(
                lists, key=lambda a: sum(not c.isascii() for c in "".join(a))
            )
    return out


def _respelled(row: _Row, spelled: tuple[str, ...] | None) -> _Row:
    """The row with the accented spelling of its authors, where it names the same people."""
    if not spelled or tuple(row.row.authors) == spelled:
        return row
    if _folded(tuple(row.row.authors)) != _folded(spelled):
        return row
    return _Row(row.ref, row.facts, row.row.model_copy(update={"authors": spelled}))


def _reading(raw: dict[str, Any] | None, flags: list[str] | None = None) -> Reading | None:
    if raw is None:
        return None
    return Reading(
        excludes=raw["excludes"],
        criteria=tuple(CriterionVerdict.model_validate(c) for c in raw["criteria"]),
        flags=tuple(flags if flags is not None else raw.get("flags") or ()),
    )


def _reviewer_rows(
    tx: Tx, stage_id: Id, reviewer_id: Id, documentation: DocumentationLevel
) -> list[_Row]:
    rows = tx.execute(
        # The item reference and the reading's flags stay on the server: the flags only keep a
        # record that tried to instruct the model from having a proposal.
        "select t.*, a.item_ref, r.flags as ai_flags from screening_reviewer_table(%s, %s) t"
        " join screening_assignment a on a.id = t.assignment_id"
        " left join screening_ai_reading r on r.stage_id = a.stage_id and r.item_ref = a.item_ref"
        " order by t.position",
        (stage_id, reviewer_id),
    ).fetchall()
    return [
        _Row(
            r["item_ref"],
            RecordFacts.model_validate(r["facts"]),
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
                        second_opinion=r["asked_second_opinion"],
                    ),
                ),
                reveal=Reveal.model_validate(r["own_reveal"]) if r["own_reveal"] else None,
                ai=_ai_before(r["ai_before"], r["title"], r["text"]),
                second_opinion=SecondOpinionContext.model_validate(r["consult"])
                if r["consult"]
                else None,
                ai_proposal=proposal(_reading(r["ai_before"], r["ai_flags"] or []), documentation),
            ),
        )
        for r in rows
    ]


def _lead_rows(
    tx: Tx, project_id: Id, stage: dict[str, Any], documentation: DocumentationLevel
) -> list[_Row]:
    stage_id = stage["id"]
    names = {m.actor_id: m.display_name for m in members(tx, project_id)}
    outcomes = record_outcomes(tx, stage)
    by_item: dict[str, list[TableDecision]] = {}
    for a in tx.execute(
        "select a.item_ref, a.reviewer_id, a.role, a.state, d.outcome, d.reason_criterion_id,"
        " d.comment, d.decided_at, coalesce(d.second_opinion, false) as second_opinion"
        " from screening_assignment a"
        " left join screening_decision d"
        " on d.id = coalesce(a.final_decision_id, a.provisional_decision_id)"
        # A second opinion whose request was taken back is not part of the record any more.
        " where a.stage_id = %s"
        " and (a.role <> 'second_opinion' or a.consults_decision_id is not null)"
        " order by case a.role when 'screener' then 0 when 'second_opinion' then 1 else 2 end,"
        " a.reviewer_id",
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
                second_opinion=a["second_opinion"],
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
        " r.excludes, r.criteria, r.rank, r.flags, r.protocol_hash as ai_protocol_hash"
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
            _Row(
                ref,
                RecordFacts.model_validate(i["facts"]),
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
                    ai_unclear=tuple(
                        c["criterion_id"] for c in i["criteria"] or () if c["status"] == "unclear"
                    ),
                    flags=tuple(flags),
                    ai_proposal=proposal(
                        _reading(i, i["flags"]) if i["criteria"] is not None else None,
                        documentation,
                    ),
                    ai_protocol_hash=i["ai_protocol_hash"],
                ),
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
    # Mode S: a second opinion settles the record.
    settled = [d for d in decisions if d.role == "second_opinion" and d.state == "decided"]
    if settled:
        return settled[-1].reason_criterion_id
    reasons = dict.fromkeys(
        d.reason_criterion_id
        for d in decisions
        if d.role == "screener" and d.state == "decided" and d.reason_criterion_id
    )
    return ", ".join(reasons) or None


__all__ = ["ScreeningTable", "TableDecision", "TableRow", "screening_table"]
