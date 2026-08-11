export interface ProjectPathOptions {
  platform?: NodeJS.Platform;
  resolve?: (value: string) => string;
  realpath?: (value: string) => string;
  stat?: null | ((value: string) => { dev: number | bigint; ino: number | bigint });
}

export function canonicalizeProjectPath(
  value: string,
  options?: ProjectPathOptions,
): string;
export function sameProjectPath(
  left: string,
  right: string,
  options?: ProjectPathOptions,
): boolean;
