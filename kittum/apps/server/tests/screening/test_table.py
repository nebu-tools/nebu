"""The screening table and the working export through the HTTP API: a reviewer's table holds
only their own rows, an AI reading only after their own decision revealed it, and nothing that
marks a sentinel; the lead's holds the whole stage. The XLSX export obeys the same rules, is
stored by hash, and is recorded in the ledger."""

import hashlib
import json
from io import BytesIO
from typing import TYPE_CHECKING, Any

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from kittum.api import AppContext, create_app
from kittum.core import SystemClock, new_id
from kittum.report import COVER_TEXT, WORKING_EXPORTED_EVENT, working_export
from kittum.screening import Decision, screening_table
from kittum.settings import Settings
from kittum.storage import MemoryStore
from tests.screening.support import (
    JUDGE_MARK,
    SCOPE,
    STAGE,
    build_world,
    recorded_backend,
    timing,
)
from tests.screening.test_m1_api import TITLES, Reviewer
from tests.screening.test_targeted import UNSURE, decide, open_s, queue, ref_of

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from kittum.core import Id
    from kittum.db import Database
    from kittum.screening import TableRow
    from tests.screening.support import World

pytestmark = pytest.mark.postgres


@pytest.fixture
def world(database: Database) -> World:
    world = build_world(database)
    world.records = [world.record(t) for t in TITLES.values()]
    return world


@pytest.fixture
def artifacts() -> MemoryStore:
    return MemoryStore()


@pytest.fixture
def client(world: World, artifacts: MemoryStore, tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(database_url="postgresql://unused", artifact_dir=tmp_path)
    context = AppContext(settings=settings, db=world.db, artifacts=artifacts, ledger=world.ledger)
    with TestClient(create_app(context)) as client:
        yield client


def table(person: Reviewer) -> Any:
    response = person.call("GET", "/table", params={"scope_id": SCOPE, "stage": STAGE})
    assert response.status_code == 200, response.text
    return response.json()


def export(person: Reviewer, view: dict[str, Any] | None = None) -> Any:
    response = person.client.post(
        f"/api/projects/{person.world.project_id}/reports/working-export",
        headers={"X-Kittum-Reviewer": str(person.id)},
        json={"scope_id": SCOPE, "stage": STAGE, "view": view},
    )
    person.seen.append(response.text if response.status_code != 200 else "")
    return response


def sheet(data: bytes, name: str) -> list[tuple[Any, ...]]:
    return list(load_workbook(BytesIO(data))[name].iter_rows(values_only=True))


def test_table_blinds_reviewers_and_exports_what_each_may_see(
    world: World, client: TestClient, artifacts: MemoryStore
) -> None:
    world.open()
    a, b = Reviewer(client, world, world.people.a), Reviewer(client, world, world.people.b)
    lead = Reviewer(client, world, world.people.lead)
    adjudicator = Reviewer(client, world, world.people.adjudicator)

    # Before deciding, B's table is B's queue: the same records in the same order, each with
    # its queue place and no decision, no AI reading, and nothing that names a sentinel.
    queue = b.whole_queue()
    mine = table(b)
    assert mine["view"] == "reviewer"
    rows = mine["rows"]
    assert [r["assignment_id"] for r in rows] == [i["assignment_id"] for i in queue]
    assert [r["position"] for r in rows] == list(range(1, len(queue) + 1))
    assert all(r["ref"] == r["assignment_id"] for r in rows)
    assert all(r["decisions"] == [{**r["decisions"][0], "state": "pending"}] for r in rows)
    assert all(r["reveal"] is None and r["flags"] == [] and r["ai_excludes"] is None for r in rows)
    first = rows[0]
    assert {frozenset(r) for r in rows} == {frozenset(first)}
    text = json.dumps(mine)
    assert "sentinel" not in text and JUDGE_MARK not in text
    for record in world.records:
        assert record.item_ref not in text  # rows are named by assignment, never by item
    patch = next(r for r in rows if r["title"].startswith(TITLES["patch"]))
    assert patch["authors"] and patch["journal"] and patch["year"]

    # A decides everything, with a comment only A should see; GLPG2737's exclusion is revealed.
    note = f"A-note-{new_id()}"
    for item in a.whole_queue():
        key = next((k for k, t in TITLES.items() if item["title"].startswith(t)), None)
        excluded = key in {"colitis", "glpg"}
        a.decide_item(item, "exclude" if excluded else "include", "POP" if excluded else None)
    # A changes their mind on a row of the table: undo, then decide again, with a comment.
    item = next(r for r in table(a)["rows"] if r["title"].startswith(TITLES["cohort"]))
    undone = a.call(
        "POST",
        f"/assignments/{item['assignment_id']}/undo",
        json={"command_id": str(new_id()), "expected_etag": item["etag"]},
    ).json()
    redone = a.call(
        "POST",
        f"/assignments/{item['assignment_id']}/decide",
        json={
            "command_id": str(new_id()),
            "decision": {"outcome": "exclude", "reason_criterion_id": "DESIGN", "comment": note},
            "phase": "provisional",
            "expected_etag": undone["etag"],
            "timing": json.loads(timing(0).model_dump_json()),
        },
    )
    assert redone.status_code == 200 and redone.json()["phase"] == "final", redone.text
    a_rows = table(a)["rows"]
    assert all(r["decisions"][0]["state"] == "decided" for r in a_rows)
    glpg = next(r for r in a_rows if r["title"].startswith(TITLES["glpg"]))
    assert glpg["reveal"]["criterion_id"] == "POP" and JUDGE_MARK in glpg["reveal"]["rationale"]
    # Taken back and decided again, the record keeps the reading A was shown: it is not shown
    # again, and A has seen it.
    undone = a.call(
        "POST",
        f"/assignments/{glpg['assignment_id']}/undo",
        json={"command_id": str(new_id()), "expected_etag": glpg["etag"]},
    ).json()
    assert a.decide_item({**glpg, "etag": undone["etag"]}, "include")["reveal"] is None
    again = next(r for r in table(a)["rows"] if r["ref"] == glpg["ref"])
    assert again["reveal"] == glpg["reveal"]
    assert again["decisions"][0]["outcome"] == "include"
    cohort = next(r for r in a_rows if r["title"].startswith(TITLES["cohort"]))
    assert cohort["decisions"][0]["outcome"] == "exclude"
    assert (cohort["decisions"][0]["reason_criterion_id"], cohort["decisions"][0]["comment"]) == (
        "DESIGN",
        note,
    )
    # Records whose decision the AI did not dispute show no AI reading.
    patch_a = next(r for r in a_rows if r["title"].startswith(TITLES["patch"]))
    assert patch_a["reveal"] is None

    # B still sees nothing of A, and decides the colitis trial from a table row: the same API
    # and rules as the queue, including the reveal of the AI's disagreement.
    assert note not in json.dumps(table(b)) and str(world.people.a) not in json.dumps(table(b))
    colitis = next(r for r in table(b)["rows"] if r["title"].startswith(TITLES["colitis"]))
    decided = b.decide_item(colitis, "include")
    assert decided["reveal"]["criterion_id"] == "POP"
    colitis = next(r for r in table(b)["rows"] if r["title"].startswith(TITLES["colitis"]))
    assert colitis["decisions"][0]["state"] == "decided"
    assert colitis["reveal"] == decided["reveal"]

    # An adjudicator who screens nothing has no table; the lead sees the whole stage.
    refused = adjudicator.call("GET", "/table", params={"scope_id": SCOPE, "stage": STAGE})
    assert refused.status_code == 404
    whole = table(lead)
    assert whole["view"] == "lead"
    by_ref = {r["ref"]: r for r in whole["rows"]}
    assert set(by_ref) >= {r.item_ref for r in world.records}
    assert any("sentinel" in r["flags"] for r in whole["rows"])
    lead_cohort = by_ref[world.record(TITLES["cohort"]).item_ref]
    assert any(
        d["comment"] == note and d["reviewer_id"] == str(world.people.a)
        for d in lead_cohort["decisions"]
    )
    assert lead_cohort["outcome"] is None  # B has not decided it yet
    lead_colitis = by_ref[world.record(TITLES["colitis"]).item_ref]
    assert lead_colitis["outcome"] == "conflict"
    assert lead_colitis["ai_excludes"] is True and lead_colitis["ai_not_met"] == ["POP"]

    # B's working export: B's rows only, the cover says what it is, and it is in the ledger.
    response = export(b)
    assert response.status_code == 200, response.text
    data = response.content
    sha = hashlib.sha256(data).hexdigest()
    assert response.headers["x-kittum-sha256"] == sha and artifacts.get(sha) == data
    about = sheet(data, "About")
    assert about[0][0] == COVER_TEXT
    records = sheet(data, "Records")
    header, body = records[0], records[1:]
    assert header[:2] == ("Ref", "Queue place")
    assert len(body) == len(rows)
    assert {r[0] for r in body} == {r["assignment_id"] for r in rows}
    flat = json.dumps([*about, *records], default=str)
    assert note not in flat and "sentinel" not in flat
    assert JUDGE_MARK in flat  # B's own reveal on the colitis trial, and only that
    revealed_rows = [r for r in body if r[header.index("AI reading")] is not None]
    assert len(revealed_rows) == 1 and revealed_rows[0][header.index("Title")].startswith(
        TITLES["colitis"]
    )
    criteria = sheet(data, "Criteria")
    assert criteria[0] == ("Key", "Criterion ID", "Short label", "Criterion")
    assert {c[1] for c in criteria[1:]} >= {"POP", "DESIGN"}

    # A view export: the rows and columns in view, in their order. A row of someone else's, or
    # a column only the lead has, is refused.
    view_rows = [rows[3]["ref"], rows[0]["ref"]]
    response = export(
        b,
        {"refs": view_rows, "columns": ["title", "ref", "decision"], "description": "Year: 2002"},
    )
    assert response.status_code == 200, response.text
    records = sheet(response.content, "Records")
    assert records[0] == ("Title", "Ref", "Decision")
    assert [r[1] for r in records[1:]] == view_rows
    assert ("View", "Year: 2002") in sheet(response.content, "About")
    # The stable reference travels even when it is not in view.
    response = export(b, {"refs": view_rows, "columns": ["decision"]})
    assert sheet(response.content, "Records")[0] == ("Ref", "Decision")
    stranger = export(b, {"refs": [a_rows[0]["ref"]], "columns": ["title"]})
    assert stranger.status_code == 400
    assert export(b, {"refs": view_rows, "columns": ["flags"]}).status_code == 400
    assert export(adjudicator).status_code == 404

    # The lead's export holds every decision with its reason criterion and the outcomes.
    response = export(lead)
    assert response.status_code == 200
    records = sheet(response.content, "Records")
    header = records[0]
    lead_row = next(r for r in records[1:] if r[0] == world.record(TITLES["cohort"]).item_ref)
    assert "(DESIGN)" in lead_row[header.index("Decisions")]
    assert (
        next(r for r in records[1:] if r[0] == world.record(TITLES["colitis"]).item_ref)[
            header.index("Outcome")
        ]
        == "Conflict"
    )
    # The lead can download any working export again by its hash.
    again = lead.client.get(
        f"/api/projects/{world.project_id}/reports/artifacts/{sha}",
        headers={"X-Kittum-Reviewer": str(world.people.lead)},
    )
    assert again.status_code == 200 and again.content == data

    with world.db.transaction() as tx:
        exported = [
            e for e in world.ledger.events(tx, world.project_id) if e.type == WORKING_EXPORTED_EVENT
        ]
        assert world.ledger.verify(tx, world.project_id).ok
    assert [(e.actor_id, e.payload["kind"], e.payload["view"]) for e in exported] == [
        (world.people.b, "stage", "reviewer"),
        (world.people.b, "view", "reviewer"),
        (world.people.b, "view", "reviewer"),
        (world.people.lead, "stage", "lead"),
    ]
    assert exported[0].payload["sha256"] == sha and exported[0].payload["rows"] == len(rows)
    assert exported[1].payload["columns"] == ["title", "ref", "decision"]

    # B never received anything of A's, nor A's comment, through the table or the export.
    for seen in b.seen:
        assert note not in seen and str(world.people.a) not in seen


def test_an_s_stage_table_lists_what_its_queue_lists(database: Database) -> None:
    """Mode S: the table holds records the judge has not read yet, the AI's reading before the
    decision once there is one, and a second opinion with the decision it is asked on; the
    export says the same."""
    world = build_world(database, "S")
    a, b, lead = world.people.a, world.people.b, world.people.lead
    open_s(world, (a, b))

    def rows(reviewer: Id) -> list[TableRow]:
        with world.db.transaction() as tx:
            return list(screening_table(tx, world.project_id, reviewer, SCOPE, STAGE).rows)

    # Before the judge has read anything, each screener's table is their queue.
    mine = rows(a)
    assert [r.assignment_id for r in mine] == [i.assignment_id for i in queue(world, a)]
    assert mine and all(r.ai is None and r.second_opinion is None for r in mine)

    # Once it has, the stage shows its reading before the decision, in the table too.
    world.backend = recorded_backend(world.records, world.criteria())
    world.run_judge_jobs(world.backend)
    items = queue(world, a)
    by_assignment = {r.assignment_id: r for r in rows(a)}
    assert items and all(i.ai is not None for i in items)
    assert all(by_assignment[i.assignment_id].ai == i.ai for i in items)

    # A asks a second opinion; B's table has it first, with A's decision and comment.
    unsure = items[0]
    decide(world, a, unsure, UNSURE, ai_on_screen=True)
    asked = next(r for r in rows(a) if r.assignment_id == unsure.assignment_id)
    assert asked.decisions[0].second_opinion and asked.decisions[0].state == "decided"
    consult = queue(world, b)[0]
    first = rows(b)[0]
    assert first.assignment_id == consult.assignment_id and first.position == 1
    assert first.second_opinion is not None
    assert first.second_opinion.comment == "Smokers? The abstract never says."

    # B settles it; the row stays in B's table, and the lead sees both decisions and the outcome.
    decide(world, b, consult, Decision(outcome="exclude", reason_criterion_id="POP"))
    settled = next(r for r in rows(b) if r.assignment_id == consult.assignment_id)
    assert settled.decisions[0].state == "decided" and settled.second_opinion is not None
    lead_row = next(r for r in rows(lead) if r.ref == ref_of(world, unsure))
    assert [(d.role, d.outcome, d.second_opinion) for d in lead_row.decisions] == [
        ("screener", "include", True),
        ("second_opinion", "exclude", False),
    ]
    assert (lead_row.outcome, lead_row.outcome_reason) == ("exclude", "POP")

    # B's export says what the table says.
    with world.db.transaction() as tx:
        _, data = working_export(
            tx,
            world.project_id,
            b,
            SCOPE,
            STAGE,
            store=world.artifacts,
            ledger=world.ledger,
            clock=SystemClock(),
        )
    header, *body = sheet(data, "Records")
    line = next(r for r in body if r[0] == str(consult.assignment_id))
    assert line[header.index("Second opinion")] == (
        "Asked of you on Include: Smokers? The abstract never says."
    )
    assert line[header.index("AI reading")] is not None
