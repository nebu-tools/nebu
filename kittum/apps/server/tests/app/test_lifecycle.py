"""A project's lifecycle through the HTTP API, from nothing to an open stage the AI has read.

The steps the demo seed takes in one call, taken one route at a time as an integrator would:
the project and its people, the protocol, two file imports, the corpus, and a title and abstract
stage. (Full texts are left to the end-to-end test: the documents tests expect an empty document
table in the shared test database.) The worker runs the stage's judge jobs on the recorded answers; a worker
whose judge is a different one refuses them before any model call, and one whose judge is the same
model under a newer prompt version judges with the prompt the stage was opened with.
"""

from dataclasses import replace
from typing import TYPE_CHECKING, Any
from uuid import UUID

import pytest
import yaml
from fastapi.testclient import TestClient

from kittum.api import AppContext, create_app
from kittum.app import Judge, add_member, job_handlers, judge_config
from kittum.app.demo import DATA, PROTOCOL, RECORDED_MODEL, SENTINELS, demo_judge
from kittum.extraction import JOB_KIND as EXTRACTION_JOB
from kittum.ledger import PostgresLedger
from kittum.models import ModelRegistry
from kittum.models.testing import RecordedBackend
from kittum.runs import PostgresJobQueue, PostgresReceipts, Worker
from kittum.screening import BENCH_JOB, JUDGE_JOB
from kittum.settings import Settings
from kittum.storage import MemoryStore

if TYPE_CHECKING:
    from pathlib import Path

    from kittum.db import Database

pytestmark = pytest.mark.postgres


def _context(database: Database, tmp_path: Path, judge: Judge) -> AppContext:
    return AppContext(
        settings=Settings(database_url="postgresql://unused", artifact_dir=tmp_path),
        db=database,
        artifacts=MemoryStore(),
        ledger=PostgresLedger(),
        judge=judge,
    )


def _run_jobs(ctx: AppContext) -> int:
    worker = Worker(ctx.db, PostgresJobQueue(), job_handlers(ctx), name="lifecycle-test")
    ran = 0
    while worker.run_once():
        ran += 1
    return ran


def test_a_project_from_nothing_to_an_open_stage(database: Database, tmp_path: Path) -> None:
    registry = ModelRegistry.load()
    ctx = _context(database, tmp_path, demo_judge(registry))
    client = TestClient(create_app(ctx))

    def ok(response: Any, status: int = 200) -> Any:
        assert response.status_code == status, response.text
        return response.json()

    project = ok(
        client.post("/api/projects", json={"name": "NRT update", "lead_name": "Morgan Lee"}), 201
    )
    pid = project["id"]
    (lead,) = [m["actor_id"] for m in project["members"] if m["roles"] == ["lead"]]
    for name, roles in (
        ("Sam Okafor", ["reviewer"]),
        ("Jun Park", ["reviewer"]),
        ("Rita Nunes", ["auditor"]),
        ("Elena Weiss", ["adjudicator"]),
        ("Ola Berg", ["reviewer"]),  # a third reviewer, whom M1 does not need
    ):
        body = {"display_name": name, "roles": roles, "added_by": lead}
        ok(client.post(f"/api/projects/{pid}/members", json=body), 201)
    people = {
        m["display_name"]: m["actor_id"] for m in ok(client.get(f"/api/projects/{pid}"))["members"]
    }
    as_lead = {"X-Kittum-Reviewer": lead}

    # Nothing to screen before a protocol, searches, and a corpus.
    stage = {"scope_id": "nrt-vs-control", "stage": "title_abstract", "actor_id": lead}
    refused = client.post(f"/api/projects/{pid}/screening/stages", json=stage)
    assert refused.status_code == 409 and "publish the protocol" in refused.text

    draft = ok(
        client.post(
            f"/api/projects/{pid}/protocol-versions", json=yaml.safe_load(PROTOCOL.read_text())
        ),
        201,
    )
    ok(
        client.post(
            f"/api/projects/{pid}/protocol-versions/{draft['id']}/publish",
            json={"approved_by": lead},
        )
    )
    published = ok(client.get(f"/api/projects/{pid}/protocol"))
    assert published["labels"]["slot.population"] == "Population"  # no profile: the core's words

    for source, platform, file in (
        ("central", "Cochrane Library (Wiley)", "central_export.ris"),
        ("citation_search", "Reference lists", "citation_search.ris"),
    ):
        body = {
            "plan": {"topic_id": "TRIALS", "source": source, "platform": platform, "strategy": "x"},
            "data": (DATA / file).read_text(),
            "format": "ris",
            "actor_id": lead,
        }
        ok(client.post(f"/api/projects/{pid}/search/import", json=body))
    ok(client.post(f"/api/projects/{pid}/corpus/ingest", json={"actor_id": lead}), 201)
    again = client.post(f"/api/projects/{pid}/corpus/ingest", json={"actor_id": lead})
    assert again.status_code == 409  # update searches need the corpus diff, not a second corpus

    corpus = ok(client.get(f"/api/projects/{pid}/corpus/revisions/latest", headers=as_lead))
    assert len(corpus["reports"]) == 10  # seven CENTRAL records and three found by citation
    sentinels = [s.model_dump(mode="json") for s in SENTINELS]
    info = ok(
        client.post(f"/api/projects/{pid}/screening/stages", json=stage | {"sentinels": sentinels}),
        201,
    )
    assert info["mode"] == "M1" and info["judge_config_id"] == ctx.judge.config.id  # type: ignore[union-attr]
    project = ok(client.get(f"/api/projects/{pid}"))
    assert [s["stage_id"] for s in project["stages"]] == [info["stage_id"]]
    reviewer = {"X-Kittum-Reviewer": project["stages"][0]["screeners"][0]}
    queue = {"scope_id": "nrt-vs-control", "stage": "title_abstract"}
    assert (
        ok(client.get(f"/api/projects/{pid}/screening/queue", params=queue, headers=reviewer)) == []
    )

    # A worker with another judge refuses the stage's jobs without calling its model.
    other = RecordedBackend(default="{}")
    stranger = _context(
        database,
        tmp_path,
        Judge(
            config=judge_config("qwen3.5-4b-ollama", label="another-judge"),
            recipe=registry.get("qwen3.5-4b-ollama"),
            backend=other,
        ),
    )
    # No job queue, so no extraction: the judge's jobs, its stages' and the test bench's.
    assert set(job_handlers(stranger)) == {JUDGE_JOB, BENCH_JOB}
    with_models = replace(
        stranger,
        backends={"qwen3.5-4b-ollama": other},
        queue=PostgresJobQueue(),
        receipts=PostgresReceipts(),
    )
    assert set(job_handlers(with_models)) == {JUDGE_JOB, BENCH_JOB, EXTRACTION_JOB}
    with database.transaction() as tx:
        jobs = tx.execute(
            "select id from job where project_id = %s and kind = %s", (pid, JUDGE_JOB)
        ).fetchall()
        tx.execute(
            "update job set run_after = now() + interval '1 hour' where project_id <> %s"
            " and status = 'queued'",
            (pid,),
        )
    assert jobs
    assert _run_jobs(stranger) >= 1
    assert other.requests == []
    with database.transaction() as tx:
        failed = tx.execute(
            "select status, last_error from job where project_id = %s", (pid,)
        ).fetchall()
        # Requeue them for the right worker: a refused job fails for good, so this stands in for the
        # operator who started the wrong worker and now starts the right one.
        tx.execute(
            "update job set status = 'queued', attempt = 0, run_after = now() where project_id = %s",
            (pid,),
        )
    assert {f["status"] for f in failed} == {"failed"}
    assert "needs demo-recorded" in failed[0]["last_error"]

    # The demo judge opened the stage under judge.v2. A worker upgraded to judge.v3 with the same
    # model judges it with the prompt it started with, and the prompt view shows that prompt.
    assert ctx.judge is not None and ctx.judge.config.id == "demo-recorded@judge.v2"
    upgraded = _context(
        database,
        tmp_path,
        replace(ctx.judge, config=judge_config(RECORDED_MODEL, label="demo-recorded")),
    )
    assert upgraded.judge is not None and upgraded.judge.config.prompt_version == "judge.v3"
    assert _run_jobs(upgraded) == len(jobs)
    with database.transaction() as tx:
        judged = tx.execute(
            "select distinct judge_config_id, item_ref from verdict where project_id = %s", (pid,)
        ).fetchall()
    assert {j["judge_config_id"] for j in judged} == {"demo-recorded@judge.v2"}
    prompt = ok(
        client.get(
            f"/api/projects/{pid}/screening/stages/{info['stage_id']}/prompt",
            params={"item_ref": judged[0]["item_ref"]},
            headers=as_lead,
        )
    )
    assert "### Criterion POP (population)" in prompt["user"]
    assert "Answer key:" not in prompt["user"]
    items = ok(
        client.get(
            f"/api/projects/{pid}/screening/queue", params=queue | {"limit": 50}, headers=reviewer
        )
    )
    assert len(items) == 11  # ten records and one sentinel, now that the AI has read them

    progress = ok(client.get(f"/api/projects/{pid}/progress", headers=as_lead))
    assert progress["identification"]["total_records_identified"] == 10
    assert progress["full_texts"] == 0
    (ta,) = progress["stages"]
    assert ta["status"]["view"] == "lead" and ta["outcomes"] == {"pending": 10}
    # A screener sees only their own counts, and no outcomes.
    mine = ok(client.get(f"/api/projects/{pid}/progress", headers=reviewer))
    assert mine["stages"][0]["status"]["view"] == "reviewer"
    assert mine["stages"][0]["outcomes"] is None
    assert mine["identification"] is None and mine["searches"] == 0

    # Only the lead reads the whole catalogue: anyone else could tell the sentinels in their
    # queue by their absence from it.
    catalogue = ("corpus/revisions/latest", "corpus/proposals", "search/executions")
    for person in ("Sam Okafor", "Rita Nunes", "Ola Berg"):
        for path in catalogue:
            read = client.get(
                f"/api/projects/{pid}/{path}", headers={"X-Kittum-Reviewer": people[person]}
            )
            assert read.status_code == 403, (person, path)
    for path in catalogue:
        ok(client.get(f"/api/projects/{pid}/{path}", headers=as_lead))

    # A reviewer with no part in the stage gets nothing of it: no lead view by default.
    outsider = {"X-Kittum-Reviewer": people["Ola Berg"]}
    assert people["Ola Berg"] not in info["screeners"]
    theirs = ok(client.get(f"/api/projects/{pid}/progress", headers=outsider))
    assert theirs["stages"] == [] and theirs["identification"] is None
    unseen = client.get(f"/api/projects/{pid}/screening/status", params=queue, headers=outsider)
    assert unseen.status_code == 404
    # Nor its reports, which hold every decision: those are the lead's too.
    render = f"/api/projects/{pid}/reports/targets/prisma/render"
    refused = client.post(render, json={"actor_id": people["Ola Berg"]})
    assert refused.status_code == 403
    rendered = ok(client.post(render, json={"actor_id": lead}))
    flow = next(f for f in rendered["artifact"]["files"] if f["path"].endswith(".json"))
    downloaded = ok(
        client.get(f"/api/projects/{pid}/reports/artifacts/{flow['sha256']}", headers=as_lead)
    )
    assert downloaded["records_identified"] == 10 and downloaded["records_awaiting_screening"] == 10

    # A lead who also screens a stage (here the auditor, made a lead too) is a screener first:
    # with the catalogue or the counts, they could tell the sentinels in their own queue.
    auditor = people["Rita Nunes"]
    with database.transaction() as tx:
        add_member(
            tx,
            pid,
            display_name="Rita Nunes",
            roles=("lead",),
            added_by=lead,
            ledger=ctx.require_ledger(),
            actor_id=UUID(auditor),
        )
    as_auditor = {"X-Kittum-Reviewer": auditor}
    for path in catalogue:
        read = client.get(f"/api/projects/{pid}/{path}", headers=as_auditor)
        assert read.status_code == 403, path
    hers = ok(client.get(f"/api/projects/{pid}/progress", headers=as_auditor))
    assert hers["identification"] is None
    assert [s["status"]["view"] for s in hers["stages"]] == ["reviewer"]
    assert hers["stages"][0]["outcomes"] is None
    assert client.post(render, json={"actor_id": auditor}).status_code == 403

    ledger = ok(client.get(f"/api/projects/{pid}/ledger/verify", headers=as_lead))
    assert ledger["ok"] and ledger["verify"]["ok"]
    # Anyone else learns that the chain holds and how far, and not what is in it: the lead's keys
    # are left out, not sent empty.
    for headers in (reviewer, as_auditor, {}):
        theirs = ok(client.get(f"/api/projects/{pid}/ledger/verify", headers=headers))
        assert theirs == {
            "ok": True,
            "checked_through_seq": ledger["checked_through_seq"],
        }
    assert ledger["by_type"]["project.member_added"] == 6  # five people and a second role
    assert ledger["by_type"]["judge.verdict_recorded"] == 11


def test_a_targeted_search_screens_with_a_pool_and_no_auditor(
    database: Database, tmp_path: Path
) -> None:
    """Mode S over HTTP: the protocol says working documentation, the stage takes the screener
    pool the lead picks, needs no auditor or adjudicator, may show the AI before the decision,
    and its queues fill before the judge has run."""
    ctx = _context(database, tmp_path, demo_judge(ModelRegistry.load()))
    client = TestClient(create_app(ctx))

    def ok(response: Any, status: int = 200) -> Any:
        assert response.status_code == status, response.text
        return response.json()

    project = ok(client.post("/api/projects", json={"name": "Confounders", "lead_name": "Mo"}), 201)
    pid = project["id"]
    (lead,) = [m["actor_id"] for m in project["members"] if m["roles"] == ["lead"]]
    for name in ("Sam Okafor", "Jun Park", "Ola Berg"):
        body = {"display_name": name, "roles": ["reviewer"], "added_by": lead}
        ok(client.post(f"/api/projects/{pid}/members", json=body), 201)
    people = {
        m["display_name"]: m["actor_id"] for m in ok(client.get(f"/api/projects/{pid}"))["members"]
    }
    source = yaml.safe_load(PROTOCOL.read_text())
    source["search_topics"][0].update(
        mode="S",
        mode_rationale={"en": "Confounder search for the team's own model."},
        audit={"sentinel_percent": "0", "random_audit_percent": "0"},
    )
    draft = ok(client.post(f"/api/projects/{pid}/protocol-versions", json=source), 201)
    ok(
        client.post(
            f"/api/projects/{pid}/protocol-versions/{draft['id']}/publish",
            json={"approved_by": lead},
        )
    )
    assert ok(client.get(f"/api/projects/{pid}/protocol"))["documentation"] == {"TRIALS": "working"}
    body = {
        "plan": {"topic_id": "TRIALS", "source": "central", "platform": "Wiley", "strategy": "x"},
        "data": (DATA / "central_export.ris").read_text(),
        "format": "ris",
        "actor_id": lead,
    }
    ok(client.post(f"/api/projects/{pid}/search/import", json=body))
    ok(client.post(f"/api/projects/{pid}/corpus/ingest", json={"actor_id": lead}), 201)

    stage = {"scope_id": "nrt-vs-control", "stage": "title_abstract", "actor_id": lead}
    stranger = client.post(
        f"/api/projects/{pid}/screening/stages", json=stage | {"screeners": [lead]}
    )
    assert stranger.status_code == 409 and "must be reviewers" in stranger.text
    pool = [people["Sam Okafor"], people["Jun Park"]]
    info = ok(
        client.post(
            f"/api/projects/{pid}/screening/stages",
            json=stage | {"screeners": pool, "reveal": "before"},
        ),
        201,
    )
    assert info["mode"] == "S" and info["documentation"] == "working"
    assert info["screeners"] == pool and info["auditor_id"] is None and info["adjudicators"] == []
    assert info["reveal"] == "before"

    # The judge has not run, and both queues hold their share; Ola is not in the pool.
    params = {"scope_id": "nrt-vs-control", "stage": "title_abstract", "limit": 50}
    sizes = [
        len(
            ok(
                client.get(
                    f"/api/projects/{pid}/screening/queue",
                    params=params,
                    headers={"X-Kittum-Reviewer": p},
                )
            )
        )
        for p in pool
    ]
    assert sum(sizes) == 7 and abs(sizes[0] - sizes[1]) <= 1
    outsider = client.get(
        f"/api/projects/{pid}/screening/queue",
        params=params,
        headers={"X-Kittum-Reviewer": people["Ola Berg"]},
    )
    assert outsider.status_code == 200 and outsider.json() == []
