// A QR code as an image the renderer can show: qrcode-generator (ES5) draws
// it as a GIF data: URL, black on white with the quiet zone round it, at
// whole pixels per module so it stays sharp.

import qrcode from "qrcode-generator";

export interface QrImage {
  src: string;
  /** Its width and height in pixels. */
  size: number;
}

/** `text` as a QR code with error correction M, about `wanted` pixels wide. */
export const qrImage = (text: string, wanted = 480): QrImage => {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  // Four modules of quiet zone on each side.
  const modules = qr.getModuleCount() + 8;
  const cell = Math.max(2, Math.floor(wanted / modules));
  return { src: qr.createDataURL(cell, cell * 4), size: modules * cell };
};
