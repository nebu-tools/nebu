"""Report routes: the targets a project can render, rendering one, downloading its files, and
sealing the handover bundle.

A render is stored by hash and recorded with a `report.rendered` event; downloads serve only
files rendered for the project, never an arbitrary artifact by hash. Sealing needs the checkpoint
key (`KITTUM_CHECKPOINT_KEY`) and writes the bundle under `bundles/` beside the artifact store.

Reports show every reviewer's decisions and the AI's output, so rendering, downloading, and
sealing are for the methods lead only (`report.require_lead`): never a screener, auditor, or
adjudicator of a stage. The working export is the exception: it follows the screening table's
blinding, so a screener or auditor exports only their own rows. Until the API has authentication (WP-15), the caller names the actor in
the body or in the `X-Kittum-Reviewer` header; that is a stand-in, not a security boundary.
"""

import base64
import binascii
from contextlib import contextmanager
from typing import TYPE_CHECKING, Annotated, Literal

from fastapi import APIRouter, Header, HTTPException, Path, Response
from pydantic import Field

from kittum.api import AppContext, Context  # noqa: TC001 - FastAPI resolves it at runtime
from kittum.core import Id, NotFoundError, Record, new_id
from kittum.ledger import LedgerIntegrityError, SigningKey
from kittum.protocol import Stage, latest_published
from kittum.report import (
    CORE_TARGETS,
    XLSX,
    Artifact,
    DecisionImportPreview,
    ExportView,
    NotTheLead,
    ReportRequestError,
    RightsProfile,
    apply_decision_import,
    head_seq,
    preview_decision_import,
    record_render,
    render,
    rendered_file,
    require_lead,
    seal_bundle,
    targets,
    working_export,
)
from kittum.runs import CommandIdReused
from kittum.screening import ImportResult, InvalidDecision, NotAssigned, Screening, StaleRevision

if TYPE_CHECKING:
    from collections.abc import Generator

    from kittum.ledger import Ledger

router = APIRouter(prefix="/api/projects/{project_id}/reports", tags=["reports"])

Sha256Path = Annotated[str, Path(pattern=r"^[0-9a-f]{64}$")]
Reviewer = Annotated[
    Id,
    Header(
        alias="X-Kittum-Reviewer",
        description="The caller's actor ID. A stand-in until the API has authentication.",
    ),
]


class TargetInfo(Record):
    id: str
    kind: Literal["core", "profile"]
    renderable: bool
    """False for `bundle`, which is sealed, not rendered."""


class RenderRequest(Record):
    actor_id: Id
    scope_id: str | None = None
    """One scope; every scope when empty."""
    cutoff_seq: int | None = None
    """The ledger event to render at; the head when empty."""
    identity_revision_id: Id | None = None
    """The identity revision to count from; the latest at the cutoff when empty."""


class RenderedArtifact(Record):
    sha256: str
    """The hash of the artifact's index, which names it."""
    artifact: Artifact


class SealRequest(Record):
    actor_id: Id
    cutoff_seq: int | None = None
    withhold_sources: dict[str, str] = Field(default_factory=dict)
    """Search source -> reason: its raw files are listed by hash, not shipped."""


class SealedBundle(Record):
    path: str
    cutoff_seq: int
    manifest_hash: str
    key_id: str


class WorkingExportRequest(Record):
    scope_id: str
    stage: Stage
    topic_id: str | None = None
    view: ExportView | None = None
    """The table view to export; the whole stage as the caller may see it when empty."""


class DecisionImportRequest(Record):
    stage_id: Id
    """The stage whose table the file is imported on; it must be the export's stage."""
    data: str = Field(max_length=50_000_000)
    """The edited working export (XLSX), its bytes in base64."""
    file_name: str | None = Field(default=None, max_length=255)


class DecisionImportApply(DecisionImportRequest):
    command_id: Id
    """Chosen by the client; a retry with the same ID returns the first result."""
    preview_hash: str
    """`preview.preview_hash` of the preview the caller saw: if anything changed since, 409."""


def _ledger(ctx: AppContext) -> Ledger:
    if ctx.ledger is None:
        raise HTTPException(status_code=503, detail="no ledger is configured")
    return ctx.ledger


@contextmanager
def _errors() -> Generator[None]:
    try:
        yield
    except NotTheLead as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except (NotFoundError, NotAssigned) as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ReportRequestError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except InvalidDecision as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except (StaleRevision, CommandIdReused) as e:
        raise HTTPException(status_code=409, detail=str(e)) from e


@router.get("/targets", operation_id="listReportTargets")
def list_targets(project_id: Id, ctx: Context) -> list[TargetInfo]:
    """The core targets, and the targets of the profile the published protocol names."""
    with _errors(), ctx.db.transaction() as tx:
        stored = latest_published(tx, project_id)
    profile = stored.version.protocol.profile if stored else None
    names = targets(profile) if profile else CORE_TARGETS
    return [
        TargetInfo(
            id=t,
            kind="core" if t in CORE_TARGETS else "profile",
            renderable=t != "bundle",
        )
        for t in names
    ]


@router.post("/targets/{target}/render", operation_id="renderReportTarget")
def render_target(
    project_id: Id, target: str, body: RenderRequest, ctx: Context
) -> RenderedArtifact:
    """Render a target from the ledger, store its files by hash, and record the render."""
    ledger = _ledger(ctx)
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, body.actor_id)
        artifact = render(
            tx,
            target,
            project_id,
            body.scope_id,
            store=ctx.artifacts,
            cutoff_seq=body.cutoff_seq,
            identity_revision_id=body.identity_revision_id,
            ledger=ledger,
        )
        sha256 = record_render(
            tx,
            artifact,
            store=ctx.artifacts,
            actor_id=body.actor_id,
            ledger=ledger,
            clock=ctx.clock,
        )
    return RenderedArtifact(sha256=sha256, artifact=artifact)


@router.get(
    "/artifacts/{sha256}",
    operation_id="downloadReportArtifact",
    response_class=Response,
    responses={200: {"content": {"application/octet-stream": {}}}},
)
def download(project_id: Id, sha256: Sha256Path, reviewer: Reviewer, ctx: Context) -> Response:
    """A rendered file, or an artifact's index, by hash. For the methods lead only."""
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, reviewer)
        media_type = rendered_file(tx, project_id, sha256)
    if media_type is None:
        raise HTTPException(
            status_code=404, detail=f"nothing rendered for the project has {sha256}"
        )
    return Response(content=ctx.artifacts.get(sha256), media_type=media_type)


@router.post(
    "/working-export",
    operation_id="exportWorkingSpreadsheet",
    response_class=Response,
    responses={200: {"content": {"application/octet-stream": {}}}},
)
def export_working(
    project_id: Id, body: WorkingExportRequest, reviewer: Reviewer, ctx: Context
) -> Response:
    """The working spreadsheet (XLSX) of a stage, or of the caller's table view: a screener's or
    auditor's own rows, or the whole stage for the methods lead. Stored by hash and recorded in
    the ledger. Not the audit bundle."""
    ledger = _ledger(ctx)
    with _errors(), ctx.db.transaction() as tx:
        exported, data = working_export(
            tx,
            project_id,
            reviewer,
            body.scope_id,
            body.stage,
            topic_id=body.topic_id,
            view=body.view,
            store=ctx.artifacts,
            ledger=ledger,
            clock=ctx.clock,
        )
    return Response(
        content=data,
        media_type=XLSX,
        headers={
            "Content-Disposition": f'attachment; filename="{exported.file_name}"',
            "X-Kittum-Sha256": exported.sha256,
        },
    )


def _upload(data: str) -> bytes:
    try:
        return base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(status_code=400, detail="the file is not valid base64") from e


@router.post("/working-export/import-preview", operation_id="previewDecisionImport")
def preview_import(
    project_id: Id, body: DecisionImportRequest, reviewer: Reviewer, ctx: Context
) -> DecisionImportPreview:
    """What importing an edited working export would decide: the rows that change, the unchanged
    ones, and the refused ones with their reasons. Records nothing. Only a screener's export of a
    title and abstract stage in a working topic brings decisions back; a complete topic refuses
    (422)."""
    data = _upload(body.data)
    with _errors(), ctx.db.transaction() as tx:
        return preview_decision_import(
            tx,
            project_id,
            reviewer,
            body.stage_id,
            data,
            screening=Screening.postgres(_ledger(ctx), ctx.clock),
            store=ctx.artifacts,
        )


@router.post("/working-export/import", operation_id="importDecisions")
def import_decisions(
    project_id: Id, body: DecisionImportApply, reviewer: Reviewer, ctx: Context
) -> ImportResult:
    """Import an edited working export as its preview showed it: the file is stored by hash, one
    batch event names it, its export, and the counts, and each changed row becomes one decision
    with `origin: spreadsheet`. If anything changed since the preview, nothing is recorded (409)."""
    data = _upload(body.data)
    with _errors(), ctx.db.transaction() as tx:
        return apply_decision_import(
            tx,
            project_id,
            reviewer,
            body.stage_id,
            data,
            command_id=body.command_id,
            expected_preview=body.preview_hash,
            file_name=body.file_name,
            screening=Screening.postgres(_ledger(ctx), ctx.clock),
            store=ctx.artifacts,
        )


@router.post("/bundle", operation_id="sealReportBundle")
def seal(project_id: Id, body: SealRequest, ctx: Context) -> SealedBundle:
    """Seal the handover bundle with every report, at the cutoff or the ledger head."""
    ledger = _ledger(ctx)
    key_path = ctx.settings.checkpoint_key_path
    if key_path is None:
        raise HTTPException(status_code=503, detail="no checkpoint key is configured")
    signer = SigningKey.from_file(key_path)
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, body.actor_id)
        cutoff = head_seq(tx, project_id) if body.cutoff_seq is None else body.cutoff_seq
        out = ctx.settings.artifact_dir.parent / "bundles" / f"{project_id}-{cutoff}-{new_id()}"
        try:
            bundle = seal_bundle(
                tx,
                project_id,
                ctx.artifacts,
                out,
                signer=signer,
                actor_id=body.actor_id,
                cutoff_seq=cutoff,
                rights=RightsProfile(id="request", withhold_sources=body.withhold_sources),
                ledger=ledger,
                clock=ctx.clock,
            )
        except LedgerIntegrityError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
    return SealedBundle(
        path=str(bundle.path),
        cutoff_seq=bundle.cutoff_seq,
        manifest_hash=bundle.manifest_hash,
        key_id=bundle.checkpoint.key_id,
    )
