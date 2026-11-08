"""Instruments as data: domains, signalling questions, their answer options and conditions.

A question applies always, or only when earlier answers meet its condition ("If Y/PY/NI to 2.1 or
2.2"). A question whose condition fails is not applicable (NA): nobody types NA, Kittum shows it.
A domain's proposed judgement comes from its algorithm once every applicable question has an
answer; the overall proposal comes from the domain judgements. Algorithms are code, registered
per instrument; a form without one (a profile's) gets its judgements from the reviewer only.
"""

from typing import TYPE_CHECKING, Literal, get_args

from kittum.core import Record

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

type Answer = Literal["yes", "probably_yes", "probably_no", "no", "no_information"]
type Judgement = Literal["low", "some_concerns", "high"]
type Applies = Literal["yes", "no", "pending"]
"""Whether a question applies: `pending` while an answer its condition reads is missing."""

ANSWERS: tuple[Answer, ...] = get_args(Answer.__value__)
JUDGEMENTS: tuple[Judgement, ...] = get_args(Judgement.__value__)

type DomainAlgorithm = Callable[[Mapping[str, Answer]], Judgement]
"""The answers of the domain's applicable questions, every one answered, to a judgement."""
type OverallRule = Callable[[tuple[Judgement, ...]], Judgement]


class Condition(Record):
    """`any`: at least one of `questions` has one of `answers`; `all`: every one has. A question
    that does not apply has none of them."""

    questions: tuple[str, ...]
    answers: tuple[Answer, ...]
    mode: Literal["any", "all"] = "any"


class SignallingQuestion(Record):
    id: str
    label: str
    """A few words for the compact list ("Sequence random?")."""
    text: str
    """The instrument's wording, without its condition."""
    options: tuple[Answer, ...] = ANSWERS
    condition: Condition | None = None
    terms: tuple[str, ...] = ()
    """Words whose mentions in the report the screen offers as quotes, in document order."""


class Domain(Record):
    id: str
    title: str
    questions: tuple[SignallingQuestion, ...]


class InstrumentDefinition(Record):
    id: str
    title: str
    source: str
    """The citation of the published instrument."""
    domains: tuple[Domain, ...]


def applicability(domain: Domain, answers: Mapping[str, Answer]) -> dict[str, Applies]:
    """Each question's applicability given the answers, in question order. A condition reads only
    earlier questions of the domain."""
    applies: dict[str, Applies] = {}
    for q in domain.questions:
        c = q.condition
        if c is None:
            applies[q.id] = "yes"
            continue
        states = [
            "pending"
            if applies.get(ref) == "pending" or (applies.get(ref) == "yes" and ref not in answers)
            else "met"
            if applies.get(ref) == "yes" and answers[ref] in c.answers
            else "unmet"
            for ref in c.questions
        ]
        if c.mode == "any":
            applies[q.id] = "yes" if "met" in states else "pending" if "pending" in states else "no"
        else:
            applies[q.id] = (
                "no" if "unmet" in states else "pending" if "pending" in states else "yes"
            )
    return applies


def propose(
    domain: Domain, answers: Mapping[str, Answer], algorithm: DomainAlgorithm | None
) -> Judgement | None:
    """The algorithm's judgement, or None until every applicable question has an answer."""
    if algorithm is None:
        return None
    applies = applicability(domain, answers)
    if any(state == "pending" for state in applies.values()):
        return None
    if any(state == "yes" and q not in answers for q, state in applies.items()):
        return None
    return algorithm({q: answers[q] for q, state in applies.items() if state == "yes"})


__all__ = [
    "ANSWERS",
    "JUDGEMENTS",
    "Answer",
    "Applies",
    "Condition",
    "Domain",
    "DomainAlgorithm",
    "InstrumentDefinition",
    "Judgement",
    "OverallRule",
    "SignallingQuestion",
    "applicability",
    "propose",
]
