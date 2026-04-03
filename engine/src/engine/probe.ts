import { spawn } from "child_process";
import { join } from "path";
import { homedir } from "os";

const PROBE_TIMEOUT = 30_000; // 30 seconds

/**
 * Spawn a minimal Haiku call to verify the API connection is alive.
 * Resolves true on first stdout data, false on timeout or error.
 */
export function probeConnectivity(): Promise<boolean> {
  return new Promise((resolve) => {
    const claudePath = process.env.CLAUDE_PATH ?? join(homedir(), '.local', 'bin', 'claude');
    let resolved = false;

    const proc = spawn(claudePath, [
      "-p", "hi",
      "--model", "haiku",
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
    ], {
      env: {
        ...process.env,
        CLAUDECODE: "",
        CLAUDE_CODE_ENTRYPOINT: "",
      },
      cwd: process.env.HOME,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin?.end();

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGKILL');
        resolve(false);
      }
    }, PROBE_TIMEOUT);

    proc.stdout?.on("data", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        proc.kill('SIGTERM');
        resolve(true);
      }
    });

    proc.on("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(false);
      }
    });

    proc.on("close", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
  });
}
