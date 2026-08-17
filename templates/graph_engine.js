// Shared routing-graph construction logic, used two ways:
//   - in the browser (templates/js_template.js), loaded via a <script> tag,
//     for click-time start/end node wiring
//   - in Node (scripts/build_paddle_edges.js), via require(), to precompute
//     the fixed portage/river/lake-vertex paddle-edge graph at build time
//     instead of paying for it in every visitor's browser on every page load
//
// This file must stay the single source of truth for this logic. The two
// call sites need to compute byte-identical results (same Turf version, same
// code) or routes that exist under one and not the other reappear - see the
// reverted-optimization history in docs/graph_map_design.md for why that's
// not a hypothetical risk here.
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.GraphEngine = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {

    const ROD_TO_METERS = 5.0292;

    // Portage endpoints are only guaranteed to be within ~25m of their matched
    // lake (portageCreator.py's own "confident match" threshold), not strictly
    // inside its polygon - buffer by that same tolerance before doing
    // containment/line-of-sight checks, or every off-polygon endpoint would be
    // stranded with zero paddle edges. Simplify first so the buffer (which
    // adds rounding vertices at every corner) stays cheap on large/complex
    // lake polygons, and cache both the buffered polygon AND its boundary-as-
    // a-line - line-of-sight gets called many times per lake once vertex
    // waypoints are involved, and re-deriving the boundary from scratch each
    // call (instead of caching it) is what made the first version of this
    // freeze the page on anything but the smallest lakes.
    const LAKE_MATCH_BUFFER_METERS = 25;
    const MAX_LAKE_VERTICES = 24;
    const SIMPLIFY_TOLERANCE_DEG = 0.00015; // ~15m at BWCA's latitude

    function createGraphEngine(turf, lakes) {
        const lakesById = new Map(lakes.features.map((f) => [f.properties.fw_id, f]));
        const nodes = new Map(); // nodeId -> { lakeId, coord: [lon, lat] }
        const adjacency = new Map(); // nodeId -> [{ to, weight, kind, geometry }]
        const accessPointsByLake = new Map(); // lakeId -> [nodeId, ...]

        const simplifiedLakeCache = new Map();
        function simplifiedLake(lakeId) {
            if (!simplifiedLakeCache.has(lakeId)) {
                const feature = lakesById.get(lakeId);
                let simplified = null;
                if (feature) {
                    try {
                        simplified = turf.simplify(feature, { tolerance: SIMPLIFY_TOLERANCE_DEG, highQuality: false });
                    } catch {
                        simplified = feature;
                    }
                }
                simplifiedLakeCache.set(lakeId, simplified);
            }
            return simplifiedLakeCache.get(lakeId);
        }

        const preparedLakeCache = new Map(); // lakeId -> { polygon, boundary } | null
        function preparedLake(lakeId) {
            if (!preparedLakeCache.has(lakeId)) {
                const simplified = simplifiedLake(lakeId);
                if (!simplified) {
                    preparedLakeCache.set(lakeId, null);
                } else {
                    const polygon = turf.buffer(simplified, LAKE_MATCH_BUFFER_METERS / 1000, { units: "kilometers" });
                    preparedLakeCache.set(lakeId, { polygon, boundary: turf.polygonToLine(polygon) });
                }
            }
            return preparedLakeCache.get(lakeId);
        }

        function lineStaysInLake(coordA, coordB, lakeId) {
            const prepared = preparedLake(lakeId);
            if (!prepared) return false;
            if (!turf.booleanPointInPolygon(coordA, prepared.polygon)) return false;
            if (!turf.booleanPointInPolygon(coordB, prepared.polygon)) return false;
            const line = turf.lineString([coordA, coordB]);
            return turf.lineIntersect(line, prepared.boundary).features.length === 0;
        }

        // A straight chord between two shore points only works for convex lakes -
        // any point/peninsula between them blocks it even with open water all
        // around. This is a real visibility graph, not just the chord shortcut:
        // once a lake has 2+ access points, add its own (simplified) boundary
        // vertices as extra waypoint nodes, wired in the same line-of-sight way,
        // so Dijkstra can hop shore-to-shore around a peninsula instead of
        // requiring one unobstructed line. Built lazily per lake (only lakes that
        // end up with 2+ access points need it) and cached.
        //
        // NOTE: an earlier version of this file (during the pass that added
        // rivers) tried two "optimizations" here - a boundary-vertex ring instead
        // of a full mesh, and simplifying the buffered polygon's boundary line at
        // a coarser tolerance - to keep load time down now that rivers roughly
        // double how many lakes need a vertex graph (~440 -> ~930). Both were
        // reverted after route-parity testing (a Node harness replaying this
        // exact algorithm against the real GeoJSON, not just eyeballing the map)
        // caught two distinct correctness bugs, not one:
        //   - the coarser boundary tolerance: Douglas-Peucker simplification
        //     isn't guaranteed to preserve topology, so a "coarser but still
        //     basically the same shoreline" boundary can flip a chord from clear
        //     to blocked (or vice versa).
        //   - the vertex-ring/skeleton cap on its own, with full simplification
        //     tolerance removed: capping a high-access-point lake (e.g. 143
        //     access points) down to a small fixed set of skeleton vertices can
        //     leave some access points with no clear chord to any surviving
        //     vertex, silently dropping a real single-portage connection even
        //     with no simplification involved at all.
        // Both were confirmed independently via isolated harness runs (removing
        // just the tolerance pass, then testing just the cap alone) - neither
        // optimization was safe on its own.
        //
        // The actual fix for the load-time cost this comment used to describe as
        // "unresolved" is architectural, not algorithmic: this exact algorithm,
        // unmodified, now also runs once at build time (scripts/build_paddle_edges.js)
        // over every portage/river endpoint, and the browser loads the resulting
        // edge set instead of recomputing it from scratch on every page load. See
        // the "Paddle-edge precomputation" section of docs/graph_map_design.md.
        // Click-time start/end wiring still runs this code live in the browser -
        // that was never the expensive part (O(k) against one lake's existing
        // access points, not O(k^2) across ~930 lakes).
        const vertexGraphBuilt = new Set();

        function lakeBoundaryPoints(lakeId) {
            const simplified = simplifiedLake(lakeId);
            if (!simplified) return [];
            const rings = simplified.geometry.type === "Polygon"
                ? simplified.geometry.coordinates
                : simplified.geometry.coordinates.flat();

            let points = rings.flatMap((ring) => ring.slice(0, -1));
            if (points.length > MAX_LAKE_VERTICES) {
                const step = Math.ceil(points.length / MAX_LAKE_VERTICES);
                points = points.filter((_, i) => i % step === 0);
            }
            return points;
        }

        function buildLakeVertexGraph(lakeId) {
            if (vertexGraphBuilt.has(lakeId)) return;
            vertexGraphBuilt.add(lakeId);
            lakeBoundaryPoints(lakeId).forEach((coord, i) => {
                addNode(`vertex:${lakeId}:${i}`, lakeId, coord);
            });
        }

        function wirePaddleEdges(nodeId, lakeId, coord) {
            if (!lakesById.get(lakeId)) return;
            const accessPoints = accessPointsByLake.get(lakeId) || [];
            if (accessPoints.length >= 1 && !vertexGraphBuilt.has(lakeId)) {
                buildLakeVertexGraph(lakeId);
            }
            for (const otherId of accessPoints) {
                const otherCoord = nodes.get(otherId).coord;
                if (lineStaysInLake(coord, otherCoord, lakeId)) {
                    const distance = turf.distance(coord, otherCoord, { units: "meters" });
                    addEdge(nodeId, otherId, distance, "paddle", turf.lineString([coord, otherCoord]).geometry);
                }
            }
        }

        function addNode(nodeId, lakeId, coord) {
            if (nodes.has(nodeId)) return;
            nodes.set(nodeId, { lakeId, coord });
            adjacency.set(nodeId, []);
            wirePaddleEdges(nodeId, lakeId, coord);
            if (!accessPointsByLake.has(lakeId)) accessPointsByLake.set(lakeId, []);
            accessPointsByLake.get(lakeId).push(nodeId);
        }

        function removeNode(nodeId) {
            if (!nodes.has(nodeId)) return;
            const node = nodes.get(nodeId);
            for (const edge of adjacency.get(nodeId)) {
                const neighborEdges = adjacency.get(edge.to);
                const idx = neighborEdges.findIndex((e) => e.to === nodeId);
                if (idx !== -1) neighborEdges.splice(idx, 1);
            }
            adjacency.delete(nodeId);
            nodes.delete(nodeId);
            const lakePoints = accessPointsByLake.get(node.lakeId);
            if (lakePoints) {
                const idx = lakePoints.indexOf(nodeId);
                if (idx !== -1) lakePoints.splice(idx, 1);
            }
        }

        function addEdge(a, b, weight, kind, geometry) {
            adjacency.get(a).push({ to: b, weight, kind, geometry });
            adjacency.get(b).push({ to: a, weight, kind, geometry });
        }

        return {
            lakesById,
            nodes,
            adjacency,
            accessPointsByLake,
            vertexGraphBuilt,
            simplifiedLake,
            preparedLake,
            lineStaysInLake,
            lakeBoundaryPoints,
            buildLakeVertexGraph,
            wirePaddleEdges,
            addNode,
            removeNode,
            addEdge,
        };
    }

    // Wire format for the build-time-precomputed fixed graph (portage
    // endpoints, routable river endpoints, lake boundary vertices) - see
    // scripts/build_paddle_edges.js. Kept here, alongside the engine it
    // describes, as the one place both the Node producer and the browser
    // consumer read the shape from.
    function dumpPrecomputed(engine) {
        const nodes = [...engine.nodes.entries()].map(([id, n]) => [id, n.lakeId, n.coord]);

        // Each addEdge() call pushes the same {to, weight, kind, geometry}
        // object under both endpoints' adjacency lists, so every edge shows up
        // twice here (once as a->b, once as b->a) - keep only the a < edge.to
        // direction so each gets dumped once. If a lake legitimately carries
        // both a paddle edge and a river edge between the same two nodes (two
        // separate addEdge calls), each is its own pair of symmetric entries,
        // so this filter keeps one copy of each independently - it doesn't
        // need to (and doesn't) distinguish or deduplicate between them.
        const edges = [];
        for (const [a, edgeList] of engine.adjacency.entries()) {
            for (const edge of edgeList) {
                if (a < edge.to) {
                    edges.push([a, edge.to, edge.weight, edge.kind, edge.geometry]);
                }
            }
        }

        return { nodes, edges, vertexGraphLakes: [...engine.vertexGraphBuilt] };
    }

    // Loads a dumpPrecomputed() payload directly into an engine's state - no
    // addNode/wirePaddleEdges calls, since the whole point is to skip redoing
    // that (expensive) work at load time. Safe to call before any click-time
    // addNode calls: those still run wirePaddleEdges live, and correctly see
    // these nodes/vertexGraphBuilt entries as already present.
    function loadPrecomputed(engine, data) {
        for (const [id, lakeId, coord] of data.nodes) {
            engine.nodes.set(id, { lakeId, coord });
            engine.adjacency.set(id, []);
            if (!engine.accessPointsByLake.has(lakeId)) engine.accessPointsByLake.set(lakeId, []);
            engine.accessPointsByLake.get(lakeId).push(id);
        }
        for (const [a, b, weight, kind, geometry] of data.edges) {
            engine.addEdge(a, b, weight, kind, geometry);
        }
        for (const lakeId of data.vertexGraphLakes) {
            engine.vertexGraphBuilt.add(lakeId);
        }
    }

    return { createGraphEngine, ROD_TO_METERS, dumpPrecomputed, loadPrecomputed };
});
