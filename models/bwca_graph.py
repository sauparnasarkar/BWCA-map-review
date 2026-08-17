# models/graph.py
import geopandas as gpd
from models.Campsite import Campsite
from models.Lake import Lake
from models.Portage import Portage
from models.River import River

class bwca_graph:

    def __init__(self):

        self.lakes = {}

        self.campsites = {}

        self.portages = []

        self.rivers = []




    lakes = {}
    def load_lakes(self,filename):
        lake_df = gpd.read_parquet(filename)

        for _, row in lake_df.iterrows():
            lake = Lake(
                fw_id=row["fw_id"],
                name=row["map_label"],
                geometry=row.geometry,
                acres=row["acres"],
                shoreline_miles=row["shore_mi"]
            )

            self.lakes[lake.fw_id] = lake


    def load_campsites(self,filename):
        camp_df = gpd.read_parquet(filename)
        unmatched = []
        for _, row in camp_df.iterrows():

            campsite = Campsite(

                camp_id=row["camp_id"],

                site_number=row["CSITENO"],

                lake_name=row["LAKE_NAME"],

                fw_id=row["fw_id"],

                status=row["STATUS"],

                district=row["District"],

                distance_to_lake=row["distance_to_lake"],

                geometry=row.geometry

            )

            self.campsites[campsite.camp_id] = campsite


    def connect_campsites(self):

        for campsite in self.campsites.values():

            if campsite.fw_id in self.lakes:
                lake = self.lakes[campsite.fw_id]

                campsite.lake = lake

                lake.campsites.append(campsite)

    def load_portages(self, filename):
        portage_df = gpd.read_parquet(filename)

        for _, row in portage_df.iterrows():

            lake_a = self.lakes.get(row["fw_id_a"])
            lake_b = self.lakes.get(row["fw_id_b"])

            if lake_a is None or lake_b is None:
                continue

            portage = Portage(
                Lake_a=lake_a,
                Lake_b=lake_b,
                length_rods=row["rods"],
                geometry=row.geometry,
                lake_match_uncertain=row["lake_match_uncertain"],
                portage_number=row["portage_number"],
                usfs_id=row["usfs_id"],
                waterbody=row["waterbody"],
                dist_lake_a=row["dist_lake_a"],
                dist_lake_b=row["dist_lake_b"]
            )

            self.portages.append(portage)

    def connect_portages(self):

        for portage in self.portages:

            portage.Lake_a.connections.append(portage)
            portage.Lake_b.connections.append(portage)

    def load_rivers(self, filename):
        river_df = gpd.read_parquet(filename)

        for _, row in river_df.iterrows():

            river = River(
                node_a=row["node_a"],
                node_b=row["node_b"],
                length_m=row["length_m"],
                geometry=row.geometry,
                strm_type=row["strm_type"],
                routable=row["routable"],
                name=row["name"],
                Lake_a=self.lakes.get(row["fw_id_a"]),
                Lake_b=self.lakes.get(row["fw_id_b"]),
                dist_lake_a=row["dist_lake_a"],
                dist_lake_b=row["dist_lake_b"]
            )

            self.rivers.append(river)

    def connect_rivers(self):

        for river in self.rivers:

            if river.Lake_a is not None:
                river.Lake_a.connections.append(river)

            if river.Lake_b is not None:
                river.Lake_b.connections.append(river)

    def find_lake(self, fw_id):

        return self.lakes.get(fw_id)

    def find_lake_by_name(self, name):

        for lake in self.lakes.values():

            if lake.name.lower() == name.lower():
                return lake

        return None