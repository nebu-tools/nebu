-- migrate:up

-- Editable screening instructions (a topic's judge strictness and guidance), re-judging an open
-- stage in place, the protocol editor's test bench, and bulk decisions in working topics.

-- The protocol version an AI reading was made under. `screening_ai_reading` holds the reading a
-- stage shows now; a re-judge replaces it. `screening_ai_reading_log` keeps every reading, the
-- replaced ones included, for reports as of any event and the AI disclosure.
alter table screening_ai_reading add column protocol_hash char(64);
update screening_ai_reading r set protocol_hash = s.protocol_hash
    from screening_stage s where s.id = r.stage_id;
alter table screening_ai_reading alter column protocol_hash set not null;

create table screening_ai_reading_log (
    stage_id uuid not null,
    item_ref text not null,
    judge_config_id text not null,
    protocol_hash char(64) not null,
    excludes boolean not null,
    rank integer not null,
    criteria jsonb not null,
    flags text[] not null,
    raw_output_hash char(64) not null,
    event_id uuid not null,
    recorded_at timestamptz not null,
    primary key (stage_id, item_ref, event_id),
    foreign key (stage_id, item_ref) references screening_item (stage_id, item_ref)
);

insert into screening_ai_reading_log
    select stage_id, item_ref, judge_config_id, protocol_hash, excludes, rank, criteria, flags,
        raw_output_hash, event_id, recorded_at
    from screening_ai_reading;

-- A stage re-judged under another published protocol version: the stage reads with it from then
-- on. Only the AI's instructions may differ (the screening service checks), so human decisions
-- keep their meaning.
create table screening_rejudge (
    id uuid primary key,
    stage_id uuid not null references screening_stage (id),
    from_protocol_version_id uuid not null references protocol_version (id),
    to_protocol_version_id uuid not null references protocol_version (id),
    from_protocol_hash char(64) not null,
    to_protocol_hash char(64) not null,
    actor_id uuid not null references actor (id),
    event_id uuid not null,
    recorded_at timestamptz not null
);

-- A bulk decision in a working topic: one batch, one decision per record.
create table screening_batch (
    id uuid primary key,
    stage_id uuid not null references screening_stage (id),
    reviewer_id uuid not null references actor (id),
    command_id uuid not null unique,
    event_id uuid not null,
    action text not null check (action in ('include', 'exclude', 'accept_ai')),
    reason_criterion_id text,
    filter text,
    decisions integer not null,
    recorded_at timestamptz not null,
    check ((action = 'exclude') = (reason_criterion_id is not null))
);

-- Where a decision came from: a key on one record (`keyboard`) or a bulk decision from the
-- table (`bulk`, with its batch). A later origin (a spreadsheet import) extends the check.
-- `ai_proposal` is the AI's proposal a bulk "accept the AI's proposals" took over.
alter table screening_decision
    add column origin text not null default 'keyboard'
        constraint screening_decision_origin_check check (origin in ('keyboard', 'bulk')),
    add column batch_id uuid references screening_batch (id),
    add column ai_proposal jsonb,
    add constraint screening_decision_batch_check check ((origin = 'keyboard') = (batch_id is null));

-- A test bench run: the judge on a stage's records with a draft protocol's instructions. Its
-- verdicts are the judge's own rows; they never become the stage's readings.
create table screening_bench (
    id uuid primary key,
    project_id uuid not null references project (id),
    stage_id uuid not null references screening_stage (id),
    topic_id text not null,
    protocol jsonb not null,
    protocol_hash char(64) not null,
    item_refs text[] not null,
    known_refs text[] not null,
    requested_by uuid not null references actor (id),
    requested_event_id uuid not null,
    recorded_at timestamptz not null,
    verdicts jsonb,
    finished_event_id uuid,
    finished_at timestamptz
);

create index screening_bench_stage on screening_bench (stage_id, recorded_at);

-- migrate:down

drop table screening_bench;
alter table screening_decision
    drop constraint screening_decision_batch_check,
    drop column ai_proposal,
    drop column batch_id,
    drop column origin;
drop table screening_batch;
drop table screening_rejudge;
drop table screening_ai_reading_log;
alter table screening_ai_reading drop column protocol_hash;
