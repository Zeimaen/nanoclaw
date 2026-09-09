import type { Migration } from './index.js';

/**
 * Drop the fork-local `instance` column from `user_dms`, restoring the
 * canonical `PRIMARY KEY (user_id, channel_type)`.
 *
 * This install carried a local `user-dms-instance` migration that keyed the
 * cold-DM cache on the adapter instance. Upstream solved the same
 * multi-instance problem differently: the cache stays un-keyed and holds only
 * the DEFAULT instance, while named instances (`matrix2`, a second bot
 * account) bypass the cache and resolve through `openDM` on every call — see
 * the `cacheable` guard in `src/modules/permissions/user-dm.ts`. Upstream's
 * `upsertUserDm` inserts without `instance` and does
 * `ON CONFLICT(user_id, channel_type)`, which cannot work against the
 * three-column primary key: the column is NOT NULL with no default, and there
 * is no unique index matching that conflict target.
 *
 * Collapse rule: keep the row whose `instance` IS the default (instance =
 * channel_type), because that is the only row upstream's cache would ever
 * write. Named-instance rows are dropped, not merged — they become
 * cache-bypass lookups, which is correct rather than lossy. Where a channel
 * somehow has no default row, fall back to the most recently resolved one so
 * the cache keeps a usable entry instead of losing the channel entirely.
 *
 * Recreate rather than `DROP COLUMN`: the column is part of the primary key,
 * so the key itself has to be rebuilt. `disableForeignKeys` covers the
 * DROP+RENAME window (user_dms references users and messaging_groups); the
 * runner's `foreign_key_check` still runs inside the transaction, so a
 * recreate that introduces a violation rolls back atomically.
 *
 * No-op on any DB that never had the column (a fresh install, or one seeded
 * from upstream's canonical schema) — probed through `columnOwners` rather
 * than PRAGMA to stay inside the portable-migration policy.
 */
export const migration026: Migration = {
  version: 26,
  name: 'user-dms-drop-instance',
  disableForeignKeys: true,
  async up(db) {
    const owners = (await db.columnOwners?.('instance')) ?? [];
    if (!owners.includes('user_dms')) return;

    await db.exec(`
      CREATE TABLE user_dms_new (
        user_id            TEXT NOT NULL REFERENCES users(id),
        channel_type       TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
        resolved_at        TEXT NOT NULL,
        PRIMARY KEY (user_id, channel_type)
      );

      -- One row per (user_id, channel_type): the default-instance row when it
      -- exists, else the most recently resolved one.
      INSERT INTO user_dms_new (user_id, channel_type, messaging_group_id, resolved_at)
      SELECT user_id, channel_type, messaging_group_id, resolved_at
      FROM (
        SELECT user_id, channel_type, messaging_group_id, resolved_at,
               ROW_NUMBER() OVER (
                 PARTITION BY user_id, channel_type
                 ORDER BY CASE WHEN instance = channel_type THEN 0 ELSE 1 END, resolved_at DESC
               ) AS pick
        FROM user_dms
      ) ranked
      WHERE pick = 1;

      DROP TABLE user_dms;
      ALTER TABLE user_dms_new RENAME TO user_dms;
    `);
  },
};
