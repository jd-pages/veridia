export function resolveSoftwareUpdateRepository(
  context: unknown,
  environment?: Record<string, string | undefined>,
): string;

export function afterPack(context: unknown): Promise<void>;

export default afterPack;
