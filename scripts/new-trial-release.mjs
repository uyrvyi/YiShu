import assert from "node:assert/strict";
import { open, readFile, rename } from "node:fs/promises";
import { parse } from "dotenv";

const filename = ".local/production/trial.env";
const values = parse(await readFile(filename));
const previous = values.RELEASE_TAG;
assert.match(previous, /^trial-[a-z0-9-]+$/);
values.RELEASE_TAG = `trial-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).toLowerCase()}`;
assert.notEqual(previous, values.RELEASE_TAG);
const file = await open(`${filename}.partial`, "wx", 0o600);
try {
  await file.writeFile(
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`
  );
} finally {
  await file.close();
}
await rename(`${filename}.partial`, filename);
console.log(
  JSON.stringify({ status: "NEW_TRIAL_RELEASE_TAG", previous, next: values.RELEASE_TAG })
);
