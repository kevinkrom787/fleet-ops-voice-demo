import { DatabaseSync } from 'node:sqlite';

/**
 * TRACK A's local DB - deliberately tiny. Compare this against src/diy-auth/db.ts:
 * no password_hash column, no sessions table, no memberships join table.
 * WorkOS *is* the identity + session system; this table exists only to map
 * a WorkOS identity onto whatever "account" concept your own app has (e.g.
 * billing records, app-specific settings, feature entitlements you track
 * yourself). That's the entire footprint auth has on your schema.
 *
 * What WorkOS handles that therefore never appears here:
 *  - password hashes / credential storage (no password ever reaches your server)
 *  - SSO connection routing (which IdP a given email/domain should hit)
 *  - directory sync (SCIM) keeping org membership in sync with the customer's IdP
 *  - session storage & revocation (the sealed session + WorkOS-side session record)
 */
export const workosDb = new DatabaseSync('./workos.db');

workosDb.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    workos_user_id           TEXT NOT NULL UNIQUE,
    workos_organization_id   TEXT,
    email                    TEXT NOT NULL,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- NOT part of a real app's schema - exists purely so dump-claims.ts can show
  -- you, side by side, "here's the full JWT WorkOS handed me" vs. "here's the
  -- three columns above I actually chose to persist." Delete this table and
  -- the app still works; you'd just lose the teaching view.
  CREATE TABLE IF NOT EXISTS _debug_last_claims (
    workos_user_id TEXT PRIMARY KEY,
    claims_json    TEXT NOT NULL,
    decoded_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export interface AccountRow {
  id: number;
  workos_user_id: string;
  workos_organization_id: string | null;
  email: string;
  created_at: string;
  updated_at: string;
}

/** Upserts the account row keyed by WorkOS user id - called once per callback/refresh. */
export function upsertAccount(params: { workosUserId: string; workosOrganizationId: string | null; email: string }): AccountRow {
  workosDb
    .prepare(
      `INSERT INTO accounts (workos_user_id, workos_organization_id, email)
       VALUES (?, ?, ?)
       ON CONFLICT(workos_user_id) DO UPDATE SET
         workos_organization_id = excluded.workos_organization_id,
         email = excluded.email,
         updated_at = datetime('now')`,
    )
    .run(params.workosUserId, params.workosOrganizationId, params.email);

  return workosDb.prepare(`SELECT * FROM accounts WHERE workos_user_id = ?`).get(params.workosUserId) as unknown as AccountRow;
}

export function getAccountByWorkosUserId(workosUserId: string): AccountRow | undefined {
  return workosDb.prepare(`SELECT * FROM accounts WHERE workos_user_id = ?`).get(workosUserId) as unknown as AccountRow | undefined;
}

/** Most recently touched account - used by the Track C demo tool that has no real caller auth. */
export function getMostRecentAccount(): AccountRow | undefined {
  return workosDb.prepare(`SELECT * FROM accounts ORDER BY updated_at DESC LIMIT 1`).get() as unknown as AccountRow | undefined;
}

export function saveDebugClaims(workosUserId: string, claims: unknown): void {
  workosDb
    .prepare(
      `INSERT INTO _debug_last_claims (workos_user_id, claims_json, decoded_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(workos_user_id) DO UPDATE SET claims_json = excluded.claims_json, decoded_at = datetime('now')`,
    )
    .run(workosUserId, JSON.stringify(claims));
}
