const COLORS = [
  "#c0392b", "#2471a3", "#1e8449", "#6c3483", "#b7950b",
  "#117a65", "#a04000", "#1a5276", "#922b21"
];

const clip = window.polygonClipping;

const map = L.map("map", { zoomControl: false, attributionControl: true });
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap",
  maxZoom: 19
}).addTo(map);

const voronoiLayer = L.layerGroup().addTo(map);
const markersLayer = L.layerGroup().addTo(map);
const overlayToggle = document.getElementById("voronoi-toggle");

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function geometryOf(geojson) {
  if (geojson.type === "Feature") return geojson.geometry;
  if (geojson.type === "FeatureCollection") return geojson.features[0].geometry;
  return geojson;
}

/** MultiPolygon-style coords: Polygon[] = Ring[][] */
function toClipShape(geojson) {
  const geom = geometryOf(geojson);
  if (geom.type === "Polygon") return [geom.coordinates];
  if (geom.type === "MultiPolygon") return geom.coordinates;
  throw new Error("Austria GeoJSON must be a Polygon or MultiPolygon");
}

function closeRing(ring) {
  if (!ring.length) return ring;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx === lx && fy === ly) return ring;
  return ring.concat([[fx, fy]]);
}

function ringLngLatToLatLng(ring) {
  return ring.map(([lng, lat]) => [lat, lng]);
}

function austriaPixelBounds(bounds) {
  const sw = map.latLngToLayerPoint(bounds.getSouthWest());
  const ne = map.latLngToLayerPoint(bounds.getNorthEast());
  const pad = 48;
  return [
    Math.min(sw.x, ne.x) - pad,
    Math.min(sw.y, ne.y) - pad,
    Math.max(sw.x, ne.x) + pad,
    Math.max(sw.y, ne.y) + pad
  ];
}

const [austriaGeo, locations] = await Promise.all([
  fetch("./austria.geojson").then((r) => {
    if (!r.ok) throw new Error("Could not load austria.geojson");
    return r.json();
  }),
  fetch("./locations.json").then((r) => {
    if (!r.ok) throw new Error("Could not load locations.json");
    return r.json();
  })
]);

const austriaShape = toClipShape(austriaGeo);
const austriaOutline = L.geoJSON(austriaGeo);
const austriaBounds = austriaOutline.getBounds();
map.fitBounds(austriaBounds, { padding: [24, 24], maxZoom: 8 });

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
  if (!overlayToggle.checked) return;
  const pts = locations.map((loc) => {
    const p = map.latLngToLayerPoint(L.latLng(loc.lat, loc.lon));
    return [p.x, p.y];
  });
  const delaunay = d3.Delaunay.from(pts);
  const voronoi = delaunay.voronoi(austriaPixelBounds(austriaBounds));
  locations.forEach((loc, i) => {
    const cell = voronoi.cellPolygon(i);
    if (!cell) return;
    const ring = closeRing(
      cell.map(([x, y]) => {
        const ll = map.layerPointToLatLng(L.point(x, y));
        return [ll.lng, ll.lat];
      })
    );
    const cellPoly = [ring];
    let pieces;
    try {
      pieces = clip.intersection([cellPoly], austriaShape);
    } catch (err) {
      return;
    }
    if (!pieces || !pieces.length) return;
    const color = COLORS[i % COLORS.length];
    pieces.forEach((poly) => {
      if (!poly || !poly.length) return;
      const latlngs = poly.map(ringLngLatToLatLng);
      L.polygon(latlngs, {
        color: color,
        weight: 2,
        opacity: 0.85,
        fillColor: color,
        fillOpacity: 0.2,
        interactive: false
      }).addTo(voronoiLayer);
    });
  });
}

drawVoronoi();
overlayToggle.addEventListener("change", () => {
  if (overlayToggle.checked) drawVoronoi();
  else voronoiLayer.clearLayers();
});
map.on("zoomend moveend", drawVoronoi);
