import { DatabaseSync } from 'node:sqlite';

/**
 * TRACK B — the status quo WorkOS (Track A, see src/workos/) replaces.
 *
 * This is what "just add login" actually means once you include multi-tenancy:
 * four tables, a hashing scheme you now own, and a session mechanism you now own.
 * Track A collapses all of this into ~3 SDK calls plus one mapping table.
 *
 * Uses Node's built-in `node:sqlite` (stable since Node 22.5) - zero extra
 * dependency, synchronous, and lets the whole schema live in one readable file.
 */
export const diyDb = new DatabaseSync('./diy-auth.db');

diyDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS organizations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Many-to-many: a user can belong to more than one org, with a role that's
  -- scoped to that specific membership (the same person can be 'admin' in one
  -- org and 'member' in another). This table is the whole reason multi-tenant
  -- auth is harder than single-tenant auth - Track A gets it via org_id + role
  -- already sitting in the JWT, no schema of your own required.
  CREATE TABLE IF NOT EXISTS memberships (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'member',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, organization_id)
  );

  -- Opaque bearer sessions. We store SHA-256(token), never the raw token -
  -- identical to why you store a password hash, not the password: a DB read
  -- (backup leak, SQLI, careless log line) shouldn't be enough to log in as
  -- someone. The raw token only ever exists in the httpOnly cookie + this one
  -- request's memory.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash      TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id INTEGER REFERENCES organizations(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at      TEXT NOT NULL
  );
`);

// TODO(SSO gap): a real B2B customer will eventually ask "can we log in with
// Okta / Azure AD / Google Workspace SSO instead of a password?" Doing that
// yourself means, per customer:
//   1. A SAML Service Provider (metadata XML, ACS endpoint, signed
//      AuthnRequest/Response parsing, X.509 cert rotation) OR an OIDC client
//      registration per IdP - and customers don't agree on which one they use.
//   2. A per-customer "connection" record (their IdP's metadata URL or issuer/
//      client_id/secret) that routes /login to the right IdP before you even
//      know who the user is.
//   3. Just-in-time provisioning: creating the users/memberships rows above
//      automatically from IdP assertions, plus deprovisioning on offboarding.
//   4. Directory sync (SCIM) if they want group/role changes in their IdP to
//      propagate here automatically instead of drifting.
//   5. Ongoing maintenance as each customer's IdP quirks change - ADFS, Okta,
//      Entra ID, Google Workspace, JumpCloud, OneLogin, Ping all diverge in
//      real-world behavior despite "supporting the standard."
// This is the exact gap Track A (src/workos/) closes: WorkOS operates the SSO
// connection routing and directory sync, so none of the above exists in this
// repo's WorkOS code at all - see the comment in src/workos/routes.ts.
