export function createDraftMediaLifecycle(deps: {
  remove: (id: string) => Promise<void>;
  sameSession: () => boolean;
}) {
  const owned = new Set<string>();
  let disposed = false;
  let preserve = false;
  let epoch = 0;
  async function release(id: string) {
    if (!deps.sameSession()) return;
    try {
      await deps.remove(id);
      owned.delete(id);
    } catch {
      // The server's expiration handler retries abandoned files after 24 hours.
    }
  }
  return {
    activate() {
      disposed = false;
      epoch++;
    },
    add(id: string) {
      owned.add(id);
      if (disposed && !preserve) void release(id);
    },
    forget(id: string) {
      owned.delete(id);
    },
    async dispose(keep: boolean) {
      disposed = true;
      preserve = keep;
      const generation = ++epoch;
      // A Strict Mode effect replay must not dispose a still-open draft.
      await Promise.resolve();
      if (!disposed || generation !== epoch || preserve) return;
      for (const id of owned) {
        if (!disposed || generation !== epoch) break;
        await release(id);
      }
    },
  };
}
