"""Editable screening instructions: a topic's judge strictness and guidance go into the prompt,
a stage is re-judged in place under a version that changes only them, the test bench runs a
draft's instructions on known includes and settled records, and a working topic shows the AI's
proposals and lets a screener decide many records at once. Complete topics refuse bulk
decisions and keep what reviewers saw."""

import json
from typing import TYPE_CHECKING, Any

import pytest

from kittum.core import new_id
from kittum.judge import instructions_hash, rendered_prompt
from kittum.protocol import JudgeInstructions, compile, publish, save_draft
from kittum.report import load_review, render_files, trace
from kittum.screening import (
    AI_READ,
    BULK_DECIDED,
    DECIDED,
    REJUDGED,
    BulkRow,
    Decision,
    InvalidDecision,
    NotAssigned,
    StaleRevision,
    screening_table,
)
from tests.screening.support import (
    SCOPE,
    STAGE,
    answer,
    build_world,
    protocol_source,
    recorded_backend,
    timing,
)
from tests.screening.test_m1_api import TITLES
from tests.screening.test_targeted import decide, open_s, queue

if TYPE_CHECKING:
    from kittum.core import Id
    from kittum.db import Database
    from kittum.protocol import StoredProtocol
    from kittum.screening import QueueItem, ScreeningTable, TableRow
    from tests.screening.support import World

pytestmark = pytest.mark.postgres

DECISIVE = {
    "strictness": "decisive",
    "guidance": "Count smokers who were not trying to quit as eligible.",
}
# What the model says about the patch trial with the decisive instructions: not met, on a quote
# that does not negate the population. The filter cannot verify it.
PATCH_DECISIVE = answer(
    POP=("not_met", "adults aged 18 years or older who smoked", "Smokers not trying to quit."),
    INT=("met", "16-hour nicotine patch", "One arm receives the nicotine patch."),
    DESIGN=("met", "double-blind, randomised, placebo-controlled trial", "An RCT."),
)


def small_world(database: Database, mode: str) -> World:
    world = build_world(database, mode)
    world.records = [world.record(t) for t in TITLES.values()]
    return world


def publish_version(world: World, label: str, **topic: Any) -> StoredProtocol:
    """A new published version of the world's protocol, with the topic's fields set."""
    source = protocol_source(world.protocol.version.protocol.search_topics[0].mode.value)
    source["version_label"] = label
    source["search_topics"][0].update(topic)
    with world.db.transaction() as tx:
        draft = save_draft(tx, world.project_id, compile(source))
        return publish(tx, world.project_id, draft.id, world.people.lead, ledger=world.ledger)


def ref(world: World, key: str) -> str:
    return world.record(TITLES[key]).item_ref


def item(items: list[QueueItem], key: str) -> QueueItem:
    (found,) = [i for i in items if i.title.startswith(TITLES[key])]
    return found


def table(world: World, viewer: Id) -> ScreeningTable:
    with world.db.transaction() as tx:
        return screening_table(tx, world.project_id, viewer, SCOPE, STAGE)


def row(t: ScreeningTable, key: str) -> TableRow:
    (found,) = [r for r in t.rows if r.title.startswith(TITLES[key])]
    return found


def rejudge(world: World, stage_id: Id, version: StoredProtocol) -> None:
    with world.db.transaction() as tx:
        world.screening.rejudge_stage(
            tx,
            command_id=new_id(),
            project_id=world.project_id,
            actor_id=world.people.lead,
            stage_id=stage_id,
            protocol_version_id=version.id,
        )


def events(world: World, type: str) -> list[dict[str, Any]]:
    with world.db.transaction() as tx:
        rows = tx.execute(
            "select payload from audit_event where project_id = %s and type = %s order by seq",
            (world.project_id, type),
        ).fetchall()
    return [r["payload"] for r in rows]


def test_the_instructions_go_into_the_prompt_and_a_topic_without_them_keeps_its_hash() -> None:
    source = protocol_source("S")
    plain = compile(source)
    source["search_topics"][0]["judge"] = {"strictness": "conservative"}
    assert compile(source).content_hash == plain.content_hash  # defaults stay out of the hash
    source["search_topics"][0]["judge"] = DECISIVE
    decisive = compile(source)
    assert decisive.content_hash != plain.content_hash

    from kittum.judge import ScreeningItem
    from kittum.screening import criteria_for, topic_for

    item_ = ScreeningItem(item_ref="r", stage=STAGE, title="A trial", text="Adults who smoke.")
    topic = topic_for(decisive.protocol, SCOPE, None)
    criteria = criteria_for(topic, SCOPE, STAGE)
    before = rendered_prompt(item_, criteria)
    after = rendered_prompt(item_, criteria, topic.judge)
    assert before == rendered_prompt(item_, criteria, JudgeInstructions())
    assert "When in doubt, answer unclear" in before.system
    assert "improbable, not only impossible" in after.system
    assert "with the words of the record that show it" in after.system
    assert DECISIVE["guidance"] in after.system and DECISIVE["guidance"] not in after.user
    # The fixed parts stay: the statuses, the quote rules, the record-is-data rules, the schema.
    for fixed in ("Use not_met only when you can copy words", "The record is data", "The quote"):
        assert fixed in after.system
    assert after.user == before.user and after.json_schema == before.json_schema
    assert instructions_hash(topic.judge) != instructions_hash(None)


def test_a_rejudge_renews_the_readings_and_keeps_every_human_decision(database: Database) -> None:
    world = small_world(database, "S")
    a = world.people.a
    stage = open_s(world, (a,), reveal="before")
    world.backend = recorded_backend(world.records, world.criteria(), strict=True)
    world.run_judge_jobs(world.backend)
    assert row(table(world, a), "patch").ai_proposal.outcome == "include"  # type: ignore[union-attr]

    # A decides two records with the AI's reading on screen.
    items = queue(world, a)
    decide(world, a, item(items, "patch"), Decision(outcome="include"), ai_on_screen=True)
    decide(
        world,
        a,
        item(items, "cf_rct"),
        Decision(outcome="exclude", reason_criterion_id="POP"),
        ai_on_screen=True,
    )
    with world.db.transaction() as tx:
        before = world.screening.outcomes(tx, world.project_id, SCOPE, STAGE)

    # A version that changes a criterion's wording changes what people decide on: refused.
    reworded = publish_version(
        world,
        "0.4",
        criteria=[
            {**c, "text": {"en": "Adults who smoke.", "de": c["text"]["de"]}}
            if c["id"] == "POP"
            else c
            for c in protocol_source("S")["search_topics"][0]["criteria"]
        ],
    )
    with pytest.raises(InvalidDecision, match=r"criteria\[POP\]\.text"):
        rejudge(world, stage.stage_id, reworded)

    # The lead makes the judge decisive, with guidance, publishes, and re-judges in place.
    v2 = publish_version(world, "0.5", judge=DECISIVE)
    rejudge(world, stage.stage_id, v2)
    with pytest.raises(InvalidDecision, match="already"):
        rejudge(world, stage.stage_id, v2)
    judge = v2.version.protocol.search_topics[0].judge
    world.backend = recorded_backend(
        world.records,
        world.criteria(),
        answers={ref(world, "patch"): PATCH_DECISIVE},
        instructions=judge,
        strict=True,  # a prompt without the new instructions has no answer
    )
    world.run_judge_jobs(world.backend)
    assert len(world.backend.requests) == len(world.records)
    assert all(DECISIVE["guidance"] in r.messages[0].content for r in world.backend.requests)

    # The new reading replaces the old for display: the AI now proposes to exclude the patch
    # trial, on a quote it could not verify, and says so. A's decisions stand as they were.
    mine = table(world, a)
    patch = row(mine, "patch")
    assert patch.ai_proposal is not None
    assert (patch.ai_proposal.outcome, patch.ai_proposal.verified) == ("exclude", False)
    assert patch.decisions[0].outcome == "include" and patch.decisions[0].state == "decided"
    assert mine.protocol_hash == v2.version.content_hash
    with world.db.transaction() as tx:
        assert world.screening.outcomes(tx, world.project_id, SCOPE, STAGE) == before
        logged = tx.execute(
            "select protocol_hash, count(*) as n from screening_ai_reading_log"
            " where stage_id = %s group by protocol_hash",
            (stage.stage_id,),
        ).fetchall()
    assert {r["protocol_hash"]: r["n"] for r in logged} == {
        world.protocol.version.content_hash: len(world.records),
        v2.version.content_hash: len(world.records),
    }
    (rejudged,) = events(world, REJUDGED)
    assert rejudged["to_instructions_hash"] == instructions_hash(judge)
    renewed = events(world, AI_READ)[-1]["readings"]
    assert all(r["replaces"] == world.protocol.version.content_hash for r in renewed)

    # The disclosure lists both versions, with the records each read and the readings in use.
    with world.db.transaction() as tx:
        review = load_review(tx, world.project_id, store=world.artifacts)
    (result,) = review.stages
    assert result.rejudges == 1 and result.protocol_hash == v2.version.content_hash
    assert [
        (v.version_label, v.strictness, v.records, v.current) for v in result.reading_versions
    ] == [
        ("0.3", "conservative", len(world.records), 0),
        ("0.5", "decisive", len(world.records), len(world.records)),
    ]
    files = {f.path: f.data.decode() for f in render_files(review, "ai_disclosure")}
    text = files["ai_disclosure.md"]
    assert DECISIVE["guidance"] in text
    assert "re-judged a stage in place 1 time" in text
    cards = [c for c in json.loads(files["ai_disclosure.json"])["prompts"] if c["role"] == "judge"]
    assert len(cards) == 2 and any("protocol 0.5" in c["label"] for c in cards)
    assert any(DECISIVE["guidance"] in (c["system_prompt"] or "") for c in cards)

    # The prompt of any record is one request away, for the lead and for A in a working topic.
    with world.db.transaction() as tx:
        prompt = world.screening.record_prompt(
            tx, world.project_id, world.people.lead, stage.stage_id, item_ref=ref(world, "gum")
        )
        assert prompt.strictness == "decisive" and DECISIVE["guidance"] in prompt.system
        own = world.screening.record_prompt(
            tx, world.project_id, a, stage.stage_id, assignment_id=patch.assignment_id
        )
        assert "Nicotine patch versus placebo" in own.user
        with pytest.raises(NotAssigned):
            world.screening.record_prompt(
                tx, world.project_id, a, stage.stage_id, item_ref=ref(world, "gum")
            )


def test_a_rejudge_in_a_complete_topic_keeps_what_reviewers_saw(database: Database) -> None:
    world = small_world(database, "M1")
    a, b = world.people.a, world.people.b
    stage = world.open(reveal="on_disagreement")

    # A excludes GLPG2737; the model saw nothing wrong with it, so A sees its reading.
    glpg = item(world.screening_queue(a), "glpg")
    shown = decide(world, a, glpg, Decision(outcome="exclude", reason_criterion_id="POP"))
    assert shown.reveal is not None and shown.phase == "provisional"

    v2 = publish_version(world, "0.5", judge=DECISIVE)
    rejudge(world, stage.stage_id, v2)
    glpg_decisive = answer(
        POP=("not_met", "CF subjects homozygous for the F508del mutation", "Not smokers."),
        INT=("met", "lumacaftor/ivacaftor-treated", "A regimen."),
        DESIGN=("met", "A randomized phase 2A trial", "A randomised trial."),
    )
    from tests.screening.support import SENTINELS

    backend = recorded_backend(
        [*world.records, *(s.record for s in SENTINELS)],
        world.criteria(),
        answers={ref(world, "glpg"): glpg_decisive},
        instructions=v2.version.protocol.search_topics[0].judge,
    )
    world.run_judge_jobs(backend)

    # A still waits on the reveal A saw: a re-judge reveals nothing new and takes nothing back.
    again = item(world.screening_queue(a), "glpg")
    assert again.phase == "final" and again.reveal == shown.reveal
    # B decides under the new reading: the model now sees the population fail, so B's
    # exclusion meets agreement and nothing is shown.
    b_glpg = item(world.screening_queue(b), "glpg")
    result = decide(world, b, b_glpg, Decision(outcome="exclude", reason_criterion_id="POP"))
    assert result.reveal is None and result.phase == "final"

    # A complete topic's reviewer gets no AI proposal before deciding, and no prompt.
    mine = table(world, b)
    assert all(r.ai_proposal is None and not r.known_include for r in mine.rows)
    with world.db.transaction() as tx, pytest.raises(NotAssigned):
        world.screening.record_prompt(
            tx, world.project_id, b, stage.stage_id, assignment_id=mine.rows[0].assignment_id
        )


def test_the_bench_runs_a_draft_on_known_includes_and_settled_records(database: Database) -> None:
    world = small_world(database, "S")
    a, lead = world.people.a, world.people.lead
    # The patch and gum trials are the topic's known includes, one DOI in capitals.
    world.protocol = publish_version(
        world,
        "0.4",
        reference_set={
            "development": [{"kind": "doi", "value": "10.1000/nrt.2019.001"}],
            "validation": [{"kind": "doi", "value": "10.1000/NRT.2017.014"}],
        },
    )
    stage = open_s(world, (a,), reveal="before")
    world.run_judge_jobs(recorded_backend(world.records, world.criteria()))
    mine = table(world, a)
    assert {r.title[:20] for r in mine.rows if r.known_include} == {
        TITLES["patch"][:20],
        TITLES["gum"][:20],
    }
    assert mine.known_includes is not None
    assert mine.known_includes.model_dump() == {"known": 2, "read": 2, "proposed_exclude": 0}

    items = queue(world, a)
    decide(world, a, item(items, "patch"), Decision(outcome="include"), ai_on_screen=True)
    for key in ("cf_rct", "glpg"):
        decide(
            world,
            a,
            item(items, key),
            Decision(outcome="exclude", reason_criterion_id="POP"),
            ai_on_screen=True,
        )

    # The lead tries the decisive instructions on the bench, before publishing them.
    source = protocol_source("S")
    source["search_topics"][0]["reference_set"] = world.protocol.version.protocol.search_topics[
        0
    ].reference_set.model_dump(mode="json")
    source["search_topics"][0]["judge"] = DECISIVE
    draft = compile(source)
    with world.db.transaction() as tx:
        bench_id = world.screening.request_bench(
            tx,
            command_id=new_id(),
            project_id=world.project_id,
            actor_id=lead,
            stage_id=stage.stage_id,
            protocol=draft,
        )
        assert world.screening.bench(tx, world.project_id, lead, bench_id).state == "running"
        with pytest.raises(NotAssigned):
            world.screening.bench(tx, world.project_id, a, bench_id)
    bench_backend = recorded_backend(
        world.records,
        world.criteria(),
        answers={ref(world, "patch"): PATCH_DECISIVE},
        instructions=draft.protocol.search_topics[0].judge,
        strict=True,
    )
    world.run_judge_jobs(bench_backend)
    assert len(bench_backend.requests) == 4  # two known includes, two settled records

    with world.db.transaction() as tx:
        result = world.screening.bench(tx, world.project_id, lead, bench_id)
    assert result.state == "done" and (result.records, result.known) == (4, 2)
    first = result.rows[0]
    assert first.title.startswith(TITLES["patch"]) and first.known_include
    assert first.flip and first.against_human and first.human == "include"
    assert first.draft is not None and not first.draft.verified
    assert result.known_proposed_exclude == 1 and result.flips == 1
    # The bench's readings never reach the stage.
    assert row(table(world, a), "patch").ai_proposal.outcome == "include"  # type: ignore[union-attr]

    # Published as it was tried, the draft re-judges the bench's records from the cache.
    world.protocol = publish_version(
        world,
        "0.3",
        reference_set=source["search_topics"][0]["reference_set"],
        judge=DECISIVE,
    )
    assert world.protocol.version.content_hash == draft.content_hash
    rejudge(world, stage.stage_id, world.protocol)
    renewal = recorded_backend(
        world.records,
        world.criteria(),
        answers={ref(world, "patch"): PATCH_DECISIVE},
        instructions=draft.protocol.search_topics[0].judge,
        strict=True,
    )
    world.run_judge_jobs(renewal)
    assert len(renewal.requests) == len(world.records) - 4
    warned = table(world, a).known_includes
    assert warned is not None and warned.proposed_exclude == 1


def rows_of(t: ScreeningTable, *keys: str) -> tuple[BulkRow, ...]:
    return tuple(
        BulkRow(assignment_id=r.assignment_id, expected_etag=r.etag)  # type: ignore[arg-type]
        for r in (row(t, k) for k in keys)
    )


def bulk(world: World, reviewer: Id, stage_id: Id, rows: tuple[BulkRow, ...], **kw: Any) -> Any:
    with world.db.transaction() as tx:
        return world.screening.bulk_decide(
            tx,
            command_id=new_id(),
            project_id=world.project_id,
            reviewer_id=reviewer,
            stage_id=stage_id,
            rows=rows,
            timing=timing(0),
            **kw,
        )


def test_a_working_topic_decides_in_bulk_and_accepts_the_ai_proposals(database: Database) -> None:
    world = small_world(database, "S")
    a = world.people.a
    stage = open_s(world, (a,), reveal="before")
    world.run_judge_jobs(recorded_backend(world.records, world.criteria()))

    # The AI's own not met counts as a proposal, unverified; the colitis trial's is verified.
    mine = table(world, a)
    colitis, cf = row(mine, "colitis").ai_proposal, row(mine, "cf_rct").ai_proposal
    assert colitis is not None and (colitis.outcome, colitis.verified) == ("exclude", True)
    assert cf is not None and (cf.outcome, cf.reason_criterion_id, cf.verified) == (
        "exclude",
        "POP",
        False,
    )
    assert row(mine, "patch").ai_proposal.outcome == "include"  # type: ignore[union-attr]

    # A stale row, a criterion with include, or nothing selected: the batch is refused whole.
    stale = (BulkRow(assignment_id=row(mine, "gum").assignment_id, expected_etag="old"),)  # type: ignore[arg-type]
    with pytest.raises(StaleRevision):
        bulk(world, a, stage.stage_id, (*rows_of(mine, "patch"), *stale), action="include")
    with pytest.raises(InvalidDecision, match="Only an exclusion"):
        bulk(
            world,
            a,
            stage.stage_id,
            rows_of(mine, "patch"),
            action="include",
            reason_criterion_id="POP",
        )

    # A accepts the AI's proposals for three records, filtered on them in the table.
    accepted = bulk(
        world,
        a,
        stage.stage_id,
        rows_of(mine, "colitis", "cf_rct", "cf_review"),
        action="accept_ai",
        filter_description="AI proposes: exclude",
    )
    assert (accepted.decided, accepted.awaiting_final) == (3, 0)
    # And includes two records at once.
    bulk(
        world,
        a,
        stage.stage_id,
        rows_of(mine, "patch", "gum"),
        action="include",
        filter_description="Title contains: nicotine",
    )
    # A record decided already cannot be decided again in bulk.
    with pytest.raises(InvalidDecision, match="decided already"):
        bulk(world, a, stage.stage_id, rows_of(table(world, a), "patch"), action="include")

    with world.db.transaction() as tx:
        outcomes = world.screening.outcomes(tx, world.project_id, SCOPE, STAGE)
        decisions = tx.execute(
            "select d.outcome, d.reason_criterion_id, d.origin, d.batch_id, d.ai_proposal,"
            " d.ai_shown_before, a.item_ref from screening_decision d"
            " join screening_assignment a on a.id = d.assignment_id"
            " where a.stage_id = %s",
            (stage.stage_id,),
        ).fetchall()
    assert {outcomes[ref(world, k)] for k in ("colitis", "cf_rct", "cf_review")} == {"exclude"}
    assert {outcomes[ref(world, k)] for k in ("patch", "gum")} == {"include"}
    assert len(decisions) == 5 and {d["origin"] for d in decisions} == {"bulk"}
    assert all(d["ai_shown_before"] for d in decisions)
    by_ref = {d["item_ref"]: d for d in decisions}
    cf_decision = by_ref[ref(world, "cf_rct")]
    assert (cf_decision["reason_criterion_id"], cf_decision["ai_proposal"]["verified"]) == (
        "POP",
        False,
    )
    assert by_ref[ref(world, "patch")]["ai_proposal"] is None

    # The ledger has one batch event with the filter, and one decision event per record.
    batches = events(world, BULK_DECIDED)
    assert [(b["action"], b["decisions"], b["filter"]) for b in batches] == [
        ("accept_ai", 3, "AI proposes: exclude"),
        ("include", 2, "Title contains: nicotine"),
    ]
    decided = [e for e in events(world, DECIDED) if e.get("origin") == "bulk"]
    assert len(decided) == 5
    assert {e["batch_id"] for e in decided} == {b["batch_id"] for b in batches}
    with world.db.transaction() as tx:
        traced = trace(tx, world.project_id, ref(world, "cf_rct"), store=world.artifacts).events
    assert any("in bulk from the table, taking over the AI's proposal" in e.summary for e in traced)

    # The methods text and the disclosure count them.
    with world.db.transaction() as tx:
        review = load_review(tx, world.project_id, store=world.artifacts)
    (result,) = review.stages
    assert (result.bulk_decisions, result.bulk_batches) == (5, 2)
    assert (result.bulk_accepted_ai, result.bulk_accepted_unverified) == (3, 2)
    text = {f.path: f.data.decode() for f in render_files(review, "ai_disclosure")}[
        "ai_disclosure.md"
    ]
    assert "5 decisions were made in bulk from the table, in 2 batches" in text
    assert "3 of them took over the AI's proposal for the record, 2 of those" in text


def test_a_complete_topic_refuses_bulk_decisions(database: Database) -> None:
    world = small_world(database, "M1")
    stage = world.open()
    mine = table(world, world.people.a)
    with pytest.raises(InvalidDecision, match="working documentation"):
        bulk(world, world.people.a, stage.stage_id, rows_of(mine, "patch"), action="include")
    # A working stage that shows the AI only after a decision has no proposals to accept.
    s_world = small_world(database, "S")
    s_stage = open_s(s_world, (s_world.people.a,), reveal="on_disagreement")
    s_world.run_judge_jobs(recorded_backend(s_world.records, s_world.criteria()))
    s_rows = table(s_world, s_world.people.a)
    with pytest.raises(InvalidDecision, match="shows them before"):
        bulk(
            s_world,
            s_world.people.a,
            s_stage.stage_id,
            rows_of(s_rows, "cf_rct"),
            action="accept_ai",
        )


def test_the_routes_take_the_lead_and_the_screener_through_it(
    database: Database, tmp_path: Any
) -> None:
    from fastapi.testclient import TestClient

    from kittum.api import AppContext, create_app
    from kittum.settings import Settings

    world = small_world(database, "S")
    a, lead = world.people.a, world.people.lead
    stage = open_s(world, (a,), reveal="before")
    world.run_judge_jobs(recorded_backend(world.records, world.criteria()))
    settings = Settings(database_url="postgresql://unused", artifact_dir=tmp_path)
    context = AppContext(
        settings=settings, db=world.db, artifacts=world.artifacts, ledger=world.ledger
    )
    base = f"/api/projects/{world.project_id}/screening"

    def as_(person: Id) -> dict[str, str]:
        return {"X-Kittum-Reviewer": str(person)}

    with TestClient(create_app(context)) as client:
        template = client.get("/api/judge/prompt-template").json()
        assert set(template["stage_rules"]) == {"conservative", "decisive"}
        assert "{guidance}" in template["guidance_frame"]
        assert template["system_before"] + "X" + template["system_after"] != ""

        # The screener sees the AI's proposals in the table and accepts two at once.
        rows = client.get(
            f"{base}/table", params={"scope_id": SCOPE, "stage": STAGE}, headers=as_(a)
        ).json()["rows"]
        chosen = [r for r in rows if r["ai_proposal"] and r["ai_proposal"]["outcome"] == "exclude"][
            :2
        ]
        body = {
            "command_id": str(new_id()),
            "rows": [
                {"assignment_id": r["assignment_id"], "expected_etag": r["etag"]} for r in chosen
            ],
            "action": "accept_ai",
            "filter": "AI proposes: exclude",
            "timing": timing(0).model_dump(mode="json"),
        }
        done = client.post(f"{base}/stages/{stage.stage_id}/bulk-decide", json=body, headers=as_(a))
        assert done.status_code == 200, done.text
        assert done.json()["decided"] == 2
        again = client.post(
            f"{base}/stages/{stage.stage_id}/bulk-decide", json=body, headers=as_(a)
        )
        assert again.json()["batch_id"] == done.json()["batch_id"]  # a retry decides nothing new

        prompt = client.get(
            f"{base}/stages/{stage.stage_id}/prompt",
            params={"assignment_id": rows[0]["assignment_id"]},
            headers=as_(a),
        )
        assert prompt.status_code == 200 and prompt.json()["strictness"] == "conservative"

        # The bench and the re-judge are the lead's: a screener is refused.
        source = protocol_source("S")
        source["search_topics"][0]["judge"] = DECISIVE
        bench = {"actor_id": str(a), "command_id": str(new_id()), "source": source}
        refused = client.post(f"{base}/stages/{stage.stage_id}/bench", json=bench)
        assert refused.status_code == 403
        bench["actor_id"] = str(lead)
        bad = client.post(
            f"{base}/stages/{stage.stage_id}/bench",
            json={**bench, "source": {**source, "search_topics": []}},
        )
        assert bad.status_code == 422
        ran = client.post(f"{base}/stages/{stage.stage_id}/bench", json=bench)
        assert ran.status_code == 201, ran.text
        assert ran.json()["state"] == "running" and ran.json()["records"] == 2
        got = client.get(f"{base}/bench/{ran.json()['bench_id']}", headers=as_(lead))
        assert got.status_code == 200
        assert (
            client.get(f"{base}/bench/{ran.json()['bench_id']}", headers=as_(a)).status_code == 404
        )

        v2 = publish_version(world, "0.5", judge=DECISIVE)
        rejudge_body = {"actor_id": str(a), "command_id": str(new_id())}
        url = f"{base}/stages/{stage.stage_id}/rejudge"
        assert client.post(url, json=rejudge_body).status_code == 403
        moved = client.post(url, json={**rejudge_body, "actor_id": str(lead)})
        assert moved.status_code == 200, moved.text
        assert moved.json()["protocol_hash"] == v2.version.content_hash
    # The worker reads the bench's records and the stage again; nothing is left queued.
    assert world.run_judge_jobs(recorded_backend(world.records, world.criteria())) > 0
