"""Parsers for bibliographic database exports: PubMed's MEDLINE format (NBIB), Scopus CSV, Web of
Science (plain text and tab-delimited), and a team's own list of records as CSV or XLSX.

Every parser takes the decoded file and returns `SourceRecord`s in file order, with the
database's own accession (PMID, Scopus EID, Web of Science UT) as the provider record ID. A file
that is not in the format it was imported as is an error, never an empty search.
"""

import csv
import io
import re
from datetime import date, datetime
from typing import TYPE_CHECKING

from kittum.core import new_id
from kittum.search.models import SourceRecord

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence

NCT_PATTERN = re.compile(r"(?i)\b(NCT\d{8})\b")
EUDRACT_PATTERN = re.compile(r"\b(\d{4}-\d{6}-\d{2}(?:-\d{2})?)\b")
YEAR_PATTERN = re.compile(r"\b(1[89]\d\d|20\d\d)\b")


def registry_ids(*texts: str | None) -> tuple[str, ...]:
    """NCT and EudraCT numbers named anywhere in `texts`, in order, without repeats."""
    combined = " ".join(t for t in texts if t)
    found = [n.upper() for n in NCT_PATTERN.findall(combined)]
    found += EUDRACT_PATTERN.findall(combined)
    return tuple(dict.fromkeys(found))


def parse_year(text: object) -> int | None:
    if text is None:
        return None
    if isinstance(text, (date, datetime)):
        return text.year
    m = YEAR_PATTERN.search(str(text))
    return int(m.group(1)) if m else None


_DOI_PREFIX = re.compile(r"^\s*(?:https?://)?(?:(?:dx\.|www\.)?doi\.org/|doi:\s*)", re.I)


def bare_doi(value: str | None) -> str | None:
    """A DOI without a resolver prefix (`https://doi.org/`, `doi:`), in the case the file gives;
    comparisons go through `canonical_doi`."""
    if not value:
        return None
    return _DOI_PREFIX.sub("", value).strip() or None


def _record(
    *,
    source: str,
    provider_record_id: str,
    ordinal: int,
    title: str,
    abstract: str | None,
    authors: Iterable[str],
    year: int | None,
    journal: str | None,
    doi: str | None,
    pmid: str | None,
    publication_types: Iterable[str],
    raw_hash: str,
    pmcid: str | None = None,
    extra_registry_text: Iterable[str] = (),
) -> SourceRecord:
    return SourceRecord(
        occurrence_id=new_id(),
        source=source,
        provider_record_id=provider_record_id,
        ordinal=ordinal,
        title=title,
        abstract=abstract or None,
        authors=tuple(a for a in authors if a),
        year=year,
        journal=journal or None,
        doi=bare_doi(doi),
        pmid=pmid or None,
        pmcid=pmcid or None,
        registry_ids=registry_ids(title, abstract, *extra_registry_text),
        publication_types=tuple(dict.fromkeys(t for t in publication_types if t)),
        raw_hash=raw_hash,
    )


# PubMed's MEDLINE format, as "Send to: Citation manager" saves it (.nbib) and as EFetch returns
# it with `rettype=medline`. The element list is at
# https://www.nlm.nih.gov/bsd/mms/medlineelements.html: a tag of up to four characters padded to
# four, "- ", then the value; a value continues on lines indented by six spaces; a blank line ends
# a record, and every record starts with PMID.
_MEDLINE_LINE = re.compile(r"^([A-Z][A-Z0-9 ]{3})- ?(.*)$")
_DOI_SUFFIX = re.compile(r"\s*\[doi\]\s*$", re.I)


def _tagged_fields(lines: Sequence[str], tag: re.Pattern[str], indent: str) -> list[list[str]]:
    """Group a tagged file's lines into (tag, value) pairs, with continuation lines joined."""
    fields: list[list[str]] = []
    for line in lines:
        if not line.strip():
            continue
        if line.startswith(indent) and fields:
            fields[-1][1] += " " + line.strip()
            continue
        m = tag.match(line)
        if m is None:
            raise ValueError(f"line {line[:40]!r} is neither a tagged field nor a continuation")
        fields.append([m.group(1).strip(), m.group(2).strip()])
    return fields


def parse_nbib(text: str, raw_hash: str, source: str) -> list[SourceRecord]:
    """PubMed MEDLINE format (.nbib): one record per PMID."""
    blocks: list[list[str]] = []
    for line in text.splitlines():
        if line.startswith("PMID-"):
            blocks.append([])
        if blocks:
            blocks[-1].append(line)
        elif line.strip():
            raise ValueError("an NBIB file starts with a PMID line; this one does not")
    if not blocks:
        if text.strip():
            raise ValueError("NBIB file has no PMID lines")
        return []
    records = []
    for ordinal, block in enumerate(blocks):
        fields: dict[str, list[str]] = {}
        for tag, value in _tagged_fields(block, _MEDLINE_LINE, "      "):
            fields.setdefault(tag, []).append(value)
        pmid = fields["PMID"][0].strip()
        if not pmid.isdigit():
            raise ValueError(f"NBIB record {ordinal + 1} has PMID {pmid!r}, not a number")
        dois = [
            _DOI_SUFFIX.sub("", v)
            for v in fields.get("AID", []) + fields.get("LID", [])
            if _DOI_SUFFIX.search(v)
        ]
        pmc = next(iter(fields.get("PMC", [])), None)
        # Individual authors in PubMed's "Last Initials" form, as the XML import writes them, and
        # group authors after them.
        authors = fields.get("AU", []) + fields.get("CN", [])
        records.append(
            _record(
                source=source,
                provider_record_id=pmid,
                ordinal=ordinal,
                title=" ".join(fields.get("TI", []) or fields.get("BTI", [])).strip(),
                abstract=" ".join(fields.get("AB", [])).strip() or None,
                authors=authors,
                year=parse_year(next(iter(fields.get("DP", [])), None)),
                journal=next(iter(fields.get("JT", []) or fields.get("TA", [])), None),
                doi=dois[0] if dois else None,
                pmid=pmid,
                pmcid=pmc,
                publication_types=fields.get("PT", []),
                raw_hash=raw_hash,
                extra_registry_text=fields.get("SI", []),
            )
        )
    return records


# Web of Science's field tags (https://webofscience.help.clarivate.com/en-us/Content/
# wos-core-collection/wos-full-record.htm, "Field tags"): PT publication type, AU authors, TI
# title, SO source, DT document type, AB abstract, PY year, DI DOI, PM PMID, UT accession number.
# The plain-text export starts with "FN Clarivate Analytics Web of Science" and "VR 1.0", gives a
# two-character tag, a space, and the value, continues values on lines indented by three spaces
# (one author per line), ends each record with ER, and ends the file with EF. The tab-delimited
# export has the same tags as its header row and "; " between authors.
_WOS_LINE = re.compile(r"^([A-Z][A-Z0-9])(?: (.*))?$")
_WOS_LIST_TAGS = {"AU", "AF", "GP", "CA"}


def _wos_record(
    fields: Mapping[str, str | list[str]], ordinal: int, raw_hash: str, source: str
) -> SourceRecord:
    def one(tag: str) -> str | None:
        value = fields.get(tag)
        if isinstance(value, list):
            value = " ".join(value)
        return value.strip() if value and value.strip() else None

    def many(tag: str) -> list[str]:
        value = fields.get(tag)
        if isinstance(value, list):
            return [v.strip() for v in value if v.strip()]
        return [v.strip() for v in (value or "").split(";") if v.strip()]

    accession = one("UT")
    title = one("TI")
    if not accession:
        raise ValueError(f"Web of Science record {ordinal + 1} has no accession number (UT)")
    if not title:
        raise ValueError(f"Web of Science record {accession} has no title (TI)")
    pub_types = [t.strip() for t in (one("DT") or "").split(";")]
    return _record(
        source=source,
        provider_record_id=accession,
        ordinal=ordinal,
        title=title,
        abstract=one("AB"),
        authors=many("AU") + many("CA") + many("GP"),
        year=parse_year(one("PY") or one("EA")),
        journal=one("SO"),
        doi=one("DI"),
        pmid=one("PM"),
        publication_types=pub_types,
        raw_hash=raw_hash,
    )


def parse_wos(text: str, raw_hash: str, source: str) -> list[SourceRecord]:
    """Web of Science, plain text ("FN Clarivate ...") or tab-delimited (a header of field tags)."""
    first = text.lstrip().split("\n", 1)[0]
    if first.startswith("FN "):
        return _parse_wos_plain(text, raw_hash, source)
    if "\t" in first and {"UT", "TI"} <= {c.strip() for c in first.split("\t")}:
        return _parse_wos_tab(text, raw_hash, source)
    raise ValueError(
        "not a Web of Science export: a plain-text file starts with FN, and a tab-delimited "
        "file starts with a header of field tags that has UT and TI"
    )


def _parse_wos_plain(text: str, raw_hash: str, source: str) -> list[SourceRecord]:
    records: list[SourceRecord] = []
    block: list[str] | None = None
    ended = False
    for line in text.splitlines():
        if line.startswith(("FN ", "VR ")) and block is None and not records:
            continue
        if line.rstrip() == "EF":
            ended = True
            break
        if line.startswith("PT "):
            if block is not None:
                raise ValueError(f"Web of Science record {len(records) + 1} has no ER line")
            block = []
        if block is None:
            if line.strip():
                raise ValueError(f"line {line[:40]!r} is outside a Web of Science record")
            continue
        if line.rstrip() == "ER":
            fields: dict[str, str | list[str]] = {}
            for tag, value in _tagged_fields(block, _WOS_LINE, "   "):
                fields[tag] = value
            # Authors continue one per line; every other field continues as running text.
            for tag in _WOS_LIST_TAGS:
                if tag in fields:
                    fields[tag] = _continuation_list(block, tag)
            records.append(_wos_record(fields, len(records), raw_hash, source))
            block = None
            continue
        block.append(line)
    if block is not None:
        raise ValueError(f"Web of Science record {len(records) + 1} has no ER line")
    if not ended:
        raise ValueError("the Web of Science file has no EF line, so it may be cut off")
    return records


def _continuation_list(block: Sequence[str], tag: str) -> list[str]:
    values: list[str] = []
    inside = False
    for line in block:
        if line.startswith(f"{tag} "):
            inside = True
            values.append(line[3:].strip())
        elif inside and line.startswith("   "):
            values.append(line.strip())
        else:
            inside = False
    return values


def _parse_wos_tab(text: str, raw_hash: str, source: str) -> list[SourceRecord]:
    rows = [
        [str(c) for c in r]
        for r in _rows(csv.reader(io.StringIO(text), delimiter="\t", quoting=csv.QUOTE_NONE))
    ]
    header, *body = rows
    keys = [h.strip() for h in header]
    records = []
    for ordinal, row in enumerate(body):
        if len(row) > len(keys) and any(cell.strip() for cell in row[len(keys) :]):
            raise ValueError(
                f"Web of Science record {ordinal + 1} has {len(row)} fields; "
                f"the header has {len(keys)}"
            )
        fields: dict[str, str | list[str]] = {k: v for k, v in zip(keys, row, strict=False) if k}
        records.append(_wos_record(fields, ordinal, raw_hash, source))
    return records


# A table of records, as a CSV or a spreadsheet's first sheet. The first non-empty row names the
# columns; names are matched without case, spaces, or punctuation.
def _column_key(name: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(name or "").casefold())


_ALIASES: dict[str, tuple[str, ...]] = {
    "title": ("title", "articletitle", "documenttitle", "primarytitle", "ti"),
    "abstract": ("abstract", "ab", "summary"),
    "doi": ("doi", "di", "digitalobjectidentifier"),
    "pmid": ("pmid", "pubmedid", "pubmed", "pm"),
    "authors": ("authors", "author", "authorss", "au", "authornames"),
    "journal": (
        "journal",
        "journaltitle",
        "sourcetitle",
        "source",
        "publication",
        "jt",
        "so",
    ),
    "year": ("year", "publicationyear", "py", "pubyear", "date", "publicationdate", "dp"),
    "types": ("publicationtype", "publicationtypes", "documenttype", "type", "pt", "dt"),
    "id": ("id", "recordid", "accessionnumber", "refid", "eid", "ut"),
}


def _columns(header: Sequence[object]) -> dict[str, int]:
    """Each known field's column: the first header that is one of its names."""
    keys = [_column_key(h) for h in header]
    found: dict[str, int] = {}
    for field, names in _ALIASES.items():
        for name in names:
            if name in keys:
                found[field] = keys.index(name)
                break
    return found


# "Smith J, Doe AB" (Vancouver style) splits on commas; "Smith, John" is one author.
_VANCOUVER = re.compile(r"^[^,]+ [A-Z][A-Z.\-]*(?:, [^,]+ [A-Z][A-Z.\-]*)+$")


def split_authors(cell: str | None) -> list[str]:
    if not cell or cell.strip().startswith("[No author"):
        return []
    text = cell.strip()
    if ";" in text or "\n" in text:
        parts = re.split(r"[;\n]", text)
    elif _VANCOUVER.match(text):
        parts = text.split(",")
    else:
        parts = [text]
    return [p.strip() for p in parts if p.strip()]


def _cell(row: Sequence[object], index: int | None) -> str | None:
    if index is None or index >= len(row):
        return None
    value = row[index]
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = str(value).strip()
    return text or None


def _rows(reader: Iterable[Sequence[object]]) -> list[list[object]]:
    try:
        rows = [list(r) for r in reader if any(str(c or "").strip() for c in r)]
    except csv.Error as exc:
        raise ValueError(f"the file is malformed: {exc}") from exc
    if not rows:
        raise ValueError("the file has no header row")
    return rows


def parse_record_rows(
    rows: Sequence[Sequence[object]], raw_hash: str, source: str
) -> list[SourceRecord]:
    """A team's list of records: a Title column, and optionally Abstract, DOI, PMID, Authors,
    Journal, Year, Publication type, and an ID, under common names."""
    # The header is the first row with a title column; rows above it (a sheet's own title, a
    # note) are not records.
    start = next((i for i, row in enumerate(rows[:10]) if "title" in _columns(row)), None)
    if start is None:
        named = ", ".join(str(h) for h in rows[0] if str(h or "").strip())
        raise ValueError(f"the list needs a Title column; its first row is {named}")
    header, body = rows[start], rows[start + 1 :]
    cols = _columns(header)
    records = []
    for ordinal, row in enumerate(body):
        title = _cell(row, cols.get("title"))
        if not title:
            raise ValueError(f"row {start + ordinal + 2} has no title")
        doi = _cell(row, cols.get("doi"))
        pmid = _cell(row, cols.get("pmid"))
        if pmid and not pmid.isdigit():
            raise ValueError(f"row {start + ordinal + 2} has PMID {pmid!r}, not a number")
        year_cell = row[cols["year"]] if "year" in cols and cols["year"] < len(row) else None
        provider_id = _cell(row, cols.get("id")) or bare_doi(doi) or pmid
        records.append(
            _record(
                source=source,
                provider_record_id=provider_id or f"{source}-{ordinal + 1}",
                ordinal=ordinal,
                title=title,
                abstract=_cell(row, cols.get("abstract")),
                authors=split_authors(_cell(row, cols.get("authors"))),
                year=parse_year(year_cell),
                journal=_cell(row, cols.get("journal")),
                doi=doi,
                pmid=pmid,
                publication_types=[
                    t.strip() for t in (_cell(row, cols.get("types")) or "").split(";")
                ],
                raw_hash=raw_hash,
            )
        )
    return records


def parse_records_csv(text: str, raw_hash: str, source: str) -> list[SourceRecord]:
    """A list of records saved as CSV, with commas, semicolons (as Excel saves CSV in many
    locales), or tabs between fields."""
    first = text.split("\n", 1)[0]
    delimiter = max((",", ";", "\t"), key=first.count)
    return parse_record_rows(
        _rows(csv.reader(io.StringIO(text), delimiter=delimiter, strict=True)), raw_hash, source
    )


def parse_records_xlsx(data: bytes, raw_hash: str, source: str) -> list[SourceRecord]:
    """A list of records in the first sheet of an Excel workbook."""
    from zipfile import BadZipFile

    from openpyxl import load_workbook

    try:
        workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except (BadZipFile, KeyError, OSError) as exc:
        raise ValueError(f"not an Excel workbook (.xlsx): {exc}") from exc
    try:
        sheet = workbook.worksheets[0]
        rows = _rows(sheet.iter_rows(values_only=True))
    finally:
        workbook.close()
    return parse_record_rows(rows, raw_hash, source)


# Scopus's CSV export (https://service.elsevier.com/app/answers/detail/a_id/11236/supporthub/
# scopus/): a header of field names, a UTF-8 byte order mark, one row per document, and the EID
# (the Scopus accession, "2-s2.0-...") in the EID column. Newer exports separate authors with
# "; ", older ones with ", ".
_SCOPUS_NO_ABSTRACT = "[No abstract available]"


def parse_scopus_csv(text: str, raw_hash: str, source: str) -> list[SourceRecord]:
    """Scopus CSV export: one record per EID."""
    rows = _rows(csv.reader(io.StringIO(text), strict=True))
    header, *body = rows
    keys = [str(h).strip() for h in header]
    if "EID" not in keys or "Title" not in keys:
        raise ValueError("not a Scopus CSV export: the header needs EID and Title columns")
    col = {k: i for i, k in enumerate(keys)}
    records = []
    for ordinal, row in enumerate(body):
        if len(row) != len(keys):
            raise ValueError(
                f"Scopus record {ordinal + 1} has {len(row)} fields; the header has {len(keys)}"
            )

        def get(name: str, row: Sequence[object] = row) -> str | None:
            return _cell(row, col.get(name))

        eid = get("EID")
        title = get("Title")
        if not eid or not title:
            raise ValueError(f"Scopus record {ordinal + 1} has no EID or no title")
        abstract = get("Abstract")
        authors_cell = get("Authors") or ""
        authors = (
            split_authors(authors_cell)
            if ";" in authors_cell
            else [a.strip() for a in authors_cell.split(",")]
        )
        if authors_cell.startswith("[No author"):
            authors = []
        records.append(
            _record(
                source=source,
                provider_record_id=eid,
                ordinal=ordinal,
                title=title,
                abstract=None if abstract == _SCOPUS_NO_ABSTRACT else abstract,
                authors=authors,
                year=parse_year(get("Year")),
                journal=get("Source title"),
                doi=get("DOI"),
                pmid=get("PubMed ID"),
                publication_types=[get("Document Type") or ""],
                raw_hash=raw_hash,
            )
        )
    return records
