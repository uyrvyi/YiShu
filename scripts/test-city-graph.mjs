import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildGraph, findShortestPath, planPigeonRoute } from "../packages/routing/dist/index.js";
import { prepareGraph } from "./prepare-city-graph.mjs";

const root = new URL("../", import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root)));
const nodes = await json("data/graphs/china-v2/station_nodes.json");
const edges = await json("data/graphs/china-v2/route_edges.json");
const map = await json("data/graphs/china-v2/region_station_map.json");
const evidence = await json("data/maps/audit/endpoint-release-20261006/city-stations.json");
const before = JSON.stringify({ nodes, edges, map, evidence });
const prepared = prepareGraph(nodes, edges, map, evidence);

test("all 370 canonical city identities have their own local station, never a province fallback", () => {
  assert.equal(Object.keys(prepared.map.cities).length, 370);
  assert.equal(prepared.nodes.length, 370);
  assert.equal(prepared.map.provinceFallback, "reject");
  for (const record of evidence.records) {
    const id = prepared.map.cities[record.city];
    const node = prepared.nodes.find((n) => n.id === id);
    assert.equal(node.province, record.province);
    assert.equal(id, record.nodeId);
  }
  assert.notEqual(prepared.map.cities.草湖市, prepared.map.provinces.新疆维吾尔自治区);
  assert.notEqual(prepared.map.cities.滁州市, prepared.map.provinces.安徽省);
});

test("old graph inputs are immutable and only two declared old coordinates change in the new graph", () => {
  assert.equal(JSON.stringify({ nodes, edges, map, evidence }), before);
  for (const node of nodes.filter((n) => !["datong", "qitaihe", "laizhou"].includes(n.id))) {
    assert.deepEqual(prepared.nodes.find((n) => n.id === node.id), node);
  }
  assert.deepEqual(prepared.retired.map((n) => n.id), ["laizhou"]);
  assert.equal(prepared.changes.filter((c) => c.method === "coordinate_corrected_from_city_source").length, 2);
  assert.equal(prepared.changes.filter((c) => c.method === "new_source_city_station").length, 77);
  assert.equal(prepared.validation.fullyConnected, true);
});

test("new graph routes all city stations for all four delivery modes", () => {
  const graph = buildGraph({ nodes: prepared.nodes, edges: prepared.edges }, "china-v3");
  let routes = 0;
  for (const node of prepared.nodes) {
    for (const transport of ["HAND_CARRY", "HORSE_RELAY", "EXPRESS_RELAY"]) {
      const route = findShortestPath(graph, node.id, "shanghai", transport);
      assert.equal(route.found, true);
      assert.equal(route.nodes[0], node.id);
      assert.equal(route.nodes.at(-1), "shanghai");
      routes++;
    }
    assert.equal(planPigeonRoute(graph, node.id, "shanghai").found, true);
    routes++;
  }
  assert.equal(routes, 1480);
});

test("new graph generation is deterministic and rejects unexpected old coordinate corrections", () => {
  assert.deepEqual(prepareGraph(nodes, edges, map, evidence), prepared);
  const changed = structuredClone(evidence);
  const city = changed.records.find((r) => r.nodeId === "shanghai");
  city.existingPointInsideSourceCity = false;
  assert.throws(() => prepareGraph(nodes, edges, map, changed), /unreviewed_old_coordinate_change/);
});

test("new graph stays unregistered and production default remains unchanged", async () => {
  const registry = await json("data/graphs/registry.json");
  assert.equal(registry.defaultVersion, "china-v2");
  assert.ok(!registry.versions.includes("china-v3"));
});

test("stored candidate runtime graph assets exactly match the source-bound preparation", async () => {
  assert.deepEqual(await json("data/graphs/china-v3/station_nodes.json"), prepared.nodes);
  assert.deepEqual(await json("data/graphs/china-v3/route_edges.json"), prepared.edges);
  assert.deepEqual(await json("data/graphs/china-v3/region_station_map.json"), prepared.map);
});
