import { createHash, randomBytes } from 'node:crypto';

import argon2 from 'argon2';
import { z } from 'zod';

/** Passwords: at least 10 characters (NIST-style length over composition rules). */
export const PasswordSchema = z.string().min(10, 'Use at least 10 characters').max(200);
export const EmailSchema = z.string().trim().toLowerCase().email().max(200);

/** argon2id hash (PHC string, salt included). */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies a password. With no stored hash (unknown user, SSO-only user) a dummy hash is verified so
 * the response time does not reveal whether the account exists.
 */
export async function verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword('not-a-real-password');
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return argon2.verify(hash, password).catch(() => false);
}

/** URL-safe random token (256 bits by default). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex of a high-entropy token; the only form in which session and invite tokens are stored. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
