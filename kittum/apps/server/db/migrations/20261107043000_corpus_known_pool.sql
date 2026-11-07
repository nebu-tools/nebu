-- migrate:up

-- A known pool: the papers a search topic is expected to find, such as the ones a customer
-- already has, imported from their files. It is compared with the topic's searches and never
-- counts as a search result. Each file is one import; a withdrawn file stops counting but stays.
create table known_pool_file (
    id uuid primary key,
    project_id uuid not null references project (id),
    topic_id text not null,
    format text not null,
    file_name text,
    file_hash char(64) not null,
    entries integer not null check (entries > 0),
    imported_by uuid not null references actor (id),
    imported_event_id uuid not null,
    imported_at timestamptz not null,
    withdrawn_by uuid references actor (id),
    withdrawn_event_id uuid,
    withdrawn_at timestamptz,
    check ((withdrawn_event_id is null) = (withdrawn_at is null))
);

create index known_pool_file_topic on known_pool_file (project_id, topic_id);

-- One paper of a pool file as the file gives it (a search module `SourceRecord`).
create table known_pool_entry (
    id uuid primary key,
    file_id uuid not null references known_pool_file (id),
    ordinal integer not null,
    record jsonb not null,
    unique (file_id, ordinal)
);

-- migrate:down

drop table known_pool_entry;
drop table known_pool_file;
