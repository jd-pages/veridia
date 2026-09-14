import { describe, expect, it } from "vitest";
import { normalizeProductAliases } from "@/lib/product-aliases";

describe("产品别名规范化", () => {
  it("按中英文分号和换行拆分、trim、去空并稳定去重", () => {
    expect(normalizeProductAliases([
      " 能恩全护7HMO；能恩全护 7HMO;\n能恩全护7HMO ",
      "\n",
    ])).toEqual(["能恩全护7HMO", "能恩全护 7HMO"]);
  });
});
