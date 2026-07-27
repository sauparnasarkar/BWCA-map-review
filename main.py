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