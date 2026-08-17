# Technical Design Document — `graph_map.py`

## 1. High-Level Overview

`graph_map.py` orchestrates two on-disk templates — `templates/html_template.html` and `templates/js_template.js` — plus a third shared logic module, `templates/graph_engine.js`, and has **three** runtime phases that never execute in the same process: a **Python build phase** (runs once, server-side) that serializes the graph to GeoJSON and fills in filename placeholders in the templates; a **Node build phase** (runs once, also server-side, via `scripts/build_paddle_edges.js`) that precomputes the graph's fixed paddle-edge mesh so the browser doesn't have to; and a **browser runtime phase** (client-side) where the routing/rendering logic lives in the generated JS files, which `fetch()` the GeoJSON and precomputed-graph files themselves before doing anything else. Python and Node hand the browser *file references*, not embedded data — routing happens client-side, but the expensive part of *building* the routing graph now happens once at build time instead of once per page load (see §2.3, "Paddle-edge precomputation").

```
┌──────────────────────────── PYTHON BUILD PHASE (runs once, offline) ─────────────────────────────┐
│                                                                                                  │
│  ┌───────────────────┐     ┌──────────────────────┐     ┌─────────────────────────────────────┐  │
│  │  Processed parquet│     │   bwca_graph         │     │  GeoJSON serializers                │  │
│  │  files (lakes,    │────▶│   (build_graph)      │────▶│  lakes_geojson / campsites_geojson  │  │
│  │  campsites,       │     │   Lake/Campsite/     │     │  / portages_geojson / rivers_geojson│  │
│  │  portages, rivers)│     │   Portage/River      │     │  reproject EPSG:26915 → 4326        │  │
│  │  EPSG:26915       │     │   objects, fw_id/    │     │  (lat/lon for Leaflet)              │  │
│  │                   │     │   camp_id keyed      │     │                                     │  │
│  └───────────────────┘     └──────────────────────┘     └───────────────┬─────────────────────┘  │
│                                                                         │                        │
│                                                                         ▼                        │
│                                                        ┌───────────────────────────────────┐     │
│                                                        │  render_map()                     │     │
│                                                        │  html_template.html: substitute   │     │
│                                                        │  __JS_FILENAME__/__ENGINE_FILENAME│     │
│                                                        │  js_template.js: substitute       │     │
│                                                        │  __LAKES_URL__ / __CAMPSITES_URL__│     │
│                                                        │  / __PORTAGES_URL__ / __RIVERS_URL│     │
│                                                        │  / __PADDLE_EDGES_URL__           │     │
│                                                        │  writes lakes/campsites/portages/ │     │
│                                                        │  rivers .json, then calls          │     │
│                                                        │  build_paddle_edges() (below)      │     │
│                                                        └────────────────┬──────────────────┘     │
└──────────────────────────────────────────────────────────────────────┼───────────────────────────┘
                                                                          │ subprocess.run(["node", ...])
┌──────────────────────────── NODE BUILD PHASE (runs once, offline) ────┼───────────────────────────┐
│                                                                        ▼                          │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │  scripts/build_paddle_edges.js                                                              │  │
│  │  - reads the lakes/portages/rivers .json files Python just wrote                           │  │
│  │  - require("../templates/graph_engine.js") - the SAME code the browser runs for click-time  │  │
│  │    wiring, unmodified, via @turf/turf@6 (package.json pins the same major version the       │  │
│  │    browser loads from CDN)                                                                  │  │
│  │  - replays the old portage/river ingestion loop (addNode/addEdge) - this is the expensive   │  │
│  │    O(k^2)-per-lake chord-test work, now paid once here instead of once per page load         │  │
│  │  - GraphEngine.dumpPrecomputed(engine) -> writes bwca_graph_map_paddle_edges.json           │  │
│  └────────────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                                          ▼
                                    maps/bwca_graph_map.html         (HTML shell, <script src=...>)
                                    maps/bwca_graph_map.js           (rendering + click-time routing)
                                    maps/bwca_graph_map_engine.js    (shared graph-construction logic)
                                    maps/bwca_graph_map_lakes.json
                                    maps/bwca_graph_map_campsites.json
                                    maps/bwca_graph_map_portages.json
                                    maps/bwca_graph_map_rivers.json
                                    maps/bwca_graph_map_paddle_edges.json  (precomputed graph)
                                                                          │
                                                                          │ opened in browser
┌─────────────────────────────────────────────────────────────────────┼───────────────────────────┐
│         BROWSER RUNTIME PHASE (fetch()es the 5 JSON files, then renders)                        │
│                                                                          ▼                      │
│  ┌────────────────────┐   ┌───────────────────────┐   ┌─────────────────────────────────────┐   │
│  │  Leaflet Map Core  │   │  Turf.js Geometry     │   │  GraphEngine (graph_engine.js)      │   │
│  │  - tile layer      │◀─▶│  Engine               │◀─▶│  - nodes / adjacency maps           │   │
│  │  - lakesLayer      │   │  - simplify/buffer    │   │  - addNode / removeNode / addEdge   │   │
│  │  - portagesLayer   │   │  - point-in-polygon   │   │  - wirePaddleEdges (chord test -    │   │
│  │  - riversLayer     │   │  - line intersect     │   │    only ever called live for        │   │
│  │  - campsitesLayer  │   │  - distance/nearest-pt│   │    click-time start/end nodes now,  │   │
│  │    (marker cluster)│   │                       │   │    see §2.3)                        │   │
│  │  - legend control  │   │                       │   │  - buildLakeVertexGraph (peninsula  │   │
│  │                    │   │                       │   │    routing via boundary waypoints)  │   │
│  │                    │   │                       │   │  - loadPrecomputed(): bulk-loads    │   │
│  │                    │   │                       │   │    the fetched paddle_edges.json    │   │
│  │                    │   │                       │   │    directly into nodes/adjacency,   │   │
│  │                    │   │                       │   │    no chord tests at load time      │   │
│  └─────────┬──────────┘   └───────────┬───────────┘   └───────────────────┬─────────────────┘   │
│            │ click events             │ used by                           │ produces graph      │
│            ▼                          │                                   ▼                     │
│  ┌────────────────────┐               │                        ┌────────────────────────────┐   │
│  │  UI Controller     │               │                        │  Routing Engine (Dijkstra) │   │
│  │  handleRouteClick  │───────────────┘                        │  dijkstra(start, end)      │   │
│  │  - findLakeAtPoint │────────────────────────────────────────▶  shortest path over        │   │
│  │  - nearestLake     │                                        │  adjacency list            │   │
│  │  - route control panel│◀─────────────────────────────────────  computeAndDrawRoute       │   │
│  │  - clearRoute      │                                        │  (draws result via Leaflet)│   │
│  └────────────────────┘                                        └────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Interaction summary:**
1. `build_graph()` loads the four parquet files into the Python object graph (`bwca_graph`), including `load_rivers()`/`connect_rivers()` — unlike portages, a river's `Lake_a`/`Lake_b` are frequently `None` (most river segments are internal network junctions, not lake mouths), which is expected, not a data error.
2. The four `*_geojson()` functions reproject and serialize that graph into WGS84 GeoJSON (as plain Python dicts, not written yet). `rivers_geojson()` is the first of these with a genuinely nullable numeric property (`fw_id_a`/`fw_id_b`) — it must serialize missing values as `None`/JSON `null`, never a raw pandas `NaN` float, or `JSON.parse` in the browser fails and the whole map (not just rivers) fails to load.
3. `render_map()` substitutes filenames into `templates/html_template.html` (`<script src>` tags for the generated JS and engine files) and `templates/js_template.js` (the five `fetch()` URLs), writes the HTML shell, `graph_engine.js` (copied verbatim, no placeholders), and one standalone `.json` file each for lakes/campsites/portages/rivers, then calls `build_paddle_edges()`, which shells out to `node scripts/build_paddle_edges.js <stem>` to produce the fifth JSON file (`..._paddle_edges.json`) before the Python process's job ends. No graph data is embedded in any template; only filenames are.
4. `scripts/build_paddle_edges.js` (Node, run once at build time — see §2.3) reads the lakes/portages/rivers JSON Python just wrote and replays the exact portage/river ingestion loop using `templates/graph_engine.js` — the same module the browser loads — via `@turf/turf`, producing the full fixed paddle-edge graph (portage endpoints, routable river endpoints, lake boundary vertices, all wired together). This is the O(access-points²)-per-lake work that used to run in every visitor's browser; it now runs once, server-side, at build time instead.
5. The browser loads `bwca_graph_map.html`, which pulls in the Leaflet/Turf CDN scripts, `bwca_graph_map_engine.js`, then `bwca_graph_map.js`. The JS's top-level bootstrap fires five `fetch()` calls via `Promise.all` for the JSON files (including the precomputed paddle-edges); `init(lakes, campsites, portages, rivers, paddleEdges)` only runs once all five have resolved.
6. Inside `init()`, Leaflet renders the four GeoJSON layers directly (lakes as polygons, portages and rivers as styled lines, campsites as clustered markers) — this part is independent of routing. The rivers layer renders all segment types for display, but only ones flagged `routable` (river/lake connectors, not small perennial creeks) become routing edges.
7. Separately, the routing subsystem builds its in-memory graph via `GraphEngine.createGraphEngine()` + `GraphEngine.loadPrecomputed(engine, paddleEdges)` — a cheap bulk load (no Turf calls) of the nodes/edges/vertex-graph state `build_paddle_edges.js` already computed. No client-side ingestion loop over `portages.features`/`rivers.features` runs anymore.
8. User clicks feed the UI Controller, which resolves clicks to lake-relative nodes, calls the engine's live `addNode`/`wirePaddleEdges` to extend the graph for just that click (the one piece of graph construction that still has to happen in the browser, since a clicked point isn't known until the user clicks it), runs Dijkstra, and asks Leaflet to draw the result.

---

## 2. Detailed Pseudocode Spec — `templates/js_template.js` + `templates/graph_engine.js` (client-side routing subsystem + data bootstrap)

Line numbers below are approximate (they drift as the file changes) but anchor each section to roughly the right place. Sections 2.1–2.5 (graph-construction primitives) now live in `templates/graph_engine.js`, a small shared module loaded via its own `<script>` tag before `js_template.js` and also `require()`'d, unmodified, by `scripts/build_paddle_edges.js` at build time — see §2.3. Everything else runs inside `js_template.js`'s `init(lakes, campsites, portages, rivers, paddleEdges)` (~line 6) except the bootstrap loader at the very end, which calls `init()`.

### 2.0 Data bootstrap — fetch loader (~1–4, end of file)

```
LAKES_URL, CAMPSITES_URL, PORTAGES_URL, RIVERS_URL, PADDLE_EDGES_URL = template placeholders
    __LAKES_URL__ / __CAMPSITES_URL__ / __PORTAGES_URL__ / __RIVERS_URL__ / __PADDLE_EDGES_URL__
# filled in by render_map() with the actual *_lakes.json / *_campsites.json /
# *_portages.json / *_rivers.json / *_paddle_edges.json filenames

Promise.all([fetch(LAKES_URL), fetch(CAMPSITES_URL), fetch(PORTAGES_URL), fetch(RIVERS_URL), fetch(PADDLE_EDGES_URL)].map(r => r.json()))
    .then(([lakes, campsites, portages, rivers, paddleEdges]) => init(lakes, campsites, portages, rivers, paddleEdges))
    .catch(err => show "Failed to load map data" in #map, log err)
# the graph data only exists on disk as sibling .json files and is pulled in
# over the network (same-origin static fetch) at load time, not embedded.
# paddleEdges is the build-time-precomputed fixed graph (§2.3) - the browser
# no longer computes it itself.
```

### 2.1 Constants & shared state (`templates/graph_engine.js`, factory-scoped)

```
ROD_TO_METERS = 5.0292               # unit conversion for portage lengths - exported from
                                      # graph_engine.js so js_template.js's route-stats display
                                      # (§2.9) can reuse the same constant
LAKE_MATCH_BUFFER_METERS = 25        # portageCreator.py/riverCreator.py's own "confident match" tolerance
MAX_LAKE_VERTICES = 24               # cap on boundary waypoints per lake, for perf
SIMPLIFY_TOLERANCE_DEG = 0.00015     # ~15m simplification tolerance at BWCA latitude

# createGraphEngine(turf, lakes) returns a fresh instance of all of the
# following, closed over one lakes FeatureCollection - both js_template.js
# (browser) and scripts/build_paddle_edges.js (Node) call this, so there is
# exactly one implementation of this state shape and the functions that
# mutate it.
lakesById            : Map<fw_id, GeoJSON Feature>        # built once from lakes.features
nodes                : Map<nodeId, { lakeId, coord }>     # all routing graph nodes
adjacency            : Map<nodeId, [{to, weight, kind, geometry}]>  # undirected edge lists
accessPointsByLake   : Map<lakeId, [nodeId, ...]>          # which nodes currently sit on each lake

simplifiedLakeCache  : Map<lakeId, simplifiedFeature | null>
preparedLakeCache    : Map<lakeId, {polygon, boundary} | null>
vertexGraphBuilt     : Set<lakeId>                         # lakes whose boundary waypoints exist
```

### 2.2 Edge primitive (`graph_engine.js`)

```
function addEdge(a, b, weight, kind, geometry):
    adjacency[a].push({to: b, weight, kind, geometry})
    adjacency[b].push({to: a, weight, kind, geometry})   # graph is undirected
```

### 2.3 Lake geometry preparation, cached (`graph_engine.js`)

```
function simplifiedLake(lakeId):
    if lakeId not in simplifiedLakeCache:
        feature = lakesById.get(lakeId)
        if feature exists:
            try: simplified = turf.simplify(feature, tolerance=SIMPLIFY_TOLERANCE_DEG, highQuality=false)
            except: simplified = feature   # fall back to raw geometry if simplify fails
        else:
            simplified = null
        simplifiedLakeCache[lakeId] = simplified
    return simplifiedLakeCache[lakeId]

function preparedLake(lakeId):
    # Buffers the simplified lake so off-polygon portage/river endpoints
    # (within the 25m match tolerance) still count as "inside" the lake.
    if lakeId not in preparedLakeCache:
        simplified = simplifiedLake(lakeId)
        if simplified is null:
            preparedLakeCache[lakeId] = null
        else:
            polygon  = turf.buffer(simplified, LAKE_MATCH_BUFFER_METERS/1000, units="kilometers")
            boundary = turf.polygonToLine(polygon)
            preparedLakeCache[lakeId] = {polygon, boundary}
    return preparedLakeCache[lakeId]

function lineStaysInLake(coordA, coordB, lakeId):
    # "Chord visibility" test: true iff a straight line between A and B
    # is a valid paddle route across this lake.
    prepared = preparedLake(lakeId)
    if prepared is null: return false
    if coordA not inside prepared.polygon: return false
    if coordB not inside prepared.polygon: return false
    line = turf.lineString([coordA, coordB])
    return turf.lineIntersect(line, prepared.boundary).features.length == 0
    # i.e. the chord touches the shoreline nowhere -> stays on open water
```

**Paddle-edge precomputation (fixed):** adding rivers roughly doubled how many lakes ever build a
vertex graph at all (~440 with portages alone → ~930 once routable river mouths are counted, since
a lake's first river connector is now often its 2nd overall access point), and a handful of very
complex lakes (e.g. the highest-count lake in the dataset has 143 access points once portages and
rivers are combined) turned `wirePaddleEdges`'s full pairwise mesh into real, measurable page-load
cost — a Node harness replaying this exact algorithm against the real GeoJSON measured load times
ranging from the low tens of seconds to (in one run) close to a minute, and the actual browser was
consistently slower still, once taking ~9.5 minutes to finish loading a comparable graph.

Two algorithmic optimizations were tried first and **reverted** during the pass that added rivers:
1. Wiring new boundary-vertex/access-point pairs against a bounded skeleton instead of a full
   mesh once a lake passes `MAX_LAKE_VERTICES` access points.
2. Simplifying the buffered boundary *line* (used only for the `lineIntersect` chord-blocking
   test) at a coarser tolerance than the polygon used for containment.

Both measurably fixed the load-time problem, but a correctness check — replaying known-working
portage-only routes through the exact same algorithm against real data, not just eyeballing the
map — showed both silently broke previously-findable routes, including a direct single-portage
connection through the dataset's highest-access-point lake, and isolating each optimization
individually (removing the tolerance pass but keeping the skeleton cap, and vice versa) showed they
failed for two distinct reasons, not one:
- The coarser boundary tolerance (#2): Douglas-Peucker simplification isn't guaranteed to preserve
  topology, so a "coarser but basically the same shoreline" boundary can flip a chord from clear to
  blocked (or vice versa) for reasons that don't show up in a quick visual check.
- The skeleton cap on its own (#1), with no simplification involved at all: capping a
  high-access-point lake down to a small bounded set of skeleton vertices can leave some access
  points with no clear chord to any surviving vertex, silently dropping a real connection — this
  broke the same highest-access-point-lake portage even with full-precision boundary geometry.

Both were reverted rather than shipped, since a slow page that gives correct answers beats a fast
one that silently reports "no route found" for a route that actually exists.

**The actual fix was architectural, not algorithmic**, and came from asking a different question:
why does this expensive, purely-deterministic computation (nothing here depends on which lakes the
*user* clicks — only on the portage/river/lake data itself) run fresh in every visitor's browser on
every page load at all? `wirePaddleEdges` is called from `addNode`, and `addNode` is also called
live at click time (for the `"start"`/`"end"` route markers, via `handleRouteClick` — see §2.10 —
and torn down again via `removeNode` in `clearRoute`), so the graph-construction code can't simply
be deleted; but the *load-time ingestion loop* over `portages.features`/`rivers.features` (§2.6) is
fully static and can be precomputed once, offline:

- The graph-construction functions (`addNode`/`removeNode`/`addEdge`/`wirePaddleEdges`/
  `buildLakeVertexGraph`/`lineStaysInLake`/`preparedLake`/`simplifiedLake`/`lakeBoundaryPoints`,
  §§2.1–2.5) were extracted **verbatim** (mechanically diffed against the pre-extraction source to
  confirm zero logic changed) into a new shared module, `templates/graph_engine.js`, wrapped in a
  `createGraphEngine(turf, lakes)` factory so any caller can get a fresh, isolated graph instance.
- A new build step, `scripts/build_paddle_edges.js` (Node, invoked by `graph_map.py`'s
  `render_map()` via `subprocess.run(["node", ...])` right after the lakes/portages/rivers JSON
  files are written), `require()`s that same module, loads those same JSON files, and replays the
  *exact* old portage/river ingestion loop against them — same code, same `@turf/turf` major version
  the browser loads from CDN (`package.json` pins `^6.5.0`) — producing the complete fixed paddle-
  edge graph (portage endpoints, routable river endpoints, lake boundary vertices, and every paddle
  edge between them) once, server-side, at build time.
- `GraphEngine.dumpPrecomputed(engine)` serializes that graph's `nodes`/`adjacency`/
  `vertexGraphBuilt` state to `bwca_graph_map_paddle_edges.json`. Each `addEdge` call stores the same
  edge under both endpoints' adjacency lists (that's what keeps the graph undirected), so an `a <
  edge.to` filter keeps exactly one of those two symmetric copies per edge — including, correctly,
  a parallel paddle edge and river edge between the same two nodes (a legitimate pair the underlying
  algorithm can produce), since each is its own independent `addEdge` call with its own pair of
  symmetric entries and the filter doesn't need to distinguish between them to keep one of each.
- The browser fetches that JSON alongside the other four and calls
  `GraphEngine.loadPrecomputed(engine, paddleEdges)`, which populates `nodes`/`adjacency`/
  `accessPointsByLake`/`vertexGraphBuilt` directly (plain Map/Set inserts and `addEdge` calls — no
  Turf calls, no chord tests) instead of running the old ingestion loop. Click-time `addNode`/
  `wirePaddleEdges` for the `"start"`/`"end"` markers still runs live, unchanged — that was never
  the expensive part (O(k) against one lake's existing access points, not O(k²) across ~930 lakes).

**Why this is safe when the two algorithmic attempts weren't**: those attempts changed *what gets
computed* (a coarser boundary, a smaller candidate vertex set) hoping the approximation stayed close
enough to correct — and it didn't, twice, for two different reasons. This fix changes *when and
where* the exact same computation happens, not what it computes. Verified three ways before landing
(all three passed, including the highest-access-point-lake case that broke both earlier attempts):
1. **Edge-set identity**: `scripts/build_paddle_edges.js`'s output was diffed against a fresh
   from-scratch run of the old (pre-extraction) ingestion loop over the same GeoJSON — byte-identical
   node set, edge set (as a `(a, b, weight, kind)` multiset, since a lake can legitimately carry a
   parallel paddle and river edge between the same two nodes), and `vertexGraphBuilt` set.
2. **Round-trip + click-path parity**: reloading a dump into a blank engine via `loadPrecomputed`
   reproduces the live engine's full state exactly, and running the same click-time `addNode`
   sequence (including the highest-access-point-lake portage) against both the live engine and the
   reloaded one produces identical Dijkstra results.
3. **Live browser click-path spot check**: fired real map clicks (via `map.fire('click', ...)`) at
   known portage endpoint coordinates, including the highest-access-point-lake case, in an actual
   loaded page — routes resolved correctly, and a long mixed portage+paddle+river route (Perent →
   Isabella) also resolved correctly, confirming the precomputed graph and the live click-time path
   compose correctly end-to-end, not just in isolation.

Measured result: browser load time dropped from ~9.5 minutes (worst case, pre-fix) to ~6 seconds.
Any future change to this shared graph-construction logic should be held to the same bar — an
edge-set diff, not just a route replay or a load-time measurement, since a visual spot-check won't
catch a single blocked or dropped chord in a graph this size.

**What this fix does *not* address — click-time cost on the same pathological lakes is real and
still there.** `loadPrecomputed` only populates `nodes`/`adjacency`/`accessPointsByLake`/
`vertexGraphBuilt` — it does not warm `simplifiedLakeCache`/`preparedLakeCache`, and it can't:
those are lazy-built per lake by `preparedLake` (§2.3) the first time `lineStaysInLake` needs them,
and a click-time `"start"`/`"end"` node still calls `wirePaddleEdges` live against every *existing*
access point on whatever lake was clicked (§2.5) — that part was never precomputed, because the
clicked point isn't known until the user clicks it. For an ordinary lake this is fast (a Trygg Lake
click, ~4 access points, measured 142ms). For the same pathological lakes that motivated this whole
fix, it isn't: a first click on Lac la Croix (fw_id 13 — 143 access points, the largest polygon in
the dataset at 32,087 raw coordinates) measured **~6.8 seconds**, and a *second* click on the same
lake (caches now warm, `vertexGraphBuilt` already true) still measured **~6.1 seconds** — meaning
the one-time `simplify`/`buffer`/`polygonToLine` prep is not the dominant cost; the ~143 repeated
`lineStaysInLake` calls (each a `lineIntersect` against that lake's buffered boundary line) are.
Basswood (fw_id 3731, the second-most-complex polygon) measured ~4.1 seconds similarly.

This is **not a regression introduced by this fix** — the original, pre-precomputation algorithm
paid this exact same O(access-points) click-time cost on these same lakes; it was simply invisible
before, buried inside a ~9.5-minute load that already dwarfed a several-second click. Fixing the
load-time cost made this pre-existing click-time cost newly the most noticeable thing about
interacting with these specific lakes. It's a real, open follow-up — not something to silently
accept as "the page is fast now" — and any fix attempt should hold to the same edge-set-diff/
route-parity bar as above, since this code path is the click-time twin of the exact code that broke
correctness twice already.

### 2.4 Visibility graph — boundary waypoints for non-convex lakes (`graph_engine.js`)

```
function lakeBoundaryPoints(lakeId):
    simplified = simplifiedLake(lakeId)
    if simplified is null: return []
    rings = (Polygon) ? simplified.coordinates
          : (MultiPolygon) ? flatten(simplified.coordinates)
    points = for each ring: all vertices except the closing duplicate
    if points.length > MAX_LAKE_VERTICES:
        step = ceil(points.length / MAX_LAKE_VERTICES)
        points = every step-th point                  # downsample evenly
    return points

function buildLakeVertexGraph(lakeId):
    # Adds the lake's own (simplified, downsampled) shoreline vertices as
    # routable nodes, so Dijkstra can hop around a peninsula that blocks
    # a direct chord. Built once per lake, lazily, on that lake's 2nd
    # access point - each vertex is added via addNode(), so it gets wired
    # (full mesh, see §2.5) against everything already on the lake, and
    # everything added later wires against it too.
    if lakeId in vertexGraphBuilt: return
    vertexGraphBuilt.add(lakeId)
    for i, coord in enumerate(lakeBoundaryPoints(lakeId)):
        addNode(f"vertex:{lakeId}:{i}", lakeId, coord)
```

### 2.5 Paddle-edge wiring & node lifecycle (`graph_engine.js`)

```
function wirePaddleEdges(nodeId, lakeId, coord):
    if lakeId not in lakesById: return
    accessPoints = accessPointsByLake.get(lakeId, [])
    if accessPoints.length >= 1 and lakeId not in vertexGraphBuilt:
        buildLakeVertexGraph(lakeId)     # triggers only once a lake gets its 2nd point
    for otherId in accessPoints:
        otherCoord = nodes[otherId].coord
        if lineStaysInLake(coord, otherCoord, lakeId):
            distance = turf.distance(coord, otherCoord, units="meters")
            addEdge(nodeId, otherId, distance, kind="paddle",
                    geometry=turf.lineString([coord, otherCoord]).geometry)

function addNode(nodeId, lakeId, coord):
    if nodeId already in nodes: return          # idempotent
    nodes[nodeId] = {lakeId, coord}
    adjacency[nodeId] = []
    wirePaddleEdges(nodeId, lakeId, coord)       # connect to existing points on same lake
    accessPointsByLake.setdefault(lakeId, []).push(nodeId)

function removeNode(nodeId):
    if nodeId not in nodes: return
    node = nodes[nodeId]
    for edge in adjacency[nodeId]:
        # remove the reverse-direction edge from each neighbor's list
        neighborEdges = adjacency[edge.to]
        idx = neighborEdges.findIndex(e => e.to == nodeId)
        if idx != -1: neighborEdges.splice(idx, 1)
    delete adjacency[nodeId]
    delete nodes[nodeId]
    lakePoints = accessPointsByLake[node.lakeId]
    if lakePoints: remove nodeId from lakePoints
```

### 2.6 Portage and river ingestion — precomputed at build time, loaded at runtime

The ingestion loop itself is unchanged logic, but it now runs in two different places depending on
which nodes it's ingesting — see §2.3 for why.

**Build time** (`scripts/build_paddle_edges.js`, Node) — runs once, offline:

```
engine = GraphEngine.createGraphEngine(turf, lakes)

for feature in portages.features:
    p = feature.properties
    coords = feature.geometry.coordinates
    nodeA = f"portage:{p.portage_number}:a"
    nodeB = f"portage:{p.portage_number}:b"
    engine.addNode(nodeA, p.fw_id_a, coords[0])          # triggers paddle-wiring on lake A
    engine.addNode(nodeB, p.fw_id_b, coords[-1])         # triggers paddle-wiring on lake B
    engine.addEdge(nodeA, nodeB, p.length_rods * ROD_TO_METERS, kind="portage",
                    geometry=feature.geometry)            # real surveyed line, for rendering

for feature in rivers.features:
    p = feature.properties
    if not p.routable: continue        # display-only types (small perennial creeks) skip routing
    coords = feature.geometry.coordinates
    # node_a/node_b are pre-snapped junction keys computed once in
    # riverCreator.py (endpoint coordinates rounded to ~0.1m) - segments
    # sharing a confluence resolve to the same graph node with no coordinate
    # matching needed here. fw_id_a/fw_id_b are only set on the minority of
    # endpoints that matched a lake within 25m (riverCreator.py restricts
    # this to "Connector (Lake)" segment endpoints specifically, since other
    # segment types are often just incidentally near a lake they don't
    # actually join); addNode's lakeId check already no-ops the paddle-wiring
    # step for a null lakeId, so pure river-junction nodes just sit in the
    # graph as plain edge endpoints.
    engine.addNode(p.node_a, p.fw_id_a, coords[0])
    engine.addNode(p.node_b, p.fw_id_b, coords[-1])
    engine.addEdge(p.node_a, p.node_b, p.length_m, kind="river", geometry=feature.geometry)

write(GraphEngine.dumpPrecomputed(engine), "<stem>_paddle_edges.json")
```

**Load time** (`js_template.js`'s `init()`, browser) — runs once per page load:

```
engine = GraphEngine.createGraphEngine(turf, lakes)
GraphEngine.loadPrecomputed(engine, paddleEdges)   # cheap: Map/Set inserts + addEdge, no Turf calls
```

`loadPrecomputed` populates `nodes`, `adjacency` (via `addEdge`, so it stays symmetric), and
`accessPointsByLake` directly from the dump, and marks every lake in `vertexGraphLakes` as already
built in `vertexGraphBuilt` — so a later click-time `addNode` on one of those lakes correctly skips
rebuilding a vertex graph that already exists, and correctly builds one on demand for a lake that
only had exactly one fixed access point at build time (matching the original algorithm's behavior
exactly either way).

### 2.7 Click → lake resolution helpers (~380–401)

```
function findLakeAtPoint(coord):
    for feature in lakes.features:
        if turf.booleanPointInPolygon(coord, feature): return feature
    return null                                     # click missed every polygon

function nearestLake(coord):
    best = null; bestDist = Infinity; bestCoord = coord
    for feature in lakes.features:
        boundary = turf.polygonToLine(feature)
        nearest  = turf.nearestPointOnLine(boundary, coord, units="meters")
        if nearest.properties.dist < bestDist:
            bestDist, best, bestCoord = nearest.properties.dist, feature, nearest.geometry.coordinates
    return {feature: best, coord: bestCoord, distance: bestDist}
    # used to snap a near-miss click (e.g. clicked the shore, not the water)
```

### 2.8 Shortest path (~403–456)

```
function dijkstra(startNode, endNode):
    dist = {startNode: 0}
    prev = {}
    visited = {}
    queue = [(0, startNode)]                        # simple array-as-priority-queue

    while queue not empty:
        queue.sort by distance ascending
        (d, u) = queue.shift()
        if u in visited: continue
        visited.add(u)
        if u == endNode: break

        for edge in adjacency.get(u, []):
            alt = d + edge.weight
            if alt < dist.get(edge.to, Infinity):
                dist[edge.to] = alt
                prev[edge.to] = u
                queue.push((alt, edge.to))

    if endNode not in dist: return null              # unreachable

    path = [endNode]
    current = endNode
    while current != startNode:
        current = prev[current]
        path.push(current)
    path.reverse()
    return {distance: dist[endNode], path}
```
Complexity note: this is O(E log E)-ish via array sort rather than a real binary heap. The static graph is now considerably larger than "portage nodes + at most two dynamic lake-vertex graphs" (rivers add thousands of pre-connected junction nodes, and ~930 lakes now carry a permanent boundary skeleton, up from ~440 with portages alone) — 22,573 nodes and 137,765 edges as of the current dataset. Each `dijkstra()` call still only traverses whatever the click-time `"start"`/`"end"` nodes connect to, so per-query cost tracks reachable graph size rather than total graph size, and building that larger graph is no longer paid at load time at all — it's precomputed once at build time (§2.3) and loaded as a flat JSON dump, which is fast to parse and insert regardless of graph size.

### 2.9 Route/UI state machine (~458–518)

```
routeLayer = markerStart = markerEnd = null

function setStatus(text):
    set #route-status-text.textContent = text

function clearRoute():
    remove markerStart, markerEnd, routeLayer from map (if present)
    removeNode("start"); removeNode("end")
    reset markerStart/markerEnd/routeLayer to null
    setStatus("Click a point on a lake to start a route.")

function computeAndDrawRoute():
    result = dijkstra("start", "end")
    remove existing routeLayer if present
    if result is null:
        setStatus("No route found - ...")
        return

    segments = for i in [0, len(result.path)-2]:
                   adjacency[path[i]].find(e => e.to == path[i+1])

    routeLayer = L.geoJSON(segments mapped to Features, style:
                    portage -> brown, dashed
                    paddle  -> blue, solid
                    river   -> teal, solid
                 ).addTo(map)

    rods     = sum(s.weight / ROD_TO_METERS for s in segments if s.kind == "portage")
    paddleKm = sum(s.weight for s in segments if s.kind == "paddle") / 1000
    riverKm  = sum(s.weight for s in segments if s.kind == "river") / 1000

    setStatus(f"Route found: {result.distance/1000:.2f} km total "
              f"({rods:.0f} rods of portaging, {paddleKm:.2f} km paddling, "
              f"{riverKm:.2f} km river).")

# Leaflet control: fixed panel with status text + "Clear route" button
routeControl.onAdd -> build div with #route-status-text and #route-clear-btn,
                       disableClickPropagation (so clicking the panel doesn't
                       also fire a map click)
routeControl.addTo(map)
bind click on #route-clear-btn -> clearRoute()
```

### 2.10 Click handling / event wiring (~520–555)

```
function handleRouteClick(latlng):
    if both "start" and "end" nodes already exist: clearRoute()   # start a fresh route

    clickCoord = [latlng.lng, latlng.lat]
    lakeFeature = findLakeAtPoint(clickCoord)
    snappedCoord = clickCoord

    if lakeFeature is null:
        nearest = nearestLake(clickCoord)
        if nearest.feature is null or nearest.distance > 200:
            setStatus("That's too far from any lake - click closer to the water.")
            return
        lakeFeature = nearest.feature
        snappedCoord = nearest.coord                 # snap to shoreline

    role = "end" if "start" node already exists else "start"
    addNode(role, lakeFeature.properties.fw_id, snappedCoord)
    marker = L.marker([snappedCoord[1], snappedCoord[0]], title=role).addTo(map)

    if role == "start":
        markerStart = marker
        setStatus("Click a second point to find a route.")
    else:
        markerEnd = marker
        computeAndDrawRoute()

# Bound to four targets because portagesLayer/campsitesLayer/riversLayer
# intercept clicks for their own popups/tooltips/cluster-zoom before they'd
# bubble to map. Click targets are still lakes-only - a route can now PASS
# THROUGH river segments between start/end, but a route still can't START
# or END on open river water directly; riversLayer is bound here only so a
# click on a river line falls through to nearestLake()'s 200m snap instead
# of being silently swallowed by the layer with no route effect at all.
map.on("click", e -> handleRouteClick(e.latlng))
portagesLayer.on("click", e -> handleRouteClick(e.latlng))
campsitesLayer.on("click", e -> handleRouteClick(e.latlng))
riversLayer.on("click", e -> handleRouteClick(e.latlng))
```

---

### Key design properties worth flagging
- **Lazy, cached geometry prep**: `simplifiedLake`/`preparedLake` memoize per-lake Turf operations; this was explicitly called out in the comments as fixing a page-freeze bug on large lakes, and again when rivers reintroduced a much bigger version of the same problem — now fixed by precomputing at build time rather than caching harder at load time (see §2.3/§2.4).
- **Visibility graph is approximate, not exact**: paddle edges are chord tests against a buffered polygon (and, past a per-lake access-point cap, against a bounded boundary skeleton rather than every other point), not a true shortest-path-in-polygon solve — a blocked chord silently yields *no* edge rather than a routed-around one.
- **Routing is undirected, including river edges**: a river segment can be traversed either direction at the same cost — upstream-vs-downstream travel time/current is not modeled. This is the same class of accepted approximation as the paddle-chord shortcut, not a bug to chase.
- **Known correctness caveat carried from the data pipeline**: `fw_id = 88888` collisions (documented in CLAUDE.md) mean `lakesById` silently keeps only the last-loaded lake for that id, so routing near those lakes can attach to the wrong polygon. The same class of issue applies to rivers: ~71% of lake rows have a null `fw_id` and can never be a river's matched endpoint, and a stream that exits/re-enters the BWCA boundary clip becomes two disconnected pieces with dangling nodes at the clip line.
- **Graph mutation is transient and query-scoped**: `"start"`/`"end"` nodes are added/removed per click cycle via the live `GraphEngine` instance's `addNode`/`removeNode`, while portage and routable-river nodes/edges are permanent and loaded once at init from the build-time precomputed dump (§2.3/§2.6), not recomputed.
- **Data is now fetched, not embedded**: `render_map()` doesn't inline the GeoJSON blobs as JS literals — it writes them as sibling `.json` files (five now, including the precomputed paddle-edge graph) and the generated JS `fetch()`es them before `init()` runs. This makes the eight output files in `maps/` interdependent (the `.html` needs its two `.js` files, which need their five `.json` siblings) rather than one self-contained artifact — moving or renaming any of them without updating the others' filename placeholders breaks the page.
- **Nullable numeric properties need explicit `None`, not raw `NaN`**: `rivers_geojson()` was the first serializer in this pipeline with a genuinely nullable numeric field (`fw_id_a`/`fw_id_b` — most river segments don't touch a lake at either end). Building the properties list with a raw pandas float lets `NaN` slip into the GeoDataFrame; going through `gdf.to_crs(4326).to_json()` (as all four `*_geojson()` functions do) converts that to a valid JSON `null` automatically — bypassing that and hand-rolling `json.dumps()` on the raw values would emit a literal `NaN` token, which isn't valid JSON and breaks `JSON.parse()` for the whole map, not just rivers.
- **The rivers-driven load-time perf regression is fixed for load time specifically, via build-time precomputation, not a smarter approximation** — but a related click-time cost on the same pathological lakes is not, and is still open (see §2.3, "Paddle-edge precomputation" and the "What this fix does not address" note directly below it). The graph-construction logic that used to run per page load was extracted verbatim into `templates/graph_engine.js`, shared with a new Node build step (`scripts/build_paddle_edges.js`) that runs it once, offline. This is a different kind of fix than the two earlier attempts (a boundary-vertex ring; a coarser-tolerance boundary line), both of which changed the geometry approximation and were reverted after route-parity testing caught silent breakage — this fix changes *when* the exact same computation runs, not *what* it computes, verified via an edge-set diff (not just a route replay) plus a live browser click-path check. Browser load time dropped from a worst-case ~9.5 minutes to ~6 seconds. The first click on the highest-access-point/most-complex lake (Lac la Croix, fw_id 13) still takes ~6-7 seconds, though — that's the same O(access-points) click-time wiring cost the original algorithm always paid on this lake, just newly noticeable now that it's no longer hidden inside a multi-minute load. Any future change to the shared graph-construction logic in `graph_engine.js` should be held to the same edge-set-diff bar, since a visual spot-check won't catch a single blocked or dropped chord in a graph this size.
