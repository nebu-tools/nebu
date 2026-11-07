"""Mode S, a targeted search with working documentation: a pool of screeners shares the records,
a second opinion settles an unsure decision, the queue does not wait for the AI judge, and a stage
may show the AI's reading before the decision. Complete topics refuse what only S allows."""

from typing import TYPE_CHECKING

import pytest

from kittum.core import new_id
from kittum.report import load_review, render_files, trace
from kittum.screening import (
    SECOND_OPINION_REQUESTED,
    Decision,
    InvalidDecision,
    StageSpec,
)
from tests.screening.support import (
    CONFIG,
    JUDGE_MARK,
    SCOPE,
    STAGE,
    build_world,
    recorded_backend,
    timing,
)

if TYPE_CHECKING:
    from kittum.core import Id
    from kittum.db import Database
    from kittum.screening import DecideResult, QueueItem, StageInfo
    from tests.screening.support import World

pytestmark = pytest.mark.postgres


def open_s(world: World, pool: tuple[Id, ...], reveal: str = "before") -> StageInfo:
    """Open the S stage and enqueue the judge, without running it."""
    with world.db.transaction() as tx:
        info = world.screening.open_stage(
            tx,
            command_id=new_id(),
            project_id=world.project_id,
            actor_id=world.people.lead,
            spec=StageSpec(
                protocol_version_id=world.protocol.id,
                scope_id=SCOPE,
                stage=STAGE,
                records=tuple(world.records),
                screeners=pool,
                reveal=reveal,  # type: ignore[arg-type]
                judge_config_id=CONFIG.id,
            ),
        )
        world.screening.request_judging(
            tx,
            command_id=new_id(),
            project_id=world.project_id,
            actor_id=world.people.lead,
            stage_id=info.stage_id,
        )
    return info


def queue(world: World, reviewer: Id) -> list[QueueItem]:
    return world.screening_queue(reviewer)


def decide(
    world: World,
    reviewer: Id,
    item: QueueItem,
    decision: Decision,
    *,
    ai_on_screen: bool = False,
) -> DecideResult:
    with world.db.transaction() as tx:
        return world.screening.decide(
            tx,
            command_id=new_id(),
            project_id=world.project_id,
            reviewer_id=reviewer,
            assignment_id=item.assignment_id,
            decision=decision,
            phase="provisional",
            expected_etag=item.etag,
            timing=timing(0, revealed=ai_on_screen),
        )


def undo(world: World, reviewer: Id, item: QueueItem, etag: str) -> None:
    with world.db.transaction() as tx:
        world.screening.undo(
            tx,
            command_id=new_id(),
            project_id=world.project_id,
            reviewer_id=reviewer,
            assignment_id=item.assignment_id,
            expected_etag=etag,
        )


def outcome_of(world: World, ref: str) -> str | None:
    with world.db.transaction() as tx:
        return world.screening.outcomes(tx, world.project_id, SCOPE, STAGE)[ref]


def ref_of(world: World, item: QueueItem) -> str:
    (found,) = [r.item_ref for r in world.records if r.title == item.title]
    return found


INCLUDE = Decision(outcome="include")
UNSURE = Decision(
    outcome="include", comment="Smokers? The abstract never says.", second_opinion=True
)


def test_s_splits_the_pool_and_a_second_opinion_settles_the_record(database: Database) -> None:
    world = build_world(database, "S")
    a, b, lead = world.people.a, world.people.b, world.people.lead
    stage = open_s(world, (a, b))
    assert stage.mode == "S" and stage.documentation == "working" and stage.auditor_id is None

    # The judge has not run, and the queues are full anyway: one screener per record, split
    # evenly, no record twice. Nothing of the AI yet.
    first_a, first_b = queue(world, a), queue(world, b)
    assert abs(len(first_a) - len(first_b)) <= 1
    assert len(first_a) + len(first_b) == len(world.records)
    assert not {i.title for i in first_a} & {i.title for i in first_b}
    assert all(i.ai is None and i.second_opinion is None for i in first_a + first_b)

    # A decides a record the AI has not read: it stands at once, nothing to reveal.
    early = first_a[0]
    result = decide(world, a, early, INCLUDE)
    assert result.phase == "final" and result.reveal is None
    assert outcome_of(world, ref_of(world, early)) == "include"

    # Once the judge has read the records, the stage shows its reading before the decision.
    world.backend = recorded_backend(world.records, world.criteria())
    world.run_judge_jobs(world.backend)
    items = queue(world, a)
    assert items and all(i.ai is not None for i in items)
    assert any(JUDGE_MARK in c.rationale for i in items for c in i.ai.criteria if i.ai)

    # A is unsure about one and asks a second opinion, with the AI's reading on screen.
    unsure = items[0]
    ref = ref_of(world, unsure)
    result = decide(world, a, unsure, UNSURE, ai_on_screen=True)
    assert result.phase == "final" and result.reveal is None  # `before` shows nothing after
    assert outcome_of(world, ref) is None  # the record waits for the second opinion

    # B gets it first in their queue, with A's decision and comment: a consult, not blind.
    consult = queue(world, b)[0]
    assert consult.title == unsure.title
    assert consult.second_opinion is not None
    assert consult.second_opinion.outcome == "include"
    assert consult.second_opinion.comment == "Smokers? The abstract never says."
    with database.transaction() as tx:
        status = world.screening.status(tx, world.project_id, lead, SCOPE, STAGE)
        event = tx.execute(
            "select payload from audit_event where project_id = %s and type = %s",
            (world.project_id, SECOND_OPINION_REQUESTED),
        ).fetchone()
    assert status.metrics is not None and status.metrics.second_opinions is not None
    assert status.metrics.second_opinions.requested == 1
    assert status.metrics.second_opinions.pending == 1
    assert status.metrics.ai_shown_before == 1
    assert status.metrics.documentation == "working"
    assert not [p for p in status.metrics.agreement if p.kind == "human_human"]
    assert event is not None and event["payload"]["reviewer_id"] == str(b)

    # A takes the decision back before B answered: the request goes with it, and comes back.
    with database.transaction() as tx:
        etag = tx.execute(
            "select etag from screening_assignment where id = %s", (unsure.assignment_id,)
        ).fetchone()
    assert etag is not None
    undo(world, a, unsure, etag["etag"])
    assert not [i for i in queue(world, b) if i.second_opinion is not None]
    again = next(i for i in queue(world, a) if i.title == unsure.title)
    decide(world, a, again, UNSURE, ai_on_screen=True)
    consult = queue(world, b)[0]
    assert consult.second_opinion is not None

    # A second opinion cannot ask for another; B's exclusion settles the record.
    with pytest.raises(InvalidDecision, match="settles the record"):
        decide(world, b, consult, UNSURE)
    excluded = Decision(outcome="exclude", reason_criterion_id="POP", comment="Not smokers.")
    decide(world, b, consult, excluded)
    assert outcome_of(world, ref) == "exclude"
    # The audit trail says the second opinion saw the first decision; it never calls it blind.
    with database.transaction() as tx:
        events = trace(tx, world.project_id, ref, store=world.artifacts).events
    (second,) = [e for e in events if "as a second opinion" in e.summary]
    assert "blind" not in second.summary.lower()
    assert ("Decision", "After the first decision, before any AI output") in [
        (f.label, f.value) for f in second.facts
    ]

    # Now A cannot take back the request.
    with database.transaction() as tx:
        etag = tx.execute(
            "select etag from screening_assignment where id = %s", (again.assignment_id,)
        ).fetchone()
    assert etag is not None
    with pytest.raises(InvalidDecision, match="answered your request"):
        undo(world, a, again, etag["etag"])

    with database.transaction() as tx:
        metrics = world.screening.status(tx, world.project_id, lead, SCOPE, STAGE).metrics
        review = load_review(tx, world.project_id, store=world.artifacts)
    assert metrics is not None and metrics.second_opinions is not None
    assert metrics.second_opinions.model_dump() == {
        "requested": 1,
        "pending": 0,
        "changed": 1,
        "kept": 0,
    }

    # The report replays the ledger to the same outcome and says what happened, in words that
    # come from the settings and the counts.
    (result_stage,) = review.stages
    assert result_stage.documentation == "working"
    item = next(i for i in result_stage.records if i.item_ref == ref)
    assert item.outcome == "exclude" and item.screened and item.second_opinion is not None
    assert result_stage.second_opinions == metrics.second_opinions
    files = {f.path: f.data.decode() for f in render_files(review, "ai_disclosure")}
    text = files["ai_disclosure.md"]
    assert "working documentation (mode S)" in text
    assert "not independent" in text
    assert "Second opinions asked: 1." in text
    assert "1 decision was made with it on screen" in text
    assert "No audit (mode S)" in text
    assert "In topics with complete documentation" not in text


def test_complete_topics_refuse_what_only_working_topics_allow(database: Database) -> None:
    m1 = build_world(database, "M1")
    with pytest.raises(InvalidDecision, match="working documentation"):
        m1.open(reveal="before")
    m1.open()
    with pytest.raises(InvalidDecision, match="Only mode S"):
        decide(m1, m1.people.a, queue(m1, m1.people.a)[0], UNSURE)

    s = build_world(database, "S")
    with s.db.transaction() as tx, pytest.raises(InvalidDecision, match="no auditor"):
        s.screening.open_stage(
            tx,
            command_id=new_id(),
            project_id=s.project_id,
            actor_id=s.people.lead,
            spec=StageSpec(
                protocol_version_id=s.protocol.id,
                scope_id=SCOPE,
                stage=STAGE,
                records=tuple(s.records),
                screeners=(s.people.a,),
                auditor_id=s.people.auditor,
                judge_config_id=CONFIG.id,
            ),
        )
    # A pool of one: everything goes to A, and nobody is there to ask.
    open_s(s, (s.people.a,), reveal="on_disagreement")
    items = queue(s, s.people.a)
    assert len(items) == len(s.records) and not queue(s, s.people.b)
    with pytest.raises(InvalidDecision, match="Nobody else"):
        decide(s, s.people.a, items[0], UNSURE)
