# Technical Design Document — `graph_map.py`

## 1. High-Level Overview

`graph_map.py` orchestrates two on-disk templates — `templates/html_template.html` and `templates/js_template.js` — and has two runtime phases that never execute in the same process: a **Python build phase** (runs once, server-side) that fills in filename placeholders in those templates and separately serializes the graph to three standalone GeoJSON files, and a **browser runtime phase** (runs client-side, in the user's browser) where the actual routing logic lives in the generated JS file, which `fetch()`es those GeoJSON files itself before doing anything else. Python hands the browser *file references*, not data — it does no routing itself, and (since the move to `fetch()`-loaded JSON) no longer embeds the graph data inline in the page either.

```
┌──────────────────────────── PYTHON BUILD PHASE (runs once, offline) ─────────────────────────────┐
│                                                                                                  │
│  ┌───────────────────┐     ┌──────────────────────┐     ┌─────────────────────────────────────┐  │
│  │  Processed parquet│     │   bwca_graph         │     │  GeoJSON serializers                │  │
│  │  files (lakes,    │────▶│   (build_graph)      │────▶│  lakes_geojson / campsites_geojson  │  │
│  │  campsites,       │     │   Lake/Campsite/     │     │  / portages_geojson                 │  │
│  │  portages)        │     │   Portage objects,   │     │  reproject EPSG:26915 → 4326        │  │
│  │  EPSG:26915       │     │   fw_id/camp_id keyed│     │  (lat/lon for Leaflet)              │  │
│  └───────────────────┘     └──────────────────────┘     └───────────────┬─────────────────────┘  │
│                                                                         │                        │
│                                                                         ▼                        │
│                                                        ┌───────────────────────────────────┐     │
│                                                        │  render_map()                     │     │
│                                                        │  html_template.html: substitute   │     │
│                                                        │  __JS_FILENAME__                  │     │
│                                                        │  js_template.js: substitute       │     │
│                                                        │  __LAKES_URL__ / __CAMPSITES_URL__│     │
│                                                        │  / __PORTAGES_URL__               │     │
│                                                        └────────────────┬──────────────────┘     │
│                                                                         │ writes 5 files          │
└──────────────────────────────────────────────────────────────────────┼───────────────────────────┘
                                                                          ▼
                                    maps/bwca_graph_map.html        (HTML shell, <script src=...js>)
                                    maps/bwca_graph_map.js          (routing/rendering logic)
                                    maps/bwca_graph_map_lakes.json
                                    maps/bwca_graph_map_campsites.json
                                    maps/bwca_graph_map_portages.json
                                                                          │
                                                                          │ opened in browser
┌─────────────────────────────────────────────────────────────────────┼───────────────────────────┐
│              BROWSER RUNTIME PHASE (fetch()es the 3 GeoJSON files, then renders)               │
│                                                                          ▼                      │
│  ┌────────────────────┐   ┌───────────────────────┐   ┌─────────────────────────────────────┐   │
│  │  Leaflet Map Core  │   │  Turf.js Geometry     │   │  Visibility-Graph Builder           │   │
│  │  - tile layer      │◀─▶│  Engine               │◀─▶│  - nodes / adjacency maps           │   │
│  │  - lakesLayer      │   │  - simplify/buffer    │   │  - addNode / removeNode / addEdge   │   │
│  │  - portagesLayer   │   │  - point-in-polygon   │   │  - wirePaddleEdges (chord test)     │   │
│  │  - campsitesLayer  │   │  - line intersect     │   │  - buildLakeVertexGraph (peninsula  │   │
│  │    (marker cluster)│   │  - distance/nearest-pt│   │    routing via boundary waypoints)  │   │
│  │  - legend control  │   │                       │   │  - portage-edge ingestion loop      │   │
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
1. `build_graph()` loads the three parquet files into the Python object graph (`bwca_graph`).
2. The three `*_geojson()` functions reproject and serialize that graph into WGS84 GeoJSON (as plain Python dicts, not written yet).
3. `render_map()` substitutes filenames into `templates/html_template.html` (the `<script src>` for the generated JS) and `templates/js_template.js` (the three `fetch()` URLs), then writes five files: the HTML shell, the JS, and one standalone `.json` file each for lakes/campsites/portages — the Python process's job ends here. No graph data is embedded in either template; only filenames are.
4. The browser loads `bwca_graph_map.html`, which pulls in the Leaflet/Turf CDN scripts and `bwca_graph_map.js`. The JS's top-level code (lines 422–431) fires three `fetch()` calls via `Promise.all` for the JSON files; `init(lakes, campsites, portages)` only runs once all three have resolved.
5. Inside `init()`, Leaflet renders the three GeoJSON layers directly (lakes as polygons, portages as styled lines, campsites as clustered markers) — this part is independent of routing.
6. Separately, the routing subsystem (lines 87–419 of `templates/js_template.js`) builds its **own** in-memory graph from the same fetched GeoJSON: portages become edges immediately; lake interiors become edges lazily, computed on demand by Turf.js as points are added.
7. User clicks feed the UI Controller, which resolves clicks to lake-relative nodes, extends the graph, runs Dijkstra, and asks Leaflet to draw the result.

---

## 2. Detailed Pseudocode Spec — `templates/js_template.js`, lines 87–431 (client-side routing subsystem + data bootstrap)

All line numbers below refer to `templates/js_template.js` directly (it's now a standalone file, not a string embedded inside `graph_map.py`). Its whole body runs inside `init(lakes, campsites, portages)` (lines 5–420) except the bootstrap loader at the very end (lines 422–431), which calls `init()`.

### 2.0 Data bootstrap — fetch loader (1–3, 422–431)

```
LAKES_URL, CAMPSITES_URL, PORTAGES_URL = template placeholders __LAKES_URL__ / __CAMPSITES_URL__ / __PORTAGES_URL__
# filled in by render_map() with the actual *_lakes.json / *_campsites.json / *_portages.json filenames

Promise.all([fetch(LAKES_URL), fetch(CAMPSITES_URL), fetch(PORTAGES_URL)].map(r => r.json()))
    .then(([lakes, campsites, portages]) => init(lakes, campsites, portages))
    .catch(err => show "Failed to load map data" in #map, log err)
# replaces the old approach of embedding the three GeoJSON blobs as JS literals
# directly in the page; the graph data now only exists on disk as sibling .json
# files and is pulled in over the network (same-origin static fetch) at load time
```

### 2.1 Constants & shared state (1–3, 98–103, 121–123)

```
ROD_TO_METERS = 5.0292          # unit conversion for portage lengths
LAKE_MATCH_BUFFER_METERS = 25   # portageCreator.py's own "confident match" tolerance
MAX_LAKE_VERTICES = 24          # cap on boundary waypoints per lake, for perf
SIMPLIFY_TOLERANCE_DEG = 0.00015  # ~15m simplification tolerance at BWCA latitude

lakesById            : Map<fw_id, GeoJSON Feature>        # built once from lakes.features
nodes                : Map<nodeId, { lakeId, coord }>     # all routing graph nodes
adjacency            : Map<nodeId, [{to, weight, kind, geometry}]>  # undirected edge lists
accessPointsByLake   : Map<lakeId, [nodeId, ...]>          # which nodes currently sit on each lake

simplifiedLakeCache  : Map<lakeId, simplifiedFeature | null>
preparedLakeCache    : Map<lakeId, {polygon, boundary} | null>
vertexGraphBuilt      : Set<lakeId>                         # lakes whose boundary waypoints exist
```

### 2.2 Edge primitive (105–108)

```
function addEdge(a, b, weight, kind, geometry):
    adjacency[a].push({to: b, weight, kind, geometry})
    adjacency[b].push({to: a, weight, kind, geometry})   # graph is undirected
```

### 2.3 Lake geometry preparation, cached (126–163)

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
    # Buffers the simplified lake so off-polygon portage endpoints (within
    # the 25m match tolerance) still count as "inside" the lake.
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

### 2.4 Visibility graph — boundary waypoints for non-convex lakes (175–196)

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
    # a direct chord. Built once per lake, lazily.
    if lakeId in vertexGraphBuilt: return
    vertexGraphBuilt.add(lakeId)
    for i, coord in enumerate(lakeBoundaryPoints(lakeId)):
        addNode(f"vertex:{lakeId}:{i}", lakeId, coord)
```

### 2.5 Paddle-edge wiring & node lifecycle (198–237)

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

### 2.6 Portage ingestion — static edges added once at load (241–249)

```
for feature in portages.features:
    p = feature.properties
    coords = feature.geometry.coordinates
    nodeA = f"portage:{p.portage_number}:a"
    nodeB = f"portage:{p.portage_number}:b"
    addNode(nodeA, p.fw_id_a, coords[0])          # triggers paddle-wiring on lake A
    addNode(nodeB, p.fw_id_b, coords[-1])         # triggers paddle-wiring on lake B
    addEdge(nodeA, nodeB, p.length_rods * ROD_TO_METERS, kind="portage",
            geometry=feature.geometry)             # real surveyed line, for rendering
```

### 2.7 Click → lake resolution helpers (251–272)

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

### 2.8 Shortest path (274–307)

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
Complexity note: this is O(E log E)-ish via array sort rather than a real binary heap — acceptable given the graph only grows to portage nodes + at most two dynamic lake-vertex graphs per query.

### 2.9 Route/UI state machine (309–380)

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
                 ).addTo(map)

    rods     = sum(s.weight / ROD_TO_METERS for s in segments if s.kind == "portage")
    paddleKm = sum(s.weight for s in segments if s.kind == "paddle") / 1000

    setStatus(f"Route found: {result.distance/1000:.2f} km total "
              f"({rods:.0f} rods of portaging, {paddleKm:.2f} km paddling).")

# Leaflet control: fixed panel with status text + "Clear route" button
routeControl.onAdd -> build div with #route-status-text and #route-clear-btn,
                       disableClickPropagation (so clicking the panel doesn't
                       also fire a map click)
routeControl.addTo(map)
bind click on #route-clear-btn -> clearRoute()
```

### 2.10 Click handling / event wiring (385–419)

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

# Bound to three targets because portagesLayer/campsitesLayer intercept
# clicks for their own popups/cluster-zoom before they'd bubble to map:
map.on("click", e -> handleRouteClick(e.latlng))
portagesLayer.on("click", e -> handleRouteClick(e.latlng))
campsitesLayer.on("click", e -> handleRouteClick(e.latlng))
```

---

### Key design properties worth flagging
- **Lazy, cached geometry prep**: `simplifiedLake`/`preparedLake` memoize per-lake Turf operations; this was explicitly called out in the comments as fixing a page-freeze bug on large lakes (lines 110–120).
- **Visibility graph is approximate, not exact**: paddle edges are chord tests against a simplified+buffered polygon, not a true shortest-path-in-polygon solve — a blocked chord silently yields *no* edge rather than a routed-around one (lines 156–163).
- **Known correctness caveat carried from the data pipeline**: `fw_id = 88888` collisions (documented in CLAUDE.md) mean `lakesById` silently keeps only the last-loaded lake for that id, so routing near those lakes can attach to the wrong polygon (lines 95–97).
- **Graph mutation is transient and query-scoped**: `"start"`/`"end"` nodes are added/removed per click cycle via `addNode`/`removeNode`, while portage nodes/edges are permanent, loaded once at lines 241–249.
- **Data is now fetched, not embedded**: since the split into `templates/html_template.html` + `templates/js_template.js`, `render_map()` no longer inlines the three GeoJSON blobs as JS literals — it writes them as sibling `.json` files and the generated JS `fetch()`es them (lines 1–3, 422–431) before `init()` runs. This makes the five output files in `maps/` interdependent (the `.html` needs its `.js`, which needs its three `.json` siblings) rather than one self-contained artifact — moving or renaming any of them without updating the others' filename placeholders breaks the page.
