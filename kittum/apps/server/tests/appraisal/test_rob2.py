"""RoB 2's suggested judgements against the published mapping tables, on every answer combination.

The tables below are transcribed from the RoB 2 guidance of 22 August 2019 (Tables 4, 6, 10, 12,
and 14), independently of the flow charts `kittum.appraisal.rob2` implements. Every combination of
answers the questions' conditions allow must match exactly one row and get that row's judgement;
a row's NA must be a question whose condition fails. So a wrong condition, a missing answer option,
or a wrong branch in an algorithm fails here.
"""

from itertools import product
from typing import TYPE_CHECKING, Any

import pytest

from kittum.appraisal import ROB2, applicability, instrument, propose

if TYPE_CHECKING:
    from kittum.appraisal import Answer, Domain, Judgement

YPY = {"yes", "probably_yes"}
NPN = {"no", "probably_no"}
NI = {"no_information"}
ANY: set[str] = YPY | NPN | NI
NA = "NA"
L, S, H = "low", "some_concerns", "high"

type Row = tuple[dict[str, Any], Judgement]

D1: list[Row] = [
    ({"1.1": YPY | NI, "1.2": YPY, "1.3": NPN | NI}, L),
    ({"1.1": YPY, "1.2": YPY, "1.3": YPY}, S),
    ({"1.1": NPN | NI, "1.2": YPY, "1.3": YPY}, S),
    # Table 4 has no row for a non-random sequence that was concealed with no imbalance; the
    # cribsheet's flow chart sends 1.1 N/PN to "some concerns" whatever 1.3 says.
    ({"1.1": NPN, "1.2": YPY, "1.3": NPN | NI}, S),
    ({"1.1": ANY, "1.2": NI, "1.3": NPN | NI}, S),
    ({"1.1": ANY, "1.2": NI, "1.3": YPY}, H),
    ({"1.1": ANY, "1.2": NPN, "1.3": ANY}, H),
]

D2_PART1: list[Row] = [
    ({"2.1": NPN, "2.2": NPN, "2.3": NA, "2.4": NA, "2.5": NA}, L),
    ({"either": YPY | NI, "2.3": NPN, "2.4": NA, "2.5": NA}, L),
    ({"either": YPY | NI, "2.3": NI, "2.4": NA, "2.5": NA}, S),
    ({"either": YPY | NI, "2.3": YPY, "2.4": NPN, "2.5": NA}, S),
    ({"either": YPY | NI, "2.3": YPY, "2.4": YPY | NI, "2.5": YPY}, S),
    ({"either": YPY | NI, "2.3": YPY, "2.4": YPY | NI, "2.5": NPN | NI}, H),
]
D2_PART2: list[Row] = [
    ({"2.6": YPY, "2.7": NA}, L),
    ({"2.6": NPN | NI, "2.7": NPN}, S),
    ({"2.6": NPN | NI, "2.7": YPY | NI}, H),
]

D3: list[Row] = [
    ({"3.1": YPY, "3.2": NA, "3.3": NA, "3.4": NA}, L),
    ({"3.1": NPN | NI, "3.2": YPY, "3.3": NA, "3.4": NA}, L),
    ({"3.1": NPN | NI, "3.2": NPN, "3.3": NPN, "3.4": NA}, L),
    ({"3.1": NPN | NI, "3.2": NPN, "3.3": YPY | NI, "3.4": NPN}, S),
    ({"3.1": NPN | NI, "3.2": NPN, "3.3": YPY | NI, "3.4": YPY | NI}, H),
]

D4: list[Row] = [
    ({"4.1": NPN | NI, "4.2": NPN, "4.3": NPN, "4.4": NA, "4.5": NA}, L),
    ({"4.1": NPN | NI, "4.2": NPN, "4.3": YPY | NI, "4.4": NPN, "4.5": NA}, L),
    ({"4.1": NPN | NI, "4.2": NPN, "4.3": YPY | NI, "4.4": YPY | NI, "4.5": NPN}, S),
    ({"4.1": NPN | NI, "4.2": NPN, "4.3": YPY | NI, "4.4": YPY | NI, "4.5": YPY | NI}, H),
    ({"4.1": NPN | NI, "4.2": NI, "4.3": NPN, "4.4": NA, "4.5": NA}, S),
    ({"4.1": NPN | NI, "4.2": NI, "4.3": YPY | NI, "4.4": NPN, "4.5": NA}, S),
    ({"4.1": NPN | NI, "4.2": NI, "4.3": YPY | NI, "4.4": YPY | NI, "4.5": NPN}, S),
    ({"4.1": NPN | NI, "4.2": NI, "4.3": YPY | NI, "4.4": YPY | NI, "4.5": YPY | NI}, H),
    ({"4.1": YPY, "4.2": ANY, "4.3": NA, "4.4": NA, "4.5": NA}, H),
    ({"4.1": NPN | NI, "4.2": YPY, "4.3": NA, "4.4": NA, "4.5": NA}, H),
]

D5: list[Row] = [
    ({"5.1": YPY, "5.2": NPN, "5.3": NPN}, L),
    ({"5.1": NPN | NI, "5.2": NPN, "5.3": NPN}, S),
    ({"5.1": ANY, "5.2": NPN, "5.3": NI}, S),
    ({"5.1": ANY, "5.2": NI, "5.3": NPN}, S),
    ({"5.1": ANY, "5.2": NI, "5.3": NI}, S),
    ({"5.1": ANY, "either": YPY}, H),
]


def _matches(row: dict[str, Any], answers: dict[str, Answer], pair: tuple[str, str]) -> bool:
    for key, allowed in row.items():
        if key == "either":
            if not any(answers.get(q) in allowed for q in pair):
                return False
        elif allowed == NA:
            if key in answers:
                return False
        elif answers.get(key) not in allowed:
            return False
    return True


REACHED: set[tuple[int, int]] = set()


def _lookup(table: list[Row], answers: dict[str, Answer], pair: tuple[str, str]) -> Judgement:
    found = [i for i, (row, _) in enumerate(table) if _matches(row, answers, pair)]
    assert len(found) == 1, (answers, found)
    REACHED.add((id(table), found[0]))
    return table[found[0]][1]


def _combinations(domain: Domain) -> list[dict[str, Answer]]:
    """Every set of answers the conditions allow: inapplicable questions stay unanswered."""
    out: list[dict[str, Answer]] = [{}]
    for q in domain.questions:
        grown = []
        for answers in out:
            if applicability(domain, answers)[q.id] == "no":
                grown.append(answers)
            else:
                grown += [answers | {q.id: a} for a in q.options]
        out = grown
    return out


def _worse(a: Judgement, b: Judgement) -> Judgement:
    order = [L, S, H]
    return max(a, b, key=order.index)


TABLES = {"D1": [D1], "D2": [D2_PART1, D2_PART2], "D3": [D3], "D4": [D4], "D5": [D5]}
EXPECTED = {
    "D1": lambda a: _lookup(D1, a, ("", "")),
    "D2": lambda a: _worse(
        _lookup(D2_PART1, a, ("2.1", "2.2")), _lookup(D2_PART2, a, ("2.6", "2.7"))
    ),
    "D3": lambda a: _lookup(D3, a, ("", "")),
    "D4": lambda a: _lookup(D4, a, ("", "")),
    "D5": lambda a: _lookup(D5, a, ("5.2", "5.3")),
}


@pytest.mark.parametrize("domain", ROB2.domains, ids=lambda d: d.id)
def test_every_answer_combination_gets_the_published_judgement(domain: Domain) -> None:
    algorithm = instrument("rob2").algorithms[domain.id]
    combinations = _combinations(domain)
    for answers in combinations:
        assert propose(domain, answers, algorithm) == EXPECTED[domain.id](answers), answers
    # Every published row is reached: no path of the tables is unreachable under the conditions.
    for table in TABLES[domain.id]:
        assert {i for t, i in REACHED if t == id(table)} == set(range(len(table)))


def test_a_judgement_waits_for_every_applicable_answer_and_ignores_stale_ones() -> None:
    d2 = next(d for d in ROB2.domains if d.id == "D2")
    algorithm = instrument("rob2").algorithms["D2"]
    blind: dict[str, Answer] = {"2.1": "no", "2.2": "probably_no", "2.6": "yes"}
    assert propose(d2, blind, algorithm) == "low"
    # Open-label: 2.3 now applies, and the domain waits for it.
    open_label: dict[str, Answer] = blind | {"2.1": "yes"}
    assert applicability(d2, open_label)["2.3"] == "yes"
    assert propose(d2, open_label, algorithm) is None
    assert propose(d2, open_label | {"2.3": "no_information"}, algorithm) == "some_concerns"
    # An answer to 2.4 left from an earlier path does not count while 2.3 says no deviations.
    stale: dict[str, Answer] = open_label | {"2.3": "no", "2.4": "yes", "2.5": "no"}
    assert applicability(d2, stale)["2.4"] == "no"
    assert propose(d2, stale, algorithm) == "low"
    # 4.3 applies only when both 4.1 and 4.2 are N/PN/NI, and waits for both.
    d4 = next(d for d in ROB2.domains if d.id == "D4")
    assert applicability(d4, {"4.1": "no"})["4.3"] == "pending"
    assert applicability(d4, {"4.1": "no", "4.2": "yes"})["4.3"] == "no"


def test_the_overall_judgement_is_the_worst_domain() -> None:
    overall = instrument("rob2").overall
    assert overall is not None
    for judgements in product((L, S, H), repeat=5):
        expected = H if H in judgements else S if S in judgements else L
        assert overall(judgements) == expected


def test_question_3_2_offers_no_no_information_answer() -> None:
    options = {q.id: q.options for d in ROB2.domains for q in d.questions}
    assert "no_information" not in options["3.2"]
    assert all("no_information" in o for q, o in options.items() if q != "3.2")
