-- migrate:up

-- The reviewer's table: every one of their own assignments the queue holds or held, decided ones
-- included, with their own decision and the AI reading their own provisional decision revealed.
-- Like screening_reviewer_queue it cannot return another reviewer's rows, an AI reading the
-- reviewer was not shown, or sentinel and audit flags; the item reference is left out too,
-- because a full-text sentinel's reference names it as one. `position` is the queue order.
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
    own_reveal jsonb
)
language sql stable as $$
    select a.id, i.title, i.text, i.facts, a.etag, a.state,
        row_number() over (
            order by case when s.mode = 'M3' then r.rank else 0 end, a.sort_key, a.id
        ),
        d.outcome, d.reason_criterion_id, d.comment, d.decided_at,
        -- What the reviewer was shown, kept when they take the decision back and decide again.
        case when a.revealed then (
            select r2.reveal from screening_decision r2
            where r2.assignment_id = a.id and r2.reveal is not null
            order by r2.recorded_at desc, r2.id desc limit 1
        ) end
    from screening_assignment a
    join screening_stage s on s.id = a.stage_id
    join screening_item i on i.stage_id = a.stage_id and i.item_ref = a.item_ref
    join screening_ai_reading r on r.stage_id = a.stage_id and r.item_ref = a.item_ref
    left join screening_decision d on d.id = coalesce(a.final_decision_id, a.provisional_decision_id)
    where a.stage_id = p_stage_id and a.reviewer_id = p_reviewer
        and i.withdrawn_event_id is null
$$;

-- migrate:down

drop function screening_reviewer_table(uuid, uuid);
