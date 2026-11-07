"""Decisions from a spreadsheet: a screener of a working topic exports their records, edits the
decision columns in Excel, and imports the file. The preview says what would change and why the
other rows do not; applying records one batch event with the file's hash and one decision per
changed row with `origin: spreadsheet`. A complete topic refuses."""

import base64
from io import BytesIO
from typing import TYPE_CHECKING, Any

import pytest
from openpyxl import load_workbook

from kittum.core import SystemClock, new_id, sha256_hex
from kittum.report import (
    ReportRequestError,
    apply_decision_import,
    load_review,
    preview_decision_import,
    render_files,
    trace,
    working_export,
)
from kittum.screening import (
    DECIDED,
    SPREADSHEET_IMPORTED,
    Decision,
    InvalidDecision,
    StaleRevision,
)
from tests.screening.support import SCOPE, STAGE, recorded_backend, timing
from tests.screening.test_instructions import events, item, ref, row, small_world, table
from tests.screening.test_targeted import decide, open_s, queue, undo

if TYPE_CHECKING:
    from kittum.core import Id
    from kittum.db import Database
    from kittum.report import DecisionImportPreview, WorkingExport
    from kittum.screening import ImportResult
    from tests.screening.support import World

pytestmark = pytest.mark.postgres


def export(world: World, person: Id) -> tuple[WorkingExport, bytes]:
    with world.db.transaction() as tx:
        return working_export(
            tx,
            world.project_id,
            person,
            SCOPE,
            STAGE,
            store=world.artifacts,
            ledger=world.ledger,
            clock=SystemClock(),
        )


def edit(data: bytes, rows: dict[str, dict[str, Any]], extra: list[dict[str, Any]] = ()) -> bytes:  # type: ignore[assignment]
    """The file as a reviewer leaves it after editing cells in Excel: by Ref, header -> value."""
    book = load_workbook(BytesIO(data))
    sheet = book["Records"]
    header = [c.value for c in sheet[1]]
    for line in sheet.iter_rows(min_row=2):
        for name, value in rows.get(str(line[0].value), {}).items():
            line[header.index(name)].value = value
    for values in extra:
        sheet.append([values.get(h) for h in header])
    out = BytesIO()
    book.save(out)
    return out.getvalue()


def preview(world: World, person: Id, stage_id: Id, data: bytes) -> DecisionImportPreview:
    with world.db.transaction() as tx:
        return preview_decision_import(
            tx,
            world.project_id,
            person,
            stage_id,
            data,
            screening=world.screening,
            store=world.artifacts,
        )


def apply(
    world: World, person: Id, stage_id: Id, data: bytes, expected: str, command_id: Id
) -> ImportResult:
    with world.db.transaction() as tx:
        return apply_decision_import(
            tx,
            world.project_id,
            person,
            stage_id,
            data,
            command_id=command_id,
            expected_preview=expected,
            file_name="edited.xlsx",
            screening=world.screening,
            store=world.artifacts,
        )


def test_a_screener_brings_decisions_back_from_an_edited_export(database: Database) -> None:
    world = small_world(database, "S")
    a = world.people.a
    stage = open_s(world, (a,), reveal="before")
    world.run_judge_jobs(recorded_backend(world.records, world.criteria()))
    decide(world, a, item(queue(world, a), "gum"), Decision(outcome="include"), ai_on_screen=True)

    exported, data = export(world, a)
    assert exported.decisions
    book = load_workbook(BytesIO(data))
    about = {r[0]: r[1] for r in book["About"].iter_rows(min_row=3, values_only=True)}
    assert about["Export ID"] == str(exported.export_id)
    records = book["Records"]
    header = [c.value for c in records[1]]
    assert {"Your decision", "Reason", "Comment"} <= set(header)
    lists = {dv.formula1 for dv in records.data_validations.dataValidation}
    assert lists == {'"Include,Exclude,Unclear"', "=Criteria!$B$2:$B$4"}
    (event,) = events(world, "report.working_exported")
    assert event["decisions_hash"]

    # After the export, A decides the patch trial in Kittum.
    decide(world, a, item(queue(world, a), "patch"), Decision(outcome="include"), ai_on_screen=True)

    mine = table(world, a)

    def r(key: str) -> str:
        return row(mine, key).ref

    title_before = row(mine, "colitis").title
    edited = edit(
        data,
        {
            # Accepted: a criterion by its number on the Criteria sheet, and a lower-case outcome.
            r("colitis"): {
                "Your decision": "Exclude",
                "Reason": 1,
                "Comment": "Colitis, not smokers",
                "Title": "A title edited in Excel",
            },
            r("varenicline"): {"Your decision": "include"},
            # Refused: decided in Kittum after the export, decided before it, unreadable, no
            # reason for an exclusion, a comment without a decision, and a Ref twice.
            r("patch"): {"Your decision": "Exclude", "Reason": "POP"},
            r("gum"): {"Your decision": "Exclude", "Reason": "INT"},
            r("combination"): {"Your decision": "Maybe"},
            r("cohort"): {"Your decision": "Exclude"},
            r("cf_review"): {"Comment": "Look at this one again"},
            r("glpg"): {"Your decision": "Exclude", "Reason": "DESIGN"},
        },
        [
            {"Ref": str(new_id()), "Your decision": "Include"},
            {"Ref": r("glpg"), "Your decision": "Include"},
        ],
    )

    seen = preview(world, a, stage.stage_id, edited)
    assert seen.export_id == exported.export_id and seen.rows == 11
    assert seen.sha256 == sha256_hex(edited)
    p = seen.preview
    assert {(c.ref, c.decision.outcome, c.decision.reason_criterion_id) for c in p.changes} == {
        (r("colitis"), "exclude", "POP"),
        (r("varenicline"), "include", None),
    }
    refusals = {(x.ref, x.refusal) for x in p.refused}
    assert refusals == {
        (r("patch"), "stale"),
        (r("gum"), "decided"),
        (r("combination"), "unreadable"),
        (r("cohort"), "invalid"),
        (r("cf_review"), "no_decision"),
        (r("glpg"), "duplicate"),
        (next(x.ref for x in p.refused if x.refusal == "unknown_ref"), "unknown_ref"),
    }
    assert len(p.refused) == 8 and p.unchanged == 1  # cf_rct, left blank
    stale = next(x for x in p.refused if x.refusal == "stale")
    assert stale.message == "Decided differently in Kittum after the export (now Include)."
    assert next(x for x in p.refused if x.ref == r("cohort")).message == (
        "An exclusion needs the criterion it excludes on."
    )
    with world.db.transaction() as tx:
        recorded = tx.execute(
            "select 1 from screening_batch where stage_id = %s", (stage.stage_id,)
        ).fetchall()
    assert not recorded  # a preview records nothing

    # A takes back the gum trial in Kittum: its row is now stale, not decided. The decisions to
    # make are the same, but the preview no longer says what an import would do.
    gum = row(table(world, a), "gum")
    undo(world, a, gum, gum.etag)  # type: ignore[arg-type]
    with pytest.raises(StaleRevision, match="Preview it again"):
        apply(world, a, stage.stage_id, edited, p.preview_hash, new_id())
    p = preview(world, a, stage.stage_id, edited).preview
    assert len(p.changes) == 2
    assert next(x.refusal for x in p.refused if x.ref == r("gum")) == "stale"

    command = new_id()
    result = apply(world, a, stage.stage_id, edited, p.preview_hash, command)
    assert (result.decided, result.awaiting_final, result.unchanged, result.refused) == (2, 0, 1, 8)
    # A retry answers the same; a second import of the same preview finds Kittum changed.
    assert apply(world, a, stage.stage_id, edited, p.preview_hash, command) == result
    with pytest.raises(StaleRevision, match="Preview it again"):
        apply(world, a, stage.stage_id, edited, p.preview_hash, new_id())
    again = preview(world, a, stage.stage_id, edited).preview
    assert again.changes == () and again.unchanged == 3

    # One batch event names the file, its export, the uploader, and the counts.
    (batch,) = events(world, SPREADSHEET_IMPORTED)
    assert batch["file_sha256"] == sha256_hex(edited) and batch["file_name"] == "edited.xlsx"
    assert world.artifacts.get(batch["file_sha256"]) == edited
    assert batch["export_id"] == str(exported.export_id)
    assert (batch["decisions"], batch["unchanged"], batch["refused"]) == (2, 1, 8)
    assert batch["refusals"]["duplicate"] == 2
    decided = [e for e in events(world, DECIDED) if e.get("origin") == "spreadsheet"]
    assert {e["batch_id"] for e in decided} == {batch["batch_id"]}
    assert {e["timing"] for e in decided} == {None}
    with world.db.transaction() as tx:
        rows = tx.execute(
            "select d.*, a.item_ref, e.actor_id from screening_decision d"
            " join screening_assignment a on a.id = d.assignment_id"
            " join audit_event e on e.event_id = d.event_id"
            " where d.origin = 'spreadsheet' and a.stage_id = %s",
            (stage.stage_id,),
        ).fetchall()
        outcomes = world.screening.outcomes(tx, world.project_id, SCOPE, STAGE)
        title_after = tx.execute(
            "select title from screening_item where stage_id = %s and item_ref = %s",
            (stage.stage_id, ref(world, "colitis")),
        ).fetchone()
    colitis = next(x for x in rows if x["item_ref"] == ref(world, "colitis"))
    assert (colitis["outcome"], colitis["reason_criterion_id"], colitis["comment"]) == (
        "exclude",
        "POP",
        "Colitis, not smokers",
    )
    assert colitis["shown_at"] is None and colitis["decided_at"] is None
    assert colitis["ai_shown_before"]  # the file carried the AI's reading
    assert {x["actor_id"] for x in rows} == {a}
    assert outcomes[ref(world, "colitis")] == "exclude"
    assert outcomes[ref(world, "varenicline")] == "include"
    assert title_after["title"] == title_before  # bibliographic data never changes

    # The audit trail and the disclosure say what Kittum can and cannot know.
    with world.db.transaction() as tx:
        traced = trace(tx, world.project_id, ref(world, "colitis"), store=world.artifacts).events
        review = load_review(tx, world.project_id, store=world.artifacts)
    line = next(e for e in traced if "imported from a spreadsheet" in e.summary)
    assert any(f.label == "Who decided" for f in line.facts)
    (result_stage,) = review.stages
    assert (
        result_stage.spreadsheet_decisions,
        result_stage.spreadsheet_imports,
        result_stage.spreadsheet_uploaders,
    ) == (2, 1, 1)
    text = {f.path: f.data.decode() for f in render_files(review, "ai_disclosure")}[
        "ai_disclosure.md"
    ]
    assert "2 decisions came from 1 spreadsheet" in text
    assert "not who decided each row in it, and it has no timing" in text


def test_only_the_screener_s_own_records_change_and_a_complete_topic_refuses(
    database: Database,
) -> None:
    world = small_world(database, "S")
    a, b, lead = world.people.a, world.people.b, world.people.lead
    stage = open_s(world, (a, b), reveal="before")
    world.run_judge_jobs(recorded_backend(world.records, world.criteria()))

    # A asks B for a second opinion on one of A's records.
    unsure = queue(world, a)[0]
    decide(world, a, unsure, Decision(outcome="include", second_opinion=True, comment="Smokers?"))
    consult = queue(world, b)[0]
    assert consult.second_opinion is not None

    _, data = export(world, b)
    own = next(x for x in table(world, b).rows if x.assignment_id != consult.assignment_id)
    edited = edit(
        data,
        {
            str(consult.assignment_id): {"Your decision": "Exclude", "Reason": "POP"},
            own.ref: {"Your decision": "Include"},
        },
    )
    p = preview(world, b, stage.stage_id, edited).preview
    assert [c.ref for c in p.changes] == [own.ref]
    assert [(x.ref, x.refusal) for x in p.refused] == [
        (str(consult.assignment_id), "second_opinion")
    ]
    # A cannot import B's file: those are B's records.
    p = preview(world, a, stage.stage_id, edited).preview
    assert p.changes == () and {x.refusal for x in p.refused} == {"not_yours"}

    # The lead's export shows every decision and brings none back; a file that is no workbook,
    # or a workbook without an export ID, is refused.
    _, lead_data = export(world, lead)
    with pytest.raises(ReportRequestError, match="methods lead's export"):
        preview(world, lead, stage.stage_id, lead_data)
    with pytest.raises(ReportRequestError, match="not an Excel workbook"):
        preview(world, b, stage.stage_id, b"Ref,Your decision\n")
    book = load_workbook(BytesIO(data))
    book["About"]["B3"].value = None
    out = BytesIO()
    book.save(out)
    with pytest.raises(ReportRequestError, match="no export ID"):
        preview(world, b, stage.stage_id, out.getvalue())

    # A complete topic exports no decision columns and refuses an import.
    m1 = small_world(database, "M1")
    m1_stage = m1.open()
    exported, m1_data = export(m1, m1.people.a)
    assert not exported.decisions
    header = [c.value for c in load_workbook(BytesIO(m1_data))["Records"][1]]
    assert "Your decision" not in header and "Decision" in header
    with pytest.raises(InvalidDecision, match="working documentation"):
        preview(m1, m1.people.a, m1_stage.stage_id, m1_data)


def test_the_routes_preview_and_import_a_file(database: Database, tmp_path: Any) -> None:
    from fastapi.testclient import TestClient

    from kittum.api import AppContext, create_app
    from kittum.settings import Settings

    world = small_world(database, "S")
    a = world.people.a
    stage = open_s(world, (a,), reveal="on_disagreement")
    world.run_judge_jobs(recorded_backend(world.records, world.criteria()))
    settings = Settings(database_url="postgresql://unused", artifact_dir=tmp_path)
    context = AppContext(
        settings=settings, db=world.db, artifacts=world.artifacts, ledger=world.ledger
    )
    base = f"/api/projects/{world.project_id}/reports/working-export"
    headers = {"X-Kittum-Reviewer": str(a)}
    with TestClient(create_app(context)) as client:
        response = client.post(base, json={"scope_id": SCOPE, "stage": STAGE}, headers=headers)
        assert response.status_code == 200
        mine = table(world, a)
        edited = edit(
            response.content,
            {
                # The AI excludes the colitis trial: including it reveals the AI's reading.
                row(mine, "colitis").ref: {"Your decision": "Include"},
                row(mine, "patch").ref: {"Your decision": "Include"},
            },
        )
        body = {
            "stage_id": str(stage.stage_id),
            "data": base64.b64encode(edited).decode(),
            "file_name": "mine.xlsx",
        }
        seen = client.post(f"{base}/import-preview", json=body, headers=headers)
        assert seen.status_code == 200, seen.text
        assert len(seen.json()["preview"]["changes"]) == 2
        apply_body = {
            **body,
            "command_id": str(new_id()),
            "preview_hash": seen.json()["preview"]["preview_hash"],
        }
        done = client.post(f"{base}/import", json=apply_body, headers=headers)
        assert done.status_code == 200, done.text
        # As with a key in the queue, the reveal leaves the colitis trial waiting for A's final
        # decision in Kittum.
        assert (done.json()["decided"], done.json()["awaiting_final"]) == (1, 1)
        colitis = next(x for x in table(world, a).rows if x.ref == row(mine, "colitis").ref)
        assert colitis.decisions[0].state == "awaiting_final" and colitis.reveal is not None
        # A keeps the decision after reading the AI's: it still came from the spreadsheet.
        with world.db.transaction() as tx:
            world.screening.decide(
                tx,
                command_id=new_id(),
                project_id=world.project_id,
                reviewer_id=a,
                assignment_id=colitis.assignment_id,  # type: ignore[arg-type]
                decision=Decision(outcome="include"),
                phase="final",
                expected_etag=colitis.etag,  # type: ignore[arg-type]
                timing=timing(0, revealed=True),
            )
            review = load_review(tx, world.project_id, store=world.artifacts)
        (result_stage,) = review.stages
        assert result_stage.spreadsheet_decisions == 2
        again = client.post(
            f"{base}/import", json={**apply_body, "command_id": str(new_id())}, headers=headers
        )
        assert again.status_code == 409
        bad = client.post(f"{base}/import-preview", json={**body, "data": "%%"}, headers=headers)
        assert bad.status_code == 400

    m1 = small_world(database, "M1")
    m1_stage = m1.open()
    _, m1_data = export(m1, m1.people.a)
    m1_context = AppContext(settings=settings, db=m1.db, artifacts=m1.artifacts, ledger=m1.ledger)
    with TestClient(create_app(m1_context)) as client:
        refused = client.post(
            f"/api/projects/{m1.project_id}/reports/working-export/import-preview",
            json={"stage_id": str(m1_stage.stage_id), "data": base64.b64encode(m1_data).decode()},
            headers={"X-Kittum-Reviewer": str(m1.people.a)},
        )
        assert refused.status_code == 422
        assert "working documentation" in refused.json()["detail"]
