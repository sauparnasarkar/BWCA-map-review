import re

import geopandas as gpd
from shapely.geometry import LineString, Point

wpts = gpd.read_file("../Data/Boundary Waters Canoe Area.gpx", layer="waypoints")

portages = wpts[wpts["name"].str.startswith("Portage ", na=False)].copy()

name_parts = portages["name"].str.extract(r"^Portage (\d+) \((A to B|B to A)\)$")
portages["portage_number"] = name_parts[0].astype(int)
portages["direction"] = name_parts[1]

portages = portages[portages["direction"] == "A to B"].copy()

portages["waterbody"] = portages["cmt"].str.extract(r"Waterbody: (.+)")[0].str.strip()
portages["usfs_id"] = portages["cmt"].str.extract(r"USFS ID: (\d+)")[0].astype(int)
portages["start_lat"] = portages["cmt"].str.extract(r"Start: (-?\d+\.?\d*),")[0].astype(float)
portages["start_lon"] = portages["cmt"].str.extract(r"Start: -?\d+\.?\d*, (-?\d+\.?\d*)")[0].astype(float)
portages["end_lat"] = portages["cmt"].str.extract(r"End: (-?\d+\.?\d*),")[0].astype(float)
portages["end_lon"] = portages["cmt"].str.extract(r"End: -?\d+\.?\d*, (-?\d+\.?\d*)")[0].astype(float)
portages["rods"] = portages["cmt"].str.extract(r"Rods: (\d+\.?\d*)")[0].astype(float)

print("parsed rows:", len(portages))
print("rows with any missing parsed field:", portages[[
    "waterbody", "usfs_id", "start_lat", "start_lon", "end_lat", "end_lon", "rods"
]].isna().any(axis=1).sum())

portages["geometry"] = [
    LineString([Point(row.start_lon, row.start_lat), Point(row.end_lon, row.end_lat)])
    for row in portages.itertuples()
]
portages = gpd.GeoDataFrame(portages, geometry="geometry", crs="EPSG:4326")

lakes = gpd.read_parquet("../Data/Processed/bwca_lakes.parquet")
portages = portages.to_crs(lakes.crs)
portages = portages.reset_index(drop=True)

start_pts = gpd.GeoDataFrame(
    {"portage_number": portages["portage_number"]},
    geometry=[Point(g.coords[0]) for g in portages.geometry],
    crs=portages.crs,
)
end_pts = gpd.GeoDataFrame(
    {"portage_number": portages["portage_number"]},
    geometry=[Point(g.coords[-1]) for g in portages.geometry],
    crs=portages.crs,
)

lake_candidates = lakes[["fw_id", "geometry"]]
start_match = gpd.sjoin_nearest(start_pts, lake_candidates, how="left", distance_col="dist_lake_a")
start_match = start_match[~start_match.index.duplicated(keep="first")]
end_match = gpd.sjoin_nearest(end_pts, lake_candidates, how="left", distance_col="dist_lake_b")
end_match = end_match[~end_match.index.duplicated(keep="first")]

portages["fw_id_a"] = start_match["fw_id"].values
portages["dist_lake_a"] = start_match["dist_lake_a"].values
portages["fw_id_b"] = end_match["fw_id"].values
portages["dist_lake_b"] = end_match["dist_lake_b"].values

MAX_MATCH_DISTANCE_M = 25
portages["lake_match_uncertain"] = (
    (portages["dist_lake_a"] > MAX_MATCH_DISTANCE_M)
    | (portages["dist_lake_b"] > MAX_MATCH_DISTANCE_M)
)

print("uncertain lake matches:", portages["lake_match_uncertain"].sum(), "of", len(portages))

portages = portages[[
    "portage_number",
    "usfs_id",
    "waterbody",
    "rods",
    "fw_id_a",
    "dist_lake_a",
    "fw_id_b",
    "dist_lake_b",
    "lake_match_uncertain",
    "start_lat",
    "start_lon",
    "end_lat",
    "end_lon",
    "geometry",
]]

print(portages.head())

# See fileCreator.py: force a clean EPSG tag instead of whatever PROJJSON came
# through the lakes join, otherwise QGIS reports "no projection specification".
portages = portages.to_crs("EPSG:26915")  # NAD83 / UTM zone 15N

portages.to_parquet("../Data/Processed/bwca_portages.parquet")
