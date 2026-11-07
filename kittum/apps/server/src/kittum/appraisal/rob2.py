"""RoB 2, the revised Cochrane risk-of-bias tool for randomized trials, as data.

The signalling questions, their answer options, their conditions, and the algorithms for the
suggested domain judgements follow the RoB 2 guidance and its cribsheet of 22 August 2019
(Higgins, Savović, Page, Sterne, eds., on behalf of the RoB 2 Development Group;
riskofbias.info) and Sterne JAC et al., "RoB 2: a revised tool for assessing risk of bias in
randomised trials", BMJ 2019;366:l4898. Domain 2 is the variant for the effect of assignment to
intervention (the intention-to-treat effect); the variant for the effect of adhering to
intervention is not built.

The wording of the signalling questions and domain titles is the RoB 2 Development Group's, under
CC BY-NC-ND 4.0 (creativecommons.org/licenses/by-nc-nd/4.0), not under Kittum's AGPL: quoted
verbatim, with attribution, unchanged. The short labels and the mention words are Kittum's.
docs/dependencies.md has the open question about commercial use.

Each algorithm is the cribsheet's flow chart for its domain. The overall rule is the guidance's
Table 1: low if every domain is low, high if any domain is high, otherwise some concerns. "Some
concerns for multiple domains in a way that substantially lowers confidence in the result" may
also be judged high; that is the reviewer's call, made as an override with a reason.
"""

from typing import TYPE_CHECKING

from kittum.appraisal.forms import Condition, Domain, InstrumentDefinition, SignallingQuestion

if TYPE_CHECKING:
    from collections.abc import Mapping

    from kittum.appraisal.forms import Answer, DomainAlgorithm, Judgement

Y: tuple[Answer, ...] = ("yes", "probably_yes")
N: tuple[Answer, ...] = ("no", "probably_no")
NI: Answer = "no_information"

_RANDOM = ("random", "sequence", "computer-generated", "minimi", "block", "stratif")
_CONCEALED = ("conceal", "allocat", "envelope", "central", "independent", "statistician")
_BASELINE = ("baseline", "imbalance", "table 1", "characteristics")
_AWARE = ("blind", "mask", "open-label", "open label", "aware", "placebo", "sham")
_DEVIATIONS = (
    "deviat",
    "crossover",
    "cross-over",
    "switch",
    "contaminat",
    "adherence",
    "non-protocol",
)
_ANALYSIS = (
    "intention-to-treat",
    "intention to treat",
    "ITT",
    "per-protocol",
    "per protocol",
    "as-treated",
    "analysis set",
    "analysed",
    "analyzed",
    "excluded from",
)
_MISSING = (
    "missing",
    "lost to follow",
    "loss to follow",
    "withdr",
    "drop",
    "imput",
    "attrition",
    "complete case",
    "sensitivity analys",
)
_MEASURE = (
    "measured",
    "measurement",
    "ascertain",
    "adjudicat",
    "laboratory",
    "questionnaire",
    "self-report",
    "validated",
)
_ASSESSORS = ("assessor", "blind", "mask", "adjudicat", "aware", "independent")
_PLAN = (
    "protocol",
    "statistical analysis plan",
    "pre-specified",
    "prespecified",
    "registered",
    "registration",
    "primary outcome",
    "primary endpoint",
    "post hoc",
    "sensitivity analys",
    "subgroup",
)


def _q(
    qid: str,
    label: str,
    text: str,
    terms: tuple[str, ...],
    condition: Condition | None = None,
    options: tuple[Answer, ...] | None = None,
) -> SignallingQuestion:
    extra = {"options": options} if options else {}
    return SignallingQuestion(
        id=qid, label=label, text=text, terms=terms, condition=condition, **extra
    )


def _if(*questions: str, answers: tuple[Answer, ...], mode: str = "any") -> Condition:
    return Condition.model_validate({"questions": questions, "answers": answers, "mode": mode})


_SELECTED = "Is the numerical result being assessed likely to have been selected, on the basis of the results, from"

ROB2 = InstrumentDefinition(
    id="rob2",
    title="RoB 2 (randomized trials, effect of assignment to intervention)",
    source=(
        "Sterne JAC, Savović J, Page MJ, et al. RoB 2: a revised tool for assessing risk of bias"
        " in randomised trials. BMJ 2019;366:l4898. Higgins JPT, Savović J, Page MJ, Sterne JAC"
        " (eds). Revised Cochrane risk-of-bias tool for randomized trials (RoB 2), guidance and"
        " cribsheet, 22 August 2019."
    ),
    domains=(
        Domain(
            id="D1",
            title="Randomization process",
            questions=(
                _q("1.1", "Sequence random?", "Was the allocation sequence random?", _RANDOM),
                _q(
                    "1.2",
                    "Allocation concealed?",
                    "Was the allocation sequence concealed until participants were enrolled and"
                    " assigned to interventions?",
                    _CONCEALED,
                ),
                _q(
                    "1.3",
                    "Baseline imbalance suggests a problem?",
                    "Did baseline differences between intervention groups suggest a problem with"
                    " the randomization process?",
                    _BASELINE,
                ),
            ),
        ),
        Domain(
            id="D2",
            title="Deviations from intended interventions",
            questions=(
                _q(
                    "2.1",
                    "Participants aware?",
                    "Were participants aware of their assigned intervention during the trial?",
                    _AWARE,
                ),
                _q(
                    "2.2",
                    "Carers and deliverers aware?",
                    "Were carers and people delivering the interventions aware of participants'"
                    " assigned intervention during the trial?",
                    _AWARE,
                ),
                _q(
                    "2.3",
                    "Deviations because of the trial context?",
                    "Were there deviations from the intended intervention that arose because of"
                    " the trial context?",
                    _DEVIATIONS,
                    _if("2.1", "2.2", answers=(*Y, NI)),
                ),
                _q(
                    "2.4",
                    "Deviations affected the outcome?",
                    "Were these deviations likely to have affected the outcome?",
                    _DEVIATIONS,
                    _if("2.3", answers=Y),
                ),
                _q(
                    "2.5",
                    "Deviations balanced?",
                    "Were these deviations from intended intervention balanced between groups?",
                    _DEVIATIONS,
                    _if("2.4", answers=(*Y, NI)),
                ),
                _q(
                    "2.6",
                    "Appropriate analysis?",
                    "Was an appropriate analysis used to estimate the effect of assignment to"
                    " intervention?",
                    _ANALYSIS,
                ),
                _q(
                    "2.7",
                    "Substantial impact of the analysis?",
                    "Was there potential for a substantial impact (on the result) of the failure"
                    " to analyse participants in the group to which they were randomized?",
                    _ANALYSIS,
                    _if("2.6", answers=(*N, NI)),
                ),
            ),
        ),
        Domain(
            id="D3",
            title="Missing outcome data",
            questions=(
                _q(
                    "3.1",
                    "Data for (nearly) all participants?",
                    "Were data for this outcome available for all, or nearly all, participants"
                    " randomized?",
                    _MISSING,
                ),
                _q(
                    "3.2",
                    "Evidence the result is not biased?",
                    "Is there evidence that the result was not biased by missing outcome data?",
                    _MISSING,
                    _if("3.1", answers=(*N, NI)),
                    # The tool offers no "no information" here.
                    options=("yes", "probably_yes", "probably_no", "no"),
                ),
                _q(
                    "3.3",
                    "Missingness could depend on the true value?",
                    "Could missingness in the outcome depend on its true value?",
                    _MISSING,
                    _if("3.2", answers=N),
                ),
                _q(
                    "3.4",
                    "Missingness likely depended on the true value?",
                    "Is it likely that missingness in the outcome depended on its true value?",
                    _MISSING,
                    _if("3.3", answers=(*Y, NI)),
                ),
            ),
        ),
        Domain(
            id="D4",
            title="Measurement of the outcome",
            questions=(
                _q(
                    "4.1",
                    "Measurement inappropriate?",
                    "Was the method of measuring the outcome inappropriate?",
                    _MEASURE,
                ),
                _q(
                    "4.2",
                    "Measurement differed between groups?",
                    "Could measurement or ascertainment of the outcome have differed between"
                    " intervention groups?",
                    _MEASURE,
                ),
                _q(
                    "4.3",
                    "Assessors aware?",
                    "Were outcome assessors aware of the intervention received by study"
                    " participants?",
                    _ASSESSORS,
                    _if("4.1", "4.2", answers=(*N, NI), mode="all"),
                ),
                _q(
                    "4.4",
                    "Assessment could have been influenced?",
                    "Could assessment of the outcome have been influenced by knowledge of"
                    " intervention received?",
                    _ASSESSORS,
                    _if("4.3", answers=(*Y, NI)),
                ),
                _q(
                    "4.5",
                    "Assessment likely influenced?",
                    "Is it likely that assessment of the outcome was influenced by knowledge of"
                    " intervention received?",
                    _ASSESSORS,
                    _if("4.4", answers=(*Y, NI)),
                ),
            ),
        ),
        Domain(
            id="D5",
            title="Selection of the reported result",
            questions=(
                _q(
                    "5.1",
                    "Analysed as pre-specified?",
                    "Were the data that produced this result analysed in accordance with a"
                    " pre-specified analysis plan that was finalized before unblinded outcome"
                    " data were available for analysis?",
                    _PLAN,
                ),
                _q(
                    "5.2",
                    "Selected from several outcome measurements?",
                    f"{_SELECTED} multiple eligible outcome measurements (e.g. scales,"
                    " definitions, time points) within the outcome domain?",
                    _PLAN,
                ),
                _q(
                    "5.3",
                    "Selected from several analyses?",
                    f"{_SELECTED} multiple eligible analyses of the data?",
                    _PLAN,
                ),
            ),
        ),
    ),
)


# The cribsheet's flow charts. Each reads only questions that apply on its path.


def randomization(a: Mapping[str, Answer]) -> Judgement:
    if a["1.2"] in N:
        return "high"
    if a["1.2"] == NI:
        return "high" if a["1.3"] in Y else "some_concerns"
    if a["1.1"] in N:
        return "some_concerns"
    return "some_concerns" if a["1.3"] in Y else "low"


def deviations(a: Mapping[str, Answer]) -> Judgement:
    """Part 1 (2.1 to 2.5) and part 2 (2.6 and 2.7); the worse of the two."""
    if (a["2.1"] in N and a["2.2"] in N) or a["2.3"] in N:
        first: Judgement = "low"
    elif a["2.3"] == NI or a["2.4"] in N:
        first = "some_concerns"
    else:
        first = "some_concerns" if a["2.5"] in Y else "high"
    if a["2.6"] in Y:
        second: Judgement = "low"
    else:
        second = "some_concerns" if a["2.7"] in N else "high"
    return worst((first, second))


def missing_data(a: Mapping[str, Answer]) -> Judgement:
    if a["3.1"] in Y or a["3.2"] in Y or a["3.3"] in N:
        return "low"
    return "some_concerns" if a["3.4"] in N else "high"


def measurement(a: Mapping[str, Answer]) -> Judgement:
    if a["4.1"] in Y or a["4.2"] in Y:
        return "high"
    # 4.2 is now N/PN or NI; no information on it costs a step on the low paths.
    settled: Judgement = "low" if a["4.2"] in N else "some_concerns"
    if a["4.3"] in N or a["4.4"] in N:
        return settled
    return "some_concerns" if a["4.5"] in N else "high"


def selection(a: Mapping[str, Answer]) -> Judgement:
    if a["5.2"] in Y or a["5.3"] in Y:
        return "high"
    if a["5.2"] in N and a["5.3"] in N:
        return "low" if a["5.1"] in Y else "some_concerns"
    return "some_concerns"


def worst(judgements: tuple[Judgement, ...]) -> Judgement:
    """The guidance's Table 1, without the reviewer's call on several "some concerns"."""
    if "high" in judgements:
        return "high"
    return "some_concerns" if "some_concerns" in judgements else "low"


ALGORITHMS: dict[str, DomainAlgorithm] = {
    "D1": randomization,
    "D2": deviations,
    "D3": missing_data,
    "D4": measurement,
    "D5": selection,
}
