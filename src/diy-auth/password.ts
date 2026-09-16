import bcrypt from 'bcryptjs';

/**
 * Password hashing - the part of Track B that WorkOS (Track A) eliminates
 * entirely, because AuthKit never gives your app a plaintext password to
 * hash in the first place.
 *
 * bcryptjs over native `argon2`/`bcrypt`: it's pure JS, so `npm install`
 * never needs a C++ toolchain. Argon2id is the stronger OWASP-recommended
 * choice for a real product (tunable memory cost resists GPU cracking better
 * than bcrypt's fixed 4KB), but bcrypt is still considered safe today and
 * the point of Track B is the *shape* of the problem, not winning a KDF
 * bake-off.
 */

// Cost factor: each +1 doubles hashing time. 12 is a common 2026 floor for
// bcrypt (~250ms on typical hardware) - slow enough to blunt offline
// cracking of a leaked hash table, fast enough not to make login feel broken.
const SALT_ROUNDS = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  // bcrypt generates and embeds a random salt in the returned hash string
  // itself (the $2b$12$<22-char-salt><31-char-hash> format) - that's why
  // there's no separate `salt` column in the users table.
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  // bcrypt.compare does a constant-time comparison internally - never
  // compare hashes with `===`, which leaks timing information an attacker
  // can use to guess the hash byte-by-byte.
  return bcrypt.compare(plaintext, hash);
}
