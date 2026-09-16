import { Router } from 'express';
import { decodeJwt } from 'jose';
import { workos, WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD, WORKOS_REDIRECT_URI } from './client.js';
import { upsertAccount, saveDebugClaims } from './db.js';

/**
 * TRACK A routes - hand-coded AuthKit integration, mounted at /login, /callback,
 * /whoami, /switch-org, /logout. Compare against src/diy-auth/routes.ts.
 *
 * What does NOT appear anywhere in this file, because WorkOS owns it:
 *  - password hashing/verification (no password ever touches this server)
 *  - which SSO connection (Okta/Azure AD/Google/etc.) a given email should
 *    hit - AuthKit's hosted UI resolves that from the org/email before the
 *    user ever lands back on /callback
 *  - directory sync keeping org membership current with the customer's IdP
 */
export const workosAuthRouter = Router();

const COOKIE_NAME = 'wos-session';

workosAuthRouter.get('/login', (req, res) => {
  if (!WORKOS_CLIENT_ID || !process.env.WORKOS_API_KEY) {
    return res
      .status(500)
      .send('WORKOS_API_KEY / WORKOS_CLIENT_ID are not set - copy .env.example to .env and fill in your WorkOS dashboard values.');
  }
  try {
    // getAuthorizationUrl() builds the URL to WorkOS-hosted AuthKit - a login
    // page WorkOS designs, hosts, and keeps working (password, Google, SSO,
    // MFA, whatever the org has configured), entirely outside this app.
    // provider: 'authkit' means "let AuthKit's hosted UI figure out how this
    // user should sign in" rather than pinning to one specific SSO connection.
    const authorizationUrl = workos.userManagement.getAuthorizationUrl({
      provider: 'authkit',
      clientId: WORKOS_CLIENT_ID,
      redirectUri: WORKOS_REDIRECT_URI,
      // organizationId here (optional) is how you'd pre-select a customer's
      // org before redirecting, e.g. from a "yourcompany.com/acme/login" path.
    });
    res.redirect(authorizationUrl);
  } catch (err) {
    res.status(500).send(`Could not build AuthKit URL: ${err instanceof Error ? err.message : String(err)}`);
  }
});

workosAuthRouter.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (typeof code !== 'string') return res.status(400).send('Missing ?code from WorkOS redirect');

  try {
    // The one network call that replaces an entire login system: WorkOS
    // verified the user's credentials (or SSO assertion) on its hosted page
    // and hands back a User plus tokens for this authorization code.
    const { user, organizationId, sealedSession } = await workos.userManagement.authenticateWithCode({
      clientId: WORKOS_CLIENT_ID,
      code,
      session: {
        // sealSession encrypts {accessToken, refreshToken, user, ...} with
        // cookiePassword and returns it as one opaque string - this app
        // never sees a raw refresh token or has to store one itself.
        sealSession: true,
        cookiePassword: WORKOS_COOKIE_PASSWORD,
      },
    });

    // The only thing WE persist: a mapping from WorkOS's identity to our own
    // app's account record. No credentials, no session state - see db.ts.
    const account = upsertAccount({
      workosUserId: user.id,
      workosOrganizationId: organizationId ?? null,
      email: user.email,
    });

    // Teaching-only: stash the decoded claims so dump-claims.ts can show you
    // exactly what WorkOS gave us next to the 3 columns we chose to keep.
    const freshSession = workos.userManagement.loadSealedSession({
      sessionData: sealedSession!,
      cookiePassword: WORKOS_COOKIE_PASSWORD,
    });
    const authResult = await freshSession.authenticate();
    if (authResult.authenticated) {
      saveDebugClaims(user.id, decodeJwt(authResult.accessToken));
    }

    res.cookie(COOKIE_NAME, sealedSession, { httpOnly: true, secure: req.protocol === 'https', sameSite: 'lax', path: '/' });
    res.redirect(`/whoami?account=${account.id}`);
  } catch (err) {
    console.error('[workos callback]', err);
    res.status(500).send(`AuthKit callback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

workosAuthRouter.get('/whoami', async (req, res) => {
  const sessionData = req.cookies?.[COOKIE_NAME];
  if (!sessionData) return res.status(401).json({ authenticated: false, reason: 'no_session_cookie' });

  // loadSealedSession decrypts the cookie locally (no network call); the
  // network call happens inside .authenticate(), which verifies the access
  // token's signature against WorkOS's JWKS (cached, refreshed ~every 5 min).
  const session = workos.userManagement.loadSealedSession({ sessionData, cookiePassword: WORKOS_COOKIE_PASSWORD });
  const result = await session.authenticate();

  if (!result.authenticated) {
    return res.status(401).json({ authenticated: false, reason: result.reason });
  }

  const claims = decodeJwt(result.accessToken);

  res.json({
    authenticated: true,
    // What WorkOS's convenience layer already parsed out for you:
    parsed: {
      userId: result.user.id,
      email: result.user.email,
      organizationId: result.organizationId ?? null,
      role: result.role ?? null,
      permissions: result.permissions ?? [],
      sessionId: result.sessionId,
    },
    // The raw JWT payload underneath - sub/sid/org_id/role/permissions/exp,
    // exactly what your notes named, plus roles[]/entitlements/feature_flags
    // that WorkOS also ships but that AuthenticateWithSessionCookieSuccessResponse
    // doesn't surface directly.
    rawJwtClaims: claims,
  });
});

// Org switching demo: re-authenticates the *existing* sealed session against
// a different organization the user belongs to, using their refresh token -
// no redirect to AuthKit, no re-entering credentials. Under the hood this is
// a refresh_token grant with an organization_id parameter; session.refresh()
// is the SDK's ergonomic wrapper around that call.
workosAuthRouter.post('/switch-org', async (req, res) => {
  const sessionData = req.cookies?.[COOKIE_NAME];
  const { organizationId } = req.body ?? {};
  if (!sessionData) return res.status(401).json({ error: 'not authenticated' });
  if (typeof organizationId !== 'string') return res.status(400).json({ error: 'organizationId is required' });

  const session = workos.userManagement.loadSealedSession({ sessionData, cookiePassword: WORKOS_COOKIE_PASSWORD });
  const result = await session.refresh({ organizationId, cookiePassword: WORKOS_COOKIE_PASSWORD });

  if (!result.authenticated) {
    // e.g. the user isn't a member of that org - WorkOS enforces this
    // server-side, this app never has to check membership itself.
    return res.status(403).json({ error: 'refresh failed', reason: result.reason });
  }

  const account = upsertAccount({
    workosUserId: result.user.id,
    workosOrganizationId: result.organizationId ?? null,
    email: result.user.email,
  });
  saveDebugClaims(result.user.id, { newOrganizationId: result.organizationId, role: result.role, permissions: result.permissions });

  res.cookie(COOKIE_NAME, result.sealedSession, { httpOnly: true, secure: req.protocol === 'https', sameSite: 'lax', path: '/' });
  res.json({ switched: true, organizationId: result.organizationId, role: result.role, accountId: account.id });
});

workosAuthRouter.post('/logout', async (req, res) => {
  const sessionData = req.cookies?.[COOKIE_NAME];
  if (!sessionData) return res.status(204).end();

  const session = workos.userManagement.loadSealedSession({ sessionData, cookiePassword: WORKOS_COOKIE_PASSWORD });
  // getLogoutUrl revokes the WorkOS-side session record (so the sealed cookie
  // can't be refreshed even if someone captured it) and returns AuthKit's
  // logout page URL. Compare to Track B, where "logout" is just deleting a
  // row from our own sessions table.
  const logoutUrl = await session.getLogoutUrl();
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ logoutUrl });
});
