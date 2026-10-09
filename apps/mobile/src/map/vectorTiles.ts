export interface StaticTileOptions {
  /** Versioned directory; HTTPS in released clients, loopback HTTP for local previews. */
  baseUrl: string;
}

export function staticTileConfig(options?: StaticTileOptions) {
  if (!options) return null;
  const url = new URL(options.baseUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    !/^(?:[a-z0-9][a-z0-9.-]*|\[[0-9a-f:]+\])$/i.test(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/maps\/[a-z0-9-]+\/?$/.test(url.pathname)
  )
    throw new Error("invalid_static_tile_url");
  return { origin: url.origin, baseUrl: url.href.replace(/\/$/, "") };
}

export function staticTileScript(baseUrl: string): string {
  return `
var staticTileBase=${JSON.stringify(baseUrl).replace(/</g, "\\u003c")};
map.getContainer().classList.add('static-tiles');
map.attributionControl.addAttribution('© OpenStreetMap contributors · ODbL');
var grid=L.vectorGrid.protobuf(staticTileBase+'/{z}/{x}/{y}.pbf',{
pane:'national-tiles',minZoom:2,maxNativeZoom:12,maxZoom:15,keepBuffer:1,noWrap:true,
rendererFactory:L.canvas.tile,
fetchOptions:{credentials:'omit',cache:'force-cache'},interactive:false,
vectorTileLayerStyles:{
water:function(){return {stroke:false,fill:true,fillColor:palette.river,fillOpacity:1}},
road:function(p,z){var major=p.kind==='motorway'||p.kind==='trunk';return {color:major?palette.majorRoad:palette.road,weight:(major?1.35:p.kind==='primary'?1:0.7)*(z>=12?1.15:1),fill:false,opacity:p.tunnel!=='no'?0.55:0.9,dashArray:p.tunnel!=='no'?'3 2':null}},
coastline:function(){return {color:palette.coast,weight:0.8,fill:false}},
boundary:function(p){return {color:p.level===4?palette.provinceBoundary:palette.boundary,weight:p.level===4?1:0.7,fill:false,dashArray:p.level===6?'3 3':null}}
}});
var tileCache=new Map();
grid._getVectorTilePromise=function(coords){var key=coords.z+'/'+coords.x+'/'+coords.y;if(tileCache.has(key))return tileCache.get(key);
var pending=fetch(staticTileBase+'/'+key+'.pbf',this.options.fetchOptions).then(function(response){
if(!response.ok)throw new Error('tile_http');return response.arrayBuffer();
}).then(function(buffer){var tile=new VectorTile(new Pbf(buffer));
Object.keys(tile.layers).forEach(function(name){var layer=tile.layers[name],features=[];for(var i=0;i<layer.length;i++){var feature=layer.feature(i);feature.geometry=feature.loadGeometry();features.push(feature)}layer.features=features});
var ordered={};['water','road','coastline','boundary'].forEach(function(name){if(tile.layers[name])ordered[name]=tile.layers[name]});tile.layers=ordered;return tile;
}).catch(function(){tileCache.delete(key);unavailable.hidden=false;unavailable.textContent='底图暂不可用';return {layers:{}}});
tileCache.set(key,pending);if(tileCache.size>128)tileCache.delete(tileCache.keys().next().value);return pending};
grid.addTo(map);
fetch(staticTileBase+'/labels.json',{credentials:'omit',cache:'force-cache'}).then(function(r){if(!r.ok)throw new Error('labels');return r.json()}).then(function(items){
detailCandidates=items.map(function(p){return {name:p.name,center:p.center,minzoom:p.minzoom,level:p.level===4?'province':p.level===5?'city':'district'}});scheduleLabels();
}).catch(function(){unavailable.hidden=false;unavailable.textContent='地名暂不可用'});
var showOverviewLand=function(){var overview=map.getZoom()<6;map.getPane('geographic-base').style.display=overview?'':'none';map.getContainer().style.setProperty('--map-background',overview?palette.water:palette.land)};
map.on('zoomend',showOverviewLand);showOverviewLand();
`;
}
