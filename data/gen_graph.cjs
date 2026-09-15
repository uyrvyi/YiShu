// 确定性生成版本化静态路网数据（Phase 4 静态数据，非运行时依赖）。
//
// 生成（每个 graphVersion 一个目录）：
//   data/graphs/<version>/{station_nodes,route_edges,region_station_map}.json
//   data/graphs/registry.json（versions 稳定顺序 + defaultVersion）
//
// 版本策略（Phase 8「Yangquan 修复」）：
// - `china-v1` = Phase 4 冻结基线，**字节冻结**：重新生成出现任何字节差异都视为回归。
// - `china-v2` = 同一算法 + 唯一获批坐标修正（VERSION_OVERRIDES.yangquan）。
//   由修正自然导致的 mapX/mapY、Haversine 距离、最近邻边与 edge.distanceKm 变化属于正常结果。
// - 所有版本共用同一份 BASE_RAW，差异只在 VERSION_OVERRIDES 声明（禁止第二份 RAW）。
//
// 坐标系：mapX/mapY 由 `./map_projection.cjs`（canonical helper）投影，与 map 生成链共用同一公式。
//
// 用法：
//   node data/gen_graph.cjs                  # 写入 data/graphs/（含 registry + 校验报告）
//   node data/gen_graph.cjs --out-root=<dir> # 写入 <dir>（不改仓库数据；供字节一致性测试使用）
//
// 仅使用真实中国城市经纬度（近似），不依赖任何外部 API。
const fs = require("fs");
const path = require("path");
const prettier = require("prettier");
const { projectStation } = require("./map_projection.cjs");

// 中国主要城市基线：[id, name, province, city, lat, lng]
// id 使用城市拼音（稳定、唯一）。**不得原地修改**：版本差异只在 VERSION_OVERRIDES 声明。
const BASE_RAW = [
  ["beijing", "北京", "北京市", "北京市", 39.9042, 116.4074],
  ["tianjin", "天津", "天津市", "天津市", 39.3434, 117.3616],
  ["chongqing", "重庆", "重庆市", "重庆市", 29.563, 106.5514],
  ["shijiazhuang", "石家庄", "河北省", "石家庄市", 38.0428, 114.5149],
  ["tangshan", "唐山", "河北省", "唐山市", 39.6354, 118.1789],
  ["handan", "邯郸", "河北省", "邯郸市", 36.6259, 114.5391],
  ["baoding", "保定", "河北省", "保定市", 38.8731, 115.4645],
  ["zhangjiakou", "张家口", "河北省", "张家口市", 40.8114, 114.8883],
  ["langfang", "廊坊", "河北省", "廊坊市", 39.5385, 116.6836],
  ["chengde", "承德", "河北省", "承德市", 40.9879, 117.9622],
  ["qinhuangdao", "秦皇岛", "河北省", "秦皇岛市", 39.9359, 119.6008],
  ["cangzhou", "沧州", "河北省", "沧州市", 38.3045, 116.8388],
  ["xingtai", "邢台", "河北省", "邢台市", 37.0706, 114.5046],
  ["hengshui", "衡水", "河北省", "衡水市", 37.7352, 115.6653],
  ["taiyuan", "太原", "山西省", "太原市", 37.8706, 112.5489],
  ["datong", "大同", "山西省", "大同市", 37.6584, 113.3001],
  ["linfen", "临汾", "山西省", "临汾市", 36.0884, 111.5181],
  ["yuncheng", "运城", "山西省", "运城市", 34.9978, 110.9935],
  ["changzhi", "长治", "山西省", "长治市", 36.3435, 113.1151],
  ["yangquan", "阳泉", "山西省", "阳泉市", 35.1975, 113.5841],
  ["jinzhong", "晋中", "山西省", "晋中市", 37.6911, 112.7444],
  ["lvliang", "吕梁", "山西省", "吕梁市", 37.5039, 111.1348],
  ["xinzhou", "忻州", "山西省", "忻州市", 38.417, 112.7349],
  ["huhehaote", "呼和浩特", "内蒙古自治区", "呼和浩特市", 40.8424, 111.7491],
  ["baotou", "包头", "内蒙古自治区", "包头市", 40.6573, 109.8404],
  ["wuhai", "乌海", "内蒙古自治区", "乌海市", 39.6554, 106.8025],
  ["chifeng", "赤峰", "内蒙古自治区", "赤峰市", 42.2571, 118.8919],
  ["tongliao", "通辽", "内蒙古自治区", "通辽市", 43.6518, 122.2734],
  ["ordos", "鄂尔多斯", "内蒙古自治区", "鄂尔多斯市", 39.6083, 109.7813],
  ["shenyang", "沈阳", "辽宁省", "沈阳市", 41.8057, 123.4315],
  ["dalian", "大连", "辽宁省", "大连市", 38.914, 121.6147],
  ["anshan", "鞍山", "辽宁省", "鞍山市", 41.1108, 122.9957],
  ["fushun", "抚顺", "辽宁省", "抚顺市", 41.8807, 123.9448],
  ["jinzhou", "锦州", "辽宁省", "锦州市", 41.0999, 121.1473],
  ["dandong", "丹东", "辽宁省", "丹东市", 40.1266, 124.3899],
  ["liaoyang", "辽阳", "辽宁省", "辽阳市", 41.2711, 123.1679],
  ["yingkou", "营口", "辽宁省", "营口市", 40.6674, 122.2351],
  ["fuxin", "阜新", "辽宁省", "阜新市", 42.0111, 121.6724],
  ["tieling", "铁岭", "辽宁省", "铁岭市", 42.2926, 123.8413],
  ["chaoyang", "朝阳", "辽宁省", "朝阳市", 41.5706, 120.4491],
  ["panjin", "盘锦", "辽宁省", "盘锦市", 41.1191, 122.0697],
  ["benxi", "本溪", "辽宁省", "本溪市", 41.2998, 123.7352],
  ["changchun", "长春", "吉林省", "长春市", 43.8171, 125.3235],
  ["jilin", "吉林", "吉林省", "吉林市", 43.8379, 126.5495],
  ["siping", "四平", "吉林省", "四平市", 43.1696, 124.3645],
  ["liaoyuan", "辽源", "吉林省", "辽源市", 42.9026, 125.1506],
  ["tonghua", "通化", "吉林省", "通化市", 41.7437, 125.9389],
  ["baicheng", "白城", "吉林省", "白城市", 45.611, 122.8353],
  ["songyuan", "松原", "吉林省", "松原市", 45.1425, 124.8236],
  ["baishan", "白山", "吉林省", "白山市", 41.9418, 126.4279],
  ["haerbin", "哈尔滨", "黑龙江省", "哈尔滨市", 45.8038, 126.5347],
  ["qiqihar", "齐齐哈尔", "黑龙江省", "齐齐哈尔市", 47.3542, 123.9171],
  ["jixi", "鸡西", "黑龙江省", "鸡西市", 45.3056, 130.9326],
  ["hegang", "鹤岗", "黑龙江省", "鹤岗市", 47.3481, 130.2907],
  ["shuangyashan", "双鸭山", "黑龙江省", "双鸭山市", 46.6468, 131.1431],
  ["daqing", "大庆", "黑龙江省", "大庆市", 46.5883, 125.1036],
  ["yichun", "伊春", "黑龙江省", "伊春市", 47.7239, 128.9156],
  ["jiamusi", "佳木斯", "黑龙江省", "佳木斯市", 46.8069, 130.3646],
  ["qitaihe", "七台河", "黑龙江省", "七台河市", 45.2234, 131.0152],
  ["mudanjiang", "牡丹江", "黑龙江省", "牡丹江市", 44.5516, 129.6429],
  ["heihe", "黑河", "黑龙江省", "黑河市", 50.2451, 127.5236],
  ["suihua", "绥化", "黑龙江省", "绥化市", 46.6403, 126.9747],
  ["shanghai", "上海", "上海市", "上海市", 31.2304, 121.4737],
  ["nanjing", "南京", "江苏省", "南京市", 32.0603, 118.7969],
  ["suzhou", "苏州", "江苏省", "苏州市", 31.2989, 120.5853],
  ["wuxi", "无锡", "江苏省", "无锡市", 31.4912, 120.3119],
  ["changzhou", "常州", "江苏省", "常州市", 31.811, 119.974],
  ["xuzhou", "徐州", "江苏省", "徐州市", 34.2618, 117.185],
  ["nantong", "南通", "江苏省", "南通市", 31.9802, 120.8943],
  ["lianyungang", "连云港", "江苏省", "连云港市", 34.5967, 119.222],
  ["yancheng", "盐城", "江苏省", "盐城市", 33.3776, 120.1984],
  ["yangzhou", "扬州", "江苏省", "扬州市", 32.3941, 119.4083],
  ["zhenjiang", "镇江", "江苏省", "镇江市", 32.2109, 119.4492],
  ["taizhoujs", "泰州", "江苏省", "泰州市", 32.4597, 119.9271],
  ["suqian", "宿迁", "江苏省", "宿迁市", 33.9602, 118.2858],
  ["huai'an", "淮安", "江苏省", "淮安市", 33.6103, 119.0188],
  ["hangzhou", "杭州", "浙江省", "杭州市", 30.2741, 120.1551],
  ["ningbo", "宁波", "浙江省", "宁波市", 29.872, 121.5503],
  ["wenzhou", "温州", "浙江省", "温州市", 27.9938, 120.6994],
  ["jiaxing", "嘉兴", "浙江省", "嘉兴市", 30.7461, 120.7686],
  ["huzhou", "湖州", "浙江省", "湖州市", 30.8946, 120.0853],
  ["shaoxing", "绍兴", "浙江省", "绍兴市", 30.0027, 120.5813],
  ["jinhua", "金华", "浙江省", "金华市", 29.0895, 119.6542],
  ["quzhou", "衢州", "浙江省", "衢州市", 28.9417, 118.8718],
  ["taizhouzj", "台州", "浙江省", "台州市", 28.6564, 121.4288],
  ["lishui", "丽水", "浙江省", "丽水市", 28.4576, 119.9217],
  ["zhoushan", "舟山", "浙江省", "舟山市", 30.0285, 122.2109],
  ["hefei", "合肥", "安徽省", "合肥市", 31.8206, 117.2272],
  ["wuhu", "芜湖", "安徽省", "芜湖市", 31.3524, 118.4345],
  ["bangbu", "蚌埠", "安徽省", "蚌埠市", 32.9155, 117.3896],
  ["huainan", "淮南", "安徽省", "淮南市", 32.6266, 116.998],
  ["ma'anshan", "马鞍山", "安徽省", "马鞍山市", 31.6885, 118.5069],
  ["huaibei", "淮北", "安徽省", "淮北市", 33.9599, 116.7914],
  ["tongling", "铜陵", "安徽省", "铜陵市", 30.9459, 117.8125],
  ["anqing", "安庆", "安徽省", "安庆市", 30.5083, 117.0477],
  ["huangshan", "黄山", "安徽省", "黄山市", 29.7152, 118.3406],
  ["fuling", "阜阳", "安徽省", "阜阳市", 32.8969, 115.8193],
  ["suzhouah", "宿州", "安徽省", "宿州市", 33.6339, 116.9847],
  ["lu'an", "六安", "安徽省", "六安市", 31.7526, 116.5211],
  ["bozhou", "亳州", "安徽省", "亳州市", 33.852, 115.781],
  ["chizhou", "池州", "安徽省", "池州市", 30.6567, 117.4852],
  ["xuancheng", "宣城", "安徽省", "宣城市", 30.9457, 118.7605],
  ["fuzhou", "福州", "福建省", "福州市", 26.0745, 119.2965],
  ["xiamen", "厦门", "福建省", "厦门市", 24.4798, 118.0894],
  ["putian", "莆田", "福建省", "莆田市", 25.4512, 119.0069],
  ["sanming", "三明", "福建省", "三明市", 26.2654, 117.6256],
  ["quanzhou", "泉州", "福建省", "泉州市", 24.8741, 118.6757],
  ["zhangzhou", "漳州", "福建省", "漳州市", 24.5133, 117.6753],
  ["nanping", "南平", "福建省", "南平市", 26.6359, 118.1777],
  ["longyan", "龙岩", "福建省", "龙岩市", 25.0751, 117.0145],
  ["ningde", "宁德", "福建省", "宁德市", 26.9963, 119.5503],
  ["nanchang", "南昌", "江西省", "南昌市", 28.6829, 115.8579],
  ["jingdezhen", "景德镇", "江西省", "景德镇市", 29.2951, 117.1794],
  ["pingxiang", "萍乡", "江西省", "萍乡市", 27.6229, 113.8526],
  ["jiujiang", "九江", "江西省", "九江市", 29.7121, 115.9928],
  ["xinyu", "新余", "江西省", "新余市", 27.8176, 114.9212],
  ["yingtan", "鹰潭", "江西省", "鹰潭市", 28.2633, 117.0537],
  ["ganzhou", "赣州", "江西省", "赣州市", 25.851, 114.9403],
  ["ji'an", "吉安", "江西省", "吉安市", 27.1173, 114.9861],
  ["yichunjx", "宜春", "江西省", "宜春市", 27.8106, 114.3925],
  ["fuzhoujx", "抚州", "江西省", "抚州市", 27.9685, 116.3579],
  ["shangrao", "上饶", "江西省", "上饶市", 28.4543, 117.9378],
  ["jinan", "济南", "山东省", "济南市", 36.6512, 117.1201],
  ["qingdao", "青岛", "山东省", "青岛市", 36.0671, 120.3826],
  ["zibo", "淄博", "山东省", "淄博市", 36.8131, 118.0547],
  ["zaozhuang", "枣庄", "山东省", "枣庄市", 34.8652, 117.5577],
  ["dongying", "东营", "山东省", "东营市", 37.4339, 118.6747],
  ["yantai", "烟台", "山东省", "烟台市", 37.4638, 121.4478],
  ["weifang", "潍坊", "山东省", "潍坊市", 36.7065, 119.1583],
  ["jining", "济宁", "山东省", "济宁市", 35.4154, 116.5869],
  ["taian", "泰安", "山东省", "泰安市", 36.2012, 117.0904],
  ["weihai", "威海", "山东省", "威海市", 37.5101, 122.1136],
  ["rizhao", "日照", "山东省", "日照市", 35.4275, 119.4555],
  ["binzhou", "滨州", "山东省", "滨州市", 37.3832, 117.9709],
  ["dezhou", "德州", "山东省", "德州市", 37.4355, 116.3618],
  ["liaocheng", "聊城", "山东省", "聊城市", 36.4569, 115.9804],
  ["linyi", "临沂", "山东省", "临沂市", 35.1047, 118.3569],
  ["heze", "菏泽", "山东省", "菏泽市", 35.2338, 115.4809],
  ["laizhou", "莱州", "山东省", "莱州市", 37.0879, 119.9426],
  ["zhengzhou", "郑州", "河南省", "郑州市", 34.7466, 113.6254],
  ["kaifeng", "开封", "河南省", "开封市", 34.7973, 114.3074],
  ["luoyang", "洛阳", "河南省", "洛阳市", 34.6192, 112.454],
  ["pingdingshan", "平顶山", "河南省", "平顶山市", 33.7398, 113.3286],
  ["anyang", "安阳", "河南省", "安阳市", 36.1014, 114.3917],
  ["hebi", "鹤壁", "河南省", "鹤壁市", 35.7488, 114.2951],
  ["xinxiang", "新乡", "河南省", "新乡市", 35.303, 113.9267],
  ["jiaozuo", "焦作", "河南省", "焦作市", 35.2399, 113.2413],
  ["puyang", "濮阳", "河南省", "濮阳市", 35.7642, 115.0166],
  ["xuchang", "许昌", "河南省", "许昌市", 34.0356, 113.846],
  ["luohe", "漯河", "河南省", "漯河市", 33.5818, 114.0161],
  ["sanmenxia", "三门峡", "河南省", "三门峡市", 34.7783, 111.1945],
  ["nanyang", "南阳", "河南省", "南阳市", 32.9905, 112.5317],
  ["shangqiu", "商丘", "河南省", "商丘市", 34.4069, 115.6511],
  ["xinyang", "信阳", "河南省", "信阳市", 32.1437, 114.0913],
  ["zhoukou", "周口", "河南省", "周口市", 33.6306, 114.6971],
  ["zhumadian", "驻马店", "河南省", "驻马店市", 33.0115, 114.0247],
  ["wuhan", "武汉", "湖北省", "武汉市", 30.5928, 114.3055],
  ["huangshi", "黄石", "湖北省", "黄石市", 30.2006, 115.0359],
  ["shiyan", "十堰", "湖北省", "十堰市", 31.8511, 110.7765],
  ["yichang", "宜昌", "湖北省", "宜昌市", 30.6912, 111.2868],
  ["xiangyang", "襄阳", "湖北省", "襄阳市", 32.0101, 112.1226],
  ["ezhou", "鄂州", "湖北省", "鄂州市", 30.3964, 114.8907],
  ["jingzhou", "荆州", "湖北省", "荆州市", 30.3379, 112.2388],
  ["jingmen", "荆门", "湖北省", "荆门市", 31.0351, 112.2042],
  ["xiaogan", "孝感", "湖北省", "孝感市", 30.9239, 113.9353],
  ["huanggang", "黄冈", "湖北省", "黄冈市", 30.4537, 114.8715],
  ["xianning", "咸宁", "湖北省", "咸宁市", 29.8328, 114.2792],
  ["suizhou", "随州", "湖北省", "随州市", 31.6907, 113.3729],
  ["enshi", "恩施", "湖北省", "恩施土家族苗族自治州", 30.2831, 109.4961],
  ["changsha", "长沙", "湖南省", "长沙市", 28.2282, 112.9388],
  ["zhuzhou", "株洲", "湖南省", "株洲市", 27.8296, 113.1345],
  ["xiangtan", "湘潭", "湖南省", "湘潭市", 27.8297, 112.9441],
  ["hengyang", "衡阳", "湖南省", "衡阳市", 26.8904, 112.6192],
  ["shaoyang", "邵阳", "湖南省", "邵阳市", 27.2443, 111.5006],
  ["yueyang", "岳阳", "湖南省", "岳阳市", 29.357, 113.1325],
  ["changde", "常德", "湖南省", "常德市", 29.0318, 111.6989],
  ["zhangjiajie", "张家界", "湖南省", "张家界市", 29.1171, 110.4793],
  ["yiyang", "益阳", "湖南省", "益阳市", 28.5546, 112.3558],
  ["chenzhou", "郴州", "湖南省", "郴州市", 25.7701, 113.0123],
  ["yongzhou", "永州", "湖南省", "永州市", 26.4218, 111.6129],
  ["huaihua", "怀化", "湖南省", "怀化市", 27.5456, 109.9782],
  ["loudi", "娄底", "湖南省", "娄底市", 27.7069, 112.0078],
  ["guangzhou", "广州", "广东省", "广州市", 23.1291, 113.2644],
  ["shenzhen", "深圳", "广东省", "深圳市", 22.5431, 114.0579],
  ["zhuhai", "珠海", "广东省", "珠海市", 22.2711, 113.5767],
  ["shantou", "汕头", "广东省", "汕头市", 23.3544, 116.682],
  ["foshan", "佛山", "广东省", "佛山市", 23.0218, 113.1219],
  ["shaoguan", "韶关", "广东省", "韶关市", 24.8104, 113.7519],
  ["zhanjiang", "湛江", "广东省", "湛江市", 21.2707, 110.3594],
  ["zhaoqing", "肇庆", "广东省", "肇庆市", 23.0475, 112.4653],
  ["jiangmen", "江门", "广东省", "江门市", 22.5787, 113.0823],
  ["maoming", "茂名", "广东省", "茂名市", 21.6632, 110.9256],
  ["huizhou", "惠州", "广东省", "惠州市", 23.111, 114.416],
  ["meizhou", "梅州", "广东省", "梅州市", 24.2885, 116.1238],
  ["shanwei", "汕尾", "广东省", "汕尾市", 22.7866, 115.3451],
  ["heyuan", "河源", "广东省", "河源市", 23.7435, 114.6971],
  ["yangjiang", "阳江", "广东省", "阳江市", 21.8583, 111.982],
  ["qingyuan", "清远", "广东省", "清远市", 23.6823, 113.0866],
  ["zhongshan", "中山", "广东省", "中山市", 22.517, 113.392],
  ["dalian2", "东莞", "广东省", "东莞市", 23.021, 113.7518],
  ["chaozhou", "潮州", "广东省", "潮州市", 23.6593, 116.6227],
  ["jieyang", "揭阳", "广东省", "揭阳市", 23.5497, 116.379],
  ["yunfu", "云浮", "广东省", "云浮市", 22.9298, 112.0445],
  ["nanning", "南宁", "广西壮族自治区", "南宁市", 22.817, 108.3665],
  ["liuzhou", "柳州", "广西壮族自治区", "柳州市", 24.3309, 109.4423],
  ["guilin", "桂林", "广西壮族自治区", "桂林市", 25.2736, 110.2902],
  ["wuzhou", "梧州", "广西壮族自治区", "梧州市", 23.4738, 111.3356],
  ["beihai", "北海", "广西壮族自治区", "北海市", 21.4811, 109.1203],
  ["fangchenggang", "防城港", "广西壮族自治区", "防城港市", 21.6147, 108.3277],
  ["qinzhou", "钦州", "广西壮族自治区", "钦州市", 21.9986, 108.6314],
  ["guigang", "贵港", "广西壮族自治区", "贵港市", 23.0936, 109.5977],
  ["yulin", "玉林", "广西壮族自治区", "玉林市", 22.6546, 110.184],
  ["baise", "百色", "广西壮族自治区", "百色市", 23.8976, 106.615],
  ["hezhou", "贺州", "广西壮族自治区", "贺州市", 24.4148, 111.5527],
  ["hechi", "河池", "广西壮族自治区", "河池市", 24.6959, 108.0834],
  ["laibin", "来宾", "广西壮族自治区", "来宾市", 23.7337, 109.2268],
  ["chongzuo", "崇左", "广西壮族自治区", "崇左市", 22.3784, 107.3559],
  ["haikou", "海口", "海南省", "海口市", 20.0444, 110.1989],
  ["sanya", "三亚", "海南省", "三亚市", 18.2528, 109.5119],
  ["chengdu", "成都", "四川省", "成都市", 30.5728, 104.0668],
  ["zigong", "自贡", "四川省", "自贡市", 29.3392, 104.7784],
  ["panzhihua", "攀枝花", "四川省", "攀枝花市", 26.5823, 101.7184],
  ["luzhou", "泸州", "四川省", "泸州市", 28.8714, 105.4416],
  ["deyang", "德阳", "四川省", "德阳市", 31.1311, 104.3986],
  ["mianyang", "绵阳", "四川省", "绵阳市", 31.4688, 104.6791],
  ["guangyuan", "广元", "四川省", "广元市", 32.4389, 105.843],
  ["suining", "遂宁", "四川省", "遂宁市", 30.5374, 105.5734],
  ["neijiang", "内江", "四川省", "内江市", 29.5811, 105.0557],
  ["leshan", "乐山", "四川省", "乐山市", 29.5568, 103.7636],
  ["nanchong", "南充", "四川省", "南充市", 30.7955, 106.0847],
  ["meishan", "眉山", "四川省", "眉山市", 30.0484, 103.8469],
  ["yibin", "宜宾", "四川省", "宜宾市", 28.7526, 104.6433],
  ["guangan", "广安", "四川省", "广安市", 30.4511, 106.6337],
  ["dazhou", "达州", "四川省", "达州市", 31.2093, 107.5023],
  ["ya'an", "雅安", "四川省", "雅安市", 29.98, 103.005],
  ["bazhong", "巴中", "四川省", "巴中市", 31.861, 106.7511],
  ["ziyang", "资阳", "四川省", "资阳市", 30.1212, 104.6483],
  ["guiyang", "贵阳", "贵州省", "贵阳市", 26.6477, 106.6302],
  ["liupanshui", "六盘水", "贵州省", "六盘水市", 26.5823, 104.848],
  ["zunyi", "遵义", "贵州省", "遵义市", 27.7277, 106.9415],
  ["anshun", "安顺", "贵州省", "安顺市", 26.2477, 105.9325],
  ["bijie", "毕节", "贵州省", "毕节市", 27.3008, 105.2958],
  ["tongren", "铜仁", "贵州省", "铜仁市", 27.7184, 109.2398],
  ["kunming", "昆明", "云南省", "昆明市", 25.0389, 102.7183],
  ["qujing", "曲靖", "云南省", "曲靖市", 25.4902, 103.7984],
  ["yuxi", "玉溪", "云南省", "玉溪市", 24.3525, 102.5423],
  ["baoshan", "保山", "云南省", "保山市", 25.1118, 99.1671],
  ["zhaotong", "昭通", "云南省", "昭通市", 27.3381, 103.7167],
  ["ljiang", "丽江", "云南省", "丽江市", 26.8559, 100.2295],
  ["pu'er", "普洱", "云南省", "普洱市", 22.7773, 100.9721],
  ["lincang", "临沧", "云南省", "临沧市", 23.8864, 100.0865],
  ["chuxiong", "楚雄", "云南省", "楚雄彝族自治州", 25.0412, 101.5463],
  ["honghe", "红河", "云南省", "红河哈尼族彝族自治州", 23.3696, 103.3841],
  ["wenshan", "文山", "云南省", "文山壮族苗族自治州", 23.3696, 104.244],
  ["xishuangbanna", "西双版纳", "云南省", "西双版纳傣族自治州", 22.0017, 100.7972],
  ["dali", "大理", "云南省", "大理白族自治州", 25.6065, 100.2676],
  ["dehong", "德宏", "云南省", "德宏傣族景颇族自治州", 24.4366, 98.5857],
  ["lasa", "拉萨", "西藏自治区", "拉萨市", 29.65, 91.1],
  ["rikaze", "日喀则", "西藏自治区", "日喀则市", 29.2667, 88.8833],
  ["shannan", "山南", "西藏自治区", "山南市", 29.2333, 91.7833],
  ["linzhi", "林芝", "西藏自治区", "林芝市", 29.65, 94.3667],
  ["chang'an", "长安", "陕西省", "西安市", 34.3416, 108.9398],
  ["tongchuan", "铜川", "陕西省", "铜川市", 34.9028, 108.948],
  ["baoji", "宝鸡", "陕西省", "宝鸡市", 34.3635, 107.2374],
  ["xianyang", "咸阳", "陕西省", "咸阳市", 34.3378, 108.7063],
  ["weinan", "渭南", "陕西省", "渭南市", 35.0947, 109.5103],
  ["yan'an", "延安", "陕西省", "延安市", 36.5966, 109.4908],
  ["hanzhong", "汉中", "陕西省", "汉中市", 33.0688, 107.0231],
  ["yulinshan", "榆林", "陕西省", "榆林市", 38.2902, 109.7338],
  ["ankang", "安康", "陕西省", "安康市", 32.6905, 109.024],
  ["shangluo", "商洛", "陕西省", "商洛市", 33.8687, 109.9398],
  ["lanzhou", "兰州", "甘肃省", "兰州市", 36.0611, 103.8343],
  ["jiayuguan", "嘉峪关", "甘肃省", "嘉峪关市", 39.7731, 98.2906],
  ["jinchang", "金昌", "甘肃省", "金昌市", 38.52, 102.1876],
  ["baiyin", "白银", "甘肃省", "白银市", 36.5433, 104.1735],
  ["tianshui", "天水", "甘肃省", "天水市", 34.5796, 105.7243],
  ["wuwei", "武威", "甘肃省", "武威市", 37.9297, 102.6337],
  ["zhangye", "张掖", "甘肃省", "张掖市", 38.9253, 100.4528],
  ["pingliang", "平凉", "甘肃省", "平凉市", 35.5434, 106.6689],
  ["jiuquan", "酒泉", "甘肃省", "酒泉市", 39.7433, 98.4907],
  ["qingyang", "庆阳", "甘肃省", "庆阳市", 35.7126, 107.6386],
  ["dingxi", "定西", "甘肃省", "定西市", 35.5797, 104.6267],
  ["longnan", "陇南", "甘肃省", "陇南市", 33.399, 104.9293],
  ["xining", "西宁", "青海省", "西宁市", 36.6171, 101.7782],
  ["haidong", "海东", "青海省", "海东市", 36.5, 102.4],
  ["yinchuan", "银川", "宁夏回族自治区", "银川市", 38.4872, 106.2309],
  ["shizuishan", "石嘴山", "宁夏回族自治区", "石嘴山市", 38.9848, 106.3807],
  ["wuzhong", "吴忠", "宁夏回族自治区", "吴忠市", 37.9956, 106.2004],
  ["guyuan", "固原", "宁夏回族自治区", "固原市", 36.0041, 106.2453],
  ["zhongwei", "中卫", "宁夏回族自治区", "中卫市", 37.5022, 105.1947],
  ["wulumuqi", "乌鲁木齐", "新疆维吾尔自治区", "乌鲁木齐市", 43.8256, 87.6168],
  ["kelamayi", "克拉玛依", "新疆维吾尔自治区", "克拉玛依市", 45.5963, 84.8958],
  ["turpan", "吐鲁番", "新疆维吾尔自治区", "吐鲁番市", 42.9476, 89.1807],
  ["hami", "哈密", "新疆维吾尔自治区", "哈密市", 41.5767, 93.0461],
];

/** 版本覆盖（唯一获批的数据修正入口；不得改写 BASE_RAW）。 */
const VERSION_OVERRIDES = {
  "china-v1": {},
  "china-v2": {
    // 阳泉：Phase 4 冻结近似坐标（lat 35.1975 / lng 113.5841）经复核偏差 ≈295 km，
    // 落入河南一侧；china-v2 采用 GeoNames「Yangquan, Shanxi, China」坐标。
    yangquan: { lat: 37.8575, lng: 113.563333 },
  },
};

/** registry.versions 稳定顺序 + 新信件默认图版本（source of truth = data/graphs/registry.json）。 */
const GRAPH_VERSIONS = ["china-v1", "china-v2"];
const DEFAULT_GRAPH_VERSION = "china-v2";

/** 应用版本覆盖 → 该版本所用 raw 行（新数组；绝不改写 BASE_RAW）。 */
function applyVersionOverrides(version) {
  const overrides = VERSION_OVERRIDES[version];
  if (overrides === undefined) throw new Error(`未登记的 graphVersion: ${version}`);
  return BASE_RAW.map((row) => {
    const override = overrides[row[0]];
    if (override === undefined) return row;
    return [row[0], row[1], row[2], row[3], override.lat, override.lng];
  });
}

function toRad(d) {
  return (d * Math.PI) / 180;
}
function haversine(a, b) {
  const R = 6371;
  const dLat = toRad(b[4] - a[4]);
  const dLng = toRad(b[5] - a[5]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[4])) * Math.cos(toRad(b[4])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** station 节点（mapX/mapY 由 canonical helper 投影；禁止内联第二套投影公式）。 */
function buildStationNodes(raw) {
  return raw.map((r) => {
    const [mapX, mapY] = projectStation(r[5], r[4]);
    return {
      id: r[0],
      name: r[1],
      province: r[2],
      city: r[3],
      lat: r[4],
      lng: r[5],
      mapX,
      mapY,
    };
  });
}

/** 生成单个图版本（nodes / edges / regionStationMap）。 */
function generateGraphVersion(version) {
  const raw = applyVersionOverrides(version);
  const nodes = buildStationNodes(raw);

  const allowedAll = ["HAND_CARRY", "HORSE_RELAY", "EXPRESS_RELAY"];

  // 生成边：每个节点连接最近的 K 个邻居 + 同省互连，保证连通
  const edges = [];
  const seen = new Set();
  function addEdge(i, j) {
    const a = raw[i],
      b = raw[j];
    const key = a[0] < b[0] ? `${a[0]}|${b[0]}` : `${b[0]}|${a[0]}`;
    if (seen.has(key)) return;
    seen.add(key);
    const d = haversine(a, b);
    if (d > 1600) return; // 距离过远不直连（避免虚假长边）
    edges.push({
      from: a[0],
      to: b[0],
      distanceKm: Math.round(d * 10) / 10,
      enabled: true,
      allowedTransport: allowedAll,
    });
  }

  // 1) 每个节点连最近 4 个邻居
  for (let i = 0; i < raw.length; i++) {
    const dists = [];
    for (let j = 0; j < raw.length; j++) {
      if (i === j) continue;
      dists.push([j, haversine(raw[i], raw[j])]);
    }
    dists.sort((x, y) => x[1] - y[1]);
    for (let k = 0; k < Math.min(4, dists.length); k++) {
      addEdge(i, dists[k][0]);
    }
  }

  // 2) 同省节点互连（保证省内可达，避免孤岛）
  const byProv = {};
  raw.forEach((r, idx) => {
    (byProv[r[2]] ??= []).push(idx);
  });
  for (const prov in byProv) {
    const list = byProv[prov];
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        addEdge(list[a], list[b]);
      }
    }
  }

  // 3) 主干连接（区域间走廊），确保全国连通：按经度/纬度链若干远距离骨干
  const backbone = [
    ["beijing", "tianjin"],
    ["beijing", "shijiazhuang"],
    ["shijiazhuang", "taiyuan"],
    ["taiyuan", "xian", "chang'an"],
    ["chang'an", "chengdu"],
    ["chengdu", "kunming"],
    ["chang'an", "zhengzhou"],
    ["zhengzhou", "wuhan"],
    ["wuhan", "changsha"],
    ["changsha", "guangzhou"],
    ["guangzhou", "shenzhen"],
    ["nanning", "guangzhou"],
    ["wuhan", "nanjing"],
    ["nanjing", "shanghai"],
    ["shanghai", "hangzhou"],
    ["hangzhou", "fuzhou"],
    ["fuzhou", "xiamen"],
    ["zhengzhou", "jinan"],
    ["jinan", "qingdao"],
    ["jinan", "beijing"],
    ["shenyang", "beijing"],
    ["changchun", "shenyang"],
    ["haerbin", "changchun"],
    ["lanzhou", "chang'an"],
    ["lanzhou", "xining"],
    ["lanzhou", "wulumuqi"],
    ["chengdu", "lanzhou"],
    ["kunming", "guiyang"],
    ["guiyang", "changsha"],
    ["nanning", "guiyang"],
    ["guangzhou", "haikou"],
    ["haikou", "sanya"],
    ["lasa", "xining"],
    ["wulumuqi", "lanzhou"],
    ["huhehaote", "beijing"],
    ["baotou", "huhehaote"],
    ["yinchuan", "lanzhou"],
    ["xianyang", "chang'an"],
  ];
  for (const pair of backbone) {
    const ai = raw.findIndex((r) => r[0] === pair[0]);
    const bi = raw.findIndex((r) => r[0] === pair[1]);
    if (ai >= 0 && bi >= 0) addEdge(ai, bi);
  }
  // 修正：backbone 中有些是三元（含 'xian' 别名），单独处理
  const backbonePairs = [
    ["beijing", "tianjin"],
    ["beijing", "shijiazhuang"],
    ["shijiazhuang", "taiyuan"],
    ["taiyuan", "chang'an"],
    ["chang'an", "chengdu"],
    ["chengdu", "kunming"],
    ["chang'an", "zhengzhou"],
    ["zhengzhou", "wuhan"],
    ["wuhan", "changsha"],
    ["changsha", "guangzhou"],
    ["guangzhou", "shenzhen"],
    ["nanning", "guangzhou"],
    ["wuhan", "nanjing"],
    ["nanjing", "shanghai"],
    ["shanghai", "hangzhou"],
    ["hangzhou", "fuzhou"],
    ["fuzhou", "xiamen"],
    ["zhengzhou", "jinan"],
    ["jinan", "qingdao"],
    ["jinan", "beijing"],
    ["shenyang", "beijing"],
    ["changchun", "shenyang"],
    ["haerbin", "changchun"],
    ["lanzhou", "chang'an"],
    ["lanzhou", "xining"],
    ["lanzhou", "wulumuqi"],
    ["chengdu", "lanzhou"],
    ["kunming", "guiyang"],
    ["guiyang", "changsha"],
    ["nanning", "guiyang"],
    ["guangzhou", "haikou"],
    ["haikou", "sanya"],
    ["lasa", "xining"],
    ["wulumuqi", "lanzhou"],
    ["huhehaote", "beijing"],
    ["baotou", "huhehaote"],
    ["yinchuan", "lanzhou"],
    ["xianyang", "chang'an"],
    ["chongqing", "chang'an"],
    ["chongqing", "chengdu"],
  ];
  for (const [a, b] of backbonePairs) {
    const ai = raw.findIndex((r) => r[0] === a);
    const bi = raw.findIndex((r) => r[0] === b);
    if (ai >= 0 && bi >= 0) addEdge(ai, bi);
  }

  // region → station 映射：city → node id（精确优先），并留 province → 省会 fallback
  const regionStationMap = { cities: {}, provinces: {} };
  const provinceCapital = {
    北京市: "beijing",
    天津市: "tianjin",
    上海市: "shanghai",
    重庆市: "chongqing",
    河北省: "shijiazhuang",
    山西省: "taiyuan",
    内蒙古自治区: "huhehaote",
    辽宁省: "shenyang",
    吉林省: "changchun",
    黑龙江省: "haerbin",
    江苏省: "nanjing",
    浙江省: "hangzhou",
    安徽省: "hefei",
    福建省: "fuzhou",
    江西省: "nanchang",
    山东省: "jinan",
    河南省: "zhengzhou",
    湖北省: "wuhan",
    湖南省: "changsha",
    广东省: "guangzhou",
    广西壮族自治区: "nanning",
    海南省: "haikou",
    四川省: "chengdu",
    贵州省: "guiyang",
    云南省: "kunming",
    西藏自治区: "lasa",
    陕西省: "chang'an",
    甘肃省: "lanzhou",
    青海省: "xining",
    宁夏回族自治区: "yinchuan",
    新疆维吾尔自治区: "wulumuqi",
  };
  for (const r of raw) {
    regionStationMap.cities[r[3]] = r[0];
    if (provinceCapital[r[2]] && !regionStationMap.provinces[r[2]]) {
      regionStationMap.provinces[r[2]] = provinceCapital[r[2]];
    }
  }

  // 映射自动校验（Phase 4 Final Gate HIGH-1）：
  // 1) 同一 city 不得出现多个节点（防止后写覆盖 canonical station）
  const cityCount = {};
  for (const r of raw) cityCount[r[3]] = (cityCount[r[3]] ?? 0) + 1;
  const dupCities = Object.keys(cityCount).filter((c) => cityCount[c] > 1);
  if (dupCities.length > 0) {
    throw new Error(`region map 存在重复 city（会导致映射覆盖）: ${dupCities.join(", ")}`);
  }
  // 2) 每个 city / province 映射必须指向有效节点
  const nodeIds = new Set(raw.map((r) => r[0]));
  for (const [k, v] of Object.entries(regionStationMap.cities)) {
    if (!nodeIds.has(v)) throw new Error(`cities.${k} -> 无效节点 ${v}`);
  }
  for (const [k, v] of Object.entries(regionStationMap.provinces)) {
    if (!nodeIds.has(v)) throw new Error(`provinces.${k} -> 无效节点 ${v}`);
  }
  // 3) 省级覆盖：每个出现的 province 必须有省级映射
  const nodeProvinces = new Set(raw.map((r) => r[2]));
  for (const p of nodeProvinces) {
    if (!regionStationMap.provinces[p]) throw new Error(`province 无省级映射: ${p}`);
  }

  return { nodes, edges, regionStationMap };
}

// ---- 输出（所有版本确定性生成；china-v1 必须字节冻结） ----

const OUT_ROOT_FLAG = "--out-root=";
const outRootArg = process.argv.find((arg) => arg.startsWith(OUT_ROOT_FLAG));
const DEFAULT_GRAPHS_DIR = path.join(__dirname, "graphs");
/** 输出目录：默认仓库 `data/graphs/`；`--out-root=<dir>` 供测试在仓库外做字节一致性校验。 */
const OUT_ROOT =
  outRootArg === undefined
    ? DEFAULT_GRAPHS_DIR
    : path.resolve(outRootArg.slice(OUT_ROOT_FLAG.length));
const IS_REPO_OUTPUT = OUT_ROOT === DEFAULT_GRAPHS_DIR;

/** BFS 连通性自检（返回 connected / isolated）。 */
function connectivityCheck(nodes, edges) {
  const adj = {};
  for (const e of edges) {
    (adj[e.from] ??= []).push(e.to);
    (adj[e.to] ??= []).push(e.from);
  }
  const visited = new Set();
  const stack = [nodes[0].id];
  while (stack.length) {
    const c = stack.pop();
    if (visited.has(c)) continue;
    visited.add(c);
    for (const n of adj[c] ?? []) if (!visited.has(n)) stack.push(n);
  }
  const isolated = nodes.filter((n) => !visited.has(n.id)).length;
  return { connected: visited.size, isolated };
}

/**
 * 写出 JSON：先 `JSON.stringify(x, null, 2)`，再按仓库 Prettier 配置格式化。
 * 冻结基线 `data/graphs/china-v1/*.json` 本身就是 Prettier 产物（数组折叠成单行、文件以换行结尾），
 * 因此生成端必须走同一格式化路径，重新生成才能与冻结基线逐字节一致。
 */
async function writeJson(file, data) {
  const config = (await prettier.resolveConfig(file)) ?? {};
  const text = await prettier.format(JSON.stringify(data, null, 2), {
    ...config,
    filepath: file,
    parser: "json",
  });
  fs.writeFileSync(file, text);
}

async function main() {
  for (const version of GRAPH_VERSIONS) {
    const { nodes, edges, regionStationMap } = generateGraphVersion(version);
    const versionDir = path.join(OUT_ROOT, version);
    fs.mkdirSync(versionDir, { recursive: true });
    await writeJson(path.join(versionDir, "station_nodes.json"), nodes);
    await writeJson(path.join(versionDir, "route_edges.json"), edges);
    await writeJson(path.join(versionDir, "region_station_map.json"), regionStationMap);
    const { connected, isolated } = connectivityCheck(nodes, edges);
    console.log(
      `nodes=${nodes.length} edges=${edges.length} version=${version} ` +
        `connected=${connected}/${nodes.length} isolated=${isolated}`
    );
  }

  // 图版本注册表：versions 为稳定顺序，defaultVersion = 新信件默认图版本
  await writeJson(path.join(OUT_ROOT, "registry.json"), {
    versions: GRAPH_VERSIONS,
    defaultVersion: DEFAULT_GRAPH_VERSION,
  });

  // 生成并写出校验报告（MEDIUM-3：报告与数据永不漂移）；仓库外输出不写报告
  const { run: validateAndReport } = require("./validate_graph.cjs");
  if (!validateAndReport({ graphsDir: OUT_ROOT, reportPath: IS_REPO_OUTPUT ? undefined : null })) {
    throw new Error("graph validation FAILED after regeneration");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
