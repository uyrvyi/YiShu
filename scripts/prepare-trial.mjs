import assert from "node:assert/strict";
import { isIP } from "node:net";
import { mkdir, open, readFile } from "node:fs/promises";
import { parse } from "dotenv";

const directory = ".local/production";
const ipv6 = process.env.TRIAL_IPV6;
const lan = process.env.TRIAL_LAN_IP;
assert.equal(isIP(ipv6 ?? ""), 6);
assert.equal(isIP(lan ?? ""), 4);
const source = parse(await readFile(`${directory}/local.env`));
const development = parse(await readFile(".env"));
const target = {
  ...source,
  RELEASE_TAG: `trial-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).toLowerCase()}`,
  TRIAL_IPV6: ipv6,
  TRIAL_LAN_IP: lan,
};
const preview = {
  EXPO_PUBLIC_API_BASE_URL: `https://[${ipv6}]:19443`,
  REACT_NATIVE_PACKAGER_HOSTNAME: lan,
  TRIAL_LAN_IP: lan,
  EXPO_NO_TELEMETRY: "1",
  EXPO_PUBLIC_BAIDU_MAP_AK: development.EXPO_PUBLIC_BAIDU_MAP_AK ?? "",
};
for (const [filename, values] of [
  ["trial.env", target],
  ["preview.env", preview],
]) {
  const pathname = `${directory}/${filename}`;
  try {
    const file = await open(pathname, "wx", 0o600);
    try {
      await file.writeFile(
        `${Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n")}\n`
      );
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = parse(await readFile(pathname));
    for (const [key, value] of Object.entries(values)) {
      if (key !== "RELEASE_TAG")
        assert.equal(existing[key], value, "Trial configuration changed; review before replacing");
    }
  }
}
await mkdir(`${directory}/public-cert`, { recursive: true, mode: 0o700 });
console.log(
  JSON.stringify({
    status: "TRIAL_CONFIG_READY",
    port: 19443,
    preview: "LAN_ONLY",
    secretsPrinted: false,
  })
);
