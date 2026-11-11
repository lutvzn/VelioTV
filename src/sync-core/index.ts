// Copied from VelioPlatform's packages/sync-core/src/index.ts by
// scripts/sync-core/copy.mjs. Don't edit it here: change it there, then copy again.

// What every platform uses, TVs included. Sign-in with a password is in
// `@velio/sync-core/login`, which TVs never load.
export * from "./account";
export * from "./bytes";
export * from "./changes";
export * from "./crypto";
export * from "./device";
export * from "./events";
export * from "./owner";
export * from "./pairing";
export { ID_PATTERN, ReadProblem } from "./read";
export * from "./records";
export * from "./testAccount";
