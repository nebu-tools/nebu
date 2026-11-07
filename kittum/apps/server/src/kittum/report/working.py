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
`working_export`, and recorded with a `report.working_exported` event.
"""

import re
from datetime import UTC
from io import BytesIO
from typing import TYPE_CHECKING, Literal

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter
from psycopg.types.json import Jsonb

from kittum.core import Id, Record, Sha256, canonical_json, new_id, sha256_hex
from kittum.ledger import EventDraft
from kittum.people import members
from kittum.protocol import get_version
from kittum.report.review import ReportRequestError, head_seq
from kittum.screening import criteria_for, screening_table, topic_for

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence
    from datetime import datetime

    from openpyxl.worksheet.worksheet import Worksheet

    from kittum.core import Clock
    from kittum.db import Tx
    from kittum.ledger import Ledger
    from kittum.protocol import Criterion, Stage
    from kittum.screening import ScreeningTable, TableDecision, TableRow
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
    return f"{_OUTCOME[d.outcome]}{reason}{final}"


def _decisions(row: TableRow) -> Value:
    parts = [f"{d.name or d.reviewer_id}: {_decision(d) or 'not decided'}" for d in row.decisions]
    return "; ".join(parts) or None


def _ai(row: TableRow) -> Value:
    r = row.reveal
    return f"{_STATUS.get(r.status, r.status)} on {r.criterion_id}" if r else None


def _ai_excludes(row: TableRow) -> Value:
    return None if row.ai_excludes is None else ("Yes" if row.ai_excludes else "No")


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
) -> bytes:
    """The XLSX file: the cover sheet, the rows, and the criteria the reasons name."""
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
    _sheet_rows(
        records,
        [[COLUMNS[c][0] for c in columns], *([COLUMNS[c][1](r) for c in columns] for r in rows)],
        [_width(c) for c in columns],
    )
    for c in records[1]:
        c.font = Font(bold=True)
    records.freeze_panes = "B2"
    records.auto_filter.ref = records.dimensions

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


def _columns(table: ScreeningTable, view: ExportView | None) -> tuple[str, ...]:
    allowed = _ONLY[table.view]
    if view is None:
        return REVIEWER_COLUMNS if table.view == "reviewer" else LEAD_COLUMNS
    unknown = [c for c in view.columns if c not in allowed]
    if unknown:
        raise ReportRequestError(f"columns not in this table: {', '.join(unknown)}")
    if not view.columns:
        raise ReportRequestError("a view export needs at least one column")
    # The stable reference always travels, in view or not.
    return tuple(dict.fromkeys(view.columns if "ref" in view.columns else ("ref", *view.columns)))


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
    cover: list[tuple[str, Value]] = [
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
    data = build_workbook(
        cover, columns, rows, criteria, created=now.astimezone(UTC).replace(tzinfo=None)
    )
    sha256 = store.put(data)
    day = now.date().isoformat()
    file_name = re.sub(r"[^A-Za-z0-9._-]+", "_", f"kittum-working-{scope_id}-{stage}-{day}.xlsx")
    export_id = new_id()
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
    exported = WorkingExport(sha256=sha256, file_name=file_name, rows=len(rows), view=table.view)
    return exported, data


__all__ = [
    "COLUMNS",
    "COVER_TEXT",
    "LEAD_COLUMNS",
    "REVIEWER_COLUMNS",
    "WORKING_EXPORT",
    "WORKING_EXPORTED_EVENT",
    "XLSX",
    "ExportView",
    "WorkingExport",
    "build_workbook",
    "working_export",
]
