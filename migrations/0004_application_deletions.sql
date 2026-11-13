-- Keep a minimal receipt independent of the removed application to block /apply replays.
CREATE TABLE application_deletions (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    owner_discord_id TEXT NOT NULL,
    forum_channel_id TEXT NOT NULL,
    discord_thread_id TEXT NOT NULL,
    details_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    application_updated_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_at INTEGER,
    state TEXT NOT NULL DEFAULT 'open'
        CHECK (state IN ('open','cancelled','pending','complete','failed','needs_check')),
    failure_stage TEXT
);

CREATE INDEX application_deletions_completed_idx
    ON application_deletions(application_id) WHERE state = 'complete';
