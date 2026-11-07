-- migrate:up

-- Risk-of-bias appraisals (DESIGN.md, "Appraisal"). One appraisal per report, instrument, and
-- result. Answers and overrides are appended, never edited: the newest row per question, or per
-- domain or the overall judgement, is the current one. Each row keeps the ledger sequence number
-- of the event that wrote it, so a report can show the appraisals as of a cutoff. `command_id`
-- makes a retried request return the first result.

create table appraisal (
    id uuid primary key,
    project_id uuid not null references project (id),
    report_id uuid not null,
    study_id uuid not null,
    document_id uuid not null references document (id),
    study_label text not null,
    report_title text not null,
    instrument text not null,
    result text not null check (length(btrim(result)) > 0),
    created_by uuid not null references actor (id),
    command_id uuid not null unique,
    event_id uuid not null,
    event_seq bigint not null,
    created_at timestamptz not null,
    unique (project_id, report_id, instrument, result)
);

create index appraisal_by_report on appraisal (project_id, report_id);

create table appraisal_answer (
    id uuid primary key,
    appraisal_id uuid not null references appraisal (id),
    project_id uuid not null references project (id),
    question_id text not null,
    answer text not null
        check (answer in ('yes', 'probably_yes', 'probably_no', 'no', 'no_information')),
    anchor_ids uuid[] not null,
    actor_id uuid not null references actor (id),
    command_id uuid not null unique,
    event_id uuid not null,
    event_seq bigint not null,
    recorded_at timestamptz not null
);

create index appraisal_answer_by_appraisal on appraisal_answer (appraisal_id, question_id, event_seq);

-- `target` is a domain ID or 'overall'. An override needs a reason; a null judgement takes the
-- override back.
create table appraisal_override (
    id uuid primary key,
    appraisal_id uuid not null references appraisal (id),
    project_id uuid not null references project (id),
    target text not null,
    judgement text check (judgement in ('low', 'some_concerns', 'high')),
    reason text,
    actor_id uuid not null references actor (id),
    command_id uuid not null unique,
    event_id uuid not null,
    event_seq bigint not null,
    recorded_at timestamptz not null,
    check (judgement is null or length(btrim(coalesce(reason, ''))) > 0)
);

create index appraisal_override_by_appraisal on appraisal_override (appraisal_id, target, event_seq);

-- migrate:down

drop table appraisal_override;
drop table appraisal_answer;
drop table appraisal;
