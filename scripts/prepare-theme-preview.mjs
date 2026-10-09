import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "apps/mobile/package.json"));
const ts = require("typescript");
const revision = "appearance-20261008-r1";
const target = join(root, `.local/cloud-preview/${revision}/context`);
const ritualFile = "apps/mobile/src/letters/LetterRitual.tsx";
const files = [
  "apps/mobile/app.json", "apps/mobile/app/_layout.tsx", "apps/mobile/app/appearance.tsx",
  ...["index", "me", "profile", "encryption", "letters/index", "letters/new", "letters/[trackingNo]", "letters/[trackingNo]/logistics"].map((name) => `apps/mobile/app/${name}.tsx`),
  ...["theme.ts", "appearanceStore.ts", "ThemeProvider.tsx", "controls.tsx", "BottomNav.tsx", "GlassSurface.tsx"].map((name) => `apps/mobile/src/ui/${name}`),
  "apps/mobile/src/regions/RegionSelector.tsx", "apps/mobile/src/media/PrivateImage.tsx", "apps/mobile/src/media/AvatarCropper.tsx",
  "apps/mobile/src/letters/LetterPaper.tsx", ritualFile,
  ...["theme.ts", "useMapColors.ts", "RouteMap.tsx", "layers.tsx", "FactList.tsx", "InteractiveRouteMap.tsx", "localMapHtml.ts", "vectorTiles.ts"].map((name) => `apps/mobile/src/map/${name}`),
  "deploy/Dockerfile.cloud-mobile-patch", "deploy/release-gallery-preview.sh",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Use the verified live ritual as the base; do not copy the pending local geometry.
let ritual = readFileSync(join(root, ".local/cloud-preview/letter-paper-front-20261008/context", ritualFile), "utf8");
const liveRitualHash = "d8e9c46f470c032b07f3c7261ff265de34466a2db6d4933b1f0a9c4a70ea3033";
if (hash(ritual) !== liveRitualHash) throw Error("live_ritual_snapshot_mismatch");
const parsed = ts.createSourceFile(ritualFile, ritual, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const edits = [];
for (const node of parsed.statements) {
  if (!ts.isFunctionDeclaration(node) || !node.body || node.name.text === "EnvelopeArt") continue;
  if (node.name.text === "PaperArt") {
    const updated = node.getText(parsed)
      .replace("{\n  return", "{\n  const { colors: C } = useAppTheme();\n  return")
      .replace('fill={PAPER} stroke="#D7C9AF"', "fill={C.paper} stroke={C.paperArtBorder}")
      .replace("fill={C.green}", "fill={C.paperAccent}")
      .replace('stroke="#DED6C5"', "stroke={C.paperArtRule}");
    if (!updated.includes("useAppTheme()") || !updated.includes("C.paperArtRule")) throw Error("paper_theme_patch_failed");
    edits.push({ at: node.getStart(parsed), end: node.end, text: updated });
    continue;
  }
  const body = node.body.getText(parsed);
  const styles = /\bstyles\./.test(body), colors = /\bC\./.test(body);
  if (styles || colors) edits.push({ at: node.body.getStart(parsed) + 1,
    text: "\n" + (colors ? "  const { colors: C } = useAppTheme();\n" : "") + (styles ? "  const styles = useThemedStyles(createStyles);\n" : "") });
}
for (const edit of edits.sort((a, b) => b.at - a.at)) ritual = ritual.slice(0, edit.at) + edit.text + ritual.slice(edit.end ?? edit.at);
ritual = ritual.replace('import { C } from "../ui/theme";', 'import { C, type Colors } from "../ui/theme";\nimport { useAppTheme, useThemedStyles } from "../ui/ThemeProvider";')
  .replace("const styles = StyleSheet.create({", "const createStyles = (C: Colors) => StyleSheet.create({");
if (ritual.includes("envelopeGeometry") || ritual.includes("envelope-flap-art")) throw Error("unverified_geometry");
const sources = files.map((file) => {
  const bytes = file === ritualFile ? Buffer.from(ritual) : readFileSync(join(root, file));
  const path = join(target, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
  return { file, sha256: hash(bytes) };
});
const manifest = { revision, baseImage: "yishu-cloud-preview:preview-20261008-letter-paper-preview-r4",
  baseImageId: "sha256:416818d2c77b7ecd7f99490e1aaa810257928c84bde61f67393c07b10b749daa", liveRitualHash, sources };
writeFileSync(join(target, "e2ee-image-patch.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ target, fileCount: files.length + 1, revision }));
