import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { config } from "./config.js";

const execAsync = promisify(exec);

// Repo dir = parent of compiled module (dist/update.js → /home/user/agent-gateway)
export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface UpdateResult {
  before: string;
  after: string;
  changed: boolean;
  log: string;
}

async function gatewayCommit(): Promise<string> {
  try {
    const { stdout } = await execAsync("git rev-parse --short HEAD", {
      cwd: REPO_DIR,
    });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

async function claudeVersion(): Promise<string> {
  try {
    const { stdout } = await execAsync(`"${config.claudeBin}" --version`);
    return stdout.trim();
  } catch (err: any) {
    return `error: ${err?.message ?? err}`;
  }
}

const tail = (s: string, n = 800): string => {
  const trimmed = s.trim();
  if (trimmed.length <= n) return trimmed;
  return `…${trimmed.slice(-n)}`;
};

export async function updateGateway(): Promise<UpdateResult> {
  const before = await gatewayCommit();
  const steps: string[] = [];

  const pull = await execAsync("git pull --ff-only", { cwd: REPO_DIR });
  steps.push(`git pull:\n${(pull.stdout + pull.stderr).trim()}`);

  const install = await execAsync("npm install --no-audit --no-fund", {
    cwd: REPO_DIR,
    timeout: 180_000,
  });
  steps.push(`npm install:\n${tail(install.stdout + install.stderr, 400)}`);

  const build = await execAsync("npm run build", {
    cwd: REPO_DIR,
    timeout: 60_000,
  });
  steps.push(`npm run build:\n${(build.stdout + build.stderr).trim() || "(silent)"}`);

  const after = await gatewayCommit();
  return {
    before,
    after,
    changed: before !== after,
    log: steps.join("\n\n"),
  };
}

export async function updateClaude(): Promise<UpdateResult> {
  const before = await claudeVersion();
  const { stdout, stderr } = await execAsync(`"${config.claudeBin}" update`, {
    timeout: 120_000,
  });
  const after = await claudeVersion();
  return {
    before,
    after,
    changed: before !== after,
    log: tail(stdout + stderr, 800),
  };
}

// Fire-and-forget pm2 reload. We are about to be killed and replaced.
export function reloadProcess(name: string): void {
  const child = spawn("pm2", ["reload", name, "--update-env"], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

export async function gatewayInfo(): Promise<{
  commit: string;
  version: string;
}> {
  const commit = await gatewayCommit();
  let version = "unknown";
  try {
    const raw = await readFile(join(REPO_DIR, "package.json"), "utf8");
    version = JSON.parse(raw).version ?? "unknown";
  } catch {}
  return { commit, version };
}
