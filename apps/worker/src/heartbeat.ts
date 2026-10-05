import { writeFile, unlink } from "node:fs/promises";

export function startHeartbeat(
  check: () => Promise<void>,
  filename = "/tmp/yishu-worker-heartbeat"
) {
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          check(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("heartbeat_timeout")), 3000);
          }),
        ]);
        if (!stopped) await writeFile(filename, String(Date.now()), { mode: 0o600 });
      } catch {
        await unlink(filename).catch(() => {});
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      running = undefined;
    });
  };
  const interval = setInterval(tick, 5000);
  tick();
  return async () => {
    stopped = true;
    clearInterval(interval);
    await running;
    await unlink(filename).catch(() => {});
  };
}
