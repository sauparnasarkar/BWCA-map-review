    const LAKES_URL = "__LAKES_URL__";
    const CAMPSITES_URL = "__CAMPSITES_URL__";
    const PORTAGES_URL = "__PORTAGES_URL__";
    const RIVERS_URL = "__RIVERS_URL__";
    const PADDLE_EDGES_URL = "__PADDLE_EDGES_URL__";

    function init(lakes, campsites, portages, rivers, paddleEdges) {
    const map = L.map("map");
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    const lakesLayer = L.geoJSON(lakes, {
        style: {
            color: "#2b6cb0",
            weight: 1,
            fillColor: "#63b3ed",
            fillOpacity: 0.35
        },
        onEachFeature: function (feature, layer) {
            const p = feature.properties;
            layer.bindTooltip(
                `${p.name} &mdash; ${p.acres.toFixed(1)} acres, ${p.num_campsites} campsite(s)`
            );
        }
    }).addTo(map);

    const CONFIDENT_PORTAGE_STYLE = { color: "#0f5c2e", weight: 3, opacity: 0.9 };
    const UNCERTAIN_PORTAGE_STYLE = { color: "#dc2626", weight: 3, opacity: 0.9, dashArray: "8 6" };

    const portagesLayer = L.geoJSON(portages, {
        style: (feature) =>
            feature.properties.lake_match_uncertain ? UNCERTAIN_PORTAGE_STYLE : CONFIDENT_PORTAGE_STYLE,
        onEachFeature: function (feature, layer) {
            const p = feature.properties;
            const waterbody = p.waterbody || "(unnamed in source data)";
            const confidence = p.lake_match_uncertain
                ? '<span style="color:#dc2626;">Uncertain match</span>'
                : '<span style="color:#0f5c2e;">Confident match</span>';
            layer.bindPopup(
                `<b>Portage #${p.portage_number}</b> (USFS ID ${p.usfs_id})<br>` +
                `${waterbody} &mdash; ${p.length_rods.toFixed(1)} rods<br>` +
                `${p.lake_a} &rarr; ${p.lake_b}<br>` +
                `${confidence}<br>` +
                `<span style="font-size:11px; color:#555;">` +
                `fw_id_a=${p.fw_id_a} (${p.dist_lake_a.toFixed(1)}m) &middot; ` +
                `fw_id_b=${p.fw_id_b} (${p.dist_lake_b.toFixed(1)}m)</span>`
            );
        }
    }).addTo(map);

    const legend = L.control({ position: "bottomright" });
    legend.onAdd = function () {
        const div = L.DomUtil.create("div", "legend");
        div.innerHTML = `
            <b>Portage match confidence</b><br>
            <span style="display:inline-block;width:20px;border-top:3px solid #0f5c2e;margin-right:4px;"></span>Confident<br>
            <span style="display:inline-block;width:20px;border-top:3px dashed #dc2626;margin-right:4px;"></span>Uncertain (&gt;25m from lake)<br>
            <b>Rivers &amp; streams</b><br>
            <span style="display:inline-block;width:20px;border-top:2px solid #0891b2;margin-right:4px;"></span>Routable (river/connector)<br>
            <span style="display:inline-block;width:20px;border-top:2px dotted #0891b2;margin-right:4px;"></span>Display only (small stream)
        `;
        return div;
    };
    legend.addTo(map);

    // Display-only layer: all four "real flow" segment types render here so
    // the map reflects the actual stream network, but only routable ones
    // (see rivers.features properties.routable, set by riverCreator.py) get
    // wired into the routing graph below - see CLAUDE.md/plan notes on why
    // small perennial creeks are shown but not treated as paddleable edges.
    const riversLayer = L.geoJSON(rivers, {
        style: (feature) => ({
            color: "#0891b2",
            weight: feature.properties.routable ? 2 : 1.5,
            opacity: feature.properties.routable ? 0.85 : 0.6,
            dashArray: feature.properties.routable ? null : "1 4"
        }),
        onEachFeature: function (feature, layer) {
            const p = feature.properties;
            layer.bindTooltip(`${p.name || "Unnamed stream"} &mdash; ${p.strm_type}`);
        }
    }).addTo(map);

    const campsitesLayer = L.markerClusterGroup();
    L.geoJSON(campsites, {
        pointToLayer: function (feature, latlng) {
            return L.circleMarker(latlng, {
                radius: 4,
                color: "#c53030",
                fillColor: "#c53030",
                fillOpacity: 1
            });
        },
        onEachFeature: function (feature, layer) {
            const p = feature.properties;
            layer.bindPopup(
                `<b>Campsite:</b> ${p.camp_id}<br>` +
                `<b>Lake:</b> ${p.lake_name}<br>` +
                `<b>Status:</b> ${p.status}<br>` +
                `<b>District:</b> ${p.district}<br>` +
                `<b>Distance to matched lake:</b> ${p.distance_to_lake.toFixed(1)} m`
            );
        }
    }).addTo(campsitesLayer);
    campsitesLayer.addTo(map);

    map.fitBounds(lakesLayer.getBounds());

    // --- Route finding: portages (surveyed lines) + paddle edges across lakes ---
    // Paddle edges are a visibility-graph shortcut, not a full solve: for two
    // points on the same lake, if the straight line between them stays inside
    // the (buffered) lake polygon, it's added as a paddle edge weighted by
    // straight-line distance. A chord genuinely blocked by an island (or
    // crossing the gap between two disjoint pieces of a lake split by the
    // boundary clip - see CLAUDE.md's CRS/clip gotcha) just gets no edge
    // rather than routing around it - a safe undercount, not a wrong route.
    // lineStaysInLake used to have a second failure mode here: the same 25m
    // buffer it used for near-shore portage/river endpoint tolerance also
    // doubled as the chord-obstruction geometry, which erased any peninsula
    // or island narrower than ~50m and let a chord that visually crossed a
    // narrow neck of land pass as "valid" - confirmed against real data
    // (Newfound Lake, fw_id 335): 7 true-shoreline crossings, 0 against the
    // buffered polygon. Fixed by testing chords against the true (unbuffered)
    // shoreline directly, ignoring only crossings that fall within 25m of
    // either endpoint (expected near-shore noise, not real land) - see
    // lineStaysInLake in graph_engine.js and docs/graph_map_design.md.
    // NOTE: fw_id 88888 is a reused DNR placeholder shared by several
    // unrelated lakes (see CLAUDE.md) - the graph only keeps the last one
    // loaded, so routing near those lakes may be attached to the wrong polygon.
    //
    // The full graph-construction logic (addNode/wirePaddleEdges/
    // buildLakeVertexGraph/lineStaysInLake) lives in graph_engine.js, shared
    // with scripts/build_paddle_edges.js, which runs this exact code once at
    // build time over every portage endpoint, routable river endpoint, and
    // lake boundary vertex - see that file and docs/graph_map_design.md's
    // "Paddle-edge precomputation" section for why. Loading that precomputed
    // result (below) replaces what used to be a live portage/river ingestion
    // loop here, calling the same expensive chord tests on every page load
    // for ~930 lakes. Click-time start/end wiring still calls this engine's
    // addNode/wirePaddleEdges live - that path was never the expensive part
    // (O(k) against one lake's existing access points, not O(k^2) across the
    // whole map) and still needs to run in the browser since a clicked point
    // isn't known until the user clicks it.
    const engine = GraphEngine.createGraphEngine(turf, lakes, rivers);
    const { nodes, adjacency, addNode, removeNode, addEdge, wireRiverSnapEdges, clearRiverSnapEdges } = engine;
    GraphEngine.loadPrecomputed(engine, paddleEdges);

    function findLakeAtPoint(coord) {
        for (const feature of lakes.features) {
            if (turf.booleanPointInPolygon(coord, feature)) return feature;
        }
        return null;
    }

    function nearestLake(coord) {
        let best = null;
        let bestDist = Infinity;
        let bestCoord = coord;
        for (const feature of lakes.features) {
            const boundary = turf.polygonToLine(feature);
            const nearest = turf.nearestPointOnLine(boundary, coord, { units: "meters" });
            if (nearest.properties.dist < bestDist) {
                bestDist = nearest.properties.dist;
                best = feature;
                bestCoord = nearest.geometry.coordinates;
            }
        }
        return { feature: best, coord: bestCoord, distance: bestDist };
    }

    // Nudges Dijkstra toward portage/river edges over open-water paddle
    // chords when they're competitively close, without changing what gets
    // reported or which routes exist. Only "paddle" edges are penalized here
    // (portage and river edges pass through at their real weight). Originally
    // added as a mitigation for lineStaysInLake's buffer-erosion bug (a
    // paddle chord could visually cross a narrow peninsula/island and still
    // test as valid); that bug is now fixed at the source (see the chord-
    // obstruction test in graph_engine.js), so this penalty is no longer
    // covering for a correctness gap. Kept anyway on its own merits - a
    // charted river/portage route is generally preferable to an open-water
    // shortcut even when both are legal, and Dijkstra has no other way to
    // express that preference. Still a soft nudge, not a filter: a paddle
    // edge decisively shorter than any river/portage alternative still wins.
    const PADDLE_PREFERENCE_PENALTY = 1.3; // tunable: 1.0 = no preference, higher = stronger pull toward rivers/portages

    function dijkstra(startNode, endNode) {
        const cost = new Map([[startNode, 0]]);      // search cost (paddle-penalized) - decides which path wins
        const trueDist = new Map([[startNode, 0]]);  // real distance (unweighted) - what gets reported/rendered
        const prev = new Map();
        const visited = new Set();
        const queue = [[0, startNode]];

        while (queue.length) {
            queue.sort((a, b) => a[0] - b[0]);
            const [c, u] = queue.shift();
            if (visited.has(u)) continue;
            visited.add(u);
            if (u === endNode) break;

            for (const edge of adjacency.get(u) || []) {
                const edgeCost = edge.kind === "paddle" ? edge.weight * PADDLE_PREFERENCE_PENALTY : edge.weight;
                const alt = c + edgeCost;
                if (alt < (cost.get(edge.to) ?? Infinity)) {
                    cost.set(edge.to, alt);
                    trueDist.set(edge.to, trueDist.get(u) + edge.weight);
                    prev.set(edge.to, u);
                    queue.push([alt, edge.to]);
                }
            }
        }

        if (!cost.has(endNode)) return null;

        const path = [endNode];
        let current = endNode;
        while (current !== startNode) {
            current = prev.get(current);
            path.push(current);
        }
        path.reverse();
        return { distance: trueDist.get(endNode), path };
    }

    let routeLayer = null;
    let markerStart = null;
    let markerEnd = null;

    function setStatus(text) {
        document.getElementById("route-status-text").textContent = text;
    }

    function clearRoute() {
        if (markerStart) map.removeLayer(markerStart);
        if (markerEnd) map.removeLayer(markerEnd);
        if (routeLayer) map.removeLayer(routeLayer);
        clearRiverSnapEdges();
        removeNode("start");
        removeNode("end");
        markerStart = null;
        markerEnd = null;
        routeLayer = null;
        setStatus("Click a point on a lake to start a route.");
    }

    function computeAndDrawRoute() {
        const result = dijkstra("start", "end");
        if (routeLayer) map.removeLayer(routeLayer);

        if (!result) {
            setStatus("No route found - these lakes aren't connected by any recorded portage or river.");
            return;
        }

        const segments = [];
        for (let i = 0; i < result.path.length - 1; i++) {
            segments.push(adjacency.get(result.path[i]).find((e) => e.to === result.path[i + 1]));
        }

        const ROUTE_COLORS = { portage: "#7c2d12", paddle: "#1d4ed8", river: "#0891b2" };

        routeLayer = L.geoJSON(
            segments.map((s) => ({ type: "Feature", properties: { kind: s.kind }, geometry: s.geometry })),
            {
                style: (feature) => ({
                    color: ROUTE_COLORS[feature.properties.kind],
                    weight: 5,
                    opacity: 0.9,
                    dashArray: feature.properties.kind === "portage" ? "2 6" : null
                })
            }
        ).addTo(map);

        const rods = segments
            .filter((s) => s.kind === "portage")
            .reduce((sum, s) => sum + s.weight / GraphEngine.ROD_TO_METERS, 0);
        const paddleKm = segments
            .filter((s) => s.kind === "paddle")
            .reduce((sum, s) => sum + s.weight, 0) / 1000;
        const riverKm = segments
            .filter((s) => s.kind === "river")
            .reduce((sum, s) => sum + s.weight, 0) / 1000;

        setStatus(
            `Route found: ${(result.distance / 1000).toFixed(2)} km total ` +
            `(${rods.toFixed(0)} rods of portaging, ${paddleKm.toFixed(2)} km paddling, ` +
            `${riverKm.toFixed(2)} km river).`
        );
    }

    const routeControl = L.control({ position: "topleft" });
    routeControl.onAdd = function () {
        const div = L.DomUtil.create("div", "legend");
        div.innerHTML = `
            <b>Route finder</b><br>
            <span id="route-status-text">Click a point on a lake to start a route.</span><br>
            <button id="route-clear-btn" style="margin-top:6px;">Clear route</button>
        `;
        L.DomEvent.disableClickPropagation(div);
        return div;
    };
    routeControl.addTo(map);
    document.getElementById("route-clear-btn").addEventListener("click", clearRoute);

    // Attached to the map AND to the portage/campsite layers: those layers
    // have their own popups/cluster-zoom click handling and swallow the
    // click before it would otherwise bubble up to the map's own listener.
    function handleRouteClick(latlng) {
        if (nodes.has("start") && nodes.has("end")) clearRoute();

        const clickCoord = [latlng.lng, latlng.lat];
        let lakeFeature = findLakeAtPoint(clickCoord);
        let snappedCoord = clickCoord;

        if (!lakeFeature) {
            const nearest = nearestLake(clickCoord);
            if (!nearest.feature || nearest.distance > 200) {
                setStatus("That's too far from any lake - click closer to the water.");
                return;
            }
            lakeFeature = nearest.feature;
            snappedCoord = nearest.coord;
        }

        const role = nodes.has("start") ? "end" : "start";
        addNode(role, lakeFeature.properties.fw_id, snappedCoord);
        wireRiverSnapEdges(role, lakeFeature.properties.fw_id, snappedCoord);
        const marker = L.marker([snappedCoord[1], snappedCoord[0]], {
            title: role === "start" ? "Start" : "End"
        }).addTo(map);

        if (role === "start") {
            markerStart = marker;
            setStatus("Click a second point to find a route.");
        } else {
            markerEnd = marker;
            computeAndDrawRoute();
        }
    }

    map.on("click", (e) => handleRouteClick(e.latlng));
    portagesLayer.on("click", (e) => handleRouteClick(e.latlng));
    campsitesLayer.on("click", (e) => handleRouteClick(e.latlng));
    riversLayer.on("click", (e) => handleRouteClick(e.latlng));
    }

    Promise.all([
        fetch(LAKES_URL).then((r) => r.json()),
        fetch(CAMPSITES_URL).then((r) => r.json()),
        fetch(PORTAGES_URL).then((r) => r.json()),
        fetch(RIVERS_URL).then((r) => r.json()),
        fetch(PADDLE_EDGES_URL).then((r) => r.json()),
    ])
        .then(([lakes, campsites, portages, rivers, paddleEdges]) => init(lakes, campsites, portages, rivers, paddleEdges))
        .catch((err) => {
            console.error("Failed to load map data:", err);
            document.getElementById("map").textContent = "Failed to load map data - see console for details.";
        });
