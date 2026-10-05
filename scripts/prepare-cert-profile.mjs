import assert from "node:assert/strict";
import { X509Certificate, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const directory = ".local/production";
const certificate = new X509Certificate(await readFile(`${directory}/root.crt`));
assert.ok(certificate.ca && certificate.verify(certificate.publicKey));
const store = path.resolve("node_modules/.pnpm");
const entry = (await readdir(store)).find((name) => name.startsWith("plist@"));
assert.ok(entry, "Use the Docker development toolchain to generate the profile");
const require = createRequire(import.meta.url);
const plist = require(path.join(store, entry, "node_modules/plist"));
const profile = {
  PayloadType: "Configuration",
  PayloadVersion: 1,
  PayloadIdentifier: "local.yishu.trial.https",
  PayloadUUID: randomUUID(),
  PayloadDisplayName: "YiShu Trial HTTPS",
  PayloadOrganization: "YiShu local trial",
  PayloadDescription:
    "Local CA for the approved YiShu trial. This adds a trusted root; remove after testing.",
  PayloadRemovalDisallowed: false,
  PayloadContent: [
    {
      PayloadType: "com.apple.security.root",
      PayloadVersion: 1,
      PayloadIdentifier: "local.yishu.trial.https.root",
      PayloadUUID: randomUUID(),
      PayloadDisplayName: "YiShu Trial Root CA",
      PayloadCertificateFileName: "yishu-trial-root.cer",
      PayloadContent: certificate.raw,
    },
  ],
};
await writeFile(`${directory}/public-cert/yishu.mobileconfig`, plist.build(profile), {
  mode: 0o644,
});
console.log(
  JSON.stringify({
    status: "PUBLIC_CA_PROFILE_READY",
    sha256: certificate.fingerprint256,
    privateKeyIncluded: false,
    installation: "USER_MANUAL_INSTALL_AND_TRUST_REQUIRED",
  })
);
