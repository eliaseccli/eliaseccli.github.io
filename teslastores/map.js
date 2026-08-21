const AUSTRIA = [[46.37, 9.53], [49.02, 17.16]];

const COLORS = [
  "#c0392b", "#2471a3", "#1e8449", "#6c3483", "#b7950b",
  "#117a65", "#a04000", "#1a5276", "#922b21"
];

const map = L.map("map", { zoomControl: false, attributionControl: true });
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap',
  maxZoom: 19
}).addTo(map);
map.fitBounds(AUSTRIA, { padding: [24, 24], maxZoom: 8 });

const voronoiLayer = L.layerGroup().addTo(map);
const markersLayer = L.layerGroup().addTo(map);

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function austriaPixelBounds() {
  const sw = map.latLngToLayerPoint(L.latLng(AUSTRIA[0][0], AUSTRIA[0][1]));
  const ne = map.latLngToLayerPoint(L.latLng(AUSTRIA[1][0], AUSTRIA[1][1]));
  return [
    Math.min(sw.x, ne.x),
    Math.min(sw.y, ne.y),
    Math.max(sw.x, ne.x),
    Math.max(sw.y, ne.y)
  ];
}

const locations = await fetch("./locations.json").then((r) => {
  if (!r.ok) throw new Error("Could not load locations.json");
  return r.json();
});

locations.forEach((loc, i) => {
  const color = COLORS[i % COLORS.length];
  L.circleMarker([loc.lat, loc.lon], {
    radius: 7,
    color: "#fff",
    weight: 2,
    fillColor: color,
    fillOpacity: 1,
    pane: "markerPane"
  })
    .bindPopup("<strong>" + esc(loc.name) + "</strong>" + esc(loc.address))
    .addTo(markersLayer);
});

function drawVoronoi() {
  voronoiLayer.clearLayers();
  const pts = locations.map((loc) => {
    const p = map.latLngToLayerPoint(L.latLng(loc.lat, loc.lon));
    return [p.x, p.y];
  });
  const delaunay = d3.Delaunay.from(pts);
  const voronoi = delaunay.voronoi(austriaPixelBounds());
  locations.forEach((loc, i) => {
    const cell = voronoi.cellPolygon(i);
    if (!cell) return;
    const latlngs = cell.map(([x, y]) => map.layerPointToLatLng(L.point(x, y)));
    const color = COLORS[i % COLORS.length];
    L.polygon(latlngs, {
      color: color,
      weight: 1,
      opacity: 0.45,
      fillColor: color,
      fillOpacity: 0.22,
      interactive: false
    }).addTo(voronoiLayer);
  });
}

drawVoronoi();
map.on("zoomend moveend", drawVoronoi);

drawVoronoi();
