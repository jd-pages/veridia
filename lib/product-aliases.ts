export function normalizeProductAliases(value: unknown): string[] {
  const inputs = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      inputs
        .flatMap((item) => String(item ?? "").split(/[；;\r\n]+/u))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}
