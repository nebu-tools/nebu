"""A topic's known pool beside its searches (DESIGN.md, "Complete the pool").

The searches are exports of four databases (PubMed NBIB, Scopus CSV, Web of Science plain text
and tab-delimited) that all hold the NEJM paper of the lumacaftor trials; the pool is the team's
own list. The comparison uses the corpus's identity rules, before and after the corpus is built,
and the pool never becomes a search result."""

from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from kittum.core import new_id, sha256_hex
from kittum.corpus import (
    compare_known_pool,
    confirm_exact,
    get_counts,
    import_known_pool,
    ingest,
    known_pool_refs,
    latest_revision,
    withdraw_known_pool,
)
from kittum.ledger.testing import InMemoryLedger
from kittum.search import SearchPlan, SourceRecord, import_file, list_executions, parse_export
from kittum.storage import MemoryStore

if TYPE_CHECKING:
    from kittum.core import Id
    from kittum.db import Tx

pytestmark = pytest.mark.postgres

FIXTURES = Path(__file__).parents[1] / "search" / "fixtures"
TOPIC = "cf"


@pytest.fixture
def people(pg: Tx) -> tuple[Id, Id]:
    project_id, actor_id = new_id(), new_id()
    pg.execute(
        "insert into project (id, name, policy_version) values (%s, 'pool', 'v1')", (project_id,)
    )
    pg.execute(
        "insert into actor (id, identity_ref, kind) values (%s, 'lead@example.org', 'human')",
        (actor_id,),
    )
    return project_id, actor_id


def _search(pg: Tx, project_id: Id, actor_id: Id, ledger: InMemoryLedger, topic: str = TOPIC):
    for file, format in (
        ("pubmed_export.nbib", "nbib"),  # Wainwright 2015, Ratjen 2017
        ("scopus_export.csv", "scopus"),  # Wainwright 2015, Konstan 2017
        ("wos_export.txt", "wos"),  # Wainwright 2015, Milla 2017
    ):
        import_file(
            pg,
            project_id,
            SearchPlan(topic_id=topic, source=format, platform=format, strategy="lumacaftor"),
            (FIXTURES / file).read_bytes(),
            format,
            ledger=ledger,
            actor_id=actor_id,
            artifacts=MemoryStore(),
        )


def _pool(text: bytes, format: str = "records-csv") -> list[SourceRecord]:
    return parse_export(text, format, raw_hash=sha256_hex(text), source="known_pool")


def test_the_pool_splits_the_search_into_found_missed_and_new(
    pg: Tx, people: tuple[Id, Id]
) -> None:
    project_id, actor_id = people
    ledger = InMemoryLedger()
    _search(pg, project_id, actor_id, ledger)
    # Another topic's search finds the paper the pool misses; it does not count for this topic.
    import_file(
        pg,
        project_id,
        SearchPlan(topic_id="other", source="ris", platform="x", strategy="y"),
        b"TY  - JOUR\nTI  - Lumacaftor-ivacaftor in adults with cystic fibrosis: real-world lung"
        b" function in a national cohort\nAU  - Burgel, PR\nPY  - 2020\nER  - \n",
        "ris",
        ledger=ledger,
        actor_id=actor_id,
        artifacts=MemoryStore(),
    )

    # The team's list: Wainwright by DOI (with a resolver prefix), Milla by PMID, Burgel by
    # title only. A paper with the right title but another DOI is another paper.
    team = (FIXTURES / "team_list.csv").read_bytes() + (
        b"4;Lumacaftor-Ivacaftor in Patients with Cystic Fibrosis Homozygous for Phe508del CFTR"
        b";Wainwright CE;N Engl J Med;2015;10.1056/NEJMc1510000;;the correspondence\n"
    )
    entries = _pool(team)
    pool_file = import_known_pool(
        pg,
        project_id,
        TOPIC,
        entries,
        file_hash=sha256_hex(team),
        format="records-csv",
        file_name="team_list.csv",
        actor_id=actor_id,
        ledger=ledger,
    )
    assert pool_file.entries == 4

    # Before the corpus: the topic's six search records, duplicates not removed yet.
    before = compare_known_pool(pg, project_id, TOPIC)
    assert before.basis == "records" and before.pool_size == 4 and before.searched == 6
    found = {m.entry.record.title[:22]: m for m in before.found}
    assert set(found) == {"Lumacaftor-Ivacaftor i", "Lumacaftor/ivacaftor i"}
    wainwright = found["Lumacaftor-Ivacaftor i"]
    assert len(wainwright.refs) == 3  # PubMed, Scopus, and Web of Science all found it
    assert wainwright.evidence == "Same DOI 10.1056/nejmoa1409547"
    assert found["Lumacaftor/ivacaftor i"].evidence == "Same PMID 27805836"
    missed = sorted(e.record.title[:22] for e in before.not_found)
    assert missed == ["Lumacaftor-Ivacaftor i", "Lumacaftor-ivacaftor i"]  # the letter; Burgel
    assert (before.in_pool, before.new) == (4, 2)  # Ratjen and Konstan are new
    assert known_pool_refs(pg, project_id, TOPIC) is None  # no screening items before a corpus

    # After the corpus, the comparison counts reports; once the lead confirms the duplicates,
    # the NEJM paper is one report found by three databases.
    ingest(pg, project_id, list_executions(pg, project_id), actor_id=actor_id, ledger=ledger)
    revision = latest_revision(pg, project_id)
    assert revision is not None
    confirm_exact(pg, project_id, revision.id, actor_id, ledger=ledger)
    after = compare_known_pool(pg, project_id, TOPIC)
    assert after.basis == "reports" and after.searched == 4  # Wainwright, Ratjen, Konstan, Milla
    assert (after.in_pool, after.new) == (2, 2)
    refs = known_pool_refs(pg, project_id, TOPIC)
    assert refs == {ref for m in after.found for ref in m.refs} and len(refs) == 2

    # The pool is no search: PRISMA's identification counts hold the seven search records only.
    newest = latest_revision(pg, project_id)
    assert newest is not None
    counts = get_counts(pg, project_id, newest.id)
    assert counts.total_records_identified == 7 and "known_pool" not in str(counts)
    assert [e.type for e in ledger.events(pg, project_id)].count("corpus.pool_imported") == 1

    # A file taken out of the pool stops counting and the event says which file it was.
    withdrawn = withdraw_known_pool(pg, project_id, pool_file.id, actor_id=actor_id, ledger=ledger)
    assert withdrawn.withdrawn_at is not None
    emptied = compare_known_pool(pg, project_id, TOPIC)
    assert emptied.pool_size == 0 and emptied.new == 4 and len(emptied.files) == 1
    assert known_pool_refs(pg, project_id, TOPIC) is None
    last = ledger.events(pg, project_id)[-1]
    assert last.type == "corpus.pool_withdrawn"
    assert last.payload["file_hash"] == sha256_hex(team)
    with pytest.raises(ValueError, match="out of the pool already"):
        withdraw_known_pool(pg, project_id, pool_file.id, actor_id=actor_id, ledger=ledger)


def test_a_pool_paper_matches_on_title_year_and_author_when_the_ids_are_missing(
    pg: Tx, people: tuple[Id, Id]
) -> None:
    """A team's list often has no IDs: the title must be close, and the year or first author
    must agree, as for duplicates."""
    project_id, actor_id = people
    ledger = InMemoryLedger()
    _search(pg, project_id, actor_id, ledger)
    rows = (
        b"Title,Year,Authors\n"
        # Konstan's PROGRESS paper, its title as a reference list shortens the punctuation.
        b'"Assessment of safety and efficacy of long term treatment with combination lumacaftor'
        b" and ivacaftor therapy in patients with cystic fibrosis homozygous for the F508del CFTR"
        b' mutation PROGRESS a phase 3 extension study",2017,Konstan MW\n'
        # Ratjen's trial, with another first author and year: not the same paper.
        b'"Efficacy and safety of lumacaftor and ivacaftor in patients aged 6-11 years with cystic'
        b' fibrosis homozygous for F508del-CFTR: a randomised, placebo-controlled phase 3 trial",'
        b"2012,Smith J\n"
    )
    import_known_pool(
        pg,
        project_id,
        TOPIC,
        _pool(rows),
        file_hash=sha256_hex(rows),
        format="records-csv",
        file_name=None,
        actor_id=actor_id,
        ledger=ledger,
    )
    comparison = compare_known_pool(pg, project_id, TOPIC)
    (konstan,) = comparison.found
    assert konstan.entry.record.authors == ("Konstan MW",)
    assert konstan.evidence.startswith("Titles") and "same year 2017" in konstan.evidence
    (ratjen,) = comparison.not_found
    assert ratjen.record.year == 2012
