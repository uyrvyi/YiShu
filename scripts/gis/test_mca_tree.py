import copy
import hashlib
from html import escape
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import verify_mca_tree as verifier


def node(code, name, children=""):
    return '<div class="layui-tree-set" data-id="' + escape(code, quote=True) + \
        '"><div><span class="layui-tree-txt">' + escape(name) + '</span></div><div>' + children + '</div></div>'


def tree(provinces):
    return '<div id="xzqhTree">' + node("00", "中国", provinces) + '</div>'


class McaTreeTests(unittest.TestCase):
    def fixture(self):
        return tree(node("13", "河北省", node("1306", "保定市", node("130606", "莲池区"))) +
                    node("31", "上海市", node("310101", "黄浦区") + node("310115", "浦东新区")) +
                    node("41", "河南省", node("419001", "济源市")) +
                    node("44", "广东省", node("4419", "东莞市")) +
                    node("81", "香港特别行政区") + node("82", "澳门特别行政区") +
                    node("资料暂缺", "台湾省"))

    def test_reads_collapsed_tree_names_codes_and_real_parents(self):
        provinces, regions = verifier.parse_tree(self.fixture())
        self.assertEqual(provinces, {"13", "31", "41", "44"})
        self.assertEqual(len(regions), 5)
        by_code = {r["code"]: r for r in regions}
        self.assertEqual(by_code["130606"]["city"], "保定市")
        self.assertEqual(by_code["310115"]["city"], "上海市")
        self.assertEqual(by_code["419001"]["city"], "济源市")
        self.assertEqual(by_code["441900"]["kind"], "city")
        self.assertEqual(by_code["441900"]["district"], "东莞市")

    def test_rejects_duplicate_code_even_if_display_name_matches(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            verifier.parse_tree(tree(node("31", "上海市", node("310101", "黄浦区") * 2)))

    def test_rejects_wrong_province_or_city_parent(self):
        for provinces in (node("13", "河北省", node("3505", "泉州市", node("350527", "金门县"))),
                          node("13", "河北省", node("1306", "保定市", node("130502", "襄都区")))):
            with self.subTest(provinces=provinces), self.assertRaisesRegex(ValueError, "parent_invalid"):
                verifier.parse_tree(tree(provinces))

    def test_rejects_unknown_empty_city_and_fake_direct_county(self):
        for provinces in (node("13", "河北省", node("1306", "保定市")),
                          node("31", "上海市", node("310100", "市辖区"))):
            with self.subTest(provinces=provinces), self.assertRaises(ValueError):
                verifier.parse_tree(tree(provinces))

    def test_does_not_treat_township_as_county(self):
        with self.assertRaisesRegex(ValueError, "district_parent_invalid"):
            verifier.parse_tree(tree(node("31", "上海市", node("310101", "黄浦区", node("310101002", "南京东路街道")))))

    def test_rejects_missing_tree_duplicate_tree_empty_name_and_wrong_root(self):
        for html in ("<div></div>", self.fixture() * 2,
                     self.fixture().replace("莲池区", ""), self.fixture().replace("中国", "世界")):
            with self.subTest(html=html[:100]), self.assertRaises(ValueError):
                verifier.parse_tree(html)

    def test_unavailable_placeholder_is_explicit_not_a_fake_numeric_code(self):
        for provinces in (node("资料暂缺", "其他地区"), node("81", "香港特别行政区", node("810101", "假区"))):
            with self.subTest(provinces=provinces), self.assertRaisesRegex(ValueError, "placeholder_invalid"):
                verifier.parse_tree(tree(provinces))

    def test_comparison_requires_every_identity_field(self):
        _, official = verifier.parse_tree(self.fixture())
        self.assertTrue(all(r["result"] == "match" for r in verifier.compare_catalog(official, official)))
        for field in ("province", "provinceCode", "city", "cityCode", "district", "kind"):
            candidate = copy.deepcopy(official)
            candidate[0][field] = "changed"
            with self.subTest(field=field):
                self.assertEqual(verifier.compare_catalog(official, candidate)[0]["result"], "identity_mismatch")

    def test_missing_extra_or_duplicate_candidate_is_not_pass(self):
        _, official = verifier.parse_tree(self.fixture())
        results = verifier.compare_catalog(official, official[1:])
        self.assertEqual(results[0]["result"], "missing_candidate")
        extra = {**official[0], "code": "130607"}
        results = verifier.compare_catalog(official, [*official, extra])
        self.assertTrue(any(r["result"] == "absent_from_official_tree" for r in results))
        with self.assertRaisesRegex(ValueError, "duplicate_code"):
            verifier.compare_catalog(official, [*official, official[0]])

    def test_changed_snapshot_and_unverified_origin_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "source.html"
            content = self.fixture().encode()
            path.write_bytes(content)
            with self.assertRaisesRegex(ValueError, "source_sha_mismatch"):
                verifier.load_snapshot(path)
            with patch.object(verifier, "SOURCE_SHA256", hashlib.sha256(content).hexdigest()):
                with self.assertRaisesRegex(ValueError, "source_origin_mismatch"):
                    verifier.load_snapshot(path)


if __name__ == "__main__":
    unittest.main()
