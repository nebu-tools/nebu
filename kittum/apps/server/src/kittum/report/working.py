"""The working export: a stage, or a reviewer's current table view, as an XLSX workbook.

It is a spreadsheet to work with, not evidence: its cover sheet says "Working export. Not the
audit bundle." The rows come from `kittum.screening.screening_table`, so the export obeys the
table's blinding: a screener or auditor exports only their own rows, with only the AI readings
their own decisions revealed; the methods lead exports the whole stage with every decision and
outcome. Rows carry stable references (assignment IDs in a reviewer's export, corpus report IDs
in the lead's) and reasons as protocol criterion IDs, which the Criteria sheet spells out.

A view export names the rows and columns in view; the server reads the rows itself and keeps
only those the viewer may see, so a client cannot put into the file anything the table would not
show it. Every export is stored by hash, kept in `report_artifact` under the target
`working_export`, and recorded with a `report.working_exported` event. Its cover sheet names it by
its export ID.

A screener's export of a title and abstract stage in a topic with working documentation (mode S)
can bring decisions back. Its "Your decision", "Reason", and "Comment" columns are editable, with
drop-down lists of the stage's outcomes and of the criterion IDs, and Kittum keeps what each row
showed beside the export (`decisions_hash` in the event). `preview_decision_import` reads an edited
copy, finds its export, and asks `kittum.screening` what importing it would do;
`apply_decision_import` stores the file by hash and records the import. Only those three columns
are read: the bibliographic columns and everything else in the file change nothing.
"""

import json
import re
import uuid
import zipfile
from datetime import UTC, datetime
from io import BytesIO
from typing import TYPE_CHECKING, Literal

from openpyxl import Workbook, load_workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.utils.exceptions import InvalidFileException
from openpyxl.worksheet.datavalidation import DataValidation
from psycopg.types.json import Jsonb

from kittum.core import Id, Record, Sha256, canonical_json, new_id, sha256_hex
from kittum.ledger import EventDraft
from kittum.people import members
from kittum.protocol import get_version
from kittum.report.review import ReportRequestError, head_seq
from kittum.screening import (
    ImportFile,
    ImportPreview,
    SheetDecision,
    SheetExported,
    SheetRow,
    criteria_for,
    screening_table,
    topic_for,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

    from openpyxl.worksheet.worksheet import Worksheet

    from kittum.core import Clock
    from kittum.db import Tx
    from kittum.ledger import Ledger
    from kittum.protocol import Criterion, Stage
    from kittum.screening import (
        ImportResult,
        Outcome,
        Screening,
        ScreeningTable,
        TableDecision,
        TableRow,
    )
    from kittum.storage import ArtifactStore

WORKING_EXPORT = "working_export"
WORKING_EXPORTED_EVENT = "report.working_exported"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
COVER_TEXT = "Working export. Not the audit bundle."
_CELL_LIMIT = 32767  # Excel's limit on the characters in one cell


class ExportView(Record):
    """The reviewer's table view: the rows and columns on screen, in their order."""

    refs: tuple[str, ...]
    """Row references (`TableRow.ref`) in view order. Rows the viewer may not see are refused."""
    columns: tuple[str, ...]
    """Column IDs in view order (see `COLUMNS`). `ref` comes first when it is not in view."""
    description: str | None = None
    """The view's filters and sort in words, for the cover sheet."""


class WorkingExport(Record):
    sha256: Sha256
    file_name: str
    rows: int
    view: Literal["reviewer", "lead"]
    export_id: Id
    decisions: bool = False
    """The file can bring decisions back (a screener's export in a working topic)."""


class DecisionImportPreview(Record):
    """What importing an edited working export would do, and the export it came from."""

    export_id: Id
    exported_by: str
    exported_at: datetime
    sha256: Sha256
    """The uploaded file's hash; applying stores the file under it."""
    rows: int
    """Rows the Records sheet holds."""
    preview: ImportPreview


_STATE = {
    "pending": "Not decided",
    "awaiting_final": "Waiting for the final decision",
    "decided": "Decided",
}
_OUTCOME = {
    "include": "Include",
    "exclude": "Exclude",
    "unclear": "Unclear",
    "insufficient_information": "Insufficient information",
    "conflict": "Conflict",
}
_STATUS = {"met": "Met", "not_met": "Not met", "unclear": "Unclear"}

type Value = str | int | None


def _own(row: TableRow) -> TableDecision | None:
    return row.decisions[0] if row.decisions else None


def _decision(d: TableDecision | None) -> Value:
    if d is None or d.outcome is None:
        return None
    reason = f" ({d.reason_criterion_id})" if d.reason_criterion_id else ""
    final = "" if d.state == "decided" else ", provisional"
    asked = ", asked a second opinion" if d.second_opinion else ""
    return f"{_OUTCOME[d.outcome]}{reason}{final}{asked}"


def _decisions(row: TableRow) -> Value:
    parts = [
        f"{d.name or d.reviewer_id}{' (second opinion)' if d.role == 'second_opinion' else ''}:"
        f" {_decision(d) or 'not decided'}"
        for d in row.decisions
    ]
    return "; ".join(parts) or None


def _ai(row: TableRow) -> Value:
    r = row.reveal
    if r:
        return f"{_STATUS.get(r.status, r.status)} on {r.criterion_id}"
    if row.ai:  # a stage that reveals `before`
        not_met = [c.criterion_id for c in row.ai.criteria if c.status == "not_met"]
        return f"Not met on {', '.join(not_met)}" if not_met else "Nothing not met"
    return None


def _second_opinion(row: TableRow) -> Value:
    """Mode S: the request this row answers, or the reviewer's own request."""
    if c := row.second_opinion:
        reason = f" ({c.reason_criterion_id})" if c.reason_criterion_id else ""
        note = f": {c.comment}" if c.comment else ""
        return f"Asked of you on {_OUTCOME[c.outcome]}{reason}{note}"
    d = _own(row)
    return "You asked for one" if d and d.second_opinion else None


def _ai_excludes(row: TableRow) -> Value:
    return None if row.ai_excludes is None else ("Yes" if row.ai_excludes else "No")


# Outcomes a working export offers in its "Your decision" drop-down: the title and abstract ones.
_SHEET_OUTCOMES: tuple[Outcome, ...] = ("include", "exclude", "unclear")
_EDITABLE = ("decision", "reason", "comment")
_EDITABLE_HEADERS = {"decision": "Your decision", "reason": "Reason", "comment": "Comment"}
_EDITABLE_FILL = PatternFill("solid", fgColor="FFF4CC")
_EXPORT_ID = "Export ID"

# Column ID -> (header, value). The workbench's table uses the same IDs.
COLUMNS: dict[str, tuple[str, Callable[[TableRow], Value]]] = {
    "ref": ("Ref", lambda r: r.ref),
    "position": ("Queue place", lambda r: r.position),
    "title": ("Title", lambda r: r.title),
    "authors": ("Authors", lambda r: "; ".join(r.authors) or None),
    "journal": ("Journal", lambda r: r.journal),
    "year": ("Year", lambda r: r.year),
    "publication_types": ("Publication types", lambda r: "; ".join(r.publication_types) or None),
    "pmid": ("PMID", lambda r: r.pmid),
    "doi": ("DOI", lambda r: r.doi),
    "registry_ids": ("Registry IDs", lambda r: "; ".join(r.registry_ids) or None),
    "abstract": ("Abstract", lambda r: r.abstract or None),
    "state": ("State", lambda r: _STATE[d.state] if (d := _own(r)) else None),
    "decision": (
        "Decision",
        lambda r: _OUTCOME[d.outcome] if (d := _own(r)) and d.outcome else None,
    ),
    "reason": ("Reason criterion", lambda r: d.reason_criterion_id if (d := _own(r)) else None),
    "comment": ("Comment", lambda r: d.comment if (d := _own(r)) else None),
    "decided_at": (
        "Decided at",
        lambda r: d.decided_at.isoformat() if (d := _own(r)) and d.decided_at else None,
    ),
    "ai": ("AI reading", _ai),
    "ai_quote": ("AI quote", lambda r: r.reveal.quote or None if r.reveal else None),
    "ai_rationale": ("AI rationale", lambda r: r.reveal.rationale if r.reveal else None),
    "second_opinion": ("Second opinion", _second_opinion),
    "outcome": ("Outcome", lambda r: _OUTCOME[r.outcome] if r.outcome else None),
    "outcome_reason": ("Outcome reason", lambda r: r.outcome_reason),
    "decisions": ("Decisions", _decisions),
    "ai_excludes": ("AI excludes", _ai_excludes),
    "ai_not_met": ("AI not met", lambda r: ", ".join(r.ai_not_met) or None),
    "flags": ("Flags", lambda r: ", ".join(r.flags) or None),
}
_COMMON = (
    "ref",
    "title",
    "authors",
    "journal",
    "year",
    "publication_types",
    "pmid",
    "doi",
    "registry_ids",
)
REVIEWER_COLUMNS = (
    "ref",
    "position",
    *_COMMON[1:],
    "state",
    "decision",
    "reason",
    "comment",
    "decided_at",
    "second_opinion",
    "ai",
    "ai_quote",
    "ai_rationale",
    "abstract",
)
LEAD_COLUMNS = (
    *_COMMON,
    "outcome",
    "outcome_reason",
    "decisions",
    "ai_excludes",
    "ai_not_met",
    "flags",
    "abstract",
)
_ONLY = {
    "reviewer": set(REVIEWER_COLUMNS),
    "lead": set(LEAD_COLUMNS),
}


def _cell(value: Value) -> Value:
    if isinstance(value, str):
        value = ILLEGAL_CHARACTERS_RE.sub("", value)[:_CELL_LIMIT]
    return value


def _sheet_rows(ws: Worksheet, rows: Sequence[Sequence[Value]], widths: Sequence[int]) -> None:
    for values in rows:
        ws.append([_cell(v) for v in values])
    for n, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(n)].width = width
    # A cell that starts with "=" is text here, never a formula.
    for row in ws.iter_rows():
        for c in row:
            if c.data_type == "f":
                c.data_type = "s"


def _width(column: str) -> int:
    return {"title": 60, "abstract": 80, "authors": 30, "journal": 24, "comment": 30}.get(
        column, 14 if column in {"year", "position", "pmid"} else 20
    )


def build_workbook(
    cover: Sequence[tuple[str, Value]],
    columns: Sequence[str],
    rows: Sequence[TableRow],
    criteria: Sequence[Criterion],
    *,
    created: datetime,
    editable: bool = False,
) -> bytes:
    """The XLSX file: the cover sheet, the rows, and the criteria the reasons name. `editable`
    makes the decision, reason, and comment columns the reviewer's to fill in, with drop-down
    lists of the outcomes and the criterion IDs."""
    wb = Workbook()
    about = wb.active
    assert about is not None
    about.title = "About"
    about.append([COVER_TEXT])
    about["A1"].font = Font(bold=True, size=14)
    about.append([])
    _sheet_rows(about, [[k, v] for k, v in cover], [28, 90])
    for row in about.iter_rows(min_row=3):
        row[0].font = Font(bold=True)
        row[1].alignment = Alignment(wrap_text=True, vertical="top")

    records = wb.create_sheet("Records")
    headers = [
        (_EDITABLE_HEADERS[c] if editable and c in _EDITABLE else COLUMNS[c][0]) for c in columns
    ]
    _sheet_rows(
        records,
        [headers, *([COLUMNS[c][1](r) for c in columns] for r in rows)],
        [_width(c) for c in columns],
    )
    for c in records[1]:
        c.font = Font(bold=True)
    records.freeze_panes = "B2"
    records.auto_filter.ref = records.dimensions
    if editable:
        last = max(len(rows) + 1, 2)
        for n, c in enumerate(columns, start=1):
            if c not in _EDITABLE:
                continue
            letter = get_column_letter(n)
            for (cell,) in records.iter_rows(min_row=1, max_row=last, min_col=n, max_col=n):
                cell.fill = _EDITABLE_FILL
            if c == "decision":
                words = ",".join(_OUTCOME[o] for o in _SHEET_OUTCOMES)
                dv = DataValidation(type="list", formula1=f'"{words}"', allow_blank=True)
                dv.error = (
                    "Pick "
                    + ", ".join(_OUTCOME[o] for o in _SHEET_OUTCOMES)
                    + ", or leave it blank."
                )
                dv.errorTitle = "Your decision"
                dv.showErrorMessage = True
            elif c == "reason" and criteria:
                # A criterion ID from the list, or its number (Key) on the Criteria sheet.
                dv = DataValidation(
                    type="list", formula1=f"=Criteria!$B$2:$B${len(criteria) + 1}", allow_blank=True
                )
                dv.showErrorMessage = False
            else:
                continue
            records.add_data_validation(dv)
            dv.add(f"{letter}2:{letter}{last}")

    sheet = wb.create_sheet("Criteria")
    _sheet_rows(
        sheet,
        [
            ["Key", "Criterion ID", "Short label", "Criterion"],
            *(
                [n, c.id, c.short_label, c.text.get("en") or next(iter(c.text.values()))]
                for n, c in enumerate(criteria, start=1)
            ),
        ],
        [6, 22, 22, 100],
    )
    for c in sheet[1]:
        c.font = Font(bold=True)

    wb.properties.creator = "Kittum"
    wb.properties.created = created
    wb.properties.modified = created
    out = BytesIO()
    wb.save(out)
    return out.getvalue()


def _importable(table: ScreeningTable) -> bool:
    """A screener's export of a title and abstract stage in a working topic brings decisions
    back."""
    return (
        table.view == "reviewer"
        and table.documentation == "working"
        and table.stage == "title_abstract"
    )


def _columns(table: ScreeningTable, view: ExportView | None) -> tuple[str, ...]:
    allowed = _ONLY[table.view]
    if view is None:
        return REVIEWER_COLUMNS if table.view == "reviewer" else LEAD_COLUMNS
    unknown = [c for c in view.columns if c not in allowed]
    if unknown:
        raise ReportRequestError(f"columns not in this table: {', '.join(unknown)}")
    if not view.columns:
        raise ReportRequestError("a view export needs at least one column")
    # The stable reference always travels, in view or not, and so do the columns that bring
    # decisions back.
    columns = view.columns if "ref" in view.columns else ("ref", *view.columns)
    if _importable(table):
        columns = (*columns, *_EDITABLE)
    return tuple(dict.fromkeys(columns))


def _rows(table: ScreeningTable, view: ExportView | None) -> list[TableRow]:
    if view is None:
        return list(table.rows)
    by_ref = {r.ref: r for r in table.rows}
    missing = [ref for ref in view.refs if ref not in by_ref]
    if missing:
        raise ReportRequestError(f"{len(missing)} rows are not in this table, e.g. {missing[0]}")
    return [by_ref[ref] for ref in dict.fromkeys(view.refs)]


def working_export(
    tx: Tx,
    project_id: Id,
    actor_id: Id,
    scope_id: str,
    stage: Stage,
    *,
    topic_id: str | None = None,
    view: ExportView | None = None,
    store: ArtifactStore,
    ledger: Ledger,
    clock: Clock,
) -> tuple[WorkingExport, bytes]:
    """Build the working export of a stage (or of a table view) as the actor may see it, store it
    by hash, and record it. Raises `kittum.screening.NotAssigned` for someone who may not see
    the stage's table, and `ReportRequestError` for a view that names rows or columns it lacks."""
    table = screening_table(tx, project_id, actor_id, scope_id, stage, topic_id=topic_id)
    columns = _columns(table, view)
    rows = _rows(table, view)
    stage_row = tx.execute(
        "select protocol_version_id, protocol_hash, topic_id from screening_stage where id = %s",
        (table.stage_id,),
    ).fetchone()
    assert stage_row is not None
    protocol = get_version(tx, project_id, stage_row["protocol_version_id"]).version.protocol
    criteria = criteria_for(topic_for(protocol, scope_id, stage_row["topic_id"]), scope_id, stage)
    project = tx.execute("select name from project where id = %s", (project_id,)).fetchone()
    names = {m.actor_id: m.display_name for m in members(tx, project_id)}
    now = clock.now()
    cutoff = head_seq(tx, project_id)
    stage_words = "Title and abstract" if stage == "title_abstract" else "Full text"
    whose = (
        "Your own records only, with the AI readings your decisions revealed"
        if table.view == "reviewer"
        else "Every record of the stage, with every decision and outcome"
    )
    export_id = new_id()
    editable = _importable(table)
    cover: list[tuple[str, Value]] = [
        (_EXPORT_ID, str(export_id)),
        ("Review", project["name"] if project else str(project_id)),
        ("Scope", scope_id),
        ("Stage", stage_words),
        ("Exported by", names.get(actor_id, str(actor_id))),
        ("Exported at", now.isoformat()),
        ("Ledger event", cutoff),
        ("Protocol hash", stage_row["protocol_hash"]),
        ("Contents", whose),
        (
            "Rows",
            f"{len(rows)} of {len(table.rows)}, as in the table view"
            if view is not None
            else f"{len(rows)}, the whole stage",
        ),
        ("View", (view.description or "As shown") if view is not None else None),
        (
            "Ref",
            "Your assignment ID for the record; it stays the same for this stage"
            if table.view == "reviewer"
            else "The corpus report ID of the record",
        ),
        ("Reasons", "Protocol criterion IDs; the Criteria sheet spells them out"),
    ]
    if editable:
        cover.append(
            (
                "Your decisions",
                "Fill in Your decision, Reason (a criterion ID, or its number on the Criteria "
                "sheet), and Comment, then import this file on the stage's table in Kittum. It "
                "shows what would change before anything is recorded. Blank cells change "
                "nothing, a record decided in Kittum is changed there, and no other column is "
                "read. Kittum records who imports the file, not who filled in each row.",
            )
        )
    data = build_workbook(
        cover,
        columns,
        rows,
        criteria,
        created=now.astimezone(UTC).replace(tzinfo=None),
        editable=editable,
    )
    sha256 = store.put(data)
    # What each row's editable cells showed, so an import can tell an edit from an old value.
    decisions_hash = (
        store.put(
            canonical_json(
                {r.ref: _exported(r, "ai" in columns).model_dump(mode="json") for r in rows}
            )
        )
        if editable
        else None
    )
    day = now.date().isoformat()
    file_name = re.sub(r"[^A-Za-z0-9._-]+", "_", f"kittum-working-{scope_id}-{stage}-{day}.xlsx")
    files = [{"path": file_name, "sha256": sha256, "media_type": XLSX}]
    index = {
        "target": WORKING_EXPORT,
        "project_id": str(project_id),
        "scope_id": scope_id,
        "cutoff_seq": cutoff,
        "files": files,
    }
    index_hash = store.put(canonical_json(index))
    event = ledger.append(
        tx,
        EventDraft(
            project_id=project_id,
            type=WORKING_EXPORTED_EVENT,
            schema_version=1,
            actor_id=actor_id,
            payload={
                "export_id": str(export_id),
                "stage_id": str(table.stage_id),
                "scope_id": scope_id,
                "stage": stage,
                "view": table.view,
                "kind": "view" if view is not None else "stage",
                "cutoff_seq": cutoff,
                "rows": len(rows),
                "refs_hash": sha256_hex(canonical_json([r.ref for r in rows])),
                "columns": list(columns),
                "description": view.description if view is not None else None,
                "sha256": sha256,
                "index_hash": index_hash,
                **({"decisions_hash": decisions_hash} if decisions_hash else {}),
            },
        ),
    )
    tx.execute(
        "insert into report_artifact (id, project_id, target, scope_id, cutoff_seq,"
        " identity_revision_id, index_hash, files, actor_id, event_id, rendered_at)"
        " values (%s, %s, %s, %s, %s, null, %s, %s, %s, %s, %s)",
        (
            export_id,
            project_id,
            WORKING_EXPORT,
            scope_id,
            cutoff,
            index_hash,
            Jsonb(files),
            actor_id,
            event.event_id,
            event.recorded_at,
        ),
    )
    exported = WorkingExport(
        sha256=sha256,
        file_name=file_name,
        rows=len(rows),
        view=table.view,
        export_id=export_id,
        decisions=editable,
    )
    return exported, data


def _exported(row: TableRow, ai_column: bool) -> SheetExported:
    d = _own(row)
    return SheetExported(
        state=d.state if d else "pending",
        decision=SheetDecision(
            outcome=d.outcome, reason_criterion_id=d.reason_criterion_id, comment=d.comment
        )
        if d
        else SheetDecision(),
        ai=ai_column and _ai(row) is not None,
    )


class _Sheet(Record):
    export_id: Id
    rows: tuple[tuple[int, str, str | None, str | None, str | None], ...]
    """Row number, Ref, and the Your decision, Reason, and Comment cells as text."""
    missing: tuple[str, ...] = ()
    """Headers of those columns the Records sheet lacks."""


def _text(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, datetime):
        value = value.isoformat()
    text = str(value).strip()
    return text or None


def _read_sheet(data: bytes) -> _Sheet:
    """The export ID and the editable cells of an edited working export."""
    try:
        wb = load_workbook(BytesIO(data), read_only=True, data_only=True)
    except (zipfile.BadZipFile, InvalidFileException, KeyError, OSError, ValueError) as e:
        raise ReportRequestError("This file is not an Excel workbook (.xlsx).") from e
    try:
        if "About" not in wb.sheetnames or "Records" not in wb.sheetnames:
            raise ReportRequestError(
                "This workbook is not a Kittum working export: it needs its About and Records "
                "sheets."
            )
        export_id = next(
            (
                _text(row[1])
                for row in wb["About"].iter_rows(max_col=2, values_only=True)
                if len(row) > 1 and _text(row[0]) == _EXPORT_ID
            ),
            None,
        )
        try:
            parsed_id = uuid.UUID(export_id) if export_id else None
        except ValueError:
            parsed_id = None
        if parsed_id is None:
            raise ReportRequestError(
                "This workbook names no export ID on its About sheet. Export the table again and "
                "edit the new file."
            )
        lines = wb["Records"].iter_rows(values_only=True)
        header = [_text(v) for v in next(lines, ())]
        missing = tuple(h for h in ("Ref", *_EDITABLE_HEADERS.values()) if h not in header)
        if missing:
            return _Sheet(export_id=parsed_id, rows=(), missing=missing)
        at = {h: header.index(h) for h in ("Ref", *_EDITABLE_HEADERS.values())}
        rows = []
        for n, line in enumerate(lines, start=2):
            cells = {h: _text(line[i]) if i < len(line) else None for h, i in at.items()}
            if not any(cells.values()):
                continue
            rows.append(
                (
                    n,
                    cells["Ref"] or "",
                    cells["Your decision"],
                    cells["Reason"],
                    cells["Comment"],
                )
            )
        return _Sheet(export_id=parsed_id, rows=tuple(rows))
    finally:
        wb.close()


def _sheet_rows_of(
    tx: Tx,
    project_id: Id,
    actor_id: Id,
    stage_id: Id,
    data: bytes,
    *,
    screening: Screening,
    store: ArtifactStore,
) -> tuple[_Sheet, dict, list[SheetRow]]:
    """The rows of an edited working export, with what each showed when exported."""
    sheet = _read_sheet(data)
    export = tx.execute(
        "select e.payload, e.actor_id, e.recorded_at from report_artifact a"
        " join audit_event e on e.event_id = a.event_id"
        " where a.id = %s and a.project_id = %s and a.target = %s",
        (sheet.export_id, project_id, WORKING_EXPORT),
    ).fetchone()
    if export is None:
        raise ReportRequestError("This file comes from no working export of this review.")
    payload = export["payload"]
    if payload.get("stage_id") != str(stage_id):
        raise ReportRequestError(
            "This file is an export of another stage. Import it on that stage's table."
        )
    stage = tx.execute(
        "select scope_id, stage, mode, topic_id, protocol_version_id from screening_stage"
        " where id = %s",
        (stage_id,),
    ).fetchone()
    assert stage is not None
    if not payload.get("decisions_hash"):
        # A complete topic or a full-text stage refuses in the screening service's own words.
        screening.preview_import(tx, project_id, actor_id, stage_id, [])
        raise ReportRequestError(
            "The methods lead's export shows every decision; decisions come back from a "
            "screener's own export."
            if payload.get("view") == "lead"
            else "This export has no columns to bring decisions back. Export the table again "
            "and edit the new file."
        )
    if sheet.missing:
        raise ReportRequestError(
            "The Records sheet has no " + ", ".join(sheet.missing) + " column. Keep the columns "
            "of the export, with their headers, and import it again."
        )
    raw = store.get(payload["decisions_hash"])
    exported = {ref: SheetExported.model_validate(v) for ref, v in json.loads(raw).items()}
    protocol = get_version(tx, project_id, stage["protocol_version_id"]).version.protocol
    criteria = criteria_for(
        topic_for(protocol, stage["scope_id"], stage["topic_id"]), stage["scope_id"], stage["stage"]
    )
    by_name = {c.id.casefold(): c.id for c in criteria}
    by_name |= {str(n): c.id for n, c in enumerate(criteria, start=1)}
    outcomes = {o: o for o in _SHEET_OUTCOMES} | {
        _OUTCOME[o].casefold(): o for o in _SHEET_OUTCOMES
    }
    words = ", ".join(_OUTCOME[o] for o in _SHEET_OUTCOMES)
    rows = []
    for n, ref, outcome_text, reason_text, comment in sheet.rows:
        problems = []
        outcome = outcomes.get(outcome_text.casefold()) if outcome_text else None
        if outcome_text and outcome is None:
            problems.append(f'Kittum knows no decision "{outcome_text}". Use {words}.')
        reason = by_name.get(reason_text.casefold()) if reason_text else None
        if reason_text and reason is None:
            problems.append(
                f'No criterion is called "{reason_text}". Use a criterion ID or its number on '
                "the Criteria sheet."
            )
        rows.append(
            SheetRow(
                row=n,
                ref=ref,
                decision=SheetDecision(
                    outcome=outcome, reason_criterion_id=reason, comment=comment
                ),
                problem=" ".join(problems) or None,
                exported=exported.get(ref),
            )
        )
    return sheet, dict(export), rows


def preview_decision_import(
    tx: Tx,
    project_id: Id,
    actor_id: Id,
    stage_id: Id,
    data: bytes,
    *,
    screening: Screening,
    store: ArtifactStore,
) -> DecisionImportPreview:
    """What importing an edited working export into the stage would do. Records nothing. Raises
    `ReportRequestError` for a file that is not a working export of the stage that can bring
    decisions back, and `kittum.screening.InvalidDecision` in a complete topic."""
    sheet, export, rows = _sheet_rows_of(
        tx, project_id, actor_id, stage_id, data, screening=screening, store=store
    )
    preview = screening.preview_import(tx, project_id, actor_id, stage_id, rows)
    names = {m.actor_id: m.display_name for m in members(tx, project_id)}
    return DecisionImportPreview(
        export_id=sheet.export_id,
        exported_by=names.get(export["actor_id"], str(export["actor_id"])),
        exported_at=export["recorded_at"],
        sha256=sha256_hex(data),
        rows=len(sheet.rows),
        preview=preview,
    )


def apply_decision_import(
    tx: Tx,
    project_id: Id,
    actor_id: Id,
    stage_id: Id,
    data: bytes,
    *,
    command_id: Id,
    expected_preview: str,
    file_name: str | None,
    screening: Screening,
    store: ArtifactStore,
) -> ImportResult:
    """Import an edited working export as its preview showed it: the file is stored by hash,
    then `kittum.screening` records one batch event and one decision per changed row."""
    sheet, _, rows = _sheet_rows_of(
        tx, project_id, actor_id, stage_id, data, screening=screening, store=store
    )
    sha256 = store.put(data)
    return screening.import_decisions(
        tx,
        command_id=command_id,
        project_id=project_id,
        reviewer_id=actor_id,
        stage_id=stage_id,
        rows=rows,
        file=ImportFile(sha256=sha256, name=file_name, export_id=sheet.export_id),
        expected_preview=expected_preview,
    )


__all__ = [
    "COLUMNS",
    "COVER_TEXT",
    "LEAD_COLUMNS",
    "REVIEWER_COLUMNS",
    "WORKING_EXPORT",
    "WORKING_EXPORTED_EVENT",
    "XLSX",
    "DecisionImportPreview",
    "ExportView",
    "WorkingExport",
    "apply_decision_import",
    "build_workbook",
    "preview_decision_import",
    "working_export",
]
