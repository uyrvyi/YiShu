import type { RouteMapViewParsed } from "@yishu/shared";
import { CHINA_GEOGRAPHIC_GEOJSON } from "./chinaGeographicData";
import { geographicMapPayload } from "./displayProjection";
import detailNotices from "./detailData/notices.json";
import osmNotice from "./detailData/osm-notice.json";
import { LEAFLET_JS, LEAFLET_CSS } from "./vendor/leaflet";
import { VECTOR_GRID_JS, VECTOR_GRID_NOTICES } from "./vendor/vectorGrid";
import { staticTileConfig, staticTileScript, type StaticTileOptions } from "./vectorTiles";

export function mapUpdateScript(view: RouteMapViewParsed, topInset: number): string {
  return `window.yishuUpdateMap(${JSON.stringify(geographicMapPayload(view)).replace(/</g, "\\u003c")},${Math.max(18, topInset)});true;`;
}

/** Assets and gesture engine are bundled; polling only replaces business overlays. */
export function buildLocalMapHtml(options?: StaticTileOptions): string {
  const tiles = staticTileConfig(options);
  const notices = {
    sources: detailNotices,
    osm: tiles
      ? {
          ...osmNotice,
          derivativeDatabase: tiles.baseUrl + "/{z}/{x}/{y}.pbf",
          snapshot: "2026-10-03T20:20:50Z",
        }
      : osmNotice,
    vectorGrid: tiles ? VECTOR_GRID_NOTICES : undefined,
  };
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src ${tiles ? tiles.origin : "'none'"};"><style>${LEAFLET_CSS}
.national-view .leaflet-tooltip{display:none}
html,body{overflow:hidden;overscroll-behavior:none}#map{touch-action:none;overscroll-behavior:none}
.place-label{white-space:nowrap;color:#71818a;font-size:12px;line-height:20px;text-align:center;text-shadow:0 1px 2px white,1px 0 2px white,-1px 0 2px white;pointer-events:none}.place-label.province{color:#84939c;font-weight:600}.place-label.district{font-size:11px;color:#89959b}.detail-unavailable{position:absolute;bottom:25px;left:12px;z-index:800;font-size:11px;color:#657d88;background:#ffffffe6;padding:3px 6px;border-radius:6px}
html,body,#map{height:100%;width:100%;margin:0;background:#eaf1f4}body{font-family:Arial,sans-serif;letter-spacing:0}.leaflet-container{background:#eaf1f4}.leaflet-control-zoom{border:0!important;box-shadow:0 2px 10px #0002!important;border-radius:12px!important;overflow:hidden}.leaflet-control-attribution{font-size:9px;background:#ffffffe6}.pin{display:block;width:12px;height:12px;border:3px solid white;border-radius:50%;box-shadow:0 1px 5px #0004;box-sizing:border-box}.leaflet-tooltip{font-size:11px;line-height:16px;border:0;box-shadow:none;background:#ffffffe6;padding:3px 6px;border-radius:6px}.leaflet-tooltip:before{display:none}</style></head><body><div id="map"></div><script type="application/json" id="map-license-notices">${JSON.stringify(notices).replace(/</g, "\\u003c")}</script><script>${LEAFLET_JS.replace(/<\/script/gi, "<\\/script")}</script>${tiles ? `<script>${VECTOR_GRID_JS.replace(/<\/script/gi, "<\\/script")}</script>` : ""}<script>
(function(){
var notify=function(v){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(v)};
try{
var map=L.map('map',{crs:L.CRS.EPSG3857,minZoom:2,maxZoom:${tiles ? 15 : 13},zoomControl:false,attributionControl:true,zoomSnap:0.1,bounceAtZoomLimits:false});
map.getContainer().addEventListener('touchmove',function(event){if(event.cancelable)event.preventDefault()},{passive:false});
L.control.zoom({position:'bottomright',zoomInTitle:'放大',zoomOutTitle:'缩小'}).addTo(map);
map.attributionControl.setPrefix(false);${tiles ? "" : "map.attributionControl.addAttribution('运输示意图 · geoBoundaries · GaryBikini · © OpenStreetMap contributors');"}
map.createPane('geographic-base');map.getPane('geographic-base').style.zIndex='200';
var base=L.geoJSON(${JSON.stringify(CHINA_GEOGRAPHIC_GEOJSON)},{pane:'geographic-base',interactive:false,smoothFactor:0,style:{stroke:false,fillColor:'#fafcfd',fillOpacity:1}}).addTo(map);
var layer=L.layerGroup().addTo(map),points=[],inset=18,first=true;
['city-boundaries','district-boundaries','physical-water','place-labels'].forEach(function(name,i){map.createPane(name);map.getPane(name).style.zIndex=String(210+i*10);map.getPane(name).style.pointerEvents='none'});
${tiles ? "map.createPane('national-tiles');map.getPane('national-tiles').style.zIndex='210';map.getPane('national-tiles').style.pointerEvents='none';" : ""}
var cities=L.layerGroup().addTo(map),districts=L.layerGroup().addTo(map),waters=L.layerGroup().addTo(map),places=L.layerGroup().addTo(map),detailCandidates=[],detailTimer=null,labelTimer=null,requestId=0;
var unavailable=document.createElement('div');unavailable.className='detail-unavailable';unavailable.hidden=true;unavailable.textContent='区域细节暂不可用';map.getContainer().appendChild(unavailable);
window.yishuMapDetailsUnavailable=function(){unavailable.hidden=false};
var labelMeasure=document.createElement('canvas').getContext('2d');
var overlap=function(a,b){return a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y};
var drawPlaceLabels=function(){
places.clearLayers();var zoom=map.getZoom(),size=map.getSize(),rect=map.getContainer().getBoundingClientRect(),occupied=[];
map.getContainer().querySelectorAll('.leaflet-tooltip').forEach(function(el){var style=getComputedStyle(el),r=el.getBoundingClientRect();if(style.display!=='none'&&Number(style.opacity)>0.05&&r.width&&r.height)occupied.push({x:r.left-rect.left-5,y:r.top-rect.top-5,w:r.width+10,h:r.height+10})});
map.getContainer().querySelectorAll('.leaflet-marker-icon:not(.place-label)').forEach(function(el){var r=el.getBoundingClientRect();if(r.width&&r.height)occupied.push({x:r.left-rect.left-8,y:r.top-rect.top-8,w:r.width+16,h:r.height+16})});
var candidates=detailCandidates.filter(function(p){return !p.minzoom||zoom>=p.minzoom});${tiles ? "" : "if(zoom<8)base.eachLayer(function(shape){var p=shape.feature.properties;if(p.province)candidates.push({name:p.province,center:p.labelPoint,level:'province'})});"}
candidates.sort(function(a,b){return (a.level==='district'?1:0)-(b.level==='district'?1:0)||a.name.localeCompare(b.name)});
var seen={};candidates.forEach(function(p){if(!p.center||seen[p.level+':'+p.name])return;var pt=map.latLngToContainerPoint([p.center[1],p.center[0]]);labelMeasure.font=(p.level==='district'?'11':'12')+'px Arial';var width=Math.ceil(labelMeasure.measureText(p.name).width)+12;var box={x:pt.x-width/2,y:pt.y-10,w:width,h:20};
if(box.x<12||box.x+box.w>size.x-54||box.y<(zoom<6?28:inset+12)||box.y+box.h>size.y-45||occupied.some(function(b){return overlap(box,b)}))return;
seen[p.level+':'+p.name]=true;occupied.push({x:box.x-5,y:box.y-5,w:box.w+10,h:box.h+10});var el=document.createElement('span');el.textContent=p.name;el.style.display='block';
L.marker([p.center[1],p.center[0]],{pane:'place-labels',interactive:false,keyboard:false,icon:L.divIcon({html:el,className:'place-label '+p.level,iconSize:[width,20],iconAnchor:[width/2,10]})}).addTo(places)});
};
var scheduleLabels=function(){clearTimeout(labelTimer);labelTimer=setTimeout(drawPlaceLabels,40)};
var requestDetails=function(){${tiles ? "scheduleLabels();return;" : ""}clearTimeout(detailTimer);detailTimer=setTimeout(function(){var b=map.getBounds().pad(0.12);var r={id:++requestId,zoom:map.getZoom(),bounds:[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()]};
if(r.zoom<6){cities.clearLayers();districts.clearLayers();waters.clearLayers();detailCandidates=[];scheduleLabels();return}
if(window.yishuDetailBridge)window.yishuDetailBridge(r);else notify('detail-request:'+JSON.stringify(r));},100)};
window.yishuMapDetails=function(payload){${tiles ? "return;" : ""}if(payload.id!==requestId)return;unavailable.hidden=true;cities.clearLayers();districts.clearLayers();waters.clearLayers();detailCandidates=[];
(payload.cities||[]).forEach(function(f,i){L.geoJSON(f,{pane:'city-boundaries',interactive:false,smoothFactor:0.5,style:{color:'#c6d2d6',weight:0.8,fillColor:['#f6f9fa','#f0f5f4','#f4f6f9'][Number(f.properties.code)%3],fillOpacity:0.75}}).addTo(cities);detailCandidates.push(f.properties)});
(payload.districts||[]).forEach(function(f){L.geoJSON(f,{pane:'district-boundaries',interactive:false,smoothFactor:f.properties.source==='OSM'?0:0.5,style:{color:'#c6d2d7',weight:0.9,fillColor:['#f0f6f4','#f2f5fa','#f7f8f9'][Number(f.properties.code)%3],fillOpacity:0.7,dashArray:'3 3'}}).addTo(districts);detailCandidates.push(f.properties)});
(payload.waters||[]).forEach(function(f){if(f.properties.source!=='OSM'||(f.geometry.type!=='Polygon'&&f.geometry.type!=='MultiPolygon'))return;L.geoJSON(f,{pane:'physical-water',interactive:false,smoothFactor:0,style:{stroke:false,fillColor:'#cee5ee',fillOpacity:0.9}}).addTo(waters)});
scheduleLabels();
};
${tiles ? staticTileScript(tiles.baseUrl) : ""}
map.on('moveend',function(){requestDetails();scheduleLabels()});
var updateLabelVisibility=function(){map.getContainer().classList.toggle('national-view',map.getZoom()<7);scheduleLabels()};
map.on('zoomend',updateLabelVisibility);
var latLng=function(p){return [p.lat,p.lng]},addPoint=function(p){if(p&&Number.isFinite(p.lat)&&Number.isFinite(p.lng))points.push(latLng(p))};
var line=function(path,color,dash,kind){if(path.length>1)L.polyline(path.map(latLng),{color:color,weight:3,dashArray:dash||null,lineCap:'round',className:'journey-segment '+kind}).addTo(layer);path.forEach(addPoint)};
var pin=function(p,color,label,direction){if(!p)return;addPoint(p);var el=document.createElement('span');el.className='pin';el.style.backgroundColor=color;var marker=L.marker(latLng(p),{icon:L.divIcon({html:el,className:'',iconSize:[12,12],iconAnchor:[6,6]})}).addTo(layer);if(label){var text=document.createElement('span');text.textContent=label;marker.bindTooltip(text,{permanent:true,direction:direction||'top',offset:[0,direction==='bottom'?8:-8]})}};
window.yishuMapOverview=function(){map.invalidateSize();map.fitBounds(base.getBounds(),{padding:[24,24],animate:false});};
window.yishuMapFit=function(){map.invalidateSize();if(points.length){var bounds=L.latLngBounds(points);map.fitBounds(bounds,{paddingTopLeft:[72,inset+44],paddingBottomRight:[80,70],maxZoom:15,animate:false});}else window.yishuMapOverview();};
window.yishuUpdateMap=function(view,topInset){
layer.clearLayers();points=[];inset=topInset||18;
(view.segments||[]).forEach(function(segment){line([segment.from,segment.to],segment.state==='COMPLETED'?'#177b65':'#95a5af',segment.state==='COMPLETED'?null:'7 7',segment.kind)});
(view.stations||[]).forEach(function(p){pin(p,'#687e88',p.name+'驿站')});
pin(view.origin,'#177b65',view.origin&&view.origin.name,'bottom');pin(view.destination,'#357ab4',view.destination&&view.destination.name,'top');
pin(view.approximatePosition,'#d18237','运输推算位置');if(!view.approximatePosition&&!view.destination)pin(view.lastKnownPosition,'#177b65');
(view.facts||[]).forEach(addPoint);
if(first){window.yishuMapFit();first=false}notify('ready');
scheduleLabels();
};
window.yishuMapOverview();notify('document-ready');
}catch(e){notify('error:render')}
})();</script></body></html>`;
}
