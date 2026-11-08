-- migrate:up

-- Decisions brought back from a working export a reviewer edited in a spreadsheet (working
-- topics only). One batch per import, with the file's hash and the export it came from, then one
-- decision per changed row with `origin = 'spreadsheet'`.
alter table screening_batch
    drop constraint screening_batch_action_check,
    add constraint screening_batch_action_check
        check (action in ('include', 'exclude', 'accept_ai', 'spreadsheet')),
    add column file_sha256 char(64),
    add column file_name text,
    add column export_id uuid,
    add column unchanged integer,
    add column refused integer,
    -- `not valid`: batch rows are append-only, and an import from before a rollback has lost
    -- its file columns; every new batch is checked.
    add constraint screening_batch_spreadsheet_check check (
        (action = 'spreadsheet') = (file_sha256 is not null and export_id is not null
            and unchanged is not null and refused is not null)
    ) not valid;

-- Kittum cannot know when a row of a spreadsheet was decided, or how long it was looked at: a
-- spreadsheet decision has no timing.
alter table screening_decision
    drop constraint if exists screening_decision_timed, -- left by a rollback of this migration
    drop constraint screening_decision_origin_check,
    add constraint screening_decision_origin_check
        check (origin in ('keyboard', 'bulk', 'spreadsheet')),
    alter column shown_at drop not null,
    alter column decided_at drop not null,
    add constraint screening_decision_timing_check
        check (origin = 'spreadsheet' or (shown_at is not null and decided_at is not null));

-- migrate:down

-- Decisions are append-only, so imported ones stay as they are: the earlier rules hold for new
-- rows only (`not valid`), and the timing columns stay nullable under a check.
alter table screening_decision
    drop constraint screening_decision_timing_check,
    add constraint screening_decision_timed
        check (shown_at is not null and decided_at is not null) not valid,
    drop constraint screening_decision_origin_check,
    add constraint screening_decision_origin_check
        check (origin in ('keyboard', 'bulk')) not valid;
alter table screening_batch
    drop constraint screening_batch_spreadsheet_check,
    drop column refused,
    drop column unchanged,
    drop column export_id,
    drop column file_name,
    drop column file_sha256,
    drop constraint screening_batch_action_check,
    add constraint screening_batch_action_check
        check (action in ('include', 'exclude', 'accept_ai')) not valid;
