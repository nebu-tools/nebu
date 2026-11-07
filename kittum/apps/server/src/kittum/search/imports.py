"""File import adapters for RIS (generic, Cochrane CENTRAL, Embase), CSV (CTIS, EU-CTR), PubMed
XML (a PubMed or MEDLINE export saved as XML, as EFetch returns it), PubMed's MEDLINE format
(NBIB), Scopus CSV, Web of Science (plain text or tab-delimited), and a team's own list of records
as CSV or XLSX."""

import csv
import io
import re
import xml.etree.ElementTree as ET
from typing import TYPE_CHECKING

import rispy

from kittum.core import Clock, Id, SystemClock, new_id, sha256_hex
from kittum.search.bibliographic import (
    EUDRACT_PATTERN,
    NCT_PATTERN,
    parse_nbib,
    parse_records_csv,
    parse_records_xlsx,
    parse_scopus_csv,
    parse_wos,
    parse_year,
    registry_ids,
)
from kittum.search.models import SearchExecution, SearchPlan, SourceRecord
from kittum.search.pubmed import parse_pubmed_xml
from kittum.search.service import record_execution

if TYPE_CHECKING:
    from collections.abc import Callable

    from kittum.db import Tx
    from kittum.ledger import Ledger
    from kittum.storage import ArtifactStore

RIS_START = re.compile(r"(?m)^TY  - ")


def parse_ris(text: str, raw_hash: str, format_name: str) -> list[SourceRecord]:
    """Parse RIS text into SourceRecord models."""
    entries = rispy.loads(text)
    # rispy skips anything it cannot read, including a record without `ER`; count `TY` lines.
    expected = len(RIS_START.findall(text))
    if len(entries) != expected or (expected == 0 and text.strip()):
        raise ValueError(f"RIS file has {expected} TY lines but {len(entries)} readable records")
    records: list[SourceRecord] = []

    for ordinal, entry in enumerate(entries):
        title = entry.get("title") or entry.get("primary_title") or ""
        abstract = entry.get("abstract") or entry.get("notes_abstract")

        authors_list = entry.get("authors") or entry.get("first_authors") or []
        if isinstance(authors_list, str):
            authors_list = [authors_list]
        authors = tuple(authors_list)

        year = parse_year(entry.get("year") or entry.get("publication_year") or entry.get("date"))

        journal = (
            entry.get("journal_name")
            or entry.get("secondary_title")
            or entry.get("name_of_database")
        )

        doi = entry.get("doi")
        record_id = (
            entry.get("accession_number") or entry.get("id") or doi or f"{format_name}-{ordinal}"
        )

        type_ref = entry.get("type_of_reference")
        pub_types = (type_ref,) if type_ref else ("Journal Article",)

        notes = str(entry.get("notes") or "")
        reg_ids = registry_ids(title, abstract, notes, record_id)

        rec = SourceRecord(
            occurrence_id=new_id(),
            source=format_name,
            provider_record_id=str(record_id),
            ordinal=ordinal,
            title=title,
            abstract=abstract,
            authors=authors,
            year=year,
            journal=journal,
            doi=doi,
            pmid=None,
            registry_ids=reg_ids,
            publication_types=pub_types,
            raw_hash=raw_hash,
        )
        records.append(rec)

    return records


CSV_ID_COLUMNS = (
    "eu_ct_number",
    "eudract_number",
    "trial_number",
    "id",
    "protocol_number",
    "sponsor_protocol_number",
)
CSV_TITLE_COLUMNS = ("trial_title", "full_title", "title")


def _norm_key(key: str) -> str:
    return key.strip().lower().replace(" ", "_")


def _get_col(norm: dict[str, str], *keys: str) -> str | None:
    for k in keys:
        if norm.get(k):
            return norm[k].strip()
    return None


def parse_csv(text: str, raw_hash: str, format_name: str) -> list[SourceRecord]:
    """Parse CTIS or EU-CTR CSV into SourceRecord models."""
    try:
        # `strict` turns an unterminated quoted field into an error instead of swallowing the rest.
        fieldnames, *rows = [row for row in csv.reader(io.StringIO(text), strict=True) if row] or [
            []
        ]
    except csv.Error as exc:
        raise ValueError(f"CSV file is malformed: {exc}") from exc
    keys = [_norm_key(k) for k in fieldnames]
    if not set(keys) & set(CSV_ID_COLUMNS) or not set(keys) & set(CSV_TITLE_COLUMNS):
        raise ValueError(
            f"CSV header needs a trial ID column ({', '.join(CSV_ID_COLUMNS)}) "
            f"and a title column ({', '.join(CSV_TITLE_COLUMNS)})"
        )
    for number, row in enumerate(rows, start=1):
        if len(row) != len(keys):
            raise ValueError(
                f"CSV record {number} has {len(row)} fields; the header has {len(keys)}"
            )
    records: list[SourceRecord] = []

    for ordinal, row in enumerate(rows):
        norm = {k: v for k, v in zip(keys, row, strict=True) if k}

        record_id = _get_col(norm, *CSV_ID_COLUMNS) or f"{format_name}-{ordinal}"

        title = _get_col(norm, *CSV_TITLE_COLUMNS) or ""
        abstract = _get_col(
            norm, "brief_summary", "medical_condition", "disease", "condition", "summary"
        )
        sponsor = _get_col(norm, "sponsor_name", "sponsor")
        status = _get_col(norm, "trial_status", "status")
        phase = _get_col(norm, "phase", "trial_phase")
        start_date = _get_col(norm, "start_date", "date")
        year = parse_year(start_date)

        authors = (sponsor,) if sponsor else ()
        journal = sponsor

        pub_types: list[str] = []
        if phase:
            pub_types.append(f"Phase: {phase}" if not phase.lower().startswith("phase") else phase)
        if status:
            pub_types.append(f"Status: {status}")
        if not pub_types:
            pub_types.append("Clinical Trial")

        reg_ids = registry_ids(record_id, title, abstract)
        if (
            record_id
            and (NCT_PATTERN.match(record_id) or EUDRACT_PATTERN.match(record_id))
            and record_id not in reg_ids
        ):
            reg_ids = (record_id, *reg_ids)

        rec = SourceRecord(
            occurrence_id=new_id(),
            source=format_name,
            provider_record_id=record_id,
            ordinal=ordinal,
            title=title,
            abstract=abstract,
            authors=authors,
            year=year,
            journal=journal,
            doi=None,
            pmid=None,
            registry_ids=reg_ids,
            publication_types=tuple(pub_types),
            raw_hash=raw_hash,
        )
        records.append(rec)

    return records


def parse_pubmed_export(text: str, raw_hash: str, format_name: str) -> list[SourceRecord]:
    """PubMed XML saved from PubMed (Send to, File, XML) or EFetch, under the plan's source."""
    try:
        records = parse_pubmed_xml(text.encode("utf-8"), raw_hash)
    except ET.ParseError as exc:
        raise ValueError(f"not PubMed XML: {exc}") from exc
    return [r.model_copy(update={"source": format_name}) for r in records]


type _Parser = Callable[[str, str, str], list[SourceRecord]]

_TEXT_PARSERS: dict[str, _Parser] = {
    "ris": parse_ris,
    "central": parse_ris,
    "centralexport": parse_ris,
    "embase": parse_ris,
    "csv": parse_csv,
    "ctis": parse_csv,
    "euctr": parse_csv,
    "eu-ctr": parse_csv,
    "pubmed-xml": parse_pubmed_export,
    "nbib": parse_nbib,
    "medline": parse_nbib,
    "scopus": parse_scopus_csv,
    "scopus-csv": parse_scopus_csv,
    "wos": parse_wos,
    "records-csv": parse_records_csv,
}
_BINARY_PARSERS: dict[str, Callable[[bytes, str, str], list[SourceRecord]]] = {
    "records-xlsx": parse_records_xlsx,
}

IMPORT_FORMATS: tuple[str, ...] = tuple(sorted(_TEXT_PARSERS.keys() | _BINARY_PARSERS.keys()))
"""Every format name `import_file` and `parse_export` read."""


def _decode(raw: bytes) -> str:
    # Web of Science's tab-delimited export may come in UTF-16 with a byte order mark.
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            return raw.decode("utf-16")
        except UnicodeDecodeError as exc:
            raise ValueError(f"import file is not valid UTF-16: {exc}") from exc
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError(f"import file is not valid UTF-8: {exc}") from exc


def parse_export(
    data: bytes | str, format: str, *, raw_hash: str, source: str
) -> list[SourceRecord]:
    """The records of an export file in `format` (one of `IMPORT_FORMATS`), in file order, each
    from `source`. Raises `ValueError` for an unknown format or a file not in it."""
    name = format.lower()
    raw = data.encode("utf-8") if isinstance(data, str) else data
    if name in _BINARY_PARSERS:
        return _BINARY_PARSERS[name](raw, raw_hash, source)
    parse = _TEXT_PARSERS.get(name)
    if parse is None:
        raise ValueError(
            f"unsupported import format {format!r}; supported: {', '.join(IMPORT_FORMATS)}"
        )
    if name == "records-csv":
        try:
            text = _decode(raw)
        except ValueError:
            # A team's own list saved as plain "CSV" by Excel in a Western European locale is
            # windows-1252, not UTF-8.
            text = raw.decode("cp1252", errors="strict")
        return parse(text, raw_hash, source)
    return parse(_decode(raw), raw_hash, source)


def import_file(
    tx: Tx,
    project_id: Id,
    plan: SearchPlan,
    data: bytes | str,
    format: str,
    *,
    ledger: Ledger,
    actor_id: Id,
    artifacts: ArtifactStore,
    clock: Clock | None = None,
) -> SearchExecution:
    """Import records from an exported file in one of `IMPORT_FORMATS`.

    The file is stored as the execution's one raw artifact. Its record count is the reported count;
    an export carries no separate platform total.
    """
    if format.lower() not in IMPORT_FORMATS:
        raise ValueError(
            f"unsupported import format {format!r}; supported: {', '.join(IMPORT_FORMATS)}"
        )
    raw_bytes = data.encode("utf-8") if isinstance(data, str) else data
    now = (clock or SystemClock()).now()
    records = parse_export(raw_bytes, format, raw_hash=sha256_hex(raw_bytes), source=plan.source)
    raw_hash = artifacts.put(raw_bytes)

    execution = SearchExecution(
        id=new_id(),
        plan=plan,
        kind="file_import",
        started_at=now,
        ended_at=now,
        query_translation=None,
        reported_count=len(records),
        retrieved_count=len(records),
        raw_artifact_hashes=(raw_hash,),
        records=tuple(records),
    )
    return record_execution(
        tx, project_id, execution, ledger=ledger, actor_id=actor_id, artifacts=artifacts
    )
