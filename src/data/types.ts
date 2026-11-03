// What the parsers read from playlists and guides.

/** A channel from an M3U playlist. */
export interface PlaylistChannel {
  /** Position in the playlist, from 0. */
  index: number;
  name: string;
  url: string;
  /** tvg-id: the guide channel this channel's programmes come from. */
  guideId?: string;
  /** tvg-name */
  guideName?: string;
  logo?: string;
  /** tvg-chno */
  number?: number;
  group?: string;
  catchup?: Catchup;
  headers?: StreamHeaders;
  /** The provider's own id for the channel, such as an Xtream stream_id. */
  providerId?: string;
}

export interface Catchup {
  /** catchup="...", such as default, append, shift or flussonic; "xtream" for Xtream archives. */
  type: string;
  days?: number;
  /** catchup-source: a URL template, or a query to append. */
  source?: string;
}

/** HTTP headers a stream needs, from #EXTVLCOPT, #EXTHTTP or "url|Header=value". */
export interface StreamHeaders {
  referer?: string;
  userAgent?: string;
}

/** A <channel> from an XMLTV guide. */
export interface GuideChannel {
  id: string;
  name?: string;
  icon?: string;
}

/** A <programme> from an XMLTV guide. Times are milliseconds since 1970. */
export interface Programme {
  channel: string;
  start: number;
  /** Optional in XMLTV; the guide writer fills it in from the next programme. */
  stop?: number;
  title: string;
  subTitle?: string;
  description?: string;
  categories?: string[];
  /** Such as "S01E02". */
  episode?: string;
  icon?: string;
  isNew?: boolean;
}
