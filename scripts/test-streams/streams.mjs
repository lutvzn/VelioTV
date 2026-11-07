// The test streams: one per video and audio combination common in IPTV.
// Each shows its name and a clock on screen, and beeps once a second.

// Headers that the /need-referer/ and /need-user-agent/ streams require.
export const REQUIRED_REFERER = "http://tiviplayer.test/";
export const REQUIRED_USER_AGENT = "TiviPlayerTest";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const KEYFRAMES = ["-g", "50", "-keyint_min", "50", "-sc_threshold", "0"];

const H264 = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-b:v", "4M", ...KEYFRAMES];
const H264_INTERLACED = [...H264, "-flags", "+ildct+ilme", "-x264opts", "tff=1"];
const HEVC = ["-c:v", "libx265", "-preset", "ultrafast", "-b:v", "3M"];
const HEVC_PARAMS = ["-x265-params", "keyint=50:min-keyint=50:scenecut=0:log-level=error"];
const MPEG2 = [
  "-c:v",
  "mpeg2video",
  "-b:v",
  "8M",
  "-maxrate",
  "10M",
  "-bufsize",
  "4M",
  "-g",
  "50",
  "-flags",
  "+ildct+ilme",
  "-top",
  "1",
];

const AAC = ["-c:a", "aac", "-b:a", "128k"];
const MP2 = ["-c:a", "mp2", "-b:a", "192k"];
const AC3 = ["-c:a", "ac3", "-b:a", "384k"];
const EAC3 = ["-c:a", "eac3", "-b:a", "384k"];

export const STREAMS = [
  { id: "h264-aac", label: "H.264 1080p + AAC stereo", video: H264, audio: AAC },
  { id: "h264-mp2", label: "H.264 1080p + MP2 stereo", video: H264, audio: MP2 },
  { id: "h264-ac3", label: "H.264 1080p + AC-3 5.1", video: H264, audio: AC3, surround: true },
  { id: "h264-eac3", label: "H.264 1080p + E-AC-3 5.1", video: H264, audio: EAC3, surround: true },
  {
    id: "h264i-mp2",
    label: "H.264 1080i + MP2 stereo",
    video: H264_INTERLACED,
    audio: MP2,
    interlaced: true,
  },
  { id: "hevc-aac", label: "HEVC 1080p + AAC stereo", video: [...HEVC, ...HEVC_PARAMS], audio: AAC },
  {
    id: "hevc10-aac",
    label: "HEVC Main10 1080p + AAC stereo",
    video: [...HEVC, "-pix_fmt", "yuv420p10le", ...HEVC_PARAMS],
    audio: AAC,
  },
  { id: "mpeg2-mp2", label: "MPEG-2 1080i + MP2 stereo", video: MPEG2, audio: MP2, interlaced: true },
  // Two audio tracks, English (one beep a second) and German (two higher
  // beeps), and subtitles in both, as WebVTT over HLS only (server.mjs).
  {
    id: "h264-tracks",
    label: "H.264 1080p + AAC eng, deu + subtitles",
    video: H264,
    audio: AAC,
    tracks: true,
  },
];

// The English subtitles of a "tracks" stream's clip, as SRT: one a second,
// saying which second of the clip it is. The German ones are made from
// these as they are served (server.mjs).
export const subtitles = seconds =>
  Array.from({ length: seconds }, (_, second) => {
    const at = `00:00:${String(second).padStart(2, "0")}`;
    return `${second + 1}\n${at},000 --> ${at},800\nEnglish subtitle, second ${second}\n`;
  }).join("\n");

export const germanSubtitle = text =>
  text.replaceAll("English subtitle, second", "Deutscher Untertitel, Sekunde");

// A 0.1-second beep at the start of each second, as an aevalsrc expression.
const beep = freq => `0.3*sin(2*PI*${freq}*t)*lt(mod(t\\,1)\\,0.1)`;

const escapeText = text => text.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");

// ffmpeg's lavfi sources for a stream's picture and sound.
export const sources = stream => {
  // Interlaced streams start from 50 frames a second and weave pairs of
  // frames into 25 interlaced ones, so the motion really is interlaced.
  const rate = stream.interlaced ? 50 : 25;
  const text = `drawtext=fontfile=${FONT}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=16`;
  const video = [
    `testsrc2=size=1920x1080:rate=${rate}`,
    `${text}:fontsize=72:x=80:y=80:text='${escapeText(stream.label)}'`,
    `${text}:fontsize=96:x=80:y=200:text='%{pts\\:hms}'`,
    ...(stream.interlaced ? ["interlace"] : []),
  ].join(",");

  // A short beep each second; for 5.1, a different pitch on each channel.
  const freqs = stream.surround ? [440, 550, 660, 0, 330, 880] : [440, 660];
  const layout = stream.surround ? "5.1" : "stereo";
  const audio = `aevalsrc=${freqs.map(beep).join("|")}:s=48000:c=${layout}`;
  if (!stream.tracks) return { video, audio };

  // Two short beeps at 880 Hz each second, on both channels.
  const twice = "0.3*sin(2*PI*880*t)*(lt(mod(t\\,1)\\,0.08)+between(mod(t\\,1)\\,0.2\\,0.28))";
  return { video, audio, audio2: `aevalsrc=${twice}|${twice}:s=48000:c=stereo` };
};
