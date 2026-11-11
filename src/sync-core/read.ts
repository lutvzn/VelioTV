// Copied from VelioPlatform's packages/sync-core/src/read.ts by
// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.

// Readers for JSON from outside: a decrypted record, a verified manifest, or
// a change sent to the server. A signature or a Poly1305 tag says who wrote
// something, not that it has the right shape, so everything is read field
// by field. Each throws a ReadProblem naming what didn't fit.

import { isRecord } from "./crypto";

export class ReadProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadProblem";
  }
}

export const record = (value: unknown, what: string) => {
  if (!isRecord(value)) throw new ReadProblem(`${what} isn't an object`);
  return value;
};

export const text = (value: unknown, what: string, maxLength = 4096) => {
  if (typeof value !== "string") throw new ReadProblem(`${what} isn't text`);
  if (value.length > maxLength) throw new ReadProblem(`${what} is too long`);
  return value;
};

export const optionalText = (value: unknown, what: string, maxLength?: number) =>
  value === undefined ? undefined : text(value, what, maxLength);

export const count = (value: unknown, what: string) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ReadProblem(`${what} isn't a count`);
  return value;
};

export const array = (value: unknown, what: string, maxLength = 1000): unknown[] => {
  if (!Array.isArray(value)) throw new ReadProblem(`${what} isn't a list`);
  if (value.length > maxLength) throw new ReadProblem(`${what} has too many items`);
  return value;
};

/** Ids are server-visible, so they are short random text and never say anything. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export const id = (value: unknown, what: string) => {
  const read = text(value, what, 40);
  if (!ID_PATTERN.test(read)) throw new ReadProblem(`${what} isn't an id`);
  return read;
};
