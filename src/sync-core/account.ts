// Copied from VelioPlatform's packages/sync-core/src/account.ts by
// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.

// Checks the server and every app share for account forms (PLAN.md,
// "Accounts, profiles and lists"), and the Argon2id settings the server checks
// without running Argon2id itself.

import nacl from "tweetnacl";

export const MAX_EMAIL_LENGTH = 254;

/** Emails are compared trimmed and in lower case. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Why an email can't be used, or undefined. Deliberately loose: the confirmation email is the real check. */
export const emailProblem = (email: string) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return "Enter your email address.";
  if (normalized.length > MAX_EMAIL_LENGTH) return "That email address is too long.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return "That doesn't look like an email address.";
  return undefined;
};

export interface KdfParams {
  /** Argon2id memory, in KiB. */
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** 64 MiB, 3 passes, 1 lane: about a second on a phone. Stored per account, so it can be raised later. */
export const DEFAULT_KDF: KdfParams = { memoryKiB: 65_536, iterations: 3, parallelism: 1 };
export const SALT_BYTES = 16;
export const MIN_PASSWORD_LENGTH = 12;

const whole = (n: number) => Number.isInteger(n);

/** The settings a server or app accepts: never weaker than the default, never so heavy a phone can't run it. */
export const kdfProblem = (params: KdfParams) => {
  const { memoryKiB, iterations, parallelism } = params;
  if (!whole(memoryKiB) || memoryKiB < DEFAULT_KDF.memoryKiB || memoryKiB > 1_048_576)
    return "memory out of range";
  if (!whole(iterations) || iterations < DEFAULT_KDF.iterations || iterations > 10)
    return "passes out of range";
  if (!whole(parallelism) || parallelism < 1 || parallelism > 4) return "lanes out of range";
  return undefined;
};

/** Why a new password can't be used, or undefined. The server never sees the password, so only apps check this. */
export const passwordProblem = (password: string) =>
  Array.from(password.normalize("NFKC")).length < MIN_PASSWORD_LENGTH
    ? `Use at least ${MIN_PASSWORD_LENGTH} characters. A few words make a good one.`
    : undefined;

export const newSalt = () => nacl.randomBytes(SALT_BYTES);
