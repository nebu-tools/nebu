import pytest

from kittum.protocol import (
    Profile,
    compile,
    render_prompt,
    render_prompt_criterion,
    render_prompt_rules,
    render_question,
)
from tests.protocol.support import example_text

PROTOCOL = compile(example_text(), profiles={}).protocol
BY_ID = {c.id: c for c in PROTOCOL.criteria}


def test_reviewer_question_in_each_language_the_criterion_has() -> None:
    en = render_question(BY_ID["POP"], "en", "title_abstract")
    de = render_question(BY_ID["POP"], "de", "title_abstract")
    assert en.question == (
        "Does the record meet this inclusion criterion? Adults (18 years or older) who smoke "
        "tobacco."
    )
    assert de.question == (
        "Erfüllt die Publikation dieses Einschlusskriterium? Erwachsene (ab 18 Jahren), die "
        "Tabak rauchen."
    )
    assert en.heading == "POP · Population · inclusion · title and abstract"
    assert [(k.key, k.answer) for k in en.keys] == [
        ("y", "met"),
        ("n", "not_met"),
        ("u", "unclear"),
    ]
    assert [(k.key, k.answer) for k in de.keys] == [
        ("j", "met"),
        ("n", "not_met"),
        ("u", "unclear"),
    ]
    assert "certainly irrelevant" in en.hint
    with pytest.raises(ValueError, match="DESIGN has no text in 'de'"):
        render_question(BY_ID["DESIGN"], "de", "title_abstract")


def test_a_profile_renames_slots_in_headings() -> None:
    profile = Profile(id="p", label={"en": "P"}, labels={"slot.comparator": {"en": "Control"}})
    q = render_question(BY_ID["COMP-CONTROL"], "en", "full_text", profile=profile)
    assert q.heading == "COMP-CONTROL · Control · inclusion · full text"
    assert q.hint == "To exclude, mark the passage that shows it."


def test_judge_v2_prompt_asks_for_a_verbatim_quote() -> None:
    prompt = render_prompt(BY_ID["DESIGN"], "title_abstract")
    assert prompt.startswith("### Criterion DESIGN (study type)")
    assert "  EN: Randomized or quasi-randomized controlled trial." in prompt
    assert "copy a verbatim quote from the title and abstract" in prompt
    assert "If you cannot quote such words, answer `unclear`." in prompt
    assert "absence of information is never `not_met`" in prompt
    assert 'A `not_met` quote must contain one of: "cohort", "cross-sectional"' in prompt


def test_prompt_lists_languages_in_a_stable_order() -> None:
    criterion = BY_ID["POP"]
    reordered = criterion.model_copy(update={"text": dict(reversed(criterion.text.items()))})
    prompt = render_prompt(criterion, "full_text")
    assert prompt == render_prompt(reordered, "full_text")
    assert prompt.index("  DE: Erwachsene") < prompt.index("  EN: Adults")
    assert "Records that do not pass:\n- Adolescent smokers aged 12 to 17 years." in prompt
    assert "absence of information" not in prompt


def test_exclusion_criterion_inverts_the_answer() -> None:
    criterion = BY_ID["DESIGN"].model_copy(
        update={"polarity": "exclude", "text": {"en": "Conference abstract only."}}
    )
    q = render_question(criterion, "en", "full_text")
    assert q.question == "Is the record free of this exclusion reason? Conference abstract only."
    assert next(k for k in q.keys if k.answer == "not_met").label == "no, applies: exclude"
    prompt = render_prompt(criterion, "full_text")
    assert "The record passes unless it shows this:" in prompt
    assert "`not_met` if the record shows it" in prompt


def test_full_text_criteria_are_not_asked_at_title_and_abstract() -> None:
    with pytest.raises(ValueError, match="COMP-CONTROL is not decidable at title_abstract"):
        render_prompt(BY_ID["COMP-CONTROL"], "title_abstract")


def test_judge_v3_names_criteria_as_reviewers_do_and_states_the_rules_once() -> None:
    """The heading carries the permanent number and short label (the slot without one), the ID
    is the answer key, one language needs no label, and the rules live above the criteria."""
    adults = BY_ID["POP"].model_copy(update={"short_label": "Adult smokers"})
    assert render_prompt_criterion(adults, "title_abstract", number=1) == (
        "### Criterion 1: Adult smokers (population)\n"
        "Answer key: `POP`\n"
        "Inclusion criterion. The record passes if it meets this condition:\n"
        "DE: Erwachsene (ab 18 Jahren), die Tabak rauchen.\n"
        "EN: Adults (18 years or older) who smoke tobacco.\n"
        "Records that do not pass:\n"
        "- Adolescent smokers aged 12 to 17 years.\n"
        "- Smokeless tobacco users."
    )
    design = render_prompt_criterion(BY_ID["DESIGN"], "full_text", number=5)
    assert design.splitlines()[:4] == [
        "### Criterion 5: Study type",
        "Answer key: `DESIGN`",
        "Inclusion criterion. The record passes if it meets this condition:",
        "Randomized or quasi-randomized controlled trial.",
    ]
    assert 'A `not_met` quote must contain one of: "cohort", "cross-sectional"' in design
    assert "verbatim" not in design and "absence of information" not in design
    # A caller that does not know the topic gets no number rather than a wrong one.
    assert render_prompt_criterion(adults, "full_text", number=None).startswith(
        "### Criterion: Adult smokers (population)\n"
    )
    excluded = BY_ID["DESIGN"].model_copy(
        update={"polarity": "exclude", "text": {"en": "Conference abstract only."}}
    )
    assert (
        "Exclusion criterion. The record passes unless it shows this:\nConference abstract only."
        in (render_prompt_criterion(excluded, "full_text", number=2))
    )

    rules = render_prompt_rules("title_abstract")
    assert "An inclusion criterion is a condition the record must meet." in rules
    assert "`not_met` if the record shows it" in rules
    assert "copy a verbatim quote from the title and abstract" in rules
    assert "absence of information is never `not_met`" in rules
    full_text = render_prompt_rules("full_text")
    assert "copy a verbatim quote from the full text" in full_text
    assert "absence of information" not in full_text
