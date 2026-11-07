"""A RoB 2 appraisal over HTTP, on a real cluster-randomized trial screened to full text.

The Lesotho trial (Gerber et al. 2026) is included at full text by both reviewers. Only then can
it be appraised, and only by someone who may see its extraction: the auditor, who has not yet
screened her audit sample, learns nothing of it. The methods lead appraises one result: quotes
adopted from the instrument's mentions and checked against the PDF, a question refused until the
answers it depends on are there, the domain judgements proposed as the published algorithms say,
an override with a reason and its retraction. The ledger trace of the report tells it in words,
and the `risk_of_bias` report shows the table as of any event. Runs on a rolled-back connection,
with the recorded judge in a worker on the same connection.
"""

import csv
import io
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest
from fastapi.testclient import TestClient

from kittum.api import AppContext, create_app
from kittum.app import job_handlers
from kittum.app.demo import DATA, PDFS, PROTOCOL, demo_judge
from kittum.core import new_id
from kittum.ledger import PostgresLedger
from kittum.models import ModelRegistry
from kittum.report import head_seq
from kittum.runs import PostgresJobQueue, PostgresReceipts, Worker
from kittum.settings import Settings
from kittum.storage import MemoryStore
from tests.documents.conftest import savepoint_db

if TYPE_CHECKING:
    from kittum.db import Tx

pytestmark = pytest.mark.postgres

SENTINELS = PROTOCOL.parents[1] / "sentinels" / "nicotine-replacement.yaml"
LESOTHO = PDFS / "gerber2026-lesotho-t2d-crct.pdf"
VITAMIN_C = PDFS / "li2026-vitamin-c-kidney-biopsy-rct.pdf"
TRIAL_DOI = "10.1186/s12916-026-04943-4"
SCOPE = "nrt-vs-control"
RESULT = "HbA1c at 12 months, primary analysis set"


def test_a_rob2_appraisal_from_quotes_to_the_report(pg: Tx) -> None:
    queue = PostgresJobQueue()
    ctx = AppContext(
        settings=Settings(database_url="postgresql://unused", artifact_dir=Path("unused")),
        db=savepoint_db(pg),
        artifacts=MemoryStore(),
        ledger=PostgresLedger(),
        judge=demo_judge(ModelRegistry.load()),
        queue=queue,
        receipts=PostgresReceipts(),
    )
    client = TestClient(create_app(ctx))
    worker = Worker(ctx.db, queue, job_handlers(ctx), name="rob", lease=timedelta(minutes=30))

    def ok(response: Any, status: int = 200) -> Any:
        assert response.status_code == status, response.text
        return response.json()

    def work() -> None:
        while worker.run_once():
            pass

    project = ok(client.post("/api/projects", json={"name": "NRT", "lead_name": "Morgan"}), 201)
    pid = project["id"]
    lead = project["members"][0]["actor_id"]
    people = {"Morgan": lead}
    for name, role in (
        ("Sam", "reviewer"),
        ("Jun", "reviewer"),
        ("Rita", "auditor"),
        ("Elena", "adjudicator"),
    ):
        body = {"display_name": name, "roles": [role], "added_by": lead}
        people[name] = ok(client.post(f"/api/projects/{pid}/members", json=body), 201)["actor_id"]
    source = ok(client.post("/api/protocol/parse", json={"text": PROTOCOL.read_text()}))["source"]
    draft = ok(client.post(f"/api/projects/{pid}/protocol-versions", json=source), 201)
    ok(
        client.post(
            f"/api/projects/{pid}/protocol-versions/{draft['id']}/publish",
            json={"approved_by": lead},
        )
    )
    plan = {"topic_id": "TRIALS", "source": "citation_search", "platform": "Lists", "strategy": "x"}
    body = {"plan": plan, "data": (DATA / "citation_search.ris").read_text(), "format": "ris"}
    ok(client.post(f"/api/projects/{pid}/search/import", json=body | {"actor_id": lead}))
    ok(client.post(f"/api/projects/{pid}/corpus/ingest", json={"actor_id": lead}), 201)
    sentinels = ok(
        client.post(
            f"/api/projects/{pid}/screening/sentinels/parse", json={"text": SENTINELS.read_text()}
        )
    )
    stage = {"scope_id": SCOPE, "stage": "title_abstract", "actor_id": lead}
    ok(
        client.post(f"/api/projects/{pid}/screening/stages", json=stage | {"sentinels": sentinels}),
        201,
    )
    work()

    def as_(person: str) -> dict[str, str]:
        return {"X-Kittum-Reviewer": people.get(person, str(new_id()))}

    def screen(person: str, stage: str, decision: Any) -> None:
        """Decide everything in the person's queue at `stage`; keep the decision on a reveal."""
        params = {"scope_id": SCOPE, "stage": stage, "limit": 50}
        items = ok(
            client.get(f"/api/projects/{pid}/screening/queue", params=params, headers=as_(person))
        )
        for item in items:
            now = datetime.now(UTC).isoformat()
            timing = {"shown_at": now, "first_key_at": now, "decided_at": now}
            path = f"/api/projects/{pid}/screening/assignments/{item['assignment_id']}/decide"
            payload = {
                "decision": decision(item, as_(person)),
                "timing": timing | {"reveal_shown_at": None},
                "expected_etag": item["etag"],
            }
            result = ok(
                client.post(
                    path,
                    json=payload | {"command_id": str(new_id()), "phase": "provisional"},
                    headers=as_(person),
                )
            )
            if result["phase"] == "provisional":
                final = payload | {
                    "expected_etag": result["etag"],
                    "timing": timing | {"reveal_shown_at": now},
                }
                ok(
                    client.post(
                        path,
                        json=final | {"command_id": str(new_id()), "phase": "final"},
                        headers=as_(person),
                    )
                )

    def include_ta(_item: Any, _headers: Any) -> dict[str, Any]:
        return {
            "outcome": "include",
            "reason_criterion_id": None,
            "evidence_anchor_ids": [],
            "comment": None,
            "criteria": [],
        }

    def include_ft(item: Any, headers: Any) -> dict[str, Any]:
        source = ok(
            client.get(
                f"/api/projects/{pid}/screening/assignments/{item['assignment_id']}/full-text",
                headers=headers,
            )
        )
        mention = next(a for c in source["mentions"] for a in c["mentions"])
        anchor = ok(
            client.post(
                f"/api/layers/{source['layer_id']}/anchors",
                json={"quote": mention["quote"]["exact"], "start": mention["start"]},
            ),
            201,
        )
        return include_ta(item, headers) | {"evidence_anchor_ids": [anchor["id"]]}

    base = f"/api/projects/{pid}/appraisal"
    for person in ("Sam", "Jun"):
        screen(person, "title_abstract", include_ta)
    reports = ok(client.get(f"/api/projects/{pid}/full-texts", headers=as_("Morgan")))
    trial = next(r for r in reports if r["doi"] == TRIAL_DOI)
    pdf = {"headers": {"Content-Type": "application/pdf"}}
    ok(
        client.post(
            f"/api/projects/{pid}/full-texts/{trial['item_ref']}",
            params={"actor_id": lead},
            content=LESOTHO.read_bytes(),
            **pdf,
        ),
        201,
    )
    other = ok(
        client.post(
            f"/api/projects/{pid}/full-text-sentinels",
            params={"actor_id": lead, "title": "Vitamin C", "expected_outcome": "exclude"},
            content=VITAMIN_C.read_bytes(),
            **pdf,
        ),
        201,
    )
    start = {"command_id": str(new_id()), "report_id": trial["report_id"], "result": RESULT}

    # Included at title and abstract only: nothing to appraise yet.
    assert ok(client.get(f"{base}/reports", headers=as_("Morgan"))) == []
    assert client.post(f"{base}/appraisals", json=start, headers=as_("Morgan")).status_code == 404

    ft = {"scope_id": SCOPE, "stage": "full_text", "actor_id": lead}
    ok(client.post(f"/api/projects/{pid}/screening/stages", json=ft), 201)
    work()
    for person in ("Sam", "Jun"):
        screen(person, "full_text", include_ft)

    listed = ok(client.get(f"{base}/reports", headers=as_("Morgan")))
    assert [(r["report_id"], r["appraisals"]) for r in listed] == [(trial["report_id"], [])]
    # The auditor's audit sample at full text is the trial and she has not screened it; a
    # stranger is no member. Neither learns of the report or can appraise it.
    for person in ("Rita", "stranger"):
        assert ok(client.get(f"{base}/reports", headers=as_(person))) == [], person
        refused = client.post(f"{base}/appraisals", json=start, headers=as_(person))
        assert refused.status_code == 404, person

    appraisal = ok(client.post(f"{base}/appraisals", json=start, headers=as_("Morgan")), 201)
    aid = appraisal["id"]
    retried = ok(client.post(f"{base}/appraisals", json=start, headers=as_("Morgan")), 201)
    assert retried["id"] == aid
    again = client.post(
        f"{base}/appraisals", json=start | {"command_id": str(new_id())}, headers=as_("Morgan")
    )
    assert again.status_code == 409 and "already has" in again.json()["detail"]
    assert [d["id"] for d in appraisal["domains"]] == ["D1", "D2", "D3", "D4", "D5"]
    assert appraisal["judgement"] is None

    screen_view = ok(client.get(f"{base}/appraisals/{aid}/screen", headers=as_("Morgan")))
    layer = screen_view["layer"]
    found = {m["question_id"]: m["mentions"] for m in screen_view["mentions"]}
    # The instrument's words for 1.2 find the trial's allocation method, in document order.
    concealment = next(
        m for m in found["1.2"] if "statistician" in m["quote"]["suffix"] + m["quote"]["exact"]
    )
    assert [m["start"] for m in found["1.2"]] == sorted(m["start"] for m in found["1.2"])

    def anchor(quote: str, start: int | None = None, layer_id: str = layer["id"]) -> str:
        body: dict[str, Any] = {"quote": quote}
        if start is not None:
            body["start"] = start
        elif layer_id != layer["id"]:
            body["occurrence"] = 0
        return ok(client.post(f"/api/layers/{layer_id}/anchors", json=body), 201)["id"]

    def answer(question: str, value: str, quotes: tuple[str, ...] = ()) -> Any:
        body = {
            "command_id": str(new_id()),
            "question_id": question,
            "answer": value,
            "anchor_ids": list(quotes),
        }
        return client.post(f"{base}/appraisals/{aid}/answers", json=body, headers=as_("Morgan"))

    def domain(view: Any, domain_id: str) -> Any:
        return next(d for d in view["domains"] if d["id"] == domain_id)

    random = anchor(
        "Half of the ComBaCaL cohort villages were randomly allocated to the intervention arm"
    )
    ok(answer("1.1", "yes", (random,)))
    allocated = anchor(concealment["quote"]["exact"], concealment["start"])
    ok(answer("1.2", "probably_yes", (allocated,)))
    view = ok(answer("1.3", "no"))
    d1 = domain(view, "D1")
    assert (d1["proposed"], d1["judgement"]) == ("low", "low")
    q11 = d1["questions"][0]
    assert q11["answer"] == "yes" and q11["answered_by"] == lead
    assert [" ".join(e["quote"]["exact"].split()) for e in q11["evidence"]] == [
        "Half of the ComBaCaL cohort villages were randomly allocated to the intervention arm"
    ]
    assert q11["evidence"][0]["boxes"], "the quote is marked on the page"

    # A quote must be from the appraised PDF: the sentinel's PDF is another document.
    elsewhere = anchor("vitamin C", layer_id=other["layer_id"])
    refused = answer("1.1", "yes", (elsewhere,))
    assert refused.status_code == 409 and "another document" in refused.json()["detail"]
    # 2.3 waits for 2.1 and 2.2; 3.2 has no "no information".
    early = answer("2.3", "no")
    assert early.status_code == 409 and "Answer 2.1, 2.2 first" in early.json()["detail"]
    ok(answer("3.1", "probably_no"))
    no_ni = answer("3.2", "no_information")
    assert no_ni.status_code == 409 and "has no answer" in no_ni.json()["detail"]

    # Domain 2: an open-label cluster trial; no deviations because of the trial context.
    unmasked = anchor("Thus, they were not masked to the intervention.")
    ok(answer("2.1", "yes", (unmasked,)))
    ok(answer("2.2", "yes", (unmasked,)))
    ok(answer("2.3", "probably_no"))
    view = ok(answer("2.6", "yes"))
    assert domain(view, "D2")["proposed"] == "low"
    # Deviations after all: 2.4 now applies and the domain waits for it.
    view = ok(answer("2.3", "yes"))
    d2 = domain(view, "D2")
    assert d2["proposed"] is None
    assert {q["id"]: q["applies"] for q in d2["questions"]}["2.4"] == "yes"
    ok(answer("2.3", "no"))

    # Domain 3: missing data imputed under missing at random, which could depend on HbA1c.
    imputed = anchor("missing-at-random assumption")
    ok(answer("3.2", "probably_no", (imputed,)))
    ok(answer("3.3", "probably_yes"))
    view = ok(answer("3.4", "probably_no"))
    assert domain(view, "D3")["proposed"] == "some_concerns"
    for q, value in (("4.1", "no"), ("4.2", "no"), ("4.3", "yes"), ("4.4", "probably_no")):
        view = ok(answer(q, value))
    assert domain(view, "D4")["proposed"] == "low"
    plan_quote = anchor("the full protocol and statistical analysis plan are")
    ok(answer("5.1", "probably_yes", (plan_quote,)))
    ok(answer("5.2", "no"))
    before_override = ok(answer("5.3", "probably_no"))
    assert [d["judgement"] for d in before_override["domains"]] == [
        "low",
        "low",
        "some_concerns",
        "low",
        "low",
    ]
    assert before_override["proposed"] == before_override["judgement"] == "some_concerns"
    cutoff = head_seq(pg, pid)

    def override(target: str, judgement: str | None, reason: str | None) -> Any:
        body = {
            "command_id": str(new_id()),
            "target": target,
            "judgement": judgement,
            "reason": reason,
        }
        return client.post(f"{base}/appraisals/{aid}/overrides", json=body, headers=as_("Morgan"))

    bare = override("D3", "low", "  ")
    assert bare.status_code == 409 and "needs a reason" in bare.json()["detail"]
    reason = "Multiple imputation with sensitivity analyses under missing not at random agreed."
    view = ok(override("D3", "low", reason))
    d3 = domain(view, "D3")
    assert (d3["proposed"], d3["judgement"], d3["override"]["reason"]) == (
        "some_concerns",
        "low",
        reason,
    )
    assert view["proposed"] == view["judgement"] == "low"
    ok(override("overall", "high", "Concerns across domains lower confidence."))
    view = ok(override("overall", None, None))
    assert view["override"] is None and view["judgement"] == "low"
    nothing = override("overall", None, None)
    assert nothing.status_code == 409 and "no override" in nothing.json()["detail"]

    listed = ok(client.get(f"{base}/reports", headers=as_("Morgan")))
    summary = listed[0]["appraisals"][0]
    assert (summary["result"], summary["judgement"], summary["open"]) == (RESULT, "low", 0)
    assert [d["overridden"] for d in summary["domains"]] == [False, False, True, False, False]

    # The report's trace tells each step in words, with its quotes.
    trace = ok(
        client.get(
            f"/api/projects/{pid}/audit/records/{trial['report_id']}/trace", headers=as_("Morgan")
        )
    )
    rob = [e for e in trace["events"] if e["kind"] == "appraisal"]
    assert rob[0]["summary"] == f"Morgan started a risk-of-bias appraisal of {RESULT!r}"
    assert any(
        e["summary"].startswith("Morgan answered 1.1 with 'yes'")
        and any("randomly allocated" in (f["value"] or "") for f in e["facts"])
        for e in rob
    )
    assert any(e["summary"] == "Morgan judged D3 low against the algorithm" for e in rob)
    assert rob[-1]["summary"] == "Morgan took back the override of the overall judgement"

    def rendered(cutoff_seq: int | None = None) -> dict[str, bytes]:
        reports = f"/api/projects/{pid}/reports"
        body = {"actor_id": lead, "cutoff_seq": cutoff_seq}
        artifact = ok(client.post(f"{reports}/targets/risk_of_bias/render", json=body))["artifact"]
        files = {}
        for f in artifact["files"]:
            got = client.get(f"{reports}/artifacts/{f['sha256']}", headers=as_("Morgan"))
            assert got.status_code == 200, got.text
            files[f["path"]] = got.content
        return files

    now = rendered()
    table = now["risk_of_bias.md"].decode()
    assert "| Study | Result | D1 | D2 | D3 | D4 | D5 | Overall |" in table
    assert f"| {RESULT} | Low | Low | Low † | Low | Low | Low |" in table
    rows = list(csv.DictReader(io.StringIO(now["risk_of_bias.csv"].decode())))
    d3_row = next(r for r in rows if r["domain"] == "D3")
    assert (d3_row["proposed"], d3_row["judgement"], d3_row["override_reason"]) == (
        "some_concerns",
        "low",
        reason,
    )
    # As of the event before the first override, D3 and the result had some concerns.
    then = json.loads(rendered(cutoff)["risk_of_bias.json"])
    overall = next(r for r in then["rows"] if r["domain"] == "overall")
    assert (overall["judgement"], overall["override_reason"]) == ("some_concerns", None)
