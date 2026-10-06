export type PrivatePixels = { status: "loading" | "failed" } | { status: "ready"; data: string };

// Owned by one visible letter page, never by a global store or persistent storage.
export function createPrivateImageCache({
  ids,
  loadImage,
  sameSession,
}: {
  ids: string[];
  loadImage: (id: string) => Promise<string>;
  sameSession: () => boolean;
}) {
  const allowed = new Set(ids);
  const pixels = new Map<string, PrivatePixels>();
  const pending = new Map<string, object>();
  const listeners = new Set<() => void>();
  let active = false;
  let epoch = 0;
  let version = 0;
  const publish = () => {
    version++;
    listeners.forEach((listener) => listener());
  };
  function load(id: string) {
    if (
      !active ||
      !sameSession() ||
      !allowed.has(id) ||
      pending.has(id) ||
      pixels.get(id)?.status === "ready"
    )
      return;
    const requestEpoch = epoch;
    const token = {};
    const current = () =>
      active && epoch === requestEpoch && pending.get(id) === token && sameSession();
    pixels.set(id, { status: "loading" });
    pending.set(id, token);
    publish();
    void Promise.resolve()
      .then(() => (current() ? loadImage(id) : Promise.reject(new Error("image_cache_disposed"))))
      .then((data) => {
        if (!current()) return;
        pending.delete(id);
        pixels.set(id, { status: "ready", data });
        publish();
      })
      .catch(() => {
        if (!current()) return;
        pending.delete(id);
        pixels.set(id, { status: "failed" });
        publish();
      })
      .finally(() => {
        if (pending.get(id) === token) pending.delete(id);
      });
  }
  return {
    preload() {
      if (!active) {
        active = true;
        epoch++;
      }
      allowed.forEach(load);
    },
    read(id: string) {
      return active && sameSession() ? pixels.get(id) : undefined;
    },
    retry(id: string) {
      if (pixels.get(id)?.status === "failed") load(id);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
    dispose() {
      active = false;
      epoch++;
      pending.clear();
      pixels.clear();
      publish();
    },
  };
}
