"""Judge routes: the judge's prompt template, for the protocol editor."""

from fastapi import APIRouter

from kittum.judge import PromptTemplate, prompt_template

router = APIRouter(prefix="/api/judge", tags=["judge"])


@router.get("/prompt-template", operation_id="getJudgePromptTemplate")
def template() -> PromptTemplate:
    """The fixed parts of the judge's prompt around the parts a topic's instructions fill in:
    the stage rule each strictness selects, and the frame of the team's guidance."""
    return prompt_template()
