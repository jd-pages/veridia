import fs from "node:fs";
import path from "node:path";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export function getRuleRepository() {
  const configPath = path.join(process.cwd(), "rules", "config.json");
  let packagedRepository = "";
  if (fs.existsSync(configPath)) {
    try {
      packagedRepository = String(
        (JSON.parse(fs.readFileSync(configPath, "utf8")) as {
          repository?: string;
        }).repository || "",
      ).trim();
    } catch {
      packagedRepository = "";
    }
  }
  const value =
    process.env.VERIDIA_RULES_REPOSITORY?.trim() || packagedRepository;
  return REPOSITORY_PATTERN.test(value) ? value : "";
}

export function getRuleSigningPublicKey() {
  const inline = process.env.VERIDIA_RULES_PUBLIC_KEY?.trim();
  if (inline) return inline.replace(/\\n/gu, "\n");

  const configuredPath = process.env.VERIDIA_RULES_PUBLIC_KEY_PATH?.trim();
  const publicKeyPath = configuredPath
    ? path.resolve(configuredPath)
    : path.join(process.cwd(), "rules", "public-key.pem");
  return fs.existsSync(publicKeyPath)
    ? fs.readFileSync(publicKeyPath, "utf8").trim()
    : "";
}

export function ruleSyncConfiguration() {
  const repository = getRuleRepository();
  const publicKey = getRuleSigningPublicKey();
  return {
    repository,
    publicKey,
    configured: Boolean(repository && publicKey),
  };
}
