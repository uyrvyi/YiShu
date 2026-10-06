import unittest

from verify_fujian_catalog import compare_catalog, parse_table


HTML = """<table>
<tr><td>福建省</td><td>350000</td></tr>
<tr><td>泉州市</td><td>350500</td></tr>
<tr><td>金门县</td><td>350527</td></tr>
<tr><td>不参与县级清单的乡镇</td><td>350527100</td></tr>
</table>"""
REGION = {"provinceCode": "35", "province": "福建省", "cityCode": "3505",
          "city": "泉州市", "district": "金门县", "code": "350527", "kind": "county"}


class FujianCatalogTests(unittest.TestCase):
    def test_parses_name_before_code_and_ignores_townships(self):
        identities = parse_table(HTML)
        self.assertEqual(len(identities), 3)
        self.assertEqual(compare_catalog(identities, [REGION])[0]["result"], "match")

    def test_rejects_duplicate_source_code(self):
        with self.assertRaisesRegex(ValueError, "duplicate_official_code"):
            parse_table(HTML + "<table><tr><td>金门县</td><td>350527</td></tr></table>")

    def test_rejects_unexpected_layout(self):
        with self.assertRaisesRegex(ValueError, "unexpected_official_table_layout"):
            parse_table(HTML.replace("<td>金门县</td><td>350527</td>", "<td>350527</td><td>金门县</td>"))

    def test_rejects_missing_parent(self):
        with self.assertRaisesRegex(ValueError, "official_city_parent_missing"):
            parse_table(HTML.replace("<tr><td>泉州市</td><td>350500</td></tr>", ""))

    def test_missing_and_extra_counties_do_not_match(self):
        checks = compare_catalog(parse_table(HTML), [{**REGION, "code": "350528"}])
        self.assertEqual([c["result"] for c in checks], ["missing_candidate", "not_in_official_table"])

    def test_name_parent_and_kind_mismatches_rejected(self):
        for field, value in [("district", "开发区"), ("city", "莆田市"), ("cityCode", "3503"), ("kind", "city")]:
            with self.subTest(field=field):
                checks = compare_catalog(parse_table(HTML), [{**REGION, field: value}])
                self.assertEqual(checks[0]["result"], "name_kind_or_parent_mismatch")

    def test_duplicate_candidate_code_rejected(self):
        with self.assertRaisesRegex(ValueError, "candidate_duplicate_code"):
            compare_catalog(parse_table(HTML), [REGION, REGION])


if __name__ == "__main__":
    unittest.main()
