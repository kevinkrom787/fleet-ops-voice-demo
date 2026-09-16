import 'dotenv/config';
import { workosDb } from './db.js';

/**
 * Run with `npm run dump:workos`. Standalone script (not an HTTP route) that
 * prints, side by side:
 *   1. the `accounts` rows - the ONLY thing this app actually persists
 *   2. the raw decoded JWT claims WorkOS handed back at last login/refresh
 * The gap between those two is the point: WorkOS gives you a lot (roles,
 * permissions, entitlements, feature flags, session id...) and a well-built
 * app persists only the sliver it needs for its own foreign keys.
 */

interface AccountRow {
  id: number;
  workos_user_id: string;
  workos_organization_id: string | null;
  email: string;
  created_at: string;
  updated_at: string;
}

interface DebugClaimsRow {
  workos_user_id: string;
  claims_json: string;
  decoded_at: string;
}

const accounts = workosDb.prepare('SELECT * FROM accounts ORDER BY id').all() as unknown as AccountRow[];
const claimsRows = workosDb.prepare('SELECT * FROM _debug_last_claims').all() as unknown as DebugClaimsRow[];
const claimsByUserId = new Map(claimsRows.map((r) => [r.workos_user_id, r]));

if (accounts.length === 0) {
  console.log('No accounts yet - visit http://localhost:3000/login and sign in once first.');
  process.exit(0);
}

for (const account of accounts) {
  console.log('\n============================================================');
  console.log('accounts row (what THIS APP persists):');
  console.table([account]);

  const claimsRow = claimsByUserId.get(account.workos_user_id);
  if (!claimsRow) {
    console.log('(no captured JWT claims for this user - log in again to capture one)');
    continue;
  }

  const claims = JSON.parse(claimsRow.claims_json) as Record<string, unknown>;
  console.log(`decoded JWT claims WorkOS issued (captured ${claimsRow.decoded_at}):`);
  console.log({
    sub: claims.sub, // the WorkOS user id - matches accounts.workos_user_id
    sid: claims.sid, // session id - what workos.userManagement.revokeSession() takes
    org_id: claims.org_id, // matches accounts.workos_organization_id
    role: claims.role, // this user's role in THAT org - not stored in our table at all
    permissions: claims.permissions, // fine-grained perms for that role - also not stored
    roles: claims.roles, // every role across all the user's orgs (plural - easy to miss)
    entitlements: claims.entitlements,
    feature_flags: claims.feature_flags,
    exp: claims.exp, // unix seconds - token expiry, enforced by session.authenticate()
    iat: claims.iat,
  });
  console.log('-> everything above except sub/org_id came from WorkOS and lives ONLY in the');
  console.log('   token on every request. We never wrote role/permissions/roles/etc. to disk.');
}
console.log('\n============================================================\n');

process.exit(0);
