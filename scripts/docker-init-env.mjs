import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

if (existsSync(".env")) {
  console.log("Existing .env preserved.");
} else {
  const host = process.env.DEV_HOST_IP || "localhost";
  const values = {
    JWT_SECRET: randomBytes(32).toString("hex"),
    CONTENT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    EXPO_PUBLIC_API_BASE_URL: `http://${host}:4000`,
    REACT_NATIVE_PACKAGER_HOSTNAME: host,
  };
  const lines = readFileSync(".env.example", "utf8").split("\n");
  const result = lines.map((line) => {
    const key = line.split("=", 1)[0];
    if (key && Object.hasOwn(values, key)) return `${key}=${values[key]}`;
    // An absent optional push token is valid; an empty token fails config validation.
    if (line === "EXPO_PUSH_ACCESS_TOKEN=") return "# EXPO_PUSH_ACCESS_TOKEN=";
    return line;
  });
  writeFileSync(".env", result.join("\n"), { flag: "wx", mode: 0o600 });
  console.log("Created .env with random local development secrets.");
}
