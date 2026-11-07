"""The risk-of-bias summary: one row per appraised result, one column per domain.

The `risk_of_bias` target writes the appraisals as of the cutoff (`kittum.appraisal.appraisals`):
a Markdown table per instrument (studies by domains, the overall judgement last, a dagger where a
reviewer judged against the algorithm), a CSV with one row per result and domain with each
override's reason, and the same as JSON.
"""

import csv
import io
import json
from typing import TYPE_CHECKING, Any

from kittum.appraisal import OVERALL

if TYPE_CHECKING:
    from kittum.appraisal import Appraisal, Judgement

WORDS = {"low": "Low", "some_concerns": "Some concerns", "high": "High", None: "Not yet"}

CSV_COLUMNS = (
    "study",
    "report",
    "result",
    "instrument",
    "domain",
    "domain_title",
    "proposed",
    "judgement",
    "override_reason",
    "appraisal_id",
    "report_id",
    "study_id",
)


def word(judgement: Judgement | None, overridden: bool) -> str:
    return WORDS[judgement] + (" †" if overridden else "")


def rows(appraisals: tuple[Appraisal, ...]) -> list[dict[str, Any]]:
    """One row per appraisal and domain, then its overall judgement."""
    out = []
    for a in appraisals:
        parts = [(d.id, d.title, d.proposed, d.judgement, d.override) for d in a.domains]
        parts.append((OVERALL, "Overall", a.proposed, a.judgement, a.override))
        for domain, title, proposed, judgement, override in parts:
            out.append(
                {
                    "study": a.study_label,
                    "report": a.report_title,
                    "result": a.result,
                    "instrument": a.instrument,
                    "domain": domain,
                    "domain_title": title,
                    "proposed": proposed,
                    "judgement": judgement,
                    "override_reason": override.reason if override else None,
                    "appraisal_id": str(a.id),
                    "report_id": str(a.report_id),
                    "study_id": str(a.study_id),
                }
            )
    return out


def as_csv(appraisals: tuple[Appraisal, ...]) -> bytes:
    out = io.StringIO()
    writer = csv.DictWriter(out, CSV_COLUMNS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows(appraisals))
    return out.getvalue().encode()


def as_json(appraisals: tuple[Appraisal, ...], cutoff_seq: int) -> bytes:
    record = {"cutoff_seq": cutoff_seq, "rows": rows(appraisals)}
    text = json.dumps(record, indent=2, ensure_ascii=False, sort_keys=True)
    return (text + "\n").encode()
