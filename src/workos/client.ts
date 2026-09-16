import { WorkOS } from '@workos-inc/node';

/**
 * TRACK A — WorkOS AuthKit, hand-coded against @workos-inc/node directly
 * (no Next.js/Express boilerplate wrapper) so every step is visible.
 *
 * One SDK instance, constructed once. The API key authenticates *your
 * server* to WorkOS; clientId identifies *which app* in your WorkOS
 * dashboard this is for - a WorkOS account can hold multiple apps/
 * environments under one API key.
 *
 * clientId is passed to the CONSTRUCTOR (not just per-call, e.g. on
 * getAuthorizationUrl below) because some methods need it and have no
 * per-call option to accept it - notably `session.authenticate()` on the
 * object `loadSealedSession()` returns, which needs a clientId to resolve
 * the JWKS URL it verifies the access token's signature against.
 * `CookieSession`'s constructor only takes (userManagement, sessionData,
 * cookiePassword) - no clientId - so without one on this WorkOS instance,
 * authenticate() throws "Missing client ID."
 */
export const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? '';

// The SDK's constructor throws immediately if given neither an API key nor a
// clientId - which would crash the whole app (Tracks B and C included) just
// because Track A isn't configured yet. Falling back to a placeholder lets
// everything else boot; Track A's routes will simply fail with a real WorkOS
// auth error (not a local crash) the first time they're hit unconfigured.
export const workos = new WorkOS(process.env.WORKOS_API_KEY || 'sk_test_placeholder_not_configured', {
  clientId: WORKOS_CLIENT_ID || undefined,
});
export const WORKOS_COOKIE_PASSWORD = process.env.WORKOS_COOKIE_PASSWORD ?? '';
export const WORKOS_REDIRECT_URI = process.env.WORKOS_REDIRECT_URI ?? 'http://localhost:3000/callback';
