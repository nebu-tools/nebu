"""Imports of the bibliographic databases' own export formats: PubMed's MEDLINE format (NBIB),
Scopus CSV, Web of Science plain text and tab-delimited, and a team's list as CSV or XLSX.

The fixtures follow each format's documentation (cited in `kittum.search.bibliographic`) with
real records of the lumacaftor-ivacaftor trials, abridged. One paper (Wainwright 2015, NEJM)
is in every export, as it would be in a real multi-database search."""

from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from openpyxl import Workbook

from kittum.core import sha256_hex
from kittum.ledger.testing import InMemoryLedger
from kittum.search import SearchPlan, get_execution, import_file, list_executions
from kittum.storage import MemoryStore

if TYPE_CHECKING:
    import uuid

    from kittum.db import Tx

pytestmark = pytest.mark.postgres

FIXTURES = Path(__file__).parent / "fixtures"
WAINWRIGHT = "10.1056/NEJMoa1409547"


def _import(pg: Tx, project_id: uuid.UUID, actor_id: uuid.UUID, data: bytes, format: str):
    plan = SearchPlan(topic_id="cf", source=format, platform=format, strategy="lumacaftor")
    artifacts = MemoryStore()
    ledger = InMemoryLedger()
    execution = import_file(
        pg,
        project_id,
        plan,
        data,
        format,
        ledger=ledger,
        actor_id=actor_id,
        artifacts=artifacts,
    )
    assert execution.raw_artifact_hashes == (sha256_hex(data),)
    assert artifacts.get(sha256_hex(data)) == data
    (event,) = ledger.events(pg, project_id)
    assert event.payload["retrieved_count"] == len(execution.records)
    loaded = get_execution(pg, project_id, execution.id)
    assert loaded is not None and loaded.records == execution.records
    return execution


def test_pubmed_nbib_import(pg: Tx, project_id: uuid.UUID, actor_id: uuid.UUID) -> None:
    data = (FIXTURES / "pubmed_export.nbib").read_bytes()
    first, second = _import(pg, project_id, actor_id, data, "nbib").records

    assert first.provider_record_id == first.pmid == "25981758"
    assert first.doi == WAINWRIGHT and first.pmcid == "PMC4764353"
    # Wrapped lines join into one title and one abstract.
    assert first.title == (
        "Lumacaftor-Ivacaftor in Patients with Cystic Fibrosis Homozygous for Phe508del CFTR."
    )
    assert first.abstract and "placebo-controlled studies (TRAFFIC and TRANSPORT)" in first.abstract
    assert first.authors == (
        "Wainwright CE",
        "Elborn JS",
        "Ramsey BW",
        "TRAFFIC Study Group",
        "TRANSPORT Study Group",
    )
    assert first.year == 2015 and first.journal == "The New England journal of medicine"
    assert "Randomized Controlled Trial" in first.publication_types
    # The trial numbers come from the SI (secondary source) field and the abstract.
    assert first.registry_ids == ("NCT01807923", "NCT01807949")
    # The DOI is the AID or LID marked [doi], never the publisher item ID ([pii]).
    assert second.doi == "10.1016/S2213-2600(17)30215-1"
    assert second.registry_ids == ("NCT02514473",)


def test_scopus_csv_import(pg: Tx, project_id: uuid.UUID, actor_id: uuid.UUID) -> None:
    data = (FIXTURES / "scopus_export.csv").read_bytes()
    assert data.startswith(b"\xef\xbb\xbf")  # Scopus writes a byte order mark
    first, second = _import(pg, project_id, actor_id, data, "scopus").records

    assert first.provider_record_id == "2-s2.0-84937468297"  # the EID
    assert first.doi == WAINWRIGHT and first.pmid == "25981758"
    assert first.authors == ("Wainwright C.E.", "Elborn J.S.", "Ramsey B.W.")
    assert first.journal == "New England Journal of Medicine" and first.year == 2015
    assert first.publication_types == ("Article",)
    # Scopus's placeholder is no abstract.
    assert second.abstract is None and second.provider_record_id == "2-s2.0-85006356431"


@pytest.mark.parametrize("encoding", ["utf-8-sig", "utf-16"])
def test_web_of_science_imports(
    pg: Tx, project_id: uuid.UUID, actor_id: uuid.UUID, encoding: str
) -> None:
    plain = _import(
        pg, project_id, actor_id, (FIXTURES / "wos_export.txt").read_bytes(), "wos"
    ).records
    wainwright, milla = plain
    assert wainwright.provider_record_id == "WOS:000357843900007"  # the UT accession
    assert wainwright.doi == WAINWRIGHT and wainwright.pmid == "25981758"
    assert wainwright.title == (
        "Lumacaftor-Ivacaftor in Patients with Cystic Fibrosis Homozygous for Phe508del CFTR"
    )
    # One author per continuation line, then the group authors.
    assert wainwright.authors == (
        "Wainwright, CE",
        "Elborn, JS",
        "Ramsey, BW",
        "TRAFFIC Study Grp",
        "TRANSPORT Study Grp",
    )
    assert wainwright.journal == "NEW ENGLAND JOURNAL OF MEDICINE"
    assert milla.registry_ids == ("NCT01897233",) and milla.year == 2017

    # The tab-delimited export, as Web of Science saves it in UTF-8 or UTF-16.
    text = (FIXTURES / "wos_export_tab.txt").read_text(encoding="utf-8-sig")
    tab = _import(pg, project_id, actor_id, text.encode(encoding), "wos").records
    konstan, mcnamara = tab
    assert konstan.provider_record_id == "WOS:000394147400016"
    assert konstan.authors == ("Konstan, MW", "McKone, EF", "Moss, RB")
    assert konstan.doi == "10.1016/S2213-2600(16)30427-1" and konstan.pmid == "28011037"
    assert mcnamara.publication_types == ("Article", "Proceedings Paper")
    assert mcnamara.year == 2019 and mcnamara.registry_ids == ("NCT02797132",)


def team_list_xlsx() -> bytes:
    """The team's own list, as a spreadsheet: a title row above the header, columns in their
    own order and names, a numeric year, and a DOI as a link."""
    book = Workbook()
    sheet = book.active
    assert sheet is not None
    sheet.append(["Known papers, lumacaftor dossier"])
    sheet.append([])
    sheet.append(["Ref ID", "Year", "AUTHOR", "Article Title", "Journal", "doi", "PubMed ID"])
    sheet.append(
        [
            "K1",
            2015,
            "Wainwright CE, Elborn JS",
            "Lumacaftor-ivacaftor in patients with cystic fibrosis homozygous for Phe508del CFTR",
            "N Engl J Med",
            f"https://doi.org/{WAINWRIGHT}",
            None,
        ]
    )
    sheet.append(
        [
            "K2",
            2017.0,
            "Milla, Carlos E.",
            "Lumacaftor/Ivacaftor in Patients Aged 6-11 Years with Cystic Fibrosis",
            None,
            None,
            27805836,
        ]
    )
    out = BytesIO()
    book.save(out)
    return out.getvalue()


def test_a_teams_list_as_csv_or_xlsx(pg: Tx, project_id: uuid.UUID, actor_id: uuid.UUID) -> None:
    # Excel's CSV in many locales: semicolons, and the team's own extra columns.
    csv_records = _import(
        pg, project_id, actor_id, (FIXTURES / "team_list.csv").read_bytes(), "records-csv"
    ).records
    assert [r.title[:30] for r in csv_records] == [
        "Lumacaftor-Ivacaftor in Patien",
        "Lumacaftor/ivacaftor in patien",
        "Lumacaftor-ivacaftor in adults",
    ]
    first, second, third = csv_records
    assert first.doi == WAINWRIGHT  # the resolver prefix goes, the DOI stays as written
    assert first.authors == ("Wainwright CE", "Elborn JS", "Ramsey BW")
    assert second.pmid == "27805836" and second.doi is None and second.year == 2017
    assert third.authors == ("Burgel PR", "Durieu I") and third.journal == "Eur Respir J"

    # Excel's plain "CSV" in a German locale: windows-1252, not UTF-8.
    german = "Title;Authors;Year\nLumacaftor bei Patienten in München;Müller K;2019\n"
    (umlauts,) = _import(pg, project_id, actor_id, german.encode("cp1252"), "records-csv").records
    assert umlauts.title.endswith("München") and umlauts.authors == ("Müller K",)

    xlsx = team_list_xlsx()
    k1, k2 = _import(pg, project_id, actor_id, xlsx, "records-xlsx").records
    assert k1.provider_record_id == "K1" and k1.doi == WAINWRIGHT and k1.year == 2015
    assert k1.authors == ("Wainwright CE", "Elborn JS")
    assert k2.pmid == "27805836" and k2.year == 2017 and k2.authors == ("Milla, Carlos E.",)


@pytest.mark.parametrize(
    ("data", "format", "error"),
    [
        (
            (FIXTURES / "wos_export.txt").read_bytes().replace(b"\nEF\n", b"\n"),
            "wos",
            "no EF line, so it may be cut off",
        ),
        (
            (FIXTURES / "wos_export.txt").read_bytes().replace(b"ER\n\nPT J", b"PT J", 1),
            "wos",
            "record 1 has no ER line",
        ),
        ((FIXTURES / "central_export.ris").read_bytes(), "wos", "not a Web of Science export"),
        ((FIXTURES / "central_export.ris").read_bytes(), "nbib", "starts with a PMID line"),
        ((FIXTURES / "team_list.csv").read_bytes(), "scopus", "needs EID and Title columns"),
        (b"Name;Year\nPatch trial;2019\n", "records-csv", "needs a Title column"),
        (b"Title;DOI\n;10.1/x\n", "records-csv", "row 2 has no title"),
        (b"Title,PMID\nA trial,PMC123\n", "records-csv", "PMID 'PMC123', not a number"),
        (b"Title\nA trial\n", "records-xlsx", "not an Excel workbook"),
    ],
    ids=[
        "wos-cut-off",
        "wos-missing-er",
        "ris-as-wos",
        "ris-as-nbib",
        "list-as-scopus",
        "list-without-title",
        "row-without-title",
        "pmcid-as-pmid",
        "csv-as-xlsx",
    ],
)
def test_imports_refuse_files_not_in_their_format(
    pg: Tx, project_id: uuid.UUID, actor_id: uuid.UUID, data: bytes, format: str, error: str
) -> None:
    plan = SearchPlan(topic_id="t", source="x", platform="x", strategy="q")
    ledger = InMemoryLedger()
    artifacts = MemoryStore()
    with pytest.raises(ValueError, match=error):
        import_file(
            pg,
            project_id,
            plan,
            data,
            format,
            ledger=ledger,
            actor_id=actor_id,
            artifacts=artifacts,
        )
    assert list_executions(pg, project_id) == []
    assert ledger.events(pg, project_id) == []
    assert not artifacts.exists(sha256_hex(data))  # a refused file is not kept
