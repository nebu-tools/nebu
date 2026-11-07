"""The working export's file: text from a record stays text in Excel."""

from datetime import datetime
from io import BytesIO

from openpyxl import load_workbook

from kittum.report.working import COVER_TEXT, REVIEWER_COLUMNS, build_workbook
from kittum.screening import TableDecision, TableRow


def test_record_text_never_becomes_a_formula_or_breaks_the_file() -> None:
    # A title that Excel would run as a formula, and an abstract with a control character that
    # XLSX cannot hold.
    row = TableRow(
        ref="a1",
        title='=HYPERLINK("http://example.org","click")',
        abstract="Background\x0b: adults with NSCLC.",
        authors=("Doe J",),
        journal=None,
        year=2020,
        publication_types=(),
        pmid=None,
        doi=None,
        registry_ids=(),
        decisions=(TableDecision(state="pending"),),
    )
    data = build_workbook(
        [("Review", "=1+1")], REVIEWER_COLUMNS, [row], (), created=datetime(2026, 11, 7)
    )
    book = load_workbook(BytesIO(data))
    assert book["About"]["A1"].value == COVER_TEXT
    assert book["About"]["B3"].data_type == "s"
    records = book["Records"]
    header = [c.value for c in records[1]]
    title = records.cell(row=2, column=header.index("Title") + 1)
    assert title.data_type == "s" and title.value == row.title
    abstract = records.cell(row=2, column=header.index("Abstract") + 1).value
    assert abstract == "Background: adults with NSCLC."
