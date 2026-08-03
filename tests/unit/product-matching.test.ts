import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRODUCT_ALIAS_AMBIGUOUS_MESSAGE,
  PRODUCT_NOT_RECOGNIZED_MESSAGE,
  normalizeProductMatchKey,
  productResolutionError,
  resolveProductReference,
  type MatchableProduct,
} from "@/lib/product-matching";

const products: MatchableProduct[] = [
  {
    id: "au",
    name: "爱他美澳洲白金版",
    seriesName: "爱他美澳洲白金系列",
    aliases: [{ alias: "澳白" }, { alias: "澳洲白金" }],
  },
  {
    id: "de",
    name: "爱他美德国白金版",
    aliases: [{ alias: "德白" }, { alias: "德国白金" }],
  },
  { id: "zhiyi", name: "爱他美至熠", aliases: [{ alias: "至熠" }] },
  {
    id: "green",
    name: "爱他美奇迹绿罐",
    aliases: [{ alias: "绿罐" }],
  },
  {
    id: "white",
    name: "爱他美亲熠5HMO",
    aliases: [{ alias: "白罐" }],
  },
];

describe("产品名称与简称标准化", () => {
  it.each([
    ["爱他美澳洲白金版", "爱他美澳洲白金版"],
    ["澳白", "爱他美澳洲白金版"],
    ["澳洲白金", "爱他美澳洲白金版"],
    ["澳爱白金", "爱他美澳洲白金版"],
    ["德白", "爱他美德国白金版"],
    ["德国白金", "爱他美德国白金版"],
    ["德爱白金", "爱他美德国白金版"],
    ["至熠", "爱他美至熠"],
    ["奇迹绿", "爱他美奇迹绿罐"],
    ["绿罐", "爱他美奇迹绿罐"],
    ["白罐", "爱他美亲熠5HMO"],
  ])("%s 识别为正式产品 %s", (input, expectedName) => {
    expect(resolveProductReference(products, { name: input })).toMatchObject({
      status: "MATCHED",
      product: { name: expectedName },
    });
  });

  it("兼容前后空格、全角空格和全角字符", () => {
    expect(normalizeProductMatchKey("　ＡＵＳ　白　")).toBe("aus白");
    expect(
      resolveProductReference(products, { name: "  澳　白  " }),
    ).toMatchObject({
      status: "MATCHED",
      product: { name: "爱他美澳洲白金版" },
    });
  });

  it("笔记导入的产品系列列可匹配产品 seriesName", () => {
    expect(
      resolveProductReference(products, { name: "爱他美澳洲白金系列" }),
    ).toMatchObject({
      status: "MATCHED",
      product: { name: "爱他美澳洲白金版" },
    });
  });

  it("奇迹白会跟随系统内实际存在的正式产品", () => {
    expect(
      resolveProductReference(
        [{ id: "miracle-white", name: "爱他美奇迹白" }],
        { name: "奇迹白" },
      ),
    ).toMatchObject({
      status: "MATCHED",
      product: { name: "爱他美奇迹白" },
    });
    expect(
      resolveProductReference(products, { name: "奇迹白" }),
    ).toMatchObject({
      status: "MATCHED",
      product: { name: "爱他美亲熠5HMO" },
    });
  });

  it("不存在的简称返回统一错误", () => {
    const result = resolveProductReference(products, { name: "不存在简称" });
    expect(result).toEqual({ status: "NOT_FOUND" });
    expect(productResolutionError(result)).toBe(
      PRODUCT_NOT_RECOGNIZED_MESSAGE,
    );
  });

  it("同一简称配置给多个产品时明确报歧义", () => {
    const result = resolveProductReference(
      [
        { id: "one", name: "产品一", aliases: ["冲突简称"] },
        { id: "two", name: "产品二", aliases: ["冲突简称"] },
      ],
      { name: "冲突简称" },
    );
    expect(result).toMatchObject({ status: "AMBIGUOUS" });
    expect(productResolutionError(result)).toBe(
      PRODUCT_ALIAS_AMBIGUOUS_MESSAGE,
    );
  });

  it("活动规则导入和笔记导入共用产品解析器", () => {
    const root = process.cwd();
    const noteImport = fs.readFileSync(
      path.join(root, "app/api/import/notes/route.ts"),
      "utf8",
    );
    const ruleImport = fs.readFileSync(
      path.join(root, "lib/rule-import.ts"),
      "utf8",
    );
    expect(noteImport).toContain("resolveProductReference");
    expect(ruleImport).toContain("resolveProductReference");
    expect(noteImport).toContain("checked.productName = product.name");
  });
});
