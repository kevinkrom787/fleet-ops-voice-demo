import { Router } from 'express';
import { diyDb } from './db.js';
import { hashPassword, verifyPassword } from './password.js';
import { createSession, validateSession, destroySession } from './session.js';

/**
 * TRACK B routes - hand-rolled email+password auth, mounted at /diy/*.
 * Compare this file line-for-line against src/workos/routes.ts: this is
 * everything an app owns when it builds auth itself instead of buying it.
 */
export const diyAuthRouter = Router();

const COOKIE_NAME = 'diy-session';

interface UserRow {
  id: number;
  email: string;
  password_hash: string;
}

diyAuthRouter.post('/diy/signup', async (req, res) => {
  const { email, password, organizationName } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }

  const existing = diyDb.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (existing) return res.status(409).json({ error: 'an account with that email already exists' });

  // This is the step that does not exist anywhere in Track A: we are now the
  // ones turning a plaintext password into something safe to store.
  const passwordHash = await hashPassword(password);

  const insertUser = diyDb.prepare(`INSERT INTO users (email, password_hash) VALUES (?, ?)`);
  const userId = Number(insertUser.run(email, passwordHash).lastInsertRowid);

  // Signup also creates (or joins) an organization - the multi-tenant shape
  // WorkOS gives you via org_id in the token, built here as two more tables
  // and an explicit membership row.
  let organizationId: number;
  const orgName = typeof organizationName === 'string' && organizationName.trim() ? organizationName.trim() : `${email}'s org`;
  const insertOrg = diyDb.prepare(`INSERT INTO organizations (name) VALUES (?)`);
  organizationId = Number(insertOrg.run(orgName).lastInsertRowid);
  diyDb.prepare(`INSERT INTO memberships (user_id, organization_id, role) VALUES (?, ?, 'admin')`).run(userId, organizationId);

  const token = createSession(userId, organizationId);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', path: '/' });
  res.status(201).json({ userId, email, organizationId, organizationName: orgName });
});

diyAuthRouter.post('/diy/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const user = diyDb.prepare(`SELECT id, email, password_hash FROM users WHERE email = ?`).get(email) as UserRow | undefined;
  // Deliberately identical error for "no such user" and "wrong password" -
  // a distinct message for each is a user-enumeration oracle (attacker can
  // find out which emails have accounts by watching which error comes back).
  const genericError = { error: 'invalid email or password' };
  if (!user) return res.status(401).json(genericError);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return res.status(401).json(genericError);

  const membership = diyDb.prepare(`SELECT organization_id FROM memberships WHERE user_id = ? LIMIT 1`).get(user.id) as
    | { organization_id: number }
    | undefined;

  const token = createSession(user.id, membership?.organization_id ?? null);
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', path: '/' });
  res.json({ userId: user.id, email: user.email, organizationId: membership?.organization_id ?? null });
});

diyAuthRouter.post('/diy/logout', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) destroySession(token);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.status(204).end();
});

diyAuthRouter.get('/diy/whoami', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ authenticated: false, reason: 'no_session_cookie' });

  // Every authenticated request pays this DB round trip - there is no signed
  // token to verify locally. Contrast with Track A's session.authenticate(),
  // which verifies a JWT signature against a cached JWKS and touches the
  // network only every ~5 minutes when the local key cache expires.
  const session = validateSession(token);
  if (!session) return res.status(401).json({ authenticated: false, reason: 'invalid_or_expired_session' });

  const user = diyDb.prepare(`SELECT id, email FROM users WHERE id = ?`).get(session.userId) as { id: number; email: string };
  const membership = session.organizationId
    ? (diyDb
        .prepare(`SELECT m.role, o.name FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? AND m.organization_id = ?`)
        .get(session.userId, session.organizationId) as { role: string; name: string } | undefined)
    : undefined;

  res.json({
    authenticated: true,
    user: { id: user.id, email: user.email },
    organizationId: session.organizationId,
    organizationName: membership?.name ?? null,
    role: membership?.role ?? null,
    sessionExpiresAt: session.expiresAt,
  });
});
