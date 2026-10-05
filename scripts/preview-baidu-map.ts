import { createServer } from "node:http";
import { projectLngLatToMapPoint, type RouteMapViewParsed } from "../packages/shared/src/index.js";
import { buildBaiduMapHtml } from "../apps/mobile/src/map/baiduMapHtml.js";

const ak = process.env.EXPO_PUBLIC_BAIDU_MAP_AK;
if (!ak) throw new Error("Missing public Baidu AK");
const start = projectLngLatToMapPoint(121.47, 31.23);
const end = projectLngLatToMapPoint(116.4, 39.9);
const view: RouteMapViewParsed = {
  status: "IN_TRANSIT",
  origin: { ...start, name: "上海", province: "上海市", city: "上海市" },
  destination: { ...end, name: "北京", province: "北京市", city: "北京市" },
  completedPath: [start],
  remainingPath: [start, end],
  lastKnownPosition: start,
  approximatePosition: null,
  facts: [],
};
const bridge = `<div id="state" style="position:fixed;bottom:0;left:0;z-index:100;background:white;padding:4px;font:12px monospace">loading</div>
<script>window.ReactNativeWebView={postMessage:(message)=>{document.getElementById('state').textContent=message}};
window.addEventListener('error',(event)=>{document.getElementById('state').textContent='error: '+event.message});
window.addEventListener('unhandledrejection',(event)=>{document.getElementById('state').textContent='error: '+event.reason});
</script>`;
createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const mobile = new URL(req.url ?? "/", "http://127.0.0.1:8090").searchParams.has("mobile");
  res.end(
    buildBaiduMapHtml(view, ak, 92).replace(
      '<div id="map"></div>',
      `<div id="map"></div>${bridge}${mobile ? "<style>html,body{width:390px;height:312px}#state{top:12px;bottom:auto;left:12px;width:290px;height:56px;border-radius:26px}</style>" : ""}`
    )
  );
}).listen(8090, "0.0.0.0", () => console.log("Baidu SDK fixture: http://127.0.0.1:8090"));
