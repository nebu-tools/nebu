-- migrate:up

-- Mode S (targeted searches, working documentation): one screener per record from a pool, a
-- second opinion on request, no auditor, and the AI's reading optionally shown before the
-- decision (reveal `before`).
alter table screening_stage
    drop constraint screening_stage_mode_check,
    add constraint screening_stage_mode_check check (mode in ('M1', 'M2', 'M3', 'S')),
    drop constraint screening_stage_reveal_check,
    add constraint screening_stage_reveal_check
        check (reveal in ('never', 'on_disagreement', 'always', 'before')),
    add constraint screening_stage_before_check check (reveal <> 'before' or mode = 'S'),
    alter column auditor_id drop not null,
    add constraint screening_stage_auditor_check check ((auditor_id is null) = (mode = 'S'));

-- A second opinion is an assignment of another screener of the pool on a record whose screener
-- asked for one. It is active while `consults_decision_id` names that decision; an undo of the
-- decision before anyone answered clears it, and asking again sets it.
alter table screening_assignment
    drop constraint screening_assignment_role_check,
    add constraint screening_assignment_role_check
        check (role in ('screener', 'auditor', 'second_opinion')),
    add column consults_decision_id uuid references screening_decision (id);

-- `second_opinion`: the screener asked for one with this decision. `ai_shown_before`: the
-- reviewer had the AI's reading on screen when deciding (reveal `before`).
alter table screening_decision
    add column second_opinion boolean not null default false,
    add column ai_shown_before boolean not null default false;

-- As before, with three changes. An S stage does not wait for the AI judge, so its items enter
-- the queue unread. A stage that reveals `before` returns the AI's reading as `ai_before` once
-- there is one. A second opinion comes first, while it is active, with the decision it is asked
-- on as `consult`.
drop function screening_reviewer_queue;
create function screening_reviewer_queue(p_stage_id uuid, p_reviewer uuid) returns table (
    assignment_id uuid,
    stage text,
    scope_id text,
    title text,
    text text,
    facts jsonb,
    etag text,
    state text,
    own_reveal jsonb,
    ai_before jsonb,
    consult jsonb,
    "position" bigint
)
language sql stable as $$
    select a.id, s.stage, s.scope_id, i.title, i.text, i.facts, a.etag, a.state,
        case when a.state = 'awaiting_final' then d.reveal end,
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
        end,
        row_number() over (
            order by a.role = 'second_opinion' desc,
                case when s.mode = 'M3' then r.rank else 0 end, a.sort_key, a.id
        )
    from screening_assignment a
    join screening_stage s on s.id = a.stage_id
    join screening_item i on i.stage_id = a.stage_id and i.item_ref = a.item_ref
    left join screening_ai_reading r on r.stage_id = a.stage_id and r.item_ref = a.item_ref
    left join screening_decision d on d.id = a.provisional_decision_id
    left join screening_decision c on c.id = a.consults_decision_id
    where a.stage_id = p_stage_id and a.reviewer_id = p_reviewer
        and i.withdrawn_event_id is null
        and (r.item_ref is not null or s.mode = 'S')
        and (a.role <> 'second_opinion' or a.consults_decision_id is not null)
$$;

-- As before, without inactive second opinions.
create or replace function screening_reviewer_progress(p_stage_id uuid, p_reviewer uuid)
returns table (assigned bigint, decided bigint)
language sql stable as $$
    select count(*), count(*) filter (where a.state = 'decided')
    from screening_assignment a
    join screening_item i on i.stage_id = a.stage_id and i.item_ref = a.item_ref
    where a.stage_id = p_stage_id and a.reviewer_id = p_reviewer
        and i.withdrawn_event_id is null
        and (a.role <> 'second_opinion' or a.consults_decision_id is not null)
$$;

-- migrate:down

create or replace function screening_reviewer_progress(p_stage_id uuid, p_reviewer uuid)
returns table (assigned bigint, decided bigint)
language sql stable as $$
    select count(*), count(*) filter (where a.state = 'decided')
    from screening_assignment a
    join screening_item i on i.stage_id = a.stage_id and i.item_ref = a.item_ref
    where a.stage_id = p_stage_id and a.reviewer_id = p_reviewer
        and i.withdrawn_event_id is null
$$;

drop function screening_reviewer_queue;
create function screening_reviewer_queue(p_stage_id uuid, p_reviewer uuid) returns table (
    assignment_id uuid,
    stage text,
    scope_id text,
    title text,
    text text,
    facts jsonb,
    etag text,
    state text,
    own_reveal jsonb,
    "position" bigint
)
language sql stable as $$
    select a.id, s.stage, s.scope_id, i.title, i.text, i.facts, a.etag, a.state,
        case when a.state = 'awaiting_final' then d.reveal end,
        row_number() over (
            order by case when s.mode = 'M3' then r.rank else 0 end, a.sort_key, a.id
        )
    from screening_assignment a
    join screening_stage s on s.id = a.stage_id
    join screening_item i on i.stage_id = a.stage_id and i.item_ref = a.item_ref
    join screening_ai_reading r on r.stage_id = a.stage_id and r.item_ref = a.item_ref
    left join screening_decision d on d.id = a.provisional_decision_id
    where a.stage_id = p_stage_id and a.reviewer_id = p_reviewer
        and i.withdrawn_event_id is null
$$;

alter table screening_decision
    drop column ai_shown_before,
    drop column second_opinion;

alter table screening_assignment
    drop column consults_decision_id,
    drop constraint screening_assignment_role_check,
    add constraint screening_assignment_role_check check (role in ('screener', 'auditor'));

alter table screening_stage
    drop constraint screening_stage_auditor_check,
    drop constraint screening_stage_before_check,
    alter column auditor_id set not null,
    drop constraint screening_stage_reveal_check,
    add constraint screening_stage_reveal_check
        check (reveal in ('never', 'on_disagreement', 'always')),
    drop constraint screening_stage_mode_check,
    add constraint screening_stage_mode_check check (mode in ('M1', 'M2', 'M3'));
