import { MAP_VIEWBOX, type MapPoint, type RouteMapViewParsed } from "@yishu/shared";
import { MAP_COLORS } from "./theme";
import { lockNorthUp } from "./northUp";

type LngLat = [number, number];

export function toApproximateLngLat(point: MapPoint): LngLat {
  return [(point.x / MAP_VIEWBOX.width) * 360 - 180, 90 - (point.y / MAP_VIEWBOX.height) * 180];
}

export function buildBaiduMapHtml(view: RouteMapViewParsed, ak: string, topInset = 18): string {
  const payload = {
    origin: view.origin ? toApproximateLngLat(view.origin) : null,
    destination: view.destination ? toApproximateLngLat(view.destination) : null,
    completed: view.completedPath.map(toApproximateLngLat),
    remaining: view.remainingPath.map(toApproximateLngLat),
    lastKnown: view.lastKnownPosition ? toApproximateLngLat(view.lastKnownPosition) : null,
    approximate: view.approximatePosition ? toApproximateLngLat(view.approximatePosition) : null,
    facts: view.facts.map((fact) => toApproximateLngLat(fact)),
  };
  const data = JSON.stringify(payload).replace(/</g, "\\u003c");
  const scriptUrl = `https://api.map.baidu.com/api?v=4.0&ak=${encodeURIComponent(ak)}&callback=yishuMapReady`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <style>html,body,#map{height:100%;width:100%;margin:0;background:${MAP_COLORS.paper}}body{overflow:hidden}</style>
</head>
<body>
  <div id="map"></div>
  <script>
    (function () {
      const data = ${data};
      const post = (message) => window.ReactNativeWebView.postMessage(message);
      post('stage:document');
      window.addEventListener('error', (event) => {
        if (event.error) post('error:script');
      });
      window.addEventListener('unhandledrejection', () => post('error:script'));
      window.yishuMapReady = function () {
      try {
      if (typeof BMap === 'undefined' || typeof BMap.Map !== 'function') { post('error:sdk'); return; }

      const groups = [data.origin, data.destination, data.completed, data.remaining,
        data.lastKnown, data.approximate, data.facts];
      const raw = [];
      const indexes = new Map();
      const flatten = (entry) => {
        if (!entry) return null;
        if (typeof entry[0] === 'number') {
          const key = entry.join(',');
          if (indexes.has(key)) return indexes.get(key);
          const index = raw.length;
          indexes.set(key, index);
          raw.push(new BMap.Point(entry[0], entry[1]));
          return index;
        }
        return entry.map(flatten);
      };
      const refs = groups.map(flatten);
      post('stage:conversion');
      const convertor = new BMap.Convertor();
      const chunks = [];
      for (let i = 0; i < raw.length; i += 10) {
        chunks.push(new Promise((resolve, reject) => {
          convertor.translate(raw.slice(i, i + 10), 1, 5, (result) => {
            if (result.status === 0 && result.points.length === Math.min(10, raw.length - i)) {
              resolve(result.points);
            } else reject(new Error('conversion'));
          });
        }));
      }
      Promise.all(chunks).then((parts) => {
        post('stage:layout');
        const points = parts.flat();
        const resolve = (ref) => ref === null ? null :
          Array.isArray(ref) ? ref.map(resolve) : points[ref];
        const [origin, destination, completed, remaining, lastKnown, approximate, facts] = refs.map(resolve);
        const map = new BMap.Map('map', { enableRotate: false, enableTilt: false });
        const lockNorth = ${lockNorthUp.toString()};
        lockNorth(map);
        let fitted = false, tilesReady = false, reportedReady = false;
        const reportReady = () => {
          if (fitted && tilesReady && !reportedReady) { reportedReady = true; post('ready'); }
        };
        const loaded = () => { tilesReady = true; reportReady(); };
        map.addEventListener('firsttileloaded', loaded);
        map.addEventListener('tilesloaded', loaded);
        map.centerAndZoom(origin || lastKnown || new BMap.Point(104.1, 35.6), 6);
        map.enableScrollWheelZoom(true);
        map.addControl(new BMap.ZoomControl({ anchor: BMAP_ANCHOR_TOP_RIGHT, offset: new BMap.Size(8, 8) }));
        map.addControl(new BMap.ScaleControl({ anchor: BMAP_ANCHOR_BOTTOM_LEFT }));
        const line = (path, color, style) => {
          if (path.length > 1) map.addOverlay(new BMap.Polyline(path, {
            strokeColor: color, strokeWeight: 4, strokeOpacity: 0.88, strokeStyle: style,
          }));
        };
        line(remaining, '${MAP_COLORS.remaining}', 'dashed');
        line(completed, '${MAP_COLORS.completed}', 'solid');
        const markers = [];
        const marker = (point, color, radius) => {
          if (!point) return;
          const circle = new BMap.Circle(point, 1, {
            strokeColor: color, strokeWeight: 2, fillColor: color, fillOpacity: 0.75,
          });
          map.addOverlay(circle);
          markers.push({ point, radius, circle });
        };
        marker(origin, '${MAP_COLORS.origin}', 5);
        marker(destination, '${MAP_COLORS.destination}', 5);
        facts.forEach((point) => marker(point, '${MAP_COLORS.fact}', 4));
        marker(lastKnown, '${MAP_COLORS.lastKnown}', 6);
        marker(approximate, '${MAP_COLORS.approximate}', 7);
        const visible = [origin, destination, ...completed, ...remaining, lastKnown, approximate,
          ...facts].filter(Boolean);
        const updateMarkers = () => markers.forEach(({ point, radius, circle }) => {
          const pixel = map.pointToPixel(point);
          const edge = map.pixelToPoint(new BMap.Pixel(pixel.x + radius, pixel.y));
          circle.setRadius(map.getDistance(point, edge));
        });
        const fit = () => {
          const { width, height } = map.getSize();
          if (width <= 0 || height <= 0) return;
          if (visible.length) {
            const top = Math.min(${Math.max(18, Math.min(300, topInset))}, height * 0.4);
            const right = 52, bottom = 32, left = 18;
            const base = map.getViewport(visible, { margins: [0, 0, 0, 0] });
            const camera = { center: base.center, zoom: base.zoom, heading: 0, tilt: 0 };
            const pixels = visible.map((point) => map.pointToPixel(point, camera));
            const xs = pixels.map((pixel) => pixel.x), ys = pixels.map((pixel) => pixel.y);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const spanX = maxX - minX, spanY = maxY - minY;
            const scale = Math.min((width - left - right) / Math.max(spanX, 0.001),
              (height - top - bottom) / Math.max(spanY, 0.001));
            const zoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(),
              spanX < 0.001 && spanY < 0.001 ? 13 : base.zoom + Math.log2(scale)));
            const boundsCenter = map.pixelToPoint(new BMap.Pixel((minX + maxX) / 2, (minY + maxY) / 2), camera);
            const center = map.pixelToPoint(new BMap.Pixel(width / 2 + (right - left) / 2,
              height / 2 + (bottom - top) / 2), { center: boundsCenter, zoom, heading: 0, tilt: 0 });
            map.setViewport({ center, zoom }, { enableAnimation: false, delay: 0 });
          }
          requestAnimationFrame(() => {
            try { updateMarkers(); fitted = true; post('stage:tiles'); reportReady(); }
            catch (_) { post('error:render'); }
          });
        };
        // Fit after WebView layout, and on resize only; gestures keep their own camera.
        let attempts = 0;
        const initialFit = () => {
          try {
          map.checkResize();
          if (map.getSize().width > 0 && map.getSize().height > 0) fit();
          else if (++attempts < 120) requestAnimationFrame(initialFit);
          else post('error:layout');
          } catch (_) { post('error:render'); }
        };
        requestAnimationFrame(initialFit);
        map.addEventListener('resize', fit);
        map.addEventListener('zoomend', updateMarkers);
      }).catch((error) => post(error.message === 'conversion' ? 'error:conversion' : 'error:render'));
      } catch (_) { post('error:render'); }
      };
      const script = document.createElement('script');
      script.src = ${JSON.stringify(scriptUrl).replace(/</g, "\\u003c")};
      script.async = true;
      script.onerror = () => post('error:sdk');
      document.body.appendChild(script);
    })();
  </script>
</body>
</html>`;
}
