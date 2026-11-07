"""Complete the pool over HTTP: the lead uploads the papers the customer already has (here an
Excel list) as a topic's known pool, sees what the search found of it, what it missed, and
what is new, and the screening table marks the pool's records so a reviewer can filter them.
A complete-documentation topic screens blind to the pool; the lead still sees it."""

import base64
from io import BytesIO
from typing import TYPE_CHECKING, Any

import pytest
import yaml
from fastapi.testclient import TestClient
from openpyxl import Workbook

from kittum.api import AppContext, create_app
from kittum.app import job_handlers
from kittum.app.demo import DATA, PROTOCOL, SENTINELS, demo_judge
from kittum.core import sha256_hex
from kittum.ledger import PostgresLedger
from kittum.models import ModelRegistry
from kittum.runs import PostgresJobQueue, Worker
from kittum.settings import Settings
from kittum.storage import MemoryStore

if TYPE_CHECKING:
    from pathlib import Path

    from kittum.db import Database

pytestmark = pytest.mark.postgres

SCOPE = "nrt-vs-control"


def _known_papers() -> bytes:
    """Two papers of the CENTRAL search, one by DOI and one by its title alone, and one paper the
    search missed."""
    book = Workbook()
    sheet = book.active
    assert sheet is not None
    sheet.append(["Title", "Authors", "Year", "DOI"])
    sheet.append(
        [
            "Varenicline and nicotine replacement therapy for smokers admitted to hospitals",
            "Weeks GR",
            2024,
            "https://doi.org/10.1001/JAMANETWORKOPEN.2024.18120",
        ]
    )
    sheet.append(
        [
            "Nicotine patch versus placebo patch for smoking cessation in adult smokers: a"
            " randomised controlled trial",
            "Hartmann L",
            2019,
            None,
        ]
    )
    sheet.append(["Nicotine mouth spray for smoking cessation: a pilot trial", "Tonnesen P", 2012])
    out = BytesIO()
    book.save(out)
    return out.getvalue()


class Project:
    def __init__(self, database: Database, tmp_path: Path, mode: str) -> None:
        self.artifacts = MemoryStore()
        self.ctx = AppContext(
            settings=Settings(database_url="postgresql://unused", artifact_dir=tmp_path),
            db=database,
            artifacts=self.artifacts,
            ledger=PostgresLedger(),
            judge=demo_judge(ModelRegistry.load()),
        )
        self.client = TestClient(create_app(self.ctx))
        project = self.ok(
            self.client.post("/api/projects", json={"name": "Pool", "lead_name": "Mo"}), 201
        )
        self.pid = project["id"]
        (self.lead,) = [m["actor_id"] for m in project["members"] if m["roles"] == ["lead"]]
        roles = [("Sam", "reviewer"), ("Jun", "reviewer")]
        if mode == "M1":
            roles += [("Rita", "auditor"), ("Elena", "adjudicator")]
        for name, role in roles:
            body = {"display_name": name, "roles": [role], "added_by": self.lead}
            self.ok(self.client.post(f"/api/projects/{self.pid}/members", json=body), 201)
        members = self.ok(self.client.get(f"/api/projects/{self.pid}"))["members"]
        self.reviewers = [m["actor_id"] for m in members if m["roles"] == ["reviewer"]]
        source = yaml.safe_load(PROTOCOL.read_text())
        if mode == "S":
            source["search_topics"][0].update(
                mode="S",
                mode_rationale={"en": "Complete the customer's pool."},
                audit={"sentinel_percent": "0", "random_audit_percent": "0"},
            )
        draft = self.ok(
            self.client.post(f"/api/projects/{self.pid}/protocol-versions", json=source), 201
        )
        self.ok(
            self.client.post(
                f"/api/projects/{self.pid}/protocol-versions/{draft['id']}/publish",
                json={"approved_by": self.lead},
            )
        )
        body = {
            "plan": {
                "topic_id": "TRIALS",
                "source": "central",
                "platform": "Wiley",
                "strategy": "x",
            },
            "data": (DATA / "central_export.ris").read_text(),
            "format": "ris",
            "actor_id": self.lead,
        }
        self.ok(self.client.post(f"/api/projects/{self.pid}/search/import", json=body))

    @staticmethod
    def ok(response: Any, status: int = 200) -> Any:
        assert response.status_code == status, response.text
        return response.json()

    def pool(self, as_: str | None = None) -> Any:
        return self.client.get(
            f"/api/projects/{self.pid}/corpus/known-pool",
            params={"topic_id": "TRIALS"},
            headers={"X-Kittum-Reviewer": as_ or self.lead},
        )

    def table(self, person: str) -> list[dict[str, Any]]:
        return self.ok(
            self.client.get(
                f"/api/projects/{self.pid}/screening/table",
                params={"scope_id": SCOPE, "stage": "title_abstract"},
                headers={"X-Kittum-Reviewer": person},
            )
        )["rows"]


def _upload(project: Project, data: bytes) -> Any:
    return project.client.post(
        f"/api/projects/{project.pid}/corpus/known-pool",
        json={
            "topic_id": "TRIALS",
            "data": base64.b64encode(data).decode(),
            "encoding": "base64",
            "format": "records-xlsx",
            "file_name": "known papers.xlsx",
            "actor_id": project.lead,
        },
    )


def test_a_targeted_topic_completes_the_customers_pool(database: Database, tmp_path: Path) -> None:
    project = Project(database, tmp_path, "S")
    pid, lead, ok = project.pid, project.lead, project.ok
    data = _known_papers()

    ok(_upload(project, data), 201)
    # Only the lead adds to the pool, or reads it.
    sam = project.reviewers[0]
    stranger = project.client.post(
        f"/api/projects/{pid}/corpus/known-pool",
        json={"topic_id": "TRIALS", "data": "x", "format": "ris", "actor_id": sam},
    )
    assert stranger.status_code == 403 and project.pool(sam).status_code == 403
    no_topic = project.client.post(
        f"/api/projects/{pid}/corpus/known-pool",
        json={"topic_id": "NOPE", "data": "x", "format": "ris", "actor_id": lead},
    )
    assert no_topic.status_code == 409 and "no search topic 'NOPE'" in no_topic.text
    not_a_list = project.client.post(
        f"/api/projects/{pid}/corpus/known-pool",
        json={"topic_id": "TRIALS", "data": "Name\nx\n", "format": "records-csv", "actor_id": lead},
    )
    assert not_a_list.status_code == 400 and "needs a Title column" in not_a_list.text

    # The file is stored by hash and named in the ledger.
    before = ok(project.pool())
    (pool_file,) = before["files"]
    assert pool_file["file_name"] == "known papers.xlsx" and pool_file["entries"] == 3
    assert project.artifacts.get(sha256_hex(data)) == data
    assert pool_file["file_hash"] == sha256_hex(data)

    # Before the corpus is built, the comparison already shows the search's gap.
    assert before["basis"] == "records" and before["searched"] == 7
    assert (before["pool_size"], len(before["found"]), before["new"]) == (3, 2, 5)
    (missed,) = before["not_found"]
    assert missed["record"]["title"].startswith("Nicotine mouth spray")

    ok(project.client.post(f"/api/projects/{pid}/corpus/ingest", json={"actor_id": lead}), 201)
    after = ok(project.pool())
    assert after["basis"] == "reports" and (after["in_pool"], after["new"]) == (2, 5)
    found = {m["entry"]["record"]["title"][:20]: m for m in after["found"]}
    assert (
        found["Varenicline and nico"]["evidence"] == "Same DOI 10.1001/jamanetworkopen.2024.18120"
    )
    assert found["Nicotine patch versu"]["evidence"].startswith("Titles")
    # The pool is not a search: the identification counts are the search's seven records.
    progress = ok(
        project.client.get(f"/api/projects/{pid}/progress", headers={"X-Kittum-Reviewer": lead})
    )
    assert progress["identification"]["total_records_identified"] == 7

    stage = {
        "scope_id": SCOPE,
        "stage": "title_abstract",
        "actor_id": lead,
        "screeners": project.reviewers,
    }
    ok(project.client.post(f"/api/projects/{pid}/screening/stages", json=stage), 201)
    pool_refs = {ref for m in after["found"] for ref in m["refs"]}
    lead_rows = project.table(lead)
    assert {r["ref"] for r in lead_rows if r["in_known_pool"]} == pool_refs
    assert sum(r["in_known_pool"] is False for r in lead_rows) == 5
    # Each screener's rows say which are in the pool, still named by assignment only.
    mine = [row for person in project.reviewers for row in project.table(person)]
    assert len(mine) == 7 and sum(bool(r["in_known_pool"]) for r in mine) == 2
    assert all(r["ref"] not in pool_refs for r in mine)
    patch = next(r for r in mine if r["title"].startswith("Nicotine patch versus"))
    assert patch["in_known_pool"] is True

    # A file uploaded by mistake comes out of the pool; the table forgets the pool with it.
    gone = ok(
        project.client.post(
            f"/api/projects/{pid}/corpus/known-pool/{pool_file['id']}/withdraw",
            json={"actor_id": lead},
        )
    )
    assert gone["withdrawn_at"] is not None
    assert ok(project.pool())["pool_size"] == 0
    assert all(r["in_known_pool"] is None for r in project.table(lead))
    by_type = ok(
        project.client.get(
            f"/api/projects/{pid}/ledger/verify", headers={"X-Kittum-Reviewer": lead}
        )
    )["by_type"]
    assert by_type["corpus.pool_imported"] == 1 and by_type["corpus.pool_withdrawn"] == 1


def test_a_complete_topic_screens_blind_to_the_pool(database: Database, tmp_path: Path) -> None:
    project = Project(database, tmp_path, "M1")
    pid, lead, ok = project.pid, project.lead, project.ok
    ok(_upload(project, _known_papers()), 201)
    ok(project.client.post(f"/api/projects/{pid}/corpus/ingest", json={"actor_id": lead}), 201)
    sentinels = [s.model_dump(mode="json") for s in SENTINELS]
    stage = {"scope_id": SCOPE, "stage": "title_abstract", "actor_id": lead, "sentinels": sentinels}
    ok(project.client.post(f"/api/projects/{pid}/screening/stages", json=stage), 201)
    with database.transaction() as tx:
        tx.execute(
            "update job set run_after = now() + interval '1 hour' where project_id <> %s"
            " and status = 'queued'",
            (pid,),
        )
    worker = Worker(database, PostgresJobQueue(), job_handlers(project.ctx), name="pool-test")
    while worker.run_once():
        pass

    assert sum(bool(r["in_known_pool"]) for r in project.table(lead)) == 2
    for person in project.reviewers:
        rows = project.table(person)
        assert rows and all(r["in_known_pool"] is None for r in rows)
