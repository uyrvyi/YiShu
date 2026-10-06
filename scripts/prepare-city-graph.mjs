import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildGraph, haversineKm, validateGraph } from "../packages/routing/dist/index.js";

const require = createRequire(import.meta.url);
const { projectLngLat } = require("../data/map_projection.cjs");
const { analyzeGraph } = require("../data/validate_graph.cjs");
const root = new URL("../", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expected = {
  "station_nodes.json": "64be6aa1348efebbabeaf6640f6dcde46eadb547416b1c3d592993bbf8041ca3",
  "route_edges.json": "c58306c6a16c893df63288b188b6d88e1ca9cc36278b2efe6f85ab7820bef50c",
  "region_station_map.json": "bb196ce39f18be922333af5d416ddc495d7e57b00fbe44013afebc0a333ec384",
};

export function prepareGraph(baseNodes, baseEdges, baseMap, evidence) {
  assert.equal(evidence.releaseApproval, "pending");
  assert.equal(evidence.summary.missingGeometries, 0);
  const used = new Set(evidence.records.filter((r) => r.method !== "new_source_city_station").map((r) => r.nodeId));
  const retired = baseNodes.filter((n) => !used.has(n.id));
  assert.deepEqual(retired.map((n) => n.id), ["laizhou"], "unreviewed_old_station_retirement");
  const nodes = baseNodes.filter((n) => used.has(n.id)).map((n) => ({ ...n }));
  const cities = {};
  const changes = [];
  const changed = new Set();
  for (const record of evidence.records) {
    assert.ok(record.sourceEvidence, "unverified_city_geometry");
    assert.ok(!Object.hasOwn(cities, record.city), "duplicate_business_city");
    const existing = nodes.find((n) => n.id === record.nodeId);
    const [lng, lat] = record.sourceEvidence.point;
    assert.ok(Number.isFinite(lat) && Number.isFinite(lng));
    if (existing && record.existingPointInsideSourceCity === false) {
      assert.ok(["datong", "qitaihe"].includes(existing.id), "unreviewed_old_coordinate_change");
      const before = { ...existing };
      const [mapX, mapY] = projectLngLat(lng, lat);
      Object.assign(existing, { lat, lng, mapX, mapY });
      changes.push({ method: "coordinate_corrected_from_city_source", nodeId: existing.id,
        before, after: { ...existing }, source: record.sourceEvidence });
      changed.add(existing.id);
    } else if (!existing) {
      assert.equal(record.method, "new_source_city_station");
      const [mapX, mapY] = projectLngLat(lng, lat);
      const node = { id: record.nodeId, name: record.city, province: record.province, city: record.city,
        lat, lng, mapX, mapY };
      nodes.push(node);
      changes.push({ method: record.method, nodeId: node.id, source: record.sourceEvidence });
      changed.add(node.id);
    }
    cities[record.city] = record.nodeId;
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(byId.size, nodes.length);
  const distance = (a, b) => haversineKm(a.lat, a.lng, b.lat, b.lng);
  const edges = baseEdges.filter((e) => byId.has(e.from) && byId.has(e.to)).map((e) => {
    const result = { ...e, allowedTransport: [...e.allowedTransport] };
    if (changed.has(e.from) || changed.has(e.to)) {
      result.distanceKm = Math.round(distance(byId.get(e.from), byId.get(e.to)) * 10) / 10;
    }
    return result;
  });
  const key = (a, b) => [a, b].sort().join("|");
  const seen = new Set(edges.map((e) => key(e.from, e.to)));
  function addEdge(a, b) {
    const id = key(a.id, b.id);
    if (a.id === b.id || seen.has(id)) return;
    const d = distance(a, b);
    if (d > 1600) return;
    const distanceKm = Math.round(d * 10) / 10;
    assert.ok(distanceKm > 0, "coincident_station_candidates");
    edges.push({ from: a.id, to: b.id, distanceKm, enabled: true,
      allowedTransport: ["HAND_CARRY", "HORSE_RELAY", "EXPRESS_RELAY"] });
    seen.add(id);
  }
  for (const node of nodes.filter((n) => changed.has(n.id))) {
    const others = nodes.filter((n) => n.id !== node.id).sort((a, b) =>
      distance(node, a) - distance(node, b) || a.id.localeCompare(b.id));
    for (const neighbour of others.slice(0, 4)) addEdge(node, neighbour);
    for (const neighbour of others.filter((n) => n.province === node.province)) addEdge(node, neighbour);
  }
  const map = { cities, provinces: { ...baseMap.provinces }, provinceFallback: "reject" };
  buildGraph({ nodes, edges }, "china-v3");
  const validation = { ...analyzeGraph(nodes, edges, map), routing: validateGraph({ nodes, edges }) };
  assert.ok(validation.fullyConnected && validation.duplicateCities.length === 0 && validation.badMappings.length === 0,
    "candidate_graph_invalid");
  return { nodes, edges, map, validation, changes, retired };
}

async function main() {
  const base = {};
  for (const [name, digest] of Object.entries(expected)) {
    const bytes = await readFile(new URL(`data/graphs/china-v2/${name}`, root));
    assert.equal(sha256(bytes), digest, `frozen_graph_changed:${name}`);
    base[name] = JSON.parse(bytes);
  }
  const evidenceBytes = await readFile(new URL("data/maps/audit/endpoint-release-20261006/city-stations.json", root));
  const evidence = JSON.parse(evidenceBytes);
  for (const [path, digest] of Object.entries(evidence.inputSha256)) {
    assert.equal(sha256(await readFile(new URL(path, root))), digest, `station_input_changed:${path}`);
  }
  const result = prepareGraph(base["station_nodes.json"], base["route_edges.json"], base["region_station_map.json"], evidence);
  const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
  const output = outputArg ? new URL(outputArg.slice(9).replace(/\/?$/, "/"), root) : new URL("data/graphs/china-v3/", root);
  await mkdir(output, { recursive: true });
  const hashes = {};
  for (const [name, content] of Object.entries({ "station_nodes.json": result.nodes,
    "route_edges.json": result.edges, "region_station_map.json": result.map })) {
    const bytes = Buffer.from(JSON.stringify(content, null, 2) + "\n");
    await writeFile(new URL(name, output), bytes);
    hashes[name] = sha256(bytes);
  }
  const manifest = { version: "china-v3", status: "candidate", baseSha256: expected,
    stationEvidenceSha256: sha256(evidenceBytes), outputSha256: hashes,
    cityCount: evidence.cityCount, validation: result.validation, changes: result.changes,
    retiredIntermediateStations: result.retired,
    edgeStrategy: "Retain unchanged old edges; recalculate incident distances for two city corrections; extend changed/new nodes with existing K=4 and same-province <=1600 km strategy.",
    releaseApproval: "pending", registered: false, defaultGraphChanged: false };
  await writeFile(new URL("manifest.json", output), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ nodes: result.nodes.length, edges: result.edges.length, cities: evidence.cityCount,
    connected: result.validation.fullyConnected, registered: false, defaultChanged: false }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
