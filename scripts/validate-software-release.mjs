import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  formatArtifactSize,
  packageVersion,
  softwareReleaseArtifactNames,
  validateSoftwareReleaseArtifacts,
} from "./software-release-artifacts.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const version = packageVersion(projectRoot);
const directoryArgument = process.argv
  .find((value) => value.startsWith("--directory="))
  ?.slice("--directory=".length);
const directory = directoryArgument
  ? path.resolve(projectRoot, directoryArgument)
  : path.join(projectRoot, "release", version);

try {
  if (process.argv.includes("--dry-run") && !fs.existsSync(directory)) {
    process.stdout.write(
      `Dry-run：正式发布将检查 ${softwareReleaseArtifactNames(version).join("、")}。\n`,
    );
  } else {
    const result = validateSoftwareReleaseArtifacts({
      projectRoot,
      version,
      directory,
    });
    process.stdout.write(
      [
        "",
        `软件发布三件套检查通过：VERIDIA ${result.version}`,
        ...result.files.map(
          (file) => `- ${file.name}：${formatArtifactSize(file.size)}`,
        ),
        `安装包 SHA-256：${result.installerSha256}`,
        "包含 blockmap：是",
        "包含 latest.yml：是",
        "本流程未执行 rules:publish，也未发布远程规则。",
        "",
      ].join("\n"),
    );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
