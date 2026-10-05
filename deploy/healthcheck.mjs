import { readFile } from "node:fs/promises";

try {
  if (process.argv[2] === "worker") {
    const updatedAt = Number(await readFile("/tmp/yishu-worker-heartbeat", "utf8"));
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > 30000) throw new Error("stale");
  } else {
    const response = await fetch("http://127.0.0.1:4000/api/v1/ready", {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error("not_ready");
  }
} catch {
  process.exitCode = 1;
}
