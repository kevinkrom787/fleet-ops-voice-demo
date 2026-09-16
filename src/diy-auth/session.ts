import { randomBytes, createHash } from 'node:crypto';
import { diyDb } from './db.js';

/**
 * Session issuance/validation - Track A gets this for free as a signed,
 * self-contained JWT (see src/workos/ - no `sessions` table, no server-side
 * lookup on every request, revocation via workos.userManagement.revokeSession).
 * Here we build it by hand: an opaque random token, hashed before storage,
 * looked up on every single authenticated request.
 */

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface DiySession {
  userId: number;
  organizationId: number | null;
  expiresAt: string;
}

/** Issues a new opaque session token and stores only its hash. */
export function createSession(userId: number, organizationId: number | null): string {
  // 32 random bytes -> 256 bits of entropy, far beyond brute-force range.
  // This is the ENTIRE credential from here on - unlike a JWT, it carries no
  // claims of its own, so every request pays a DB round trip to resolve it.
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  diyDb
    .prepare(`INSERT INTO sessions (token_hash, user_id, organization_id, expires_at) VALUES (?, ?, ?, ?)`)
    .run(hashToken(token), userId, organizationId, expiresAt);

  return token;
}

/** Looks up a session by its raw token, checking expiry. Returns null if invalid/expired. */
export function validateSession(token: string): DiySession | null {
  const row = diyDb
    .prepare(`SELECT user_id, organization_id, expires_at FROM sessions WHERE token_hash = ?`)
    .get(hashToken(token)) as { user_id: number; organization_id: number | null; expires_at: string } | undefined;

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    // Lazy cleanup: delete expired rows as we find them rather than running a
    // cron sweep - fine at demo scale, a real app would still want the sweep
    // so dead rows don't pile up between logins.
    diyDb.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
    return null;
  }

  return { userId: row.user_id, organizationId: row.organization_id, expiresAt: row.expires_at };
}

export function destroySession(token: string): void {
  diyDb.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
}
