import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const routerRoot = path.dirname(require.resolve("expo-router/package.json"));
const { StackRouter } = require(
  path.join(routerRoot, "build/react-navigation/routers/StackRouter.js")
);
describe("actual Expo StackRouter protected history", () => {
  it("removes Alice's detail and logistics routes before Bob can log in and go back", () => {
    const source = readFileSync(new URL("../../app/_layout.tsx", import.meta.url), "utf8");
    expect(source).toContain("<Stack key={version}");
    const protectedBlock = source
      .split("<Stack.Protected guard={authenticated}>")[1]
      ?.split("</Stack.Protected>")[0];
    expect(protectedBlock).toBeTruthy();
    if (!protectedBlock) throw new Error("protected_routes_missing");
    const protectedNames = [...protectedBlock.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);
    expect(protectedNames).toContain("letters/[trackingNo]");
    expect(protectedNames).toContain("letters/[trackingNo]/logistics");
    const authenticated = {
      routeNames: ["index", ...protectedNames],
      routeParamList: {},
      routeKeyChanges: [],
      routeGetIdList: {},
    };
    const router = StackRouter({ initialRouteName: "index" });
    let state = router.getInitialState(authenticated);
    for (const name of ["letters/[trackingNo]", "letters/[trackingNo]/logistics"])
      state = router.getStateForAction(
        state,
        { type: "PUSH", payload: { name, params: { trackingNo: "ALICE" } } },
        authenticated
      );
    const loggedOut = router.getStateForRouteNamesChange(state, {
      ...authenticated,
      routeNames: ["index"],
    });
    expect(loggedOut.routes.map((route: { name: string }) => route.name)).toEqual(["index"]);
    const bob = router.getStateForRouteNamesChange(loggedOut, authenticated);
    expect(
      bob.routes.some(
        (route: { params?: { trackingNo?: string } }) => route.params?.trackingNo === "ALICE"
      )
    ).toBe(false);
  });
});
