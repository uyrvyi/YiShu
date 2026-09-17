import { describe, expect, it, vi } from "vitest";
import { AuthExpiredError, createAuthenticatedFetch } from "./authenticatedFetch";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Deterministic wait for an async side effect; no fake timers in this file. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !condition(); attempt++) await flush();
  expect(condition()).toBe(true);
}

describe("Phase 9 authenticated requests", () => {
  it("shares one refresh across concurrent 401 responses", async () => {
    let token = "old";
    const refresh = vi.fn(async () => {
      token = "new";
      return token;
    });
    const fetchImpl = vi.fn(
      async (_input: unknown, init?: RequestInit) =>
        new Response(null, {
          status: new Headers(init?.headers).get("authorization") === "Bearer new" ? 200 : 401,
        })
    );
    const invalidate = vi.fn();
    const request = createAuthenticatedFetch({
      token: async () => token,
      refresh,
      invalidate,
      version: () => 0,
      fetchImpl,
    });
    const responses = await Promise.all([
      request("https://test.invalid"),
      request("https://test.invalid"),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Two requests, one retry each, no further attempts after the retry succeeded.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("never reuses the previous account's refresh for the new account", async () => {
    let version = 0;
    const resolvers: ((token: string | null) => void)[] = [];
    const refresh = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const invalidate = vi.fn();
    const request = createAuthenticatedFetch({
      token: async () => "old",
      refresh,
      invalidate,
      version: () => version,
      fetchImpl: vi.fn(
        async (_input: unknown, init?: RequestInit) =>
          new Response(null, {
            status: new Headers(init?.headers).get("authorization") === "Bearer old" ? 401 : 200,
          })
      ),
    });
    const settle = (input: string) =>
      request(input).then(
        () => "ok" as const,
        (error) => error
      );
    // Account A blocks on its own refresh.
    const previousAccount = settle("https://test.invalid");
    await until(() => refresh.mock.calls.length === 1);
    // Account switch: the new account hits 401 while A's refresh is still in flight.
    version++;
    const nextAccount = settle("https://test.invalid");
    await until(() => refresh.mock.calls.length === 2);
    // A's refresh fails, but it must neither be applied to B nor invalidate B.
    resolvers[0](null);
    expect(await previousAccount).toBeInstanceOf(AuthExpiredError);
    resolvers[1]("new");
    expect(await nextAccount).toBe("ok");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("keeps the new account's shared refresh after the previous account's refresh settles", async () => {
    let version = 0;
    const resolvers: ((token: string | null) => void)[] = [];
    const refresh = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const invalidate = vi.fn();
    const fetchImpl = vi.fn(
      async (_input: unknown, init?: RequestInit) =>
        new Response(null, {
          status: new Headers(init?.headers).get("authorization") === "Bearer old" ? 401 : 200,
        })
    );
    const request = createAuthenticatedFetch({
      token: async () => "old",
      refresh,
      invalidate,
      version: () => version,
      fetchImpl,
    });
    const settle = (input: string) =>
      request(input).then(
        () => "ok" as const,
        (error) => error
      );
    const previousAccount = settle("https://test.invalid");
    await until(() => refresh.mock.calls.length === 1);
    version++;
    const nextAccount = settle("https://test.invalid");
    await until(() => refresh.mock.calls.length === 2);
    // A's refresh settles after B's entry exists: A's cleanup must not drop B's shared state.
    resolvers[0](null);
    expect(await previousAccount).toBeInstanceOf(AuthExpiredError);
    await flush();
    const lateNextAccount = settle("https://test.invalid");
    await until(() => fetchImpl.mock.calls.length === 3);
    // B still shares its own in-flight refresh instead of starting a third one.
    expect(refresh).toHaveBeenCalledTimes(2);
    resolvers[1]("new");
    expect(await nextAccount).toBe("ok");
    expect(await lateNextAccount).toBe("ok");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("failed refresh invalidates authentication", async () => {
    const invalidate = vi.fn();
    const request = createAuthenticatedFetch({
      token: async () => "old",
      refresh: async () => null,
      invalidate,
      version: () => 0,
      fetchImpl: vi.fn(async () => new Response(null, { status: 401 })),
    });
    await expect(request("https://test.invalid")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("late retry from A cannot invalidate B", async () => {
    let version = 0;
    let calls = 0;
    const invalidate = vi.fn();
    const request = createAuthenticatedFetch({
      token: async () => "old",
      refresh: async () => "new",
      invalidate,
      version: () => version,
      fetchImpl: vi.fn(async () => {
        if (++calls === 2) version++;
        return new Response(null, { status: 401 });
      }),
    });
    await expect(request("https://test.invalid")).rejects.toBeInstanceOf(AuthExpiredError);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("late successful response from A is not delivered to B", async () => {
    let version = 0;
    const request = createAuthenticatedFetch({
      token: async () => "old",
      refresh: async () => null,
      invalidate: vi.fn(),
      version: () => version,
      fetchImpl: vi.fn(async () => {
        version++;
        return new Response(null, { status: 200 });
      }),
    });
    await expect(request("https://test.invalid")).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
