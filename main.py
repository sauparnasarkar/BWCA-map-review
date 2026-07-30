import duckdb
import geopandas as gpd

from models.bwca_graph import bwca_graph
# print(bwca_graph)
# print(type(bwca_graph))
graph = bwca_graph()

graph.load_lakes("Data/processed/bwca_lakes.parquet")
graph.load_campsites("Data/processed/bwca_campsites.parquet")

graph.connect_campsites()

knife = graph.find_lake(3731)

print(knife.name)
print(len(knife.campsites))

lake_name_counts = {}
for campsite in knife.campsites:
    lake_name_counts[campsite.lake_name] = lake_name_counts.get(campsite.lake_name, 0) + 1

for lake_name, count in lake_name_counts.items():
    print(f'"{lake_name}",{count}')

for campsite in knife.campsites:
    print(
        f'"{campsite.camp_id}",'
        f'{campsite.site_number},'
        f'"{campsite.lake_name}",'
        f'{campsite.fw_id},'
        f'"{campsite.status}",'
        f'"{campsite.district}",'
        f'{campsite.distance_to_lake}'
    )

portages = gpd.read_parquet("Data/processed/bwca_portages.parquet")
knife_portages = portages[
    (portages["fw_id_a"] == knife.fw_id) | (portages["fw_id_b"] == knife.fw_id)
]

print(len(knife_portages))

for portage in knife_portages.itertuples():
    print(
        f'{portage.portage_number},'
        f'"{portage.waterbody}",'
        f'{portage.rods},'
        f'{portage.fw_id_a},'
        f'{portage.fw_id_b},'
        f'{portage.lake_match_uncertain}'
    )

duckdb.sql(f"""
    SELECT portage_number, waterbody, rods, fw_id_a, fw_id_b, lake_match_uncertain,
        start_lat, start_lon, end_lat, end_lon, dist_lake_a, dist_lake_b
    FROM 'Data/processed/bwca_portages.parquet'
    WHERE (fw_id_a = {knife.fw_id} OR fw_id_b = {knife.fw_id})
    AND lake_match_uncertain = false
""").write_csv("basswood_portages.csv")