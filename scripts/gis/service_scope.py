"""User-confirmed business exclusions, not administrative or geometry corrections."""

import hashlib
import json
from pathlib import Path

POLICY_PATH = Path(__file__).resolve().parents[2] / "packages/shared/src/service-scope.json"
PREVIOUS_APPROVED_SCOPE = {
    "version": 1, "revision": "service-scope-20261006",
    "authority": "user_confirmed_service_availability",
    "unavailableProvinces": [{"code": "71", "name": "台湾省"},
                             {"code": "81", "name": "香港特别行政区"},
                             {"code": "82", "name": "澳门特别行政区"}],
    "unavailableDistricts": [{"code": "350527", "name": "金门县"}],
    "sha256": "bb8e3ebd4173b08cc38dc682a516bbf378fea4250910783663662f72de4608d4",
}


def load_service_scope():
    content = POLICY_PATH.read_bytes()
    policy = json.loads(content)
    if policy != {
        "version": 1, "revision": "service-scope-20261006-r2",
        "authority": "user_confirmed_service_availability",
        "unavailableProvinces": [{"code": "71", "name": "台湾省"},
                                 {"code": "81", "name": "香港特别行政区"},
                                 {"code": "82", "name": "澳门特别行政区"}],
        "unavailableDistricts": [{"code": "350527", "name": "金门县"},
                                 {"code": "460303", "name": "南沙区", "province": "海南省", "city": "三沙市",
                                  "legacyCodes": ["460322"], "legacyNames": ["南沙群岛"]}],
    }:
        raise ValueError("unapproved_service_scope")
    return {**policy, "sha256": hashlib.sha256(content).hexdigest()}


def unavailable_codes(regions, scope):
    if scope is None:
        return set()
    if scope != load_service_scope() and scope != PREVIOUS_APPROVED_SCOPE:
        raise ValueError("service_scope_evidence_invalid")
    provinces = {row["code"] for row in scope["unavailableProvinces"]}
    districts = {row["code"] for row in scope["unavailableDistricts"]}
    return {row["code"] for row in regions if row["code"][:2] in provinces or row["code"] in districts}
