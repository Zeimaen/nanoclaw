/**
 * Channel-instance dimension on user_dms.
 *
 * ensureUserDm's cache and cold-DM resolution were channel_type-scoped only,
 * so a channel with multiple adapter instances of the same type (e.g. two
 * Matrix bot accounts, `matrix` + `matrix2`) collapsed a shared human user id
 * onto ONE cached messaging_group — whichever instance resolved first — and
 * every later cold-DM to that user through ANY instance got silently routed
 * to it. Confirmed live: an approval request from Eve's agent (instance
 * matrix2) was delivered into Chef's chat (instance matrix) because both
 * share the human's `matrix:@user:server` user id and user_dms had no
 * instance column to tell them apart.
 *
 * Backfill mirrors migration016's messaging_groups precedent exactly:
 * instance = channel_type for every existing row, since every row predates
 * multi-instance-aware resolution and was in fact resolved against the
 * default instance. Composite key becomes (user_id, channel_type, instance);
 * SQLite can't relax a table-level PK in place, hence the documented
 * recreate (sqlite.org/lang_altertable.html). No child table references
 * user_dms, so this rebuild doesn't strictly need disableForeignKeys, but
 * it's set anyway for the same belt-and-suspenders reason migration016 keeps
 * foreign_keys off during a multi-step recreate: an interrupted transaction
 * should never trip an FK violation on the intermediate state.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration021: Migration = {
  version: 21,
  name: 'user-dms-instance',
  disableForeignKeys: true,
  up: (db: Database.Database) => {
    // Idempotency guard per the 012/016 pattern.
    const cols = db.prepare("PRAGMA table_info('user_dms')").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'instance')) return;

    db.exec(`
      CREATE TABLE user_dms_new (
        user_id            TEXT NOT NULL REFERENCES users(id),
        channel_type       TEXT NOT NULL,
        instance           TEXT NOT NULL,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
        resolved_at        TEXT NOT NULL,
        PRIMARY KEY (user_id, channel_type, instance)
      );
      INSERT INTO user_dms_new (user_id, channel_type, instance, messaging_group_id, resolved_at)
        SELECT user_id, channel_type, channel_type, messaging_group_id, resolved_at
          FROM user_dms;
      DROP TABLE user_dms;
      ALTER TABLE user_dms_new RENAME TO user_dms;
    `);
  },
};
