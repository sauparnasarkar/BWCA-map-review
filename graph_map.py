import json
from pathlib import Path

import geopandas as gpd

from models.bwca_graph import bwca_graph

# Data/processed/*.parquet is written in NAD83 / UTM zone 15N (see CLAUDE.md's
# CRS gotcha) - the graph's Lake/Campsite objects carry that geometry as-is,
# with no CRS attached to the dataclass itself, so this has to match whatever
# fileCreator.py/portageCreator.py actually wrote.
SOURCE_CRS = "EPSG:26915"

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
HTML_TEMPLATE = (TEMPLATES_DIR / "html_template.html").read_text()
JS_TEMPLATE = (TEMPLATES_DIR / "js_template.js").read_text()


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
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    js_filename = out_path.stem + ".js"
    lakes_filename = out_path.stem + "_lakes.json"
    campsites_filename = out_path.stem + "_campsites.json"
    portages_filename = out_path.stem + "_portages.json"

    html = HTML_TEMPLATE.replace("__JS_FILENAME__", js_filename)
    js = (
        JS_TEMPLATE
        .replace("__LAKES_URL__", lakes_filename)
        .replace("__CAMPSITES_URL__", campsites_filename)
        .replace("__PORTAGES_URL__", portages_filename)
    )

    written = [out_path, out_path.parent / js_filename]
    out_path.write_text(html)
    written[1].write_text(js)

    for filename, data in (
        (lakes_filename, lakes_geojson(graph)),
        (campsites_filename, campsites_geojson(graph)),
        (portages_filename, portages_geojson(graph)),
    ):
        data_path = out_path.parent / filename
        data_path.write_text(json.dumps(data))
        written.append(data_path)

    print("Wrote " + ", ".join(str(p) for p in written))


if __name__ == "__main__":
    render_map(build_graph())
