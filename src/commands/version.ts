import { execa } from "execa";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const getCliVersion = async (): Promise<string> => {
  const packageJsonPath = resolve(process.cwd(), "package.json");
  const raw = await readFile(packageJsonPath, "utf-8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "unknown";
};

const getGhVersion = async (): Promise<string> => {
  const result = await execa("gh", ["--version"], { reject: false });
  if (result.exitCode !== 0) {
    return "unavailable";
  }
  return result.stdout.split("\n")[0]?.trim() ?? "unknown";
};

export const runVersionCommand = async (): Promise<void> => {
  const [cliVersion, ghVersion] = await Promise.all([getCliVersion(), getGhVersion()]);

  process.stdout.write(`ghprai ${cliVersion}\n`);
  process.stdout.write(`${ghVersion}\n`);
};
