from pipeline.radar_sectors import ray_land, widest_sector

class HalfPlane:
    """Land wherever lon < 0: a straight north-south coast through the radar."""
    def _hits(self, p):
        return p.x < 0

def test_ray_land_on_a_straight_coast_is_half_sea_and_the_land_sector_is_the_west():
    share = ray_land(HalfPlane(), 0.0, 0.0)
    assert share[:180] == [0.0] * 180 and share[180:] == [1.0] * 180
    assert widest_sector(share) == (180, 360)

def test_widest_sector_takes_the_widest_run_and_never_wraps_north():
    share = [1.0] * 10 + [0.0] * 300 + [1.0] * 50          # land 0-10 and 310-360: one arc across north
    assert widest_sector(share) == (310, 360)               # the wider piece; vol2bird 0.5 cannot wrap
    assert widest_sector([0.95] * 360) == (0, 360) and widest_sector([0.5] * 360) is None
    assert widest_sector([0.9] * 5 + [0.89] * 355) == (0, 5)   # LAND_MIN is inclusive

class BeyondKm:
    """Land only farther than km from (0, 0): every ray is part sea, part land."""
    def __init__(self, km):
        self.km = km
    def _hits(self, p):
        import math
        return math.hypot(p.x, p.y) * 111.32 > self.km

def test_ray_land_weights_each_sample_by_its_range_as_the_ring_area_does():
    share = ray_land(BeyondKm(20.5), 0.0, 0.0)
    assert all(abs(s - 420 / 620) < 1e-9 for s in share)          # ranges 21-35 of 5-35; unweighted 15/31
