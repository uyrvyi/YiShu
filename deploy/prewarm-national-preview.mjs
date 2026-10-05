import assert from "node:assert/strict";

const response = await fetch("http://127.0.0.1:8081", {
  headers: { "expo-platform": "ios", accept: "application/expo+json" },
  signal: AbortSignal.timeout(30000),
});
assert.equal(response.status, 200);
const manifest = await response.json();
const bundleUrl = new URL(manifest.launchAsset.url);
assert.equal(bundleUrl.searchParams.get("dev"), "true");
bundleUrl.protocol = "http:";
bundleUrl.hostname = "127.0.0.1";
bundleUrl.port = "8081";
const bundleResponse = await fetch(bundleUrl, { signal: AbortSignal.timeout(480000) });
assert.equal(bundleResponse.status, 200);
const bundle = await bundleResponse.text();
for (const symbol of ["https://8.136.121.71/maps/national-20261003-v2", "L.vectorGrid.protobuf",
  "rendererFactory:L.canvas.tile", "beginMapTouch", "nestedScrollEnabled: true", "touchSession"])
  assert.ok(bundle.includes(symbol), "missing:" + symbol);
console.log(JSON.stringify({ status: "NATIONAL_MAP_PREWARM_PASS", bundleCharacters: bundle.length,
  sdk: manifest.extra.expoClient.sdkVersion, owner: manifest.extra.expoClient.owner }));
