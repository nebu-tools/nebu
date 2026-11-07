"""Risk-of-bias appraisal (DESIGN.md, "Appraisal").

Forms are data: domains, signalling questions with their answer options and conditions, and
words that point at the passages each question is about. The core instrument is RoB 2 for
randomized trials (`kittum.appraisal.rob2`), with its published algorithms for the suggested
domain judgements and the overall rule. Profiles add their own forms with `register_instrument`
under IDs of the form `<profile id>.<name>`; a form without algorithms gets every judgement from
the reviewer.

A named human answers every question. An appraisal is of one result of one report, on the
report's full text: each answer carries quotes as anchors on that document, and Kittum checks
each quote with `find_quote`. The algorithm proposes each domain's judgement once its applicable
questions are answered; the reviewer may override a domain or the overall judgement with a
reason. Every answer and override is a ledger event.

    with ctx.db.transaction() as tx:
        appraisal = appraisal.start(tx, ledger, command_id=..., instrument_id="rob2", ...)
        appraisal = appraisal.answer(tx, ledger, appraisal_id=..., question_id="1.1",
                                     answer="probably_yes", anchor_ids=(anchor.id,), ...)

No model answers or assembles anything yet. Owner: WP-12.
"""

from typing import Literal, get_args

from kittum.appraisal.forms import (
    ANSWERS,
    JUDGEMENTS,
    Answer,
    Applies,
    Condition,
    Domain,
    DomainAlgorithm,
    InstrumentDefinition,
    Judgement,
    OverallRule,
    SignallingQuestion,
    applicability,
    propose,
)
from kittum.appraisal.rob2 import ALGORITHMS as ROB2_ALGORITHMS
from kittum.appraisal.rob2 import ROB2, worst
from kittum.appraisal.store import (
    ANSWERED,
    OVERALL,
    OVERRIDDEN,
    STARTED,
    Appraisal,
    AppraisalError,
    DomainView,
    Instrument,
    Override,
    QuestionMentions,
    QuestionView,
    answer,
    appraisals,
    get,
    instrument,
    mentions,
    override,
    register,
    registered,
    start,
)

type CoreInstrument = Literal["rob2"]

CORE_INSTRUMENTS: tuple[CoreInstrument, ...] = get_args(CoreInstrument.__value__)

register(Instrument(definition=ROB2, algorithms=ROB2_ALGORITHMS, overall=worst))


def register_instrument(
    definition: InstrumentDefinition,
    algorithms: dict[str, DomainAlgorithm] | None = None,
    overall: OverallRule | None = None,
) -> None:
    """Add a profile's instrument. Called from the entry points, once per process."""
    profile, dot, name = definition.id.partition(".")
    if not (profile and dot and name):
        raise ValueError(
            f"profile instruments are named '<profile id>.<name>', got {definition.id!r}"
        )
    register(Instrument(definition=definition, algorithms=algorithms or {}, overall=overall))


def instruments() -> tuple[str, ...]:
    """The core instruments, then the profiles', by ID."""
    return (*CORE_INSTRUMENTS, *sorted(i for i in registered() if i not in CORE_INSTRUMENTS))


__all__ = [
    "ANSWERED",
    "ANSWERS",
    "CORE_INSTRUMENTS",
    "JUDGEMENTS",
    "OVERALL",
    "OVERRIDDEN",
    "ROB2",
    "STARTED",
    "Answer",
    "Applies",
    "Appraisal",
    "AppraisalError",
    "Condition",
    "CoreInstrument",
    "Domain",
    "DomainAlgorithm",
    "DomainView",
    "InstrumentDefinition",
    "Judgement",
    "OverallRule",
    "Override",
    "QuestionMentions",
    "QuestionView",
    "SignallingQuestion",
    "answer",
    "applicability",
    "appraisals",
    "get",
    "instrument",
    "instruments",
    "mentions",
    "override",
    "propose",
    "register_instrument",
    "start",
]
