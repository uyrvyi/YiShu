# 金门公开矢量来源核验

核验日期：2026-10-06。仅为隔离数据研究；未修改线上地图、地区选项、端点或运单。

## 已取得的数据

提供机构：内政部国土测绘中心。原始下载入口：[国土测绘图资服务云](https://maps.nlsc.gov.tw/pro/download.jsp)。

| 项目 | 官方数据集 | 下载页版本 | 下载页更新日期 | 本地原始文件 |
| --- | --- | --- | --- | --- |
| 县市界 | [直辖市、县市界线](https://data.gov.tw/dataset/7442) | 2020/8 | 2025-11-18 | `.local/regions/nlsc-county-20261006.zip` |
| 乡镇界 | [乡镇市区界线](https://data.gov.tw/dataset/7441) | 2023/3/23 | 2025-11-18 | `.local/regions/nlsc-town-20261006.zip` |

下载页更新日不代表重新测绘日；不能称这些文件为 2026 年新测绘数据。ZIP 内县界文件为 `COUNTY_MOI_1090820`，乡镇文件为 `TOWN_MOI_1120317`。乡镇包另带马家／三和修正文件，不涉及本次金门选择。

原始 SHA-256：

```text
county 0c6fca34a92b92ef3e9a41957e403cb89e814bb64942ca7c7e51c746f913d49d
town   e028e5a750eee48cf7913330655e5e5c5bb1f176868fbd0afdfc661fca60557c
```

## 实际提取结果

- 县名 `金門縣`、来源县码 `09020`；取得 1 个县级 MultiPolygon、43 个多边形部件、6733 个顶点。
- 六个乡镇：金城镇 `09020010`、金沙镇 `09020020`、金湖镇 `09020030`、金宁乡 `09020040`、烈屿乡 `09020050`、乌坵乡 `09020060`。原始名称与代码逐项保留，不转换成大陆县级代码。
- 县界与六乡镇共 7 个要素的原始及转换后几何均通过非空、类型、有效性检查。没有简化、描边、修复、吸附或删去乌坵。
- 两包 PRJ 都识别为 `EPSG:3824`。使用 pyproj 的非 ballpark、经度／纬度顺序转换到 `EPSG:4326`；转换操作标称精度 1 米不等于源边界本身精度 1 米。乡镇 XML 标记 Big5，但实际 DBF 为 UTF-8，已按实际字节严格解码。
- 将两版文件统一投影到 `EPSG:3825` 后，县界与六乡镇合并轮廓的对称差面积约 `0.075147 km²`，约县界面积的 `0.04068%`。乡镇之间未测得正面积重叠。不同版本的轮廓仍有差异，不宣称严格同源对齐。

提取文件：`.local/maps/kinmen-nlsc-20261006/kinmen-nlsc-wgs84.geojson`，含县界和全部六个乡镇。SHA-256 为 `06fdd17d3cda47f3b34bf12d8185c8a0ecd34a1396ceeeae761b31e68fe490f9`。完整核验报告见 `data/maps/audit/kinmen-nlsc-20261006/inspection.json`；文件未接入公开瓦片。

## 许可与归属

两数据集注明免费及[政府资料开放授权条款第1版](https://data.gov.tw/license)。派生物必须保留提供机构、数据名称／版本及许可链接的署名；许可不表示提供机构批准本项目的行政归属、地图发布或审核。提取文件及报告已附署名。

来源县范围含乌坵，不能未经核验直接等同项目中的泉州市金门县 `350527`。当前完整保留来源县及六乡镇，范围映射保持 pending，不篡改 OSM 行政层级或对象 ID。本次来源也不能补证三沙南沙区 `460303`。

补查了[泉州市民政局县情说明](https://www.quanzhou.gov.cn/zfb/zjqz/xsqgk/201709/t20170906_527728.htm)、[福建省 2026 年 6 月代码表](https://mzt.fujian.gov.cn/gk/tzgg/202607/t20260710_7176497.htm)，以及金门县文化局所公开县志的行政区域章节（PDF 第 13 页、印刷页 213）。县志区分五个乡镇和另代管的乌坵，代码表确认项目身份仍是泉州市金门县 `350527`。原件 SHA 和核对页码见 `data/maps/audit/kinmen-nlsc-20261006/scope-evidence.json`。历史描述不等于完整现行县界，县情文字的面积也不能直接等于行政多边形面积；所以没有凭这两条说明自动删去乌坵并关闭门禁。

## 复现

```sh
docker build -f scripts/gis/Dockerfile.nlsc -t yishu-gis-nlsc:local .
docker run --rm --init --network none -v "$PWD:/workspace" yishu-gis-nlsc:local python scripts/gis/inspect_kinmen_source.py
docker run --rm --init --network none -v "$PWD:/workspace:ro" yishu-gis-nlsc:local python -m unittest discover -s scripts/gis -p test_kinmen_source.py -v
```

提取过程对原始 ZIP SHA、坐标系、县码、六乡镇名称／代码和有效几何执行拒绝式检查。ZIP 内文件直接读入内存，不展开路径、不执行包内程序。
