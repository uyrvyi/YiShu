import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import https from "node:https";

const directory = ".local/production";
const ca = await readFile(`${directory}/root.crt`);
const credentialsPath = `${directory}/trial-test-users.json`;
let credentials;
try {
  credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const suffix = randomBytes(4).toString("hex");
  credentials = {
    users: ["sender", "recipient"].map((role) => ({
      account: `trial_${role}_${suffix}`,
      password: randomBytes(24).toString("hex"),
    })),
    clientRequestId: randomUUID(),
  };
  const file = await open(credentialsPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(credentials, null, 2)}\n`);
  } finally {
    await file.close();
  }
}
async function request(path, token, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "host.docker.internal",
        port: 19443,
        servername: "localhost",
        ca,
        path,
        method: payload === undefined ? "GET" : "POST",
        timeout: 15000,
        headers: {
          host: "localhost",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode, body: body ? JSON.parse(body) : null });
          } catch {
            reject(new Error("unexpected_response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("trial_smoke_timeout")));
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}
try {
  assert.equal((await request("/api/v1/health")).status, 200);
  assert.equal((await request("/api/v1/users/me")).status, 401);
  assert.equal((await request("/api/v1/ready")).status, 404);
  const tokens = [];
  for (const [index, user] of credentials.users.entries()) {
    const region =
      index === 0
        ? { province: "北京市", city: "北京市", district: "东城区" }
        : { province: "上海市", city: "上海市", district: "黄浦区" };
    const registered = await request("/api/v1/auth/register", undefined, {
      ...user,
      ...region,
      nickname: index === 0 ? "Trial sender" : "Trial recipient",
    });
    assert.ok([201, 409].includes(registered.status));
    const login = await request("/api/v1/auth/login", undefined, user);
    assert.equal(login.status, 200);
    tokens.push(login.body.accessToken);
    assert.equal((await request("/api/v1/users/me", login.body.accessToken)).status, 200);
  }
  const [sender, recipient] = tokens;
  const content = "YiShu HTTPS trial verification letter.";
  const created = await request("/api/v1/letters", sender, {
    recipient: credentials.users[1].account,
    content,
    transportType: "HAND_CARRY",
    clientRequestId: credentials.clientRequestId,
  });
  assert.ok([200, 201].includes(created.status));
  const trackingNo = created.body.letter.trackingNo;
  credentials.trackingNo = trackingNo;
  await writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  assert.equal(
    (await request(`/api/v1/letters/${trackingNo}`, recipient)).body.letter.content,
    null
  );
  assert.equal((await request(`/api/v1/letters/${trackingNo}/open`, recipient, {})).status, 409);
  assert.equal((await request(`/api/v1/letters/${trackingNo}/journey`, recipient)).status, 404);
  const journey = await request(`/api/v1/letters/${trackingNo}/journey`, sender, {});
  assert.ok([200, 201].includes(journey.status));
  for (const token of tokens) {
    assert.equal((await request(`/api/v1/letters/${trackingNo}/timeline`, token)).status, 200);
    assert.equal((await request(`/api/v1/letters/${trackingNo}/map`, token)).status, 200);
  }
  const senderDetail = await request(`/api/v1/letters/${trackingNo}`, sender);
  assert.equal(senderDetail.body.letter.content, content);
  assert.ok(!/"readState"|"openedAt"/.test(JSON.stringify(senderDetail.body)));
  const evidence = {
    status: "TRIAL_BACKEND_TLS_SMOKE_PASS",
    capturedAt: new Date().toISOString(),
    checks: [
      "strict-localhost-CA-TLS",
      "auth",
      "send",
      "journey",
      "timeline",
      "map",
      "recipient-future-privacy",
      "sender-read-privacy",
    ],
    accountsCreated: 2,
    lettersCreated: 1,
    iphoneAndCellular: "SEPARATE_VERIFICATION_REQUIRED",
  };
  await writeFile(`${directory}/trial-smoke.json`, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(JSON.stringify(evidence));
} catch {
  console.error("trial_backend_smoke_failed_credentials_preserved_for_retry");
  process.exitCode = 1;
}
