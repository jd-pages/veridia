export const PRODUCT_NOT_RECOGNIZED_MESSAGE =
  "产品名称无法识别，请填写系统产品名称或已配置简称。";

export const PRODUCT_ALIAS_AMBIGUOUS_MESSAGE =
  "产品简称匹配到多个系统产品，请填写完整产品名称。";

export interface MatchableProduct {
  id: string;
  name: string;
  code?: string | null;
  seriesName?: string | null;
  aliases?: Array<string | { alias: string }>;
}

export type ProductResolution<T extends MatchableProduct> =
  | { status: "MATCHED"; product: T; matchedBy: "CODE" | "NAME" | "ALIAS" }
  | { status: "NOT_FOUND" }
  | { status: "AMBIGUOUS"; products: T[] };

const BUILTIN_PRODUCT_ALIASES: Array<{
  aliases: string[];
  productNames: string[];
}> = [
  {
    aliases: ["澳白", "澳洲白金", "澳爱白金"],
    productNames: ["爱他美澳洲白金版"],
  },
  {
    aliases: ["德白", "德国白金", "德爱白金"],
    productNames: ["爱他美德国白金版"],
  },
  { aliases: ["至熠"], productNames: ["爱他美至熠"] },
  {
    aliases: ["奇迹绿", "绿罐"],
    productNames: ["爱他美奇迹绿罐"],
  },
  {
    aliases: ["奇迹白", "白罐"],
    productNames: ["爱他美奇迹白", "爱他美亲熠5HMO"],
  },
  {
    aliases: [
      "荷兰佳贝1",
      "荷兰佳贝2",
      "荷兰佳贝3",
      "荷兰佳贝1段",
      "荷兰佳贝2段",
      "荷兰佳贝3段",
      "荷兰佳贝一段",
      "荷兰佳贝二段",
      "荷兰佳贝三段",
      "佳贝艾特荷兰1",
      "佳贝艾特荷兰2",
      "佳贝艾特荷兰3",
      "佳贝艾特荷兰版",
      "Kabrita荷兰版",
    ],
    productNames: ["佳贝艾特荷兰版"],
  },
  {
    aliases: [
      "港版佳贝1",
      "港版佳贝2",
      "港版佳贝3",
      "港版佳贝1段",
      "港版佳贝2段",
      "港版佳贝3段",
      "港版佳贝一段",
      "港版佳贝二段",
      "港版佳贝三段",
      "佳贝艾特港版1",
      "佳贝艾特港版2",
      "佳贝艾特港版3",
      "佳贝艾特港版",
      "Kabrita港版",
    ],
    productNames: ["佳贝艾特港版"],
  },
];

export function normalizeProductMatchKey(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s\u00a0\u3000]+/gu, "")
    .toLocaleLowerCase("zh-CN");
}

function uniqueProducts<T extends MatchableProduct>(products: T[]) {
  return [...new Map(products.map((product) => [product.id, product])).values()];
}

function aliasValues(product: MatchableProduct) {
  return (product.aliases || []).map((item) =>
    typeof item === "string" ? item : item.alias,
  );
}

function fromCandidates<T extends MatchableProduct>(
  candidates: T[],
  matchedBy: "CODE" | "NAME" | "ALIAS",
): ProductResolution<T> {
  const unique = uniqueProducts(candidates);
  if (!unique.length) return { status: "NOT_FOUND" };
  if (unique.length > 1) return { status: "AMBIGUOUS", products: unique };
  return { status: "MATCHED", product: unique[0], matchedBy };
}

export function resolveProductReference<T extends MatchableProduct>(
  products: T[],
  input: { name?: unknown; code?: unknown },
): ProductResolution<T> {
  const codeKey = normalizeProductMatchKey(input.code);
  if (codeKey) {
    const codeResult = fromCandidates(
      products.filter(
        (product) => normalizeProductMatchKey(product.code) === codeKey,
      ),
      "CODE",
    );
    if (codeResult.status !== "NOT_FOUND") return codeResult;
  }

  const nameKey = normalizeProductMatchKey(input.name);
  if (!nameKey) return { status: "NOT_FOUND" };

  const nameResult = fromCandidates(
    products.filter(
      (product) => normalizeProductMatchKey(product.name) === nameKey,
    ),
    "NAME",
  );
  if (nameResult.status !== "NOT_FOUND") return nameResult;

  const seriesResult = fromCandidates(
    products.filter(
      (product) => normalizeProductMatchKey(product.seriesName) === nameKey,
    ),
    "NAME",
  );
  if (seriesResult.status !== "NOT_FOUND") return seriesResult;

  const configuredAliasResult = fromCandidates(
    products.filter((product) =>
      aliasValues(product).some(
        (alias) => normalizeProductMatchKey(alias) === nameKey,
      ),
    ),
    "ALIAS",
  );
  if (configuredAliasResult.status !== "NOT_FOUND") {
    return configuredAliasResult;
  }

  const builtinTargets = BUILTIN_PRODUCT_ALIASES.filter((mapping) =>
    mapping.aliases.some(
      (alias) => normalizeProductMatchKey(alias) === nameKey,
    ),
  ).flatMap((mapping) => mapping.productNames.map(normalizeProductMatchKey));
  if (!builtinTargets.length) return { status: "NOT_FOUND" };
  return fromCandidates(
    products.filter((product) =>
      builtinTargets.includes(normalizeProductMatchKey(product.name)),
    ),
    "ALIAS",
  );
}

export function productResolutionError(
  resolution: ProductResolution<MatchableProduct>,
) {
  return resolution.status === "AMBIGUOUS"
    ? PRODUCT_ALIAS_AMBIGUOUS_MESSAGE
    : PRODUCT_NOT_RECOGNIZED_MESSAGE;
}
