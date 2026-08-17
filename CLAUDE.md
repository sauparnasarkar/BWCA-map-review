# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

An exploratory GIS project that models the Boundary Waters Canoe Area Wilderness (BWCA) — lakes,
campsites, portages, entry points — for eventual mapping/routing. It ingests Esri File Geodatabases
(`.gdb`) with `geopandas`/`pyogrio`, joins campsites to their nearest lake, and renders an interactive
Folium map of lakes and campsites.

The codebase is early-stage and exploratory: scripts are run ad hoc (not via a test suite or CLI),
several files are dead/duplicate code from earlier iterations, and there is no `.gitignore` at the
repo root. Treat this as a data-science notebook-style project rather than a packaged application —
don't assume conventions (tests, CI, linting) that aren't actually present.

## Running things

There's no build/test/lint tooling. Scripts are run directly with Python (PyCharm project configured
for Python 3.14). Runtime dependencies are pinned in `requirements.txt` (`geopandas`, `pyogrio`,
`folium`, `matplotlib`, `pyarrow` for parquet I/O — `shapely` comes in transitively). Set up with
`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`, then run scripts with
`.venv/bin/python ...`.

`graph_map.py` additionally needs a one-time `npm install` from the repo root (`package.json` pins
`@turf/turf@^6.5.0`, matching the version the browser loads from CDN) — it shells out to
`node scripts/build_paddle_edges.js` as part of `render_map()` to precompute the routing graph's
paddle-edge mesh; see Architecture below and `docs/graph_map_design.md`'s "Paddle-edge
precomputation" section for why.

- Entry-point scripts (`main.py`, `Map.py`) are meant to be run **from the repo root** — they use
  paths like `Data/processed/bwca_lakes.parquet`.
- Scripts under `processing/` (except `pre.py`, see below) are meant to be run **from inside
  `processing/`** — they use relative paths like `../Data/...`. Don't run them from the repo root
  without adjusting paths.
- `processing/fileCreator.py` is the actual ETL pipeline that produces the parquet files everything
  else reads (see Data pipeline below). Run it (`cd processing && python fileCreator.py`) before
  running `main.py` or `Map.py` if `Data/processed/*.parquet` don't exist yet.
- `processing/riverCreator.py` builds `bwca_rivers.parquet` and must also be run from inside
  `processing/`, after `fileCreator.py` (it reads `../Data/Processed/bwca_lakes.parquet`). Not
  required for `main.py`/`Map.py`, but `graph_map.py` needs it.
- `processing/pre.py` is a separate, in-progress rewrite of `fileCreator.py` — it does not follow the
  "run from inside `processing/`" convention above. It imports `models.Campsite` (needs the repo root
  on `sys.path`) and uses root-relative `Data/...` paths (no `../`), so it must be run as
  `python -m processing.pre` from the repo root instead. As of now it only loads the raw campsite
  `.gdb` and starts loading hydrography — it does **not** do the clip/join/write steps yet, so it
  won't produce the processed parquet files; use `fileCreator.py` for that.
- `Map.py` (repo root) writes the rendered map to `maps/bwca_map_Campsites.html` (directory not
  currently checked in — create it first, or the save will fail).

## Data pipeline

Raw source data lives under `Data/` as Esri File Geodatabases:

- `Data/Campsites/USFS R09 SNF BWCA Wilderness Campsites Public fgdb.gdb` — the only raw dataset
  actually committed to git (layer `Campsites`).
- `Data/Lakes/water_dnr_hydrography*.gdb` (layer `dnr_hydro_features_all`) and
  `Data/Boundaries/bdry_boundary_waters_canoe_area/*.gdb` (layer
  `boundary_waters_canoe_area_wilderness`) — referenced by the processing scripts but **not checked
  into git** (the hydrography `.gdb` alone is ~310MB, well past what's reasonable to commit); they
  must be sourced separately per checkout. The DNR hydrography dataset (`water_dnr_hydrography`) is
  available from the Minnesota Geospatial Commons (`gisdata.mn.gov`). The BWCAW boundary is trickier:
  it's published as an ArcGIS Online **Feature Service** (owner `lbj_UMN`, item id
  `3d6e078b431b4a6eab7da6c0c54f7a4d`), not a static file — there's no direct `.gdb` download. Pull it
  via the service's `/query?...&f=geojson` endpoint (its `/query` doesn't accept `f=filegdb` directly,
  that export format is only for the async Export-Item job) and convert locally with
  `geopandas.read_file(...).to_file(..., driver="OpenFileGDB")` to get a `.gdb` with the expected
  layer name.
- `Data/Boundary Waters Canoe Area.gpx` — a community-uploaded POI file from poi-factory.com (not an
  official agency source), also **not checked into git**. Its `waypoints` layer mixes campsites
  (~2,214), portages (1,810 — see below), entry points, and outfitter/lodge POIs in one flat table,
  distinguished only by parsing the `name`/`cmt` fields. GPX has no polygon geometry type at all, so
  it can never substitute for the DNR lake polygons; its campsite points are also less complete than
  the official USFS layer (no `STATUS`/`District`/`CSITENO` columns). The one thing it's genuinely
  useful for is portages, which have no other easy-to-source free dataset (see `portageCreator.py`
  below).

`processing/fileCreator.py` is the canonical pipeline: it filters DNR hydrography to `wb_class ==
"Lake or Pond"`, clips to the BWCA boundary polygon, filters campsites to `STATUS == "open"`,
spatially joins each campsite to its nearest lake (`gpd.sjoin_nearest`, recorded as
`distance_to_lake`), derives a `camp_id` (`LAKE_NAME_CSITENO`), and writes `bwca_lakes.parquet` /
`bwca_campsites.parquet`. (`processing/pre.py` is a newer, incomplete rewrite of this — see Running
things above.)

`processing/portageCreator.py` builds the third processed dataset, `bwca_portages.parquet`, from the
GPX file above (there's no authoritative free portages source, unlike lakes/campsites). It reads the
GPX `waypoints` layer, filters to `name` starting with `"Portage "`, and keeps only the `(A to B)`
direction (each physical portage appears twice — `(A to B)`/`(B to A)` — as a mirrored pair with
identical `Rods` and swapped `Start`/`End`), collapsing 1,810 waypoints to 905 distinct portages. Each
portage's `cmt` field is a structured text blob (`Waterbody`, `USFS ID`, `Start`/`End` lat/lon, `Rods`)
that gets regex-parsed into real columns. The two endpoints are then each spatially joined to the
nearest lake polygon (same `gpd.sjoin_nearest` pattern as the campsites join) to get `fw_id_a`/`fw_id_b`
plus `dist_lake_a`/`dist_lake_b`, with `lake_match_uncertain=True` when either endpoint is >25m from
its matched lake.

`processing/riverCreator.py` builds the fourth processed dataset, `bwca_rivers.parquet`, from the
`dnr_rivers_and_streams` layer in the same DNR hydrography `.gdb` used for lakes (a `MultiLineString`
layer, ~133k rows nationally, ~6k after the BWCA boundary clip). It keeps four `Strm_type_desc`
categories (`Stream (Perennial)`, `Centerline (River)`, `Connector (River)`, `Connector (Lake)`) and
explodes any multi-part geometry into single `LineString` segments. Unlike lakes/campsites, this
layer's own `FW_ID` column is a *flowline* ID, not the same ID space as lake `fw_id` (confirmed zero
overlap against `bwca_lakes.parquet`) — lake attachment is done spatially instead, the same
`gpd.sjoin_nearest` + 25m-threshold pattern as `portageCreator.py`, but restricted to `Connector
(Lake)`-type endpoints specifically: those are ~99% within 25m of a lake (median distance 0.0m — they
touch it), while other segment types are only 65–74% within 25m of *some* lake, mostly incidental
proximity (a creek passing near a pond it doesn't connect to) rather than a real junction. Each
segment's two endpoints get a `node_a`/`node_b` string key from their coordinates rounded to ~0.1m —
adjacent segments in this source share exact endpoint coordinates at confluences, so this cheap
coordinate-snap is a legitimate stand-in for a full topology engine (verified: rounding collapses raw
endpoint records into shared junction nodes in the large majority of cases). A `routable` boolean
(`Centerline (River)` / `Connector (River)` / `Connector (Lake)`, i.e. not the much larger
`Stream (Perennial)` category of small creeks) tells consumers which segments are safe to treat as
paddleable routing edges versus display-only context — DNR's classification doesn't distinguish
"canoeable" from "too narrow to paddle" within `Stream (Perennial)`.

**Casing gotcha:** `fileCreator.py` writes to `Data/Processed/...` (capital P) but `main.py`/`Map.py`
read from `Data/processed/...` (lowercase p). This only works silently on case-insensitive
filesystems (default macOS/Windows) — keep this in mind if anything moves to Linux/CI.

**CRS gotcha:** the raw DNR hydrography `.gdb` carries a "promoted to 3D" PROJJSON CRS rather than a
plain EPSG code. Left as-is, that CRS propagates through `lakes.crs`/`bwca_lakes.crs` into all four
processed parquet files (`fileCreator.py` derives `campsites`' CRS from it directly;
`portageCreator.py`/`riverCreator.py` reproject their outputs to `lakes.crs` read back from
`bwca_lakes.parquet`). QGIS reads that PROJJSON as "no projection specification" and silently
mis-plots the geometry until the layer's CRS is manually reassigned. `fileCreator.py`,
`portageCreator.py`, and `riverCreator.py` all call `gdf.to_crs("EPSG:26915")` (NAD83 / UTM zone 15N)
immediately before each `to_parquet()` call to force a clean tag — keep that pattern for any new
processed dataset.

**Known data-quality issues in the join** (found by comparing the processed parquet files back
against the raw `.gdb` sources — not yet fixed, intentionally left for follow-up):

- `fw_id` is not a reliable unique lake key: `88888` is a DNR placeholder reused across 6 unrelated
  lakes (e.g. Saganaga, East Vermilion, Bearskin). Since `bwca_graph.py` keys its lake dict by
  `fw_id`, loading silently collapses all 6 into whichever is read last — any campsite matched to
  `fw_id=88888` gets wired to the wrong lake. Separately, ~71% of lake rows have a **null** `fw_id`
  (inherited from the raw DNR source — small/unnamed ponds never got an ID assigned), so those can
  never be resolved via `find_lake`/`find_lake_by_name` even though they still render fine on the map.
- `camp_id` (`LAKE_NAME_CSITENO`) collides for ~96 campsites: 22 pairs predate the join (same lake
  name reused across different `District`s, e.g. "Clearwater Lake" in both `KAW` and `GUN`, since
  `CSITENO` numbering restarts per district), and ~74 more come from genuine `gpd.sjoin_nearest` ties
  (multiple lakes at identical distance). Since `bwca_graph.py` stores campsites in a dict keyed by
  `camp_id`, duplicates silently overwrite each other on load.
- `sjoin_nearest` only considers `wb_class == "Lake or Pond"` as match candidates, so campsites that
  are actually on a river (e.g. two "Basswood River" sites) get matched to the nearest *lake* instead,
  sometimes hundreds of meters away — `distance_to_lake` is the tell (normal matches are single-digit
  to low-double-digit meters; these outliers are 480m+). Confirmed against the actual river network
  (layer `dnr_rivers_and_streams`, a `MultiLineString` layer in the same hydrography `.gdb` — not the
  polygon `wb_class` classes `"Riverine polygon"`/`"Riverine island"`, which are sparse and don't
  represent the real stream network): 57 campsites are both >50m from their matched lake **and**
  closer to a stream line than to that lake, mostly the Kawishiwi/Basswood/Isabella/Little Indian
  Sioux river campsites. Neither signal alone is clean — naming (`LAKE_NAME` containing "River") and
  river-proximity each have their own false positives (e.g. lake-named sites near a small feeder
  stream) — so a fix should require both the distance outlier *and* the river-proximity check before
  nulling out `fw_id`/flagging a row, rather than trusting either alone.
- `bwca_portages.parquet`'s lake matches are noisier than the campsites join: 385 of 905 portages
  (43%) are flagged `lake_match_uncertain`. Of those, ~89 have an endpoint that falls **outside** the
  BWCA boundary clip (their true nearest lake was excluded from `bwca_lakes.parquet` by the boundary
  clip in `fileCreator.py`, so the nearest surviving lake can be km away) and ~191 are inside the
  boundary but still land 25m+ from any lake — most likely coordinate imprecision in the source GPX
  itself, since it's a **community-uploaded** poi-factory file, not a surveyed dataset. Also confirmed
  (empirically, via 48 coincidental overlaps that turned out semantically unrelated) that the GPX's
  `USFS ID` field is **not** the same ID space as DNR's `fw_id` — don't try to join on it.
- `bwca_rivers.parquet`'s lake attachment is deliberately more conservative than the portages join:
  only `Connector (Lake)`-type segment endpoints are matched to a lake at all (see Data pipeline
  above for why), so most river segments have `fw_id_a`/`fw_id_b` both null — that's expected, not a
  join failure. The client-side routing graph in `graph_map.py`'s Leaflet page inherited the same
  `fw_id=88888`/null-`fw_id` caveats as portages once rivers were wired into it, plus a new one: a
  stream that exits and re-enters the BWCA boundary clip becomes two disconnected segments with
  dangling nodes at the clip line, since `riverCreator.py`'s node-snapping only merges endpoints that
  share (near-)identical coordinates, and the clip severs that continuity.

Other `processing/*.py` files (`boundariesData.py`, `LakeData.py`, `Campsite Data.py`,
`processed_datasets.py`) are exploratory/scratch scripts (data inspection, `print` debugging, mostly
commented-out code) rather than a pipeline — don't treat them as required steps.

## Architecture

- `models/Lake.py`, `models/Campsite.py` — plain `@dataclass` models (geometry + attributes,
  including `distance_to_lake` on `Campsite`; `Lake` holds `campsites`/`connections` lists populated
  later).
- `models/Portage.py` — `@dataclass` connecting two `Lake` objects (`Lake_a`/`Lake_b`), plus the
  portage's own `geometry` (the real surveyed line from `bwca_portages.parquet`, not a straight line
  between the lakes), `length_rods`, and `lake_match_uncertain` (carried through from
  `portageCreator.py`'s >25m distance check — see the data-quality notes above) alongside optional
  `portage_number`/`usfs_id`/`waterbody`/`dist_lake_a`/`dist_lake_b` for popups/labels.
- `models/River.py` — `@dataclass` for one river/stream segment: `node_a`/`node_b` (the snapped
  junction-key strings from `riverCreator.py`), `length_m`, `geometry`, `strm_type`, `routable`, and
  optional `name`/`Lake_a`/`Lake_b`/`dist_lake_a`/`dist_lake_b`. Unlike `Portage`, `Lake_a`/`Lake_b`
  are usually `None` — most river segments are internal network junctions that don't touch a lake at
  either end, which is the normal case here, not a data-quality problem.
- `models/bwca_graph.py` — the in-memory graph/loader actually used by `main.py`: loads the
  processed parquet files into `Lake`/`Campsite` objects keyed by `fw_id`/`camp_id`, then
  `connect_campsites()` links each campsite to its lake via `fw_id`. `load_portages()` builds
  `Portage` objects from `bwca_portages.parquet`, skipping rows where either endpoint's `fw_id`
  doesn't resolve to a loaded `Lake` (nulls, or lakes cut by the boundary clip) — it keeps both
  confident and uncertain matches, so `Portage.lake_match_uncertain` must be checked by any consumer
  that cares about match quality. `connect_portages()` then appends each portage to both lakes'
  `connections` lists. `load_rivers()` builds `River` objects from `bwca_rivers.parquet` similarly,
  but — unlike `load_portages()` — does **not** skip rows with an unresolved endpoint, since that's
  the common case for rivers rather than a join failure; `connect_rivers()` appends each river to
  whichever of `Lake_a`/`Lake_b` did resolve (zero, one, or both). `find_lake` / `find_lake_by_name`
  are the lookup API.
- `main.py` / `Map.py` / `graph_map.py` (repo root) are the three usable entry points: `main.py`
  exercises the graph API, `Map.py` renders lakes + clustered campsite markers straight from the
  GeoDataFrames via Folium, and `graph_map.py` renders lakes + campsites + portages + rivers from the
  in-memory `bwca_graph` (not the raw parquet) using raw Leaflet.js (CDN, no folium) — portages are
  styled by `lake_match_uncertain` (solid green vs. dashed red, with a legend) rather than filtered,
  and rivers are styled by `routable` (solid vs. dotted) since only routable segments (river/lake
  connectors, not small perennial creeks) become edges in the client-side Dijkstra routing graph
  alongside portages and lake-interior paddle edges — see `docs/graph_map_design.md` for the full
  routing-graph design. Rivers roughly double how many lakes need a boundary-vertex graph
  (~440 with portages alone → ~930); building that graph is expensive (chord-visibility tests
  against every existing access point on a lake), so `graph_map.py` now precomputes it once at
  build time via `templates/graph_engine.js` (the same graph-construction code the browser uses for
  live click-time routing, shared verbatim) run once in Node by `scripts/build_paddle_edges.js`,
  instead of the browser recomputing it on every page load — see the design doc's "Paddle-edge
  precomputation" section for the fix and how it was verified (an edge-set diff against the old
  algorithm, not just a route replay, after two earlier attempts that changed the geometry
  approximation instead were found to silently break routes and were reverted). Browser load time
  dropped from a worst-case ~9.5 minutes to ~6 seconds as a result. This only fixes *load* time,
  though: a click-to-route "start"/"end" node still wires against a lake's existing access points
  live, in the browser, since a clicked point can't be precomputed — on an ordinary lake that's fast
  (~150ms), but the first click on the most complex/highest-access-point lake (Lac la Croix, fw_id
  13 — 143 access points) still takes ~6-7 seconds, the same cost the original algorithm always
  paid there, just no longer hidden inside a multi-minute load. See the design doc's "What this fix
  does not address" note — an open follow-up, not something papered over.
  All three write into `maps/` (directory not currently checked in — create it first, or the save
  will fail; `graph_map.py` creates it automatically).

**Known dead/inconsistent code** — don't extend these without reconciling them first:

- `models/graph.py` is an older, superseded version of `bwca_graph.py`'s logic living outside any
  loader class, with imports (`from Campsite import Campsite`) that don't match how the rest of
  `models/` imports (`from models.Campsite import Campsite`) — it won't run from the repo root.
- `models/entry_points.py` has the same broken-import pattern (`from Lake import Lake`).
- `BoundarWaters.py` (repo root, note the typo in the filename) is an unused stub class
  (`BoundaryWaters`) not wired into anything else.
