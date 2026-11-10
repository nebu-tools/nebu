"""The AI-use disclosure says which decisions were blind from what the ledger recorded, never from
a fixed sentence: in a mode S stage whose reveal setting is before, a person who decides once the
AI has read the record has its reading on screen, and the disclosure counts those decisions apart
from the blind ones, per stage and per pair it compares."""

import json
import xml.etree.ElementTree as ET
from typing import TYPE_CHECKING

import pytest

from kittum.report import load_review, render_files
from tests.screening.support import build_world, recorded_backend
from tests.screening.test_targeted import INCLUDE, decide, open_s, queue

if TYPE_CHECKING:
    from kittum.db import Database, Tx

pytestmark = pytest.mark.postgres


def test_decisions_with_the_ai_on_screen_are_counted_apart_from_blind_ones(
    database: Database,
) -> None:
    world = build_world(database, "S")
    a, b = world.people.a, world.people.b
    open_s(world, (a, b), reveal="before")

    # A decides one record before the judge has read anything: blind.
    decide(world, a, queue(world, a)[0], INCLUDE)
    # The judge reads the rest, and from then on every decision has its reading on screen.
    world.backend = recorded_backend(world.records, world.criteria())
    world.run_judge_jobs(world.backend)
    for person in (a, b):
        for item in queue(world, person):
            assert item.ai is not None
            decide(world, person, item, INCLUDE, ai_on_screen=True)

    with world.db.transaction() as tx:
        review = load_review(tx, world.project_id, store=world.artifacts)
    files = {f.path: f.data.decode() for f in render_files(review, "ai_disclosure")}
    (stage,) = json.loads(files["ai_disclosure.json"])["stages"]
    total = len(world.records)
    assert stage["reveal"] == "before"
    assert stage["first_decisions"] == {"total": total, "ai_on_screen": total - 1}
    # The judge read A's first record too, after A had decided it: A's pairs with the AI cover
    # it as a blind decision, and every other record as one made with the reading on screen.
    pairs = {(p["kind"], p["actor_ids"][0]): p for p in stage["agreement"]}
    own_a, checked_a = pairs["human_ai", str(a)], pairs["human_ai_verified", str(a)]
    own_b = pairs["human_ai", str(b)]
    assert own_a["ai_on_screen"] == checked_a["ai_on_screen"] == own_a["items"] - 1
    assert own_b["ai_on_screen"] == own_b["items"] > 0
    assert own_a["items"] + own_b["items"] == total

    # The Markdown never calls these decisions blind, and says how many were not.
    text = files["ai_disclosure.md"]
    assert "Each was made blind" not in text
    assert (
        f"Title and abstract, scope {stage['scope_id']}: {total - 1} of {total} first decisions "
        "were made with the AI's reading on screen."
    ) in text
    assert "Agreement with the AI in that stage is not independent." in text
    assert f"On {own_b['items']} of them a person decided with the AI's reading on screen." in text


class _RollBack(Exception):
    """Ends a transaction that tampered with the ledger, so nothing of it stays."""


def test_reports_on_a_broken_ledger_say_they_are_unverified_drafts(database: Database) -> None:
    world = build_world(database, "S")
    a, b = world.people.a, world.people.b
    open_s(world, (a, b), reveal="never")
    # Run the stage's judge jobs here, so none is left queued for a later test's worker.
    world.backend = recorded_backend(world.records, world.criteria())
    world.run_judge_jobs(world.backend)
    decide(world, a, queue(world, a)[0], INCLUDE)

    def rendered(tx: Tx) -> dict[str, str]:
        review = load_review(tx, world.project_id, store=world.artifacts)
        return {
            f.path: f.data.decode()
            for target in ("prisma", "ai_disclosure", "risk_of_bias")
            for f in render_files(review, target)  # type: ignore[arg-type]
        }

    with world.db.transaction() as tx:
        sound = rendered(tx)
    assert "Unverified draft" not in "".join(sound.values())
    assert json.loads(sound["ai_disclosure.json"])["integrity"]["ok"] is True

    # Someone with the table owner's rights edits the third event in place.
    with pytest.raises(_RollBack), world.db.transaction() as tx:
        tx.execute("alter table audit_event disable trigger user")
        tx.execute(
            "update audit_event set payload = payload || '{\"edited\": true}'::jsonb"
            " where project_id = %s and seq = 3",
            (world.project_id,),
        )
        tx.execute("alter table audit_event enable trigger user")
        broken = rendered(tx)
        raise _RollBack

    warning = "Unverified draft: the ledger's hash chain breaks at event 3"
    drawings = [text for path, text in broken.items() if path.endswith(".svg")]
    assert drawings
    for drawing in drawings:
        said = " ".join(
            t.text or ""
            for t in ET.fromstring(drawing).iter("{http://www.w3.org/2000/svg}text")
            if t.get("class") == "warning"
        )
        # The figure sets its apostrophes as a paper would.
        assert said.startswith(warning.replace("'", "\u2019")), said
    assert broken["ai_disclosure.md"].split("\n")[2].startswith(f"**{warning}")
    assert warning in broken["risk_of_bias.md"]
    integrity = json.loads(broken["ai_disclosure.json"])["integrity"]
    assert (integrity["ok"], integrity["first_bad_seq"]) == (False, 3)
