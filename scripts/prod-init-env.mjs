import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, appendFile } from "node:fs/promises";
import { parse } from "dotenv";

await mkdir(".local/phase12", { recursive: true, mode: 0o700 });
try {
  const file = await open(".local/phase12/local.env", "wx", 0o600);
  try {
    const contents = [
      "RELEASE_TAG=phase12-local",
      ...[
        "POSTGRES_PASSWORD",
        "APP_POSTGRES_PASSWORD",
        "REDIS_PASSWORD",
        "JWT_SECRET",
        "CONTENT_ENCRYPTION_KEY",
      ].map((name) => `${name}=${randomBytes(32).toString("hex")}`),
    ].join("\n");
    await file.writeFile(`${contents}\n`);
  } finally {
    await file.close();
  }
  console.log("Created isolated local rehearsal credentials; existing .env unchanged.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  const existing = parse(await readFile(".local/phase12/local.env"));
  if (!existing.APP_POSTGRES_PASSWORD) {
    await appendFile(
      ".local/phase12/local.env",
      `APP_POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}\n`
    );
  }
  console.log("Existing rehearsal credentials preserved.");
}
