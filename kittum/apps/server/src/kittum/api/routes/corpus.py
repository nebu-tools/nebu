"""Corpus routes for proposals, human confirmation, split, merge, and PRISMA counts."""

from contextlib import contextmanager
from typing import TYPE_CHECKING

from fastapi import APIRouter, HTTPException, Query

from kittum.api import AppContext, Context  # noqa: TC001
from kittum.api.routes.projects import Viewer  # noqa: TC001 - FastAPI resolves it at runtime
from kittum.api.routes.search import UploadEncoding, upload_bytes
from kittum.app import (
    LifecycleError,
    NotLead,
    import_pool_file,
    ingest_corpus,
    request_enrichment,
    require_lead,
)
from kittum.core import Id, NotFoundError, Record
from kittum.corpus import (
    CorpusLink,
    CorpusReport,
    CorpusRevision,
    CorpusSearch,
    IdentityRevision,
    KnownPoolFile,
    LinkProposal,
    PoolComparison,
    PrismaCounts,
    ProposalStatus,
    Relation,
    SplitLevel,
    StaleRevision,
    compare_known_pool,
    confirm,
    confirm_exact,
    get_counts,
    latest_revision,
    links,
    list_proposals,
    merge,
    reports,
    searches,
    split,
    withdraw_known_pool,
)
from kittum.ledger import Ledger  # noqa: TC001

if TYPE_CHECKING:
    from collections.abc import Generator

router = APIRouter(prefix="/api/projects/{project_id}/corpus", tags=["corpus"])


class IngestRequest(Record):
    actor_id: Id


class CorpusView(Record):
    """The newest identity revision: every report with its records and study, the searches the
    records came from, and why linked records are together."""

    revision: IdentityRevision
    reports: tuple[CorpusReport, ...]
    searches: tuple[CorpusSearch, ...] = ()
    links: tuple[CorpusLink, ...] = ()


class ConfirmRequest(Record):
    revision_id: Id
    proposal_id: Id
    actor_id: Id


class ConfirmExactRequest(Record):
    revision_id: Id
    actor_id: Id


class MergeRequest(Record):
    revision_id: Id
    occurrence_ids: tuple[Id, ...]
    relation: Relation
    actor_id: Id
    reason: str = ""


class SplitRequest(Record):
    revision_id: Id
    occurrence_ids: tuple[Id, ...]
    level: SplitLevel
    actor_id: Id
    reason: str = ""


@router.post("/ingest", operation_id="ingestCorpus", status_code=201)
def ingest_route(project_id: Id, body: IngestRequest, ctx: Context) -> CorpusRevision:
    """Deduplicate every search of the project into the first identity revision, and queue its
    enrichment from the open sources when a worker can run it."""
    with _errors(), ctx.db.transaction() as tx:
        # The revision comes back with every record: the lead's catalogue.
        require_lead(tx, project_id, body.actor_id)
        revision = ingest_corpus(tx, project_id, actor_id=body.actor_id, ledger=_ledger(ctx))
        if ctx.queue is not None and ctx.gateway is not None:
            request_enrichment(
                tx,
                project_id,
                actor_id=body.actor_id,
                trigger="corpus_built",
                ledger=_ledger(ctx),
                queue=ctx.queue,
                clock=ctx.clock,
            )
        return revision


@router.get("/revisions/latest", operation_id="getLatestCorpusRevision")
def latest_route(project_id: Id, viewer: Viewer, ctx: Context) -> CorpusView:
    """Every record of the project, for its methods lead only (403 otherwise)."""
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, viewer)
        revision = latest_revision(tx, project_id)
        if revision is None:
            raise NotFoundError("the corpus is not ingested yet")
        return CorpusView(
            revision=revision,
            reports=tuple(reports(tx, project_id, revision.id)),
            searches=tuple(searches(tx, project_id)),
            links=tuple(links(tx, project_id, revision.id, ledger=_ledger(ctx))),
        )


@router.get("/proposals", operation_id="listCorpusProposals")
def list_proposals_route(
    project_id: Id,
    viewer: Viewer,
    ctx: Context,
    corpus_revision_id: Id | None = Query(default=None),
    status: ProposalStatus | None = Query(default=None),
) -> list[LinkProposal]:
    """The link proposals, for the project's methods lead only (403 otherwise)."""
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, viewer)
        return list_proposals(
            tx,
            project_id,
            corpus_revision_id=corpus_revision_id,
            status=status,
        )


@router.post("/confirm", operation_id="confirmCorpusProposal")
def confirm_route(
    project_id: Id,
    body: ConfirmRequest,
    ctx: Context,
) -> IdentityRevision:
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, body.actor_id)
        return confirm(
            tx,
            project_id,
            body.revision_id,
            body.proposal_id,
            body.actor_id,
            ledger=_ledger(ctx),
        )


@router.post("/confirm-exact", operation_id="confirmExactDuplicates")
def confirm_exact_route(
    project_id: Id,
    body: ConfirmExactRequest,
    ctx: Context,
) -> IdentityRevision:
    """Confirm every open duplicate that shares a DOI, PMID, or PMCID; 400 when there is none,
    409 when the revision is no longer the newest."""
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, body.actor_id)
        return confirm_exact(tx, project_id, body.revision_id, body.actor_id, ledger=_ledger(ctx))


@router.post("/merge", operation_id="mergeCorpusOccurrences")
def merge_route(
    project_id: Id,
    body: MergeRequest,
    ctx: Context,
) -> IdentityRevision:
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, body.actor_id)
        return merge(
            tx,
            project_id,
            body.revision_id,
            body.occurrence_ids,
            body.relation,
            body.actor_id,
            reason=body.reason,
            ledger=_ledger(ctx),
        )


@router.post("/split", operation_id="splitCorpusOccurrences")
def split_route(
    project_id: Id,
    body: SplitRequest,
    ctx: Context,
) -> IdentityRevision:
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, body.actor_id)
        return split(
            tx,
            project_id,
            body.revision_id,
            body.occurrence_ids,
            body.level,
            body.actor_id,
            reason=body.reason,
            ledger=_ledger(ctx),
        )


@router.get("/revisions/{revision_id}/counts", operation_id="getCorpusPrismaCounts")
def get_counts_route(
    project_id: Id,
    revision_id: Id,
    ctx: Context,
) -> PrismaCounts:
    with _errors(), ctx.db.transaction() as tx:
        return get_counts(tx, project_id, revision_id)


class KnownPoolImportRequest(Record):
    topic_id: str
    data: str
    """The file: its text, or for `records-xlsx` its bytes in base64."""
    encoding: UploadEncoding = "text"
    format: str
    """Any search import format: RIS, NBIB, a records list as CSV or XLSX, and the rest."""
    file_name: str | None = None
    actor_id: Id


class KnownPoolWithdrawRequest(Record):
    actor_id: Id


@router.post("/known-pool", operation_id="importKnownPool", status_code=201)
def import_known_pool_route(
    project_id: Id, body: KnownPoolImportRequest, ctx: Context
) -> KnownPoolFile:
    """Add a file of papers the topic's searches should find to its known pool."""
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, body.actor_id)
        return import_pool_file(
            tx,
            project_id,
            body.topic_id,
            upload_bytes(body.data, body.encoding),
            body.format,
            file_name=body.file_name,
            actor_id=body.actor_id,
            ledger=_ledger(ctx),
            artifacts=ctx.artifacts,
        )


@router.get("/known-pool", operation_id="getKnownPool")
def known_pool_route(
    project_id: Id, viewer: Viewer, ctx: Context, topic_id: str = Query()
) -> PoolComparison:
    """The topic's known pool beside its searches: what they found of it, what they missed, and
    what is new. For the methods lead only (403 otherwise)."""
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, viewer)
        return compare_known_pool(tx, project_id, topic_id)


@router.post("/known-pool/{file_id}/withdraw", operation_id="withdrawKnownPoolFile")
def withdraw_known_pool_route(
    project_id: Id, file_id: Id, body: KnownPoolWithdrawRequest, ctx: Context
) -> KnownPoolFile:
    """Take a pool file out of the comparison. It stays listed, and in the ledger."""
    with _errors(), ctx.db.transaction() as tx:
        require_lead(tx, project_id, body.actor_id)
        return withdraw_known_pool(
            tx, project_id, file_id, actor_id=body.actor_id, ledger=_ledger(ctx)
        )


@contextmanager
def _errors() -> Generator[None]:
    try:
        yield
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except NotLead as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except (LifecycleError, StaleRevision) as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def _ledger(ctx: AppContext) -> Ledger:
    if ctx.ledger is None:
        raise HTTPException(status_code=503, detail="no ledger is configured")
    return ctx.ledger
