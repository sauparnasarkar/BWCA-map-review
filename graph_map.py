import json
from pathlib import Path

import geopandas as gpd

from models.bwca_graph import bwca_graph

# Data/processed/*.parquet is written in NAD83 / UTM zone 15N (see CLAUDE.md's
# CRS gotcha) - the graph's Lake/Campsite objects carry that geometry as-is,
# with no CRS attached to the dataclass itself, so this has to match whatever
# fileCreator.py/portageCreator.py actually wrote.
SOURCE_CRS = "EPSG:26915"

HTML_TEMPLATE = """<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>BWCA Map</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css" />
    <style>
        html, body, #map { height: 100%; margin: 0; font-family: system-ui, sans-serif; }
        .legend {
            background: white;
            padding: 10px 12px;
            border-radius: 6px;
            box-shadow: 0 1px 4px rgba(0,0,0,0.3);
            font-size: 13px;
            line-height: 1.6;
        }
    </style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"></script>
<script>
    const lakes = __LAKES_GEOJSON__;
    const campsites = __CAMPSITES_GEOJSON__;
    const portages = __PORTAGES_GEOJSON__;

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
            <span style="display:inline-block;width:20px;border-top:3px dashed #dc2626;margin-right:4px;"></span>Uncertain (&gt;25m from lake)
        `;
        return div;
    };
    legend.addTo(map);

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
</script>
</body>
</html>
"""


def build_graph():
    graph = bwca_graph()

    graph.load_lakes("Data/processed/bwca_lakes.parquet")
    graph.load_campsites("Data/processed/bwca_campsites.parquet")
    graph.connect_campsites()

    graph.load_portages("Data/processed/bwca_portages.parquet")
    graph.connect_portages()

    return graph


def lakes_geojson(graph):
    lakes = list(graph.lakes.values())
    gdf = gpd.GeoDataFrame(
        {
            "fw_id": [lake.fw_id for lake in lakes],
            "name": [lake.name for lake in lakes],
            "acres": [lake.acres for lake in lakes],
            "shoreline_miles": [lake.shoreline_miles for lake in lakes],
            "num_campsites": [len(lake.campsites) for lake in lakes],
        },
        geometry=[lake.geometry for lake in lakes],
        crs=SOURCE_CRS,
    )
    return json.loads(gdf.to_crs(4326).to_json())


def campsites_geojson(graph):
    campsites = list(graph.campsites.values())
    gdf = gpd.GeoDataFrame(
        {
            "camp_id": [c.camp_id for c in campsites],
            "lake_name": [c.lake_name for c in campsites],
            "status": [c.status for c in campsites],
            "district": [c.district for c in campsites],
            "distance_to_lake": [c.distance_to_lake for c in campsites],
        },
        geometry=[c.geometry for c in campsites],
        crs=SOURCE_CRS,
    )
    return json.loads(gdf.to_crs(4326).to_json())


def portages_geojson(graph):
    portages = graph.portages
    gdf = gpd.GeoDataFrame(
        {
            "portage_number": [p.portage_number for p in portages],
            "usfs_id": [p.usfs_id for p in portages],
            "waterbody": [p.waterbody for p in portages],
            "lake_a": [p.Lake_a.name for p in portages],
            "lake_b": [p.Lake_b.name for p in portages],
            "fw_id_a": [p.Lake_a.fw_id for p in portages],
            "fw_id_b": [p.Lake_b.fw_id for p in portages],
            "length_rods": [p.length_rods for p in portages],
            "dist_lake_a": [p.dist_lake_a for p in portages],
            "dist_lake_b": [p.dist_lake_b for p in portages],
            "lake_match_uncertain": [bool(p.lake_match_uncertain) for p in portages],
        },
        geometry=[p.geometry for p in portages],
        crs=SOURCE_CRS,
    )
    return json.loads(gdf.to_crs(4326).to_json())


def render_map(graph, out_path="maps/bwca_graph_map.html"):
    html = (
        HTML_TEMPLATE
        .replace("__LAKES_GEOJSON__", json.dumps(lakes_geojson(graph)))
        .replace("__CAMPSITES_GEOJSON__", json.dumps(campsites_geojson(graph)))
        .replace("__PORTAGES_GEOJSON__", json.dumps(portages_geojson(graph)))
    )

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    render_map(build_graph())
