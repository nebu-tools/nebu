-- migrate:up

-- The reviewer's table: every one of their own assignments the queue holds or held, decided ones
-- included, with their own decision and the AI reading their own provisional decision revealed.
-- It lists what screening_reviewer_queue lists, in the same order (`position`): in S the records
-- the judge has not read yet, and a second opinion while it is active, with the decision it is
-- asked on (`consult`); a stage that reveals `before` returns the AI's reading as `ai_before`.
-- Like the queue it cannot return another reviewer's rows (but a consult's decision), an AI
-- reading the reviewer may not see yet, or sentinel and audit flags. The item reference is left
-- out too, because a full-text sentinel's reference names it as one.
create function screening_reviewer_table(p_stage_id uuid, p_reviewer uuid) returns table (
    assignment_id uuid,
    title text,
    text text,
    facts jsonb,
    etag text,
    state text,
    "position" bigint,
    outcome text,
    reason_criterion_id text,
    comment text,
    decided_at timestamptz,
    asked_second_opinion boolean,
    own_reveal jsonb,
    ai_before jsonb,
    consult jsonb
)
language sql stable as $$
    select a.id, i.title, i.text, i.facts, a.etag, a.state,
        row_number() over (
            order by a.role = 'second_opinion' desc,
                case when s.mode = 'M3' then r.rank else 0 end, a.sort_key, a.id
        ),
        d.outcome, d.reason_criterion_id, d.comment, d.decided_at,
        coalesce(d.second_opinion, false),
        -- What the reviewer was shown, kept when they take the decision back and decide again.
        case when a.revealed then (
            select r2.reveal from screening_decision r2
            where r2.assignment_id = a.id and r2.reveal is not null
            order by r2.recorded_at desc, r2.id desc limit 1
        ) end,
        case when s.reveal = 'before' and r.item_ref is not null then
            jsonb_build_object('excludes', r.excludes, 'criteria', r.criteria)
        end,
        case when c.id is not null then
            jsonb_build_object(
                'outcome', c.outcome,
                'reason_criterion_id', c.reason_criterion_id,
                'comment', c.comment,
                'criteria', c.criteria
            )
        end
    from screening_assignment a
    join screening_stage s on s.id = a.stage_id
    join screening_item i on i.stage_id = a.stage_id and i.item_ref = a.item_ref
    left join screening_ai_reading r on r.stage_id = a.stage_id and r.item_ref = a.item_ref
    left join screening_decision d on d.id = coalesce(a.final_decision_id, a.provisional_decision_id)
    left join screening_decision c on c.id = a.consults_decision_id
    where a.stage_id = p_stage_id and a.reviewer_id = p_reviewer
        and i.withdrawn_event_id is null
        and (r.item_ref is not null or s.mode = 'S')
        and (a.role <> 'second_opinion' or a.consults_decision_id is not null)
$$;

-- migrate:down

drop function screening_reviewer_table(uuid, uuid);
