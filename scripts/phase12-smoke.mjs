import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";

const ca = await readFile(".local/phase12/root.crt");
async function request(path, token, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "host.docker.internal",
        port: 8443,
        servername: "localhost",
        path,
        ca,
        method: payload ? "POST" : "GET",
        headers: {
          ...headers,
          host: "localhost",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "content-type": "application/json" } : {}),
        },
        timeout: 10000,
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          try {
            resolve({ status: response.statusCode, body: data ? JSON.parse(data) : null });
          } catch {
            reject(new Error("smoke_unexpected_response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("smoke_timeout")));
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
}
try {
  if (process.argv.includes("--proxy-only")) {
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      const result = await request(
        "/api/v1/auth/login",
        undefined,
        {},
        {
          "x-forwarded-for": `203.0.113.${i + 1}`,
          forwarded: `for=203.0.113.${i + 1}`,
          "x-real-ip": `203.0.113.${i + 1}`,
        }
      );
      statuses.push(result.status);
    }
    assert.ok(statuses.includes(429));
    assert.ok(statuses.every((status) => status === 400 || status === 429));
    console.log(JSON.stringify({ status: "PROXY_SPOOF_QUOTA_PASS", statuses }));
  } else {
    assert.equal((await request("/api/v1/health")).status, 200);
    assert.equal((await request("/api/v1/users/me")).status, 401);
    assert.equal((await request("/api/v1/ready")).status, 404);
    assert.equal((await request("/not-an-api")).status, 404);
    const id = randomBytes(4).toString("hex");
    const password = randomBytes(24).toString("hex");
    const users = [];
    for (const role of ["sender", "recipient"]) {
      const account = `p12_${role}_${id}`;
      const response = await request("/api/v1/auth/register", undefined, {
        account,
        password,
        nickname: role,
        province: "北京市",
        city: "北京市",
        district: "东城区",
      });
      assert.equal(response.status, 201);
      const login = await request("/api/v1/auth/login", undefined, { account, password });
      assert.equal(login.status, 200);
      users.push({ account, token: login.body.accessToken });
    }
    const [sender, recipient] = users;
    const content = "Phase 12 isolated TLS rehearsal letter.";
    const created = await request("/api/v1/letters", sender.token, {
      recipient: recipient.account,
      content,
      transportType: "HAND_CARRY",
      clientRequestId: randomUUID(),
    });
    assert.equal(created.status, 201);
    const trackingNo = created.body.letter.trackingNo;
    const recipientDetail = await request(`/api/v1/letters/${trackingNo}`, recipient.token);
    assert.equal(recipientDetail.body.letter.content, null);
    assert.equal(
      (await request(`/api/v1/letters/${trackingNo}/journey`, recipient.token)).status,
      404
    );
    assert.equal(
      (await request(`/api/v1/letters/${trackingNo}/open`, recipient.token, {})).status,
      409
    );
    assert.equal(
      (await request(`/api/v1/letters/${trackingNo}/journey`, sender.token, {})).status,
      201
    );
    assert.equal(
      (await request(`/api/v1/letters/${trackingNo}/timeline`, recipient.token)).status,
      200
    );
    assert.equal((await request(`/api/v1/letters/${trackingNo}/map`, recipient.token)).status, 200);
    const senderDetail = await request(`/api/v1/letters/${trackingNo}`, sender.token);
    assert.equal(senderDetail.body.letter.content, content);
    assert.ok(!/"readState"|"openedAt"/.test(JSON.stringify(senderDetail.body)));
    console.log(
      JSON.stringify({
        status: "LOCAL_TLS_SMOKE_PASS",
        checks: [
          "trusted-CA-TLS",
          "health",
          "auth",
          "send",
          "route",
          "timeline",
          "map",
          "recipient-pre-delivery-privacy",
          "sender-read-privacy",
        ],
        deliveryAndRemotePush: "NOT_VERIFIED",
      })
    );
  }
} catch {
  console.error("phase12_smoke_failed");
  process.exitCode = 1;
}
