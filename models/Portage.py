from dataclasses import dataclass

from models.Lake import Lake


@dataclass
class Portage:
    Lake_a: Lake
    Lake_b: Lake
    length_rods: float
    geometry: object
    lake_match_uncertain: bool
    portage_number: int = None
    usfs_id: int = None
    waterbody: str = None
    dist_lake_a: float = None
    dist_lake_b: float = None
