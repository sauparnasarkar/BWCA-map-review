from dataclasses import dataclass

from models.Lake import Lake


@dataclass
class River:
    node_a: str
    node_b: str
    length_m: float
    geometry: object
    strm_type: str
    routable: bool
    name: str = None
    Lake_a: Lake = None
    Lake_b: Lake = None
    dist_lake_a: float = None
    dist_lake_b: float = None
