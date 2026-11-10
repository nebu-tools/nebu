"""`judge_many` against Postgres: verdict rows, raw outputs, ledger events, and the cache."""

import json
import os
import threading
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import psycopg
import pytest
from psycopg.rows import dict_row

from kittum.core import FixedClock
from kittum.judge import (
    PROMPT_VERSION,
    VERDICT_RECORDED,
    JudgeConfig,
    JudgeConfigConflict,
    build_request,
    config_prompt_version,
    judge_many,
    load_config,
    load_verdicts,
    register_config,
)
from kittum.ledger.testing import InMemoryLedger
from kittum.models import ModelRegistry
from kittum.models.testing import RecordedBackend
from kittum.protocol import JudgeInstructions
from kittum.storage import MemoryStore
from tests.judge.records import (
    ADOLESCENTS,
    ANSWERS,
    CHEMO_NAIVE,
    CONFIG,
    CRITERIA,
    EXCLUDED_CHEMO_NAIVE,
    INJECTED,
    SCOPE,
    answer,
    recorded,
)

if TYPE_CHECKING:
    from kittum.db import Tx
    from kittum.models.testing import RecordedBackend as Backend

pytestmark = pytest.mark.postgres

PROTOCOL_HASH = "a" * 64
ITEMS = [ADOLESCENTS, EXCLUDED_CHEMO_NAIVE, CHEMO_NAIVE, INJECTED]
RECIPE = ModelRegistry.load().get(CONFIG.model_id)


def _seed(pg: Tx) -> tuple[Any, Any]:
    project = pg.execute(
        "insert into project (name, policy_version) values ('NSCLC review', 'p1') returning id"
    ).fetchone()
    actor = pg.execute(
        "insert into actor (identity_ref, kind) values ('model:qwen3.8-27b-bf16', 'model')"
        " on conflict (identity_ref) do update set kind = excluded.kind returning id"
    ).fetchone()
    assert project and actor
    return project["id"], actor["id"]


def _run(
    pg: Tx,
    backend: Backend,
    ledger: InMemoryLedger,
    store: MemoryStore,
    ids: tuple[Any, Any],
    config: JudgeConfig = CONFIG,
) -> list[Any]:
    return judge_many(
        pg,
        ITEMS,
        project_id=ids[0],
        actor_id=ids[1],
        scope_id=SCOPE,
        criteria=CRITERIA,
        protocol_hash=PROTOCOL_HASH,
        config=config,
        recipe=RECIPE,
        backend=backend,
        ledger=ledger,
        store=store,
        clock=FixedClock(datetime(2026, 10, 28, 12, tzinfo=UTC)),
        concurrency=3,
    )


def test_a_batch_records_verdicts_and_a_rerun_makes_no_model_calls(pg: Tx) -> None:
    ids = _seed(pg)
    ledger, store = InMemoryLedger(), MemoryStore()
    backend = recorded(*ITEMS)

    verdicts = _run(pg, backend, ledger, store, ids)

    assert len(backend.requests) == 4
    assert [v.item_ref for v in verdicts] == [i.item_ref for i in ITEMS]
    assert [v.excludes for v in verdicts] == [False, False, True, False]

    rows = pg.execute(
        "select v.*, c.weights_hash, c.prompt_version from verdict v"
        " join judge_config c on c.id = v.judge_config_id"
        " where project_id = %s order by item_ref",
        (ids[0],),
    ).fetchall()
    assert {r["item_ref"]: r["excludes"] for r in rows} == {
        i.item_ref: v.excludes for i, v in zip(ITEMS, verdicts, strict=True)
    }
    injected = next(r for r in rows if r["item_ref"] == INJECTED.item_ref)
    assert injected["flags"] == ["injection_suspected"]
    assert injected["model_identity"] == "Qwen/Qwen3.8-27B"
    assert injected["prompt_version"] == "judge.v2"
    negated = next(r for r in rows if r["item_ref"] == EXCLUDED_CHEMO_NAIVE.item_ref)
    chemo = next(c for c in negated["criteria"] if c["criterion_id"] == "C_PRIOR_CHEMO")
    assert (chemo["status"], chemo["downgraded_from"], chemo["failed_check"]) == (
        "unclear",
        "not_met",
        "negation",
    )
    titles = {i.item_ref: i.title for i in ITEMS}
    # Raw output and the rendered request are in the store, so the verdict can be replayed.
    for row in rows:
        (attempt,) = row["attempts"]
        assert store.get(row["raw_output_hash"]) == store.get(attempt["output_hash"])
        rendered = json.loads(store.get(row["rendered_prompt_hash"]))
        assert titles[row["item_ref"]] in rendered["messages"][1]["content"]
        assert (rendered["temperature"], rendered["seed"]) == (0, 0)

    events = ledger.events(pg, ids[0])
    assert [e.type for e in events] == [VERDICT_RECORDED] * 4
    assert {e.payload["item_ref"]: e.payload["excludes"] for e in events} == {
        r["item_ref"]: r["excludes"] for r in rows
    }
    assert ledger.verify(pg, ids[0]).ok

    silent = RecordedBackend()  # raises if anything asks it
    again = _run(pg, silent, ledger, store, ids)
    assert silent.requests == []
    assert again == verdicts
    assert len(ledger.events(pg, ids[0])) == 4
    assert load_verdicts(pg, ids[0], scope_id=SCOPE, item_refs=[CHEMO_NAIVE.item_ref]) == [
        verdicts[2]
    ]


def test_a_new_seed_is_a_new_cache_key_and_a_reused_config_id_is_refused(pg: Tx) -> None:
    ids = _seed(pg)
    ledger, store = InMemoryLedger(), MemoryStore()
    _run(pg, recorded(*ITEMS), ledger, store, ids)

    with pytest.raises(JudgeConfigConflict, match="decoding"):
        _run(pg, RecordedBackend(), ledger, store, ids, CONFIG.model_copy(update={"seed": 5}))

    reseeded = CONFIG.model_copy(update={"id": "qwen-ta-v1-seed5", "seed": 5})
    backend = RecordedBackend(default='{"not": "valid"}')
    verdicts = _run(pg, backend, ledger, store, ids, reseeded)
    assert len(backend.requests) == 8  # four records, two attempts each
    assert all(v.flags == ("invalid_output",) for v in verdicts)
    assert not any(v.excludes for v in verdicts)
    row = pg.execute(
        "select attempts from verdict where judge_config_id = %s and item_ref = %s",
        (reseeded.id, ADOLESCENTS.item_ref),
    ).fetchone()
    assert row is not None
    assert [a["seed"] for a in row["attempts"]] == [5, 6]
    assert all(a["error"] for a in row["attempts"])


class CutOff:
    """A reasoning model that thinks through its whole budget: every answer ends at max_tokens."""

    def __init__(self, inner: Backend) -> None:
        self.inner = inner

    def complete(self, request: Any) -> Any:
        return self.inner.complete(request).model_copy(update={"finish_reason": "length"})


def test_an_answer_the_token_budget_cut_off_is_not_asked_for_again(pg: Tx) -> None:
    """The same budget would cut the answer off again, so the judge asks once per record and
    the verdict says why it is unclear."""
    ids = _seed(pg)
    config = CONFIG.model_copy(update={"id": "qwen-ta-v1-cut", "seed": 9})
    backend = RecordedBackend(default='{"c0": {"status": "met", "quote": "patients aged')
    verdicts = _run(pg, CutOff(backend), InMemoryLedger(), MemoryStore(), ids, config)
    assert len(backend.requests) == 4  # one attempt per record, not two
    message = (
        f"{CONFIG.model_id} ran out of tokens before it finished."
        f" Its limit was {CONFIG.max_tokens:,} tokens."
        " If the reasoning used most of them, raise reasoning_tokens in its recipe."
        " Otherwise ask again."
    )
    assert all(v.flags == ("invalid_output",) for v in verdicts)
    assert {c.rationale for v in verdicts for c in v.criteria} == {message}
    row = pg.execute(
        "select attempts from verdict where judge_config_id = %s and item_ref = %s",
        (config.id, ADOLESCENTS.item_ref),
    ).fetchone()
    assert row is not None
    assert [(a["finish_reason"], a["error"]) for a in row["attempts"]] == [("length", message)]


def test_verdict_rows_cannot_be_changed(pg: Tx) -> None:
    ids = _seed(pg)
    _run(pg, recorded(*ITEMS), InMemoryLedger(), MemoryStore(), ids)
    with pytest.raises(psycopg.errors.RaiseException, match="immutable"):
        pg.execute("update verdict set excludes = true where project_id = %s", (ids[0],))


@pytest.mark.usefixtures("pg")  # skips without a database
def test_concurrent_batches_record_each_verdict_once() -> None:
    """Two workers miss the cache together; the loser takes the winner's row and stays usable."""
    url = os.environ["KITTUM_DATABASE_URL"]
    config = CONFIG.model_copy(update={"id": f"race-{time.time_ns()}"})
    connect = lambda: psycopg.Connection[dict[str, Any]].connect(url, row_factory=dict_row)  # noqa: E731
    with connect() as first, connect() as second, connect() as watcher:
        watcher.autocommit = True
        ids = _seed(first)
        register_config(first, config, RECIPE, FixedClock(datetime(2026, 10, 28, tzinfo=UTC)))
        first.commit()
        try:
            winner_ledger, loser_ledger = InMemoryLedger(), InMemoryLedger()
            winner = _run(first, recorded(*ITEMS), winner_ledger, MemoryStore(), ids, config)
            # `first` holds its uncommitted rows; `second` misses the cache and blocks on insert.
            pid = second.execute("select pg_backend_pid() as pid").fetchone()["pid"]
            result: dict[str, Any] = {}

            def race() -> None:
                try:
                    backend = recorded(*ITEMS)
                    result["verdicts"] = _run(
                        second, backend, loser_ledger, MemoryStore(), ids, config
                    )
                    result["calls"] = len(backend.requests)
                    second.commit()
                except Exception as e:
                    result["error"] = e
                    second.rollback()

            thread = threading.Thread(target=race)
            thread.start()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and thread.is_alive():
                row = watcher.execute(
                    "select cardinality(pg_blocking_pids(%s)) as n", (pid,)
                ).fetchone()
                if row and row["n"]:
                    break
                time.sleep(0.02)
            first.commit()
            thread.join(timeout=10)

            assert "error" not in result, result.get("error")
            assert result["calls"] == len(ITEMS)  # it did miss the cache
            assert result["verdicts"] == winner
            assert len(winner_ledger.events(first, ids[0])) == len(ITEMS)
            assert loser_ledger.events(second, ids[0]) == []
            count = watcher.execute(
                "select count(*) as n from verdict where judge_config_id = %s", (config.id,)
            ).fetchone()
            assert count == {"n": len(ITEMS)}
        finally:
            first.rollback()
            watcher.execute("delete from verdict where judge_config_id = %s", (config.id,))
            watcher.execute("delete from judge_config where id = %s", (config.id,))
            watcher.execute("delete from project where id = %s", (ids[0],))


# What judge.v2 sent before judge.v3 existed: the request hashes recordings are keyed by, and the
# template hash its configs are registered with.
V2_REQUESTS = {
    ADOLESCENTS.item_ref: "90665e18e56c3ea494c6a6ada3d50e361f6df1db0c64bb52454472bd4ec7f3e5",
    CHEMO_NAIVE.item_ref: "e341ae9ee5344c514c66a421cf34cbcf10258b55f55f14a9c4ebaf343563224a",
}
V2_PROMPT_HASH = "e3109608fab2aa64a72a6367466580031fb537b431808bb871fd01e205d8c237"

V3_CRITERIA = """\
How to answer each criterion
- An inclusion criterion is a condition the record must meet. Answer `met` if the record meets \
it, `not_met` if the record shows that it does not, and `unclear` if the record does not say.
- An exclusion criterion is a condition the record must not show. Answer `met` if the record \
does not show it, `not_met` if the record shows it, and `unclear` if the record does not say.
- For `not_met`, copy a verbatim quote from the title and abstract: the exact, contiguous words \
that show it, without paraphrase, ellipsis, or translation. If you cannot quote such words, \
answer `unclear`.
- At title and abstract, absence of information is never `not_met`: answer `unclear`.
- Give each answer under the criterion's answer key.

Criteria. Judge every one:

### Criterion 1: Adults with NSCLC (population)
Answer key: `C_POP_ADULT_NSCLC`
Inclusion criterion. The record passes if it meets this condition:
DE: Erwachsene (ab 18 Jahren) mit nicht-kleinzelligem Lungenkarzinom
EN: Adults (18 years or older) with non-small cell lung cancer
Records that pass:
- adults with stage IV NSCLC
Records that do not pass:
- children with neuroblastoma

### Criterion 2: Population
Answer key: `C_PRIOR_CHEMO`
Inclusion criterion. The record passes if it meets this condition:
DE: Vorbehandlung mit Chemotherapie
EN: Previously treated with chemotherapy

### Criterion 3: RCT (study type)
Answer key: `C_RCT`
Inclusion criterion. The record passes if it meets this condition:
DE: Randomisierte kontrollierte Studie
EN: Randomised controlled trial"""


def test_a_judge_v2_config_keeps_its_prompt_and_a_judge_v3_config_states_the_rules_once(
    pg: Tx,
) -> None:
    """A config registered with judge.v2 sends byte for byte the requests recorded before
    judge.v3, so its recordings still answer; a judge.v3 config of the same model names each
    criterion by its number and short label, gives its ID once as the answer key, and states the
    shared rules once. The two are separate configs with separate verdicts and template hashes."""
    ids = _seed(pg)
    ledger, store = InMemoryLedger(), MemoryStore()
    labels = {"C_POP_ADULT_NSCLC": "Adults with NSCLC", "C_RCT": "RCT"}
    criteria = tuple(c.model_copy(update={"short_label": labels.get(c.id)}) for c in CRITERIA)
    numbers = {c.id: n for n, c in enumerate(criteria, start=1)}
    items = [ADOLESCENTS, CHEMO_NAIVE]
    v3 = JudgeConfig(id="qwen-ta-v3", model_id=CONFIG.model_id, prompt_version=PROMPT_VERSION)

    def run(config: JudgeConfig, backend: Backend) -> list[Any]:
        return judge_many(
            pg,
            items,
            project_id=ids[0],
            actor_id=ids[1],
            scope_id=SCOPE,
            criteria=criteria,
            protocol_hash=PROTOCOL_HASH,
            config=config,
            recipe=RECIPE,
            backend=backend,
            ledger=ledger,
            store=store,
            clock=FixedClock(datetime(2026, 11, 9, tzinfo=UTC)),
            numbers=numbers,
        )

    # No default answer: a v2 request that differs in one byte finds no recording and fails.
    old = RecordedBackend({V2_REQUESTS[i.item_ref]: ANSWERS[i.item_ref] for i in items})
    assert [v.excludes for v in run(CONFIG, old)] == [False, True]
    unclear = answer(**{c.id: ("unclear", "", "The record does not say.") for c in criteria})
    new = RecordedBackend(default=unclear)
    assert [v.judge_config_id for v in run(v3, new)] == [v3.id, v3.id]

    first = new.requests[0]
    assert first.messages[0] == old.requests[0].messages[0]  # the system message is the same
    user = first.messages[1].content
    assert user.startswith(f"Stage: title and abstract screening\n\n{V3_CRITERIA}\n\nThe record")
    assert user.count("verbatim") == user.count("absence of information") == 1
    assert user.count("Answer key:") == 3  # the full-text criterion is not asked
    assert first.json_schema == old.requests[0].json_schema  # the answer schema keys on IDs

    # A team's own user message gets the same block, rules included, in {criteria}.
    own = JudgeInstructions(user_template="Judge these:\n{criteria}\n\nRecord: {text}")
    request = build_request(ADOLESCENTS, criteria[:3], v3, instructions=own, numbers=numbers)
    assert request.messages[1].content.startswith(f"Judge these:\n{V3_CRITERIA}\n\nRecord: ")

    rows = pg.execute(
        "select id, prompt_version, prompt_hash from judge_config where id = any(%s) order by id",
        ([CONFIG.id, v3.id],),
    ).fetchall()
    assert [(r["id"], r["prompt_version"]) for r in rows] == [
        (CONFIG.id, "judge.v2"),
        (v3.id, "judge.v3"),
    ]
    assert rows[0]["prompt_hash"] == V2_PROMPT_HASH != rows[1]["prompt_hash"]
    assert load_config(pg, CONFIG.id) == CONFIG
    assert config_prompt_version(pg, v3.id) == "judge.v3"
    assert config_prompt_version(pg, "unregistered@judge.v2") == "judge.v2"
    assert len(load_verdicts(pg, ids[0])) == 4
