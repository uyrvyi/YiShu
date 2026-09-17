export class AuthExpiredError extends Error {
  constructor() {
    super("auth_expired");
    this.name = "AuthExpiredError";
  }
}

/** One retry after one shared refresh. No background 401 storm after session invalidation. */
export function createAuthenticatedFetch(deps: {
  token: () => Promise<string | null>;
  refresh: () => Promise<string | null>;
  invalidate: () => Promise<void>;
  version: () => number;
  fetchImpl?: typeof fetch;
}): typeof fetch {
  // Share one refresh only inside the same session generation: a refresh started by the
  // previous account must never be handed to, or invalidate, the account that replaced it.
  let refreshing: { generation: number; promise: Promise<string | null> } | null = null;
  const refresh = (generation: number): Promise<string | null> => {
    if (refreshing?.generation === generation) return refreshing.promise;
    const entry = { generation, promise: deps.refresh().catch(() => null) };
    refreshing = entry;
    void entry.promise.then(() => {
      if (refreshing === entry) refreshing = null;
    });
    return entry.promise;
  };
  return async (input, init) => {
    const generation = deps.version();
    const token = await deps.token();
    if (!token || generation !== deps.version()) throw new AuthExpiredError();
    const send = (accessToken: string) =>
      (deps.fetchImpl ?? fetch)(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(15000),
        headers: {
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          authorization: `Bearer ${accessToken}`,
        },
      });
    let response = await send(token);
    if (generation !== deps.version()) throw new AuthExpiredError();
    if (response.status !== 401) return response;
    // A concurrent caller may already have refreshed the same expired access token.
    const current = await deps.token();
    const renewed = current && current !== token ? current : await refresh(generation);
    if (generation !== deps.version()) throw new AuthExpiredError();
    if (renewed) response = await send(renewed);
    // A late retry from the previous account must never invalidate the new session.
    if (generation !== deps.version()) throw new AuthExpiredError();
    if (!renewed || response.status === 401) {
      await deps.invalidate();
      throw new AuthExpiredError();
    }
    if (generation !== deps.version()) throw new AuthExpiredError();
    return response;
  };
}
