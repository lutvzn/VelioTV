import { describe, expect, it } from "vitest";
import {
  charsetOfLanguage,
  decodeSubtitles,
  guessCharset,
  isUtf8,
  repairMojibake,
  withoutSoundText,
} from "./subtitleText";

const bytes = (...values: number[]) => new Uint8Array(values);
const buffer = (array: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(array.byteLength);
  new Uint8Array(copy).set(array);
  return copy;
};

describe("a subtitle file's characters", () => {
  it("follow the language's usual set", () => {
    expect(charsetOfLanguage("por")).toBe("windows-1252");
    expect(charsetOfLanguage("pob")).toBe("windows-1252");
    expect(charsetOfLanguage("rus")).toBe("windows-1251");
    expect(charsetOfLanguage("zh-TW")).toBe("big5");
    expect(charsetOfLanguage("zh-CN")).toBe("gb18030");
    expect(charsetOfLanguage("zho")).toBeUndefined();
  });

  it("tell UTF-8 from other sets", () => {
    expect(isUtf8(new TextEncoder().encode("ação"))).toBe(true);
    expect(isUtf8(bytes(0x61, 0xe7, 0xe3, 0x6f))).toBe(false);
    // "Привет, как дела? Это проверка русских субтитров." in Windows-1251.
    const russian = bytes(
      0xcf,
      0xf0,
      0xe8,
      0xe2,
      0xe5,
      0xf2,
      0x2c,
      0x20,
      0xea,
      0xe0,
      0xea,
      0x20,
      0xe4,
      0xe5,
      0xeb,
      0xe0,
      0x3f,
      0x20,
      0xdd,
      0xf2,
      0xee,
      0x20,
      0xef,
      0xf0,
      0xee,
      0xe2,
      0xe5,
      0xf0,
      0xea,
      0xe0,
      0x20,
      0xf0,
      0xf3,
      0xf1,
      0xf1,
      0xea,
      0xe8,
      0xf5,
      0x20,
      0xf1,
      0xf3,
      0xe1,
      0xf2,
      0xe8,
      0xf2,
      0xf0,
      0xee,
      0xe2,
      0x2e,
    );
    expect(guessCharset(russian)).toBe("windows-1251");
    expect(decodeSubtitles(buffer(russian))).toBe("Привет, как дела? Это проверка русских субтитров.");
  });

  it("decode by the byte order mark, as UTF-8, or in the language's set", () => {
    expect(decodeSubtitles(buffer(bytes(0xef, 0xbb, 0xbf, 0xc3, 0xa9)))).toBe("é");
    expect(decodeSubtitles(buffer(bytes(0xff, 0xfe, 0xe9, 0x00)))).toBe("é");
    expect(decodeSubtitles(buffer(new TextEncoder().encode("Olá, ação")), "por")).toBe("Olá, ação");
    // "ação" in Windows-1252.
    expect(decodeSubtitles(buffer(bytes(0x61, 0xe7, 0xe3, 0x6f)), "por")).toBe("ação");
    // "Привет" in Windows-1251.
    expect(decodeSubtitles(buffer(bytes(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2)), "rus")).toBe("Привет");
    expect(decodeSubtitles(new ArrayBuffer(0))).toBe("");
  });

  it("repair UTF-8 once read as Windows-1252", () => {
    expect(repairMojibake("Itâ€™s")).toBe("It’s");
    expect(repairMojibake("plain")).toBe("plain");
  });
});

describe("subtitles without sound descriptions", () => {
  it("take out brackets, sounds in parentheses, chevrons and speakers' names", () => {
    expect(withoutSoundText("[music]\nHello there.")).toBe("Hello there.");
    expect(withoutSoundText("(DOOR SLAMS) Who's there?")).toBe("Who's there?");
    expect(withoutSoundText(">> Good evening.")).toBe("Good evening.");
    expect(withoutSoundText("JOHN: Run!")).toBe("Run!");
    expect(withoutSoundText("- MARY: Wait.\n- JOHN: No.")).toBe("- Wait.\n- No.");
  });

  it("keep speech that looks like a label, and a cue that was all sound is empty", () => {
    expect(withoutSoundText("The answer is: maybe")).toBe("The answer is: maybe");
    expect(withoutSoundText("I was born in (1984)")).toBe("I was born in (1984)");
    expect(withoutSoundText("[thunder]\n♪")).toBe("♪");
    expect(withoutSoundText("[thunder]")).toBe("");
  });
});
