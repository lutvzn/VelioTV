// Signing in to TorBox without typing its key: the TV shows a code and an
// address, the user types the code on a phone, and the TV asks every few
// seconds until TorBox gives it the key.
//
// After NuvioTVSmart's js/core/debrid/debridDeviceAuthService.js
// (https://github.com/NuvioMedia/NuvioTVSmart, GPL-3.0); changed: rewritten
// in TypeScript, for TorBox only.

import { AGENT, failure, httpFor } from "./api";

export interface DeviceCode {
  deviceCode: string;
  /** The code the user types. */
  userCode: string;
  /** Where they type it. */
  address: string;
  /** The address with the code in it, for the QR code. */
  fullAddress: string;
  intervalMs: number;
  /** When the code stops working, in ms since 1970. */
  expiresAt: number;
}

export type DeviceAnswer = { state: "signedIn"; key: string } | { state: "waiting" } | { state: "expired" };

const BASE = "https://api.torbox.app/v1/api/user/auth/device/";
const MINUTES_10 = 10 * 60_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const words = (body: unknown) =>
  isObject(body) ? `${text(body.error)} ${text(body.detail)} ${text(body.message)}`.trim() : text(body);

export const torboxDeviceSignIn = (fetcher: typeof fetch = (input, init) => fetch(input, init)) => {
  const http = httpFor("TorBox", fetcher, 20_000);
  return {
    start: async (): Promise<DeviceCode> => {
      const answer = await http(`${BASE}start?app=${encodeURIComponent(AGENT)}`);
      const data = isObject(answer.body) ? answer.body.data : undefined;
      const deviceCode = isObject(data) ? text(data.device_code) : "";
      const userCode = isObject(data) ? text(data.code) : "";
      const address = isObject(data) ? text(data.verification_url) : "";
      if (!answer.ok || !isObject(data) || !deviceCode || !userCode || !address)
        throw failure("failed", words(answer.body) || `TorBox answered ${answer.status}`);
      const interval = Number(data.interval);
      const expires = Date.parse(text(data.expires_at));
      return {
        deviceCode,
        userCode,
        address,
        fullAddress: text(data.friendly_verification_url) || address,
        intervalMs:
          Number.isFinite(interval) && interval > 0 ? Math.max(1, Math.trunc(interval)) * 1000 : 5000,
        expiresAt: Number.isFinite(expires) ? expires : Date.now() + MINUTES_10,
      };
    },
    check: async (code: DeviceCode): Promise<DeviceAnswer> => {
      const answer = await http(`${BASE}token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: code.deviceCode }),
      });
      const data = isObject(answer.body) ? answer.body.data : undefined;
      const key = isObject(data) ? text(data.access_token) : "";
      if (answer.ok && key && !(isObject(answer.body) && answer.body.success === false))
        return { state: "signedIn", key };
      const why = words(answer.body).toLowerCase();
      if (
        [404, 409, 425].includes(answer.status) ||
        /pending|not authorized|not (been )?used|scan the code/.test(why)
      )
        return { state: "waiting" };
      if (answer.status === 410 || why.includes("expired")) return { state: "expired" };
      throw failure("failed", words(answer.body) || `TorBox answered ${answer.status}`);
    },
  };
};
