// The debrid services the app can use itself (PLAN.md, "Debrid services"):
// a torrent an add-on lists (an info hash, as Torrentio gives without a
// key) is played from the service's copy, if it has one. Each signs in with
// its API key; TorBox also by a code typed on a phone. Some can say which torrents they have before one is played.
//
// After NuvioTVSmart's js/core/debrid/debridProviders.js
// (https://github.com/NuvioMedia/NuvioTVSmart, GPL-3.0); changed: rewritten
// in TypeScript, with more services, whose calls follow StremThru's
// (https://github.com/MunifTanjim/stremthru, MIT).

export type ServiceId =
  | "torbox"
  | "realdebrid"
  | "premiumize"
  | "alldebrid"
  | "debridlink"
  | "easydebrid"
  | "offcloud";

export interface ServiceInfo {
  id: ServiceId;
  name: string;
  /** On a stream's row, such as "TB". */
  short: string;
  /** Where its API key is, for the user to type it in. */
  keyPage: string;
  /** Signs in without typing the key, by a code typed on a phone. */
  signIn?: "device";
  /** Can say which torrents it has before one is played. */
  checks: boolean;
}

export const SERVICES: readonly ServiceInfo[] = [
  {
    id: "torbox",
    name: "TorBox",
    short: "TB",
    keyPage: "torbox.app/settings",
    signIn: "device",
    checks: true,
  },
  { id: "realdebrid", name: "Real-Debrid", short: "RD", keyPage: "real-debrid.com/apitoken", checks: false },
  { id: "premiumize", name: "Premiumize", short: "PM", keyPage: "premiumize.me/account", checks: true },
  { id: "alldebrid", name: "AllDebrid", short: "AD", keyPage: "alldebrid.com/apikeys", checks: false },
  {
    id: "debridlink",
    name: "Debrid-Link",
    short: "DL",
    keyPage: "debrid-link.com/webapp/apikey",
    checks: false,
  },
  { id: "easydebrid", name: "EasyDebrid", short: "ED", keyPage: "easydebrid.com/dashboard", checks: true },
  { id: "offcloud", name: "Offcloud", short: "OC", keyPage: "offcloud.com/#/account", checks: true },
];

export const SERVICE_IDS = SERVICES.map(service => service.id);

export const serviceInfo = (id: ServiceId): ServiceInfo =>
  SERVICES.find(service => service.id === id) ?? SERVICES[0];
