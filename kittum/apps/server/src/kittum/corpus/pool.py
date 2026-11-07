"""A search topic's known pool (DESIGN.md, "Complete the pool").

The pool is the set of papers the topic's searches are expected to find, such as the ones a
customer already has. It is imported from their files and compared with the topic's search
results by the corpus's own identity rules: report identifiers (DOI, PMID, PMCID) first, then a
fuzzy title with the year or the first author (`check_same_record`). The comparison splits the
pool into papers the searches found and papers they missed, and the search results into those in
the pool and new ones. Pool papers are never search results: they enter no execution, no corpus
revision, and no PRISMA count.
"""

from datetime import datetime
from typing import TYPE_CHECKING, Literal

from rapidfuzz import fuzz, process

from kittum.core import Id, NotFoundError, Record, canonical_doi, new_id
from kittum.corpus.dedupe import (
    check_same_record,
    normalize_pmcid,
    normalize_pmid,
    normalize_title,
)
from kittum.ledger import EventDraft
from kittum.search import SourceRecord, list_executions

if TYPE_CHECKING:
    from collections.abc import Sequence

    from kittum.db import Tx
    from kittum.ledger import Ledger


class KnownPoolFile(Record):
    """One imported pool file. A withdrawn file stays listed but no longer counts."""

    id: Id
    topic_id: str
    format: str
    file_name: str | None = None
    file_hash: str
    entries: int
    imported_by: Id
    imported_at: datetime
    withdrawn_at: datetime | None = None


class PoolEntry(Record):
    id: Id
    file_id: Id
    record: SourceRecord


class PoolMatch(Record):
    """A pool paper the topic's searches found: the search results it is (`refs`), and why."""

    entry: PoolEntry
    refs: tuple[str, ...]
    evidence: str


type PoolBasis = Literal["reports", "records"]


class PoolComparison(Record):
    """The topic's pool beside its searches.

    `basis` is `reports` once the corpus is built: `refs` are report IDs (the screening item
    references) and `searched` and `new` count deduplicated reports. Before that it is `records`:
    `refs` are occurrence IDs and the counts are search records before deduplication.
    """

    topic_id: str
    basis: PoolBasis
    files: tuple[KnownPoolFile, ...]
    pool_size: int
    found: tuple[PoolMatch, ...]
    not_found: tuple[PoolEntry, ...]
    searched: int
    """Search results of the topic, as `basis` counts them."""
    in_pool: int
    """Search results that are a paper of the pool."""
    new: int
    """Search results that are not in the pool: the ones that need screening."""


_FILE_COLUMNS = (
    "id, topic_id, format, file_name, file_hash, entries, imported_by, imported_at, withdrawn_at"
)


def import_known_pool(
    tx: Tx,
    project_id: Id,
    topic_id: str,
    records: Sequence[SourceRecord],
    *,
    file_hash: str,
    format: str,
    file_name: str | None,
    actor_id: Id,
    ledger: Ledger,
) -> KnownPoolFile:
    """Add a file of known papers to the topic's pool, with a `corpus.pool_imported` event. The
    caller stores the file by `file_hash` and checks that the topic exists."""
    if not records:
        raise ValueError("the file has no records")
    file_id = new_id()
    event = ledger.append(
        tx,
        EventDraft(
            project_id=project_id,
            type="corpus.pool_imported",
            schema_version=1,
            actor_id=actor_id,
            payload={
                "file_id": str(file_id),
                "topic_id": topic_id,
                "format": format,
                "file_name": file_name,
                "file_hash": file_hash,
                "entries": len(records),
            },
        ),
    )
    tx.execute(
        "insert into known_pool_file (id, project_id, topic_id, format, file_name, file_hash,"
        " entries, imported_by, imported_event_id, imported_at)"
        " values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (
            file_id,
            project_id,
            topic_id,
            format,
            file_name,
            file_hash,
            len(records),
            actor_id,
            event.event_id,
            event.recorded_at,
        ),
    )
    with tx.cursor() as cur:
        cur.executemany(
            "insert into known_pool_entry (id, file_id, ordinal, record) values (%s, %s, %s, %s)",
            [(r.occurrence_id, file_id, i, r.model_dump_json()) for i, r in enumerate(records)],
        )
    return KnownPoolFile(
        id=file_id,
        topic_id=topic_id,
        format=format,
        file_name=file_name,
        file_hash=file_hash,
        entries=len(records),
        imported_by=actor_id,
        imported_at=event.recorded_at,
    )


def withdraw_known_pool(
    tx: Tx, project_id: Id, file_id: Id, *, actor_id: Id, ledger: Ledger
) -> KnownPoolFile:
    """Take a pool file out of the comparison, with a `corpus.pool_withdrawn` event."""
    row = tx.execute(
        f"select {_FILE_COLUMNS}, withdrawn_event_id from known_pool_file"
        " where id = %s and project_id = %s for update",
        (file_id, project_id),
    ).fetchone()
    if row is None:
        raise NotFoundError(f"pool file {file_id} not found")
    if row["withdrawn_event_id"] is not None:
        raise ValueError("This file is out of the pool already.")
    event = ledger.append(
        tx,
        EventDraft(
            project_id=project_id,
            type="corpus.pool_withdrawn",
            schema_version=1,
            actor_id=actor_id,
            payload={
                "file_id": str(file_id),
                "topic_id": row["topic_id"],
                "file_hash": row["file_hash"],
                "entries": row["entries"],
            },
        ),
    )
    tx.execute(
        "update known_pool_file set withdrawn_by = %s, withdrawn_event_id = %s,"
        " withdrawn_at = %s where id = %s",
        (actor_id, event.event_id, event.recorded_at, file_id),
    )
    del row["withdrawn_event_id"]
    return KnownPoolFile.model_validate({**row, "withdrawn_at": event.recorded_at})


def pool_files(tx: Tx, project_id: Id, topic_id: str) -> list[KnownPoolFile]:
    """The topic's pool files, oldest first, withdrawn ones included."""
    rows = tx.execute(
        f"select {_FILE_COLUMNS} from known_pool_file where project_id = %s and topic_id = %s"
        " order by imported_at, id",
        (project_id, topic_id),
    ).fetchall()
    return [KnownPoolFile.model_validate(r) for r in rows]


def _entries(tx: Tx, project_id: Id, topic_id: str) -> list[PoolEntry]:
    rows = tx.execute(
        "select e.id, e.file_id, e.record from known_pool_entry e"
        " join known_pool_file f on f.id = e.file_id"
        " where f.project_id = %s and f.topic_id = %s and f.withdrawn_event_id is null"
        " order by f.imported_at, f.id, e.ordinal",
        (project_id, topic_id),
    ).fetchall()
    return [
        PoolEntry(id=r["id"], file_id=r["file_id"], record=SourceRecord.model_validate(r["record"]))
        for r in rows
    ]


def _search_results(
    tx: Tx, project_id: Id, topic_id: str
) -> tuple[PoolBasis, list[tuple[str, list[SourceRecord]]]]:
    """The topic's search results: the reports with a record from one of its searches, or each
    search record before the corpus is built."""
    from kittum.corpus import latest_revision, reports  # the package imports this module

    executions = list(reversed(list_executions(tx, project_id, topic_id=topic_id)))
    revision = latest_revision(tx, project_id)
    if revision is None:
        return "records", [(str(r.occurrence_id), [r]) for e in executions for r in e.records]
    mine = {r.occurrence_id for e in executions for r in e.records}
    return "reports", [
        (str(rep.report_id), list(rep.records))
        for rep in reports(tx, project_id, revision.id)
        if any(r.occurrence_id in mine for r in rep.records)
    ]


def _match(
    entries: Sequence[PoolEntry], units: Sequence[tuple[str, list[SourceRecord]]]
) -> dict[Id, tuple[list[str], str]]:
    """Each entry's matching units and the evidence of the first match."""
    by_doi: dict[str, set[int]] = {}
    by_pmid: dict[str, set[int]] = {}
    by_pmcid: dict[str, set[int]] = {}
    titles: list[str] = []
    title_unit: list[int] = []
    for i, (_, recs) in enumerate(units):
        for rec in recs:
            if doi := canonical_doi(rec.doi):
                by_doi.setdefault(doi, set()).add(i)
            if pmid := normalize_pmid(rec.pmid):
                by_pmid.setdefault(pmid, set()).add(i)
            if pmcid := normalize_pmcid(rec.pmcid):
                by_pmcid.setdefault(pmcid, set()).add(i)
            titles.append(normalize_title(rec.title))
            title_unit.append(i)
    found: dict[Id, tuple[list[str], str]] = {}
    for entry in entries:
        rec = entry.record
        candidates = set(by_doi.get(canonical_doi(rec.doi) or "", ()))
        candidates |= by_pmid.get(normalize_pmid(rec.pmid) or "", set())
        candidates |= by_pmcid.get(normalize_pmcid(rec.pmcid) or "", set())
        # `check_same_record` needs titles at least 90% alike, so only those are candidates.
        if title := normalize_title(rec.title):
            for _, _, at in process.extract(
                title, titles, scorer=fuzz.token_sort_ratio, score_cutoff=90, limit=None
            ):
                candidates.add(title_unit[at])
        refs: list[str] = []
        evidence = ""
        for i in sorted(candidates):
            ref, recs = units[i]
            for other in recs:
                same, why = check_same_record(rec, other)
                if same:
                    refs.append(ref)
                    evidence = evidence or why or ""
                    break
        if refs:
            found[entry.id] = (refs, evidence)
    return found


def compare_known_pool(tx: Tx, project_id: Id, topic_id: str) -> PoolComparison:
    """The topic's pool beside its search results (see `PoolComparison`)."""
    files = pool_files(tx, project_id, topic_id)
    entries = _entries(tx, project_id, topic_id)
    basis, units = _search_results(tx, project_id, topic_id)
    matched = _match(entries, units)
    in_pool = {ref for refs, _ in matched.values() for ref in refs}
    return PoolComparison(
        topic_id=topic_id,
        basis=basis,
        files=tuple(files),
        pool_size=len(entries),
        found=tuple(
            PoolMatch(entry=e, refs=tuple(matched[e.id][0]), evidence=matched[e.id][1])
            for e in entries
            if e.id in matched
        ),
        not_found=tuple(e for e in entries if e.id not in matched),
        searched=len(units),
        in_pool=len(in_pool),
        new=len(units) - len(in_pool),
    )


def known_pool_refs(tx: Tx, project_id: Id, topic_id: str) -> frozenset[str] | None:
    """The report IDs of the topic's search results that are in its pool, or None when the topic
    has no pool or the corpus is not built yet."""
    has_pool = tx.execute(
        "select 1 from known_pool_file where project_id = %s and topic_id = %s"
        " and withdrawn_event_id is null limit 1",
        (project_id, topic_id),
    ).fetchone()
    if has_pool is None:
        return None
    comparison = compare_known_pool(tx, project_id, topic_id)
    if comparison.basis != "reports":
        return None
    return frozenset(ref for m in comparison.found for ref in m.refs)
