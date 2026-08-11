export interface SelectableProductStage {
  value: string;
  label: string;
}

export function nextSelectedProductStage(
  options: readonly SelectableProductStage[],
  currentStage: string | null | undefined,
) {
  if (options.length === 1) return options[0].value;
  if (
    currentStage &&
    options.some((option) => option.value === currentStage)
  ) {
    return currentStage;
  }
  return null;
}
