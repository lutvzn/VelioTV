import { describe, expect, it } from "vitest";
import { type LinkText, orderLinks, qualityRank } from "./linkOrder";

const names = (links: readonly LinkText[]) => links.map(link => link.name);

describe("orderLinks", () => {
  const links: LinkText[] = [
    { name: "EN - The Great Adventure (1999)" },
    { name: "The Great Adventure SD" },
    { name: "PT - A Grande Aventura [4K]" },
    { name: "The Great Adventure FHD" },
    { name: "A Grande Aventura", category: "|BR| Filmes" },
  ];

  it("puts the app's language first, untagged next, then the best quality", () => {
    expect(names(orderLinks(links, link => link, "pt-BR"))).toEqual([
      "PT - A Grande Aventura [4K]",
      "A Grande Aventura",
      "The Great Adventure FHD",
      "The Great Adventure SD",
      "EN - The Great Adventure (1999)",
    ]);
    expect(names(orderLinks(links, link => link, "en"))[0]).toBe("EN - The Great Adventure (1999)");
  });

  it("reads quality words only as words", () => {
    expect(qualityRank("Sdafsd Film")).toBe(2);
    expect(qualityRank("Film 2160p")).toBe(0);
    expect(qualityRank("UHD: Film")).toBe(0);
  });
});
