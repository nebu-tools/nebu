"""Which user message template the AI disclosure names for a group of verdicts."""

from kittum.judge import USER_TEMPLATES
from kittum.report.model_calls import _template

V3 = {"prompt_version": "judge.v3"}
OWN = "Judge these:\n{criteria}\n\nRecord: {text}"


def test_the_disclosure_names_the_template_the_verdicts_were_sent_with() -> None:
    own = {"p1": {"smoking": OWN, "vaping": None, "patches": OWN}}
    # A topic's own template, and Kittum's for a topic without one.
    assert _template(own, "p1", {"smoking"}, V3, USER_TEMPLATES) == OWN
    assert _template(own, "p1", {"vaping"}, V3, USER_TEMPLATES) == USER_TEMPLATES["judge.v3"]
    # Two topics screen one scope: the same template either way, or none rather than a guess.
    assert _template(own, "p1", {"smoking", "patches"}, V3, USER_TEMPLATES) == OWN
    assert _template(own, "p1", {"smoking", "vaping"}, V3, USER_TEMPLATES) is None
    # A protocol version or topic Kittum has no document of names no template.
    assert _template(own, "p2", {"smoking"}, V3, USER_TEMPLATES) is None
    assert _template(own, "p1", {"other"}, V3, USER_TEMPLATES) is None
