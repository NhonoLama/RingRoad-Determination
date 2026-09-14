const fs = require("fs");
const turf = require("@turf/turf");

const geojson = JSON.parse(
  fs.readFileSync("ringroad.geojson", "utf8")
);

// Keep only Kathmandu Ring Road / NH39 line segments
const ringRoadLines = geojson.features.filter((feature) => {
  const props = feature.properties || {};
  const geometry = feature.geometry || {};

  return (
    geometry.type === "LineString" &&
    props.ref === "NH39" &&
    (
      props.name === "Kathmandu Ringroad" ||
      props["name:en"] === "Kathmandu Ringroad" ||
      props.int_name === "Ring Road"
    )
  );
});

console.log("Ring Road line segments:", ringRoadLines.length);

const lines = turf.featureCollection(ringRoadLines);

// Convert the connected road lines into polygons
const polygons = turf.polygonize(lines);

console.log("Polygons created:", polygons.features.length);

if (!polygons.features.length) {
  console.error("No polygons could be created.");
  process.exit(1);
}

// Find the largest polygon.
// The largest enclosed area should be the inside of Kathmandu Ring Road.
let largestPolygon = polygons.features[0];
let largestArea = turf.area(largestPolygon);

for (const polygon of polygons.features) {
  const area = turf.area(polygon);

  if (area > largestArea) {
    largestArea = area;
    largestPolygon = polygon;
  }
}

largestPolygon.properties = {
  name: "Kathmandu Ring Road Delivery Boundary",
  areaSquareKm: largestArea / 1000000
};

fs.writeFileSync(
  "ringroad-polygon.geojson",
  JSON.stringify(largestPolygon, null, 2)
);

console.log(
  "Largest polygon area:",
  (largestArea / 1000000).toFixed(2),
  "km²"
);

console.log("Saved: ringroad-polygon.geojson");
