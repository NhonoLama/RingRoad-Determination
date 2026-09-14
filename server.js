require("dotenv").config();

const express = require("express");
const fs = require("fs");
const turf = require("@turf/turf");

const app = express();
const PORT = process.env.PORT || 3007;

app.use(express.json());

/*
|--------------------------------------------------------------------------
| BASIC CORS
|--------------------------------------------------------------------------
| Required because the GHL checkout page will eventually call:
|
| https://2-25-179-133.sslip.io/location/autocomplete
|
| from a different website/domain.
|
| For testing we allow all origins.
| Later we can restrict this to your actual store domain.
|--------------------------------------------------------------------------
*/

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

/*
|--------------------------------------------------------------------------
| CHECK REQUIRED ENV VARIABLES
|--------------------------------------------------------------------------
*/

if (!process.env.LOCATIONIQ_API_KEY) {
  console.error(
    "ERROR: LOCATIONIQ_API_KEY missing from .env"
  );

  process.exit(1);
}

/*
|--------------------------------------------------------------------------
| LOAD KATHMANDU RING ROAD POLYGON
|--------------------------------------------------------------------------
|
| This file was generated from OpenStreetMap NH39 data.
| We load it once when Node starts instead of reading it for every request.
|--------------------------------------------------------------------------
*/

const ringRoadPolygon = JSON.parse(
  fs.readFileSync(
    "/var/www/rainbowbakes.shop/ringroad-polygon.geojson",
    "utf8"
  )
);

console.log("Kathmandu Ring Road polygon loaded.");

/*
|--------------------------------------------------------------------------
| DELIVERY RULES
|--------------------------------------------------------------------------
*/

const INSIDE_FREE_THRESHOLD = 1500;
const INSIDE_DELIVERY_PRICE = 100;

const OUTSIDE_FREE_THRESHOLD = 3000;
const OUTSIDE_DELIVERY_PRICE = 200;

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Raindow Peaks Delivery API"
  });
});

/*
|--------------------------------------------------------------------------
| LOCATION AUTOCOMPLETE
|--------------------------------------------------------------------------
|
| Customer types:
|
|   "Puta..."
|
| Browser calls:
|
|   GET /location/autocomplete?q=Puta
|
| Our VPS calls LocationIQ.
|
| LocationIQ API key stays private on the VPS.
|--------------------------------------------------------------------------
*/

app.get("/location/autocomplete", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();

    console.log(
      "Autocomplete search:",
      query
    );

    /*
     * Don't waste LocationIQ requests for very short input.
     */
    if (query.length < 3) {
      return res.json([]);
    }

    const url = new URL(
      "https://api.locationiq.com/v1/autocomplete"
    );

    url.searchParams.set(
      "key",
      process.env.LOCATIONIQ_API_KEY
    );

    url.searchParams.set(
      "q",
      query
    );

    /*
     * Nepal only.
     */
    url.searchParams.set(
      "countrycodes",
      "np"
    );

    /*
     * Bias search around Kathmandu Valley.
     *
     * west,south,east,north
     */
    url.searchParams.set(
      "viewbox",
      "85.20,27.58,85.55,27.85"
    );

    /*
     * 0 = Kathmandu is preferred,
     * but valid Nepal results outside the box are still possible.
     */
    url.searchParams.set(
      "bounded",
      "1"
    );
    
    url.searchParams.set("accept-language", "en");

    url.searchParams.set(
      "limit",
      "5"
    );

    url.searchParams.set(
      "normalizecity",
      "1"
    );

    url.searchParams.set(
      "dedupe",
      "1"
    );

    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();

      console.error(
        "LocationIQ autocomplete error:",
        response.status,
        text
      );

      throw new Error(
        `LocationIQ autocomplete HTTP ${response.status}`
      );
    }

    const results = await response.json();

    if (!Array.isArray(results)) {
      return res.json([]);
    }

    /*
     * Only expose information our checkout needs.
     *
     * Do NOT expose our LocationIQ API key.
     */
    const suggestions = results.map((item) => ({
      placeId: item.place_id || null,

      displayName:
        item.display_name || "",

      latitude:
        Number(item.lat),

      longitude:
        Number(item.lon),

      type:
        item.type || null,

      address: {
        name:
          item.address?.name || "",

        road:
          item.address?.road || "",

        neighbourhood:
          item.address?.neighbourhood || "",

        suburb:
          item.address?.suburb || "",

        city:
          item.address?.city ||
          item.address?.town ||
          item.address?.municipality ||
          "Kathmandu",

        postcode:
          item.address?.postcode || "",

        countryCode:
          item.address?.country_code || "np"
      }
    }));

    console.log(
      "Autocomplete suggestions:",
      suggestions.length
    );

    return res.json(suggestions);

  } catch (error) {
    console.error(
      "Autocomplete error:",
      error.message
    );

    return res.status(500).json({
      error: "Unable to search locations"
    });
  }
});

/*
|--------------------------------------------------------------------------
| GHL SHIPPING RATE CALLBACK
|--------------------------------------------------------------------------
*/

app.post("/ghl/shipping-rates", async (req, res) => {
  try {
    console.log(
      "\n===== GHL SHIPPING REQUEST ====="
    );

    console.log(
      JSON.stringify(req.body, null, 2)
    );

    const rate =
      req.body?.rate;

    const destination =
      rate?.destination;

    const items =
      Array.isArray(rate?.items)
        ? rate.items
        : [];

    /*
    |--------------------------------------------------------------------------
    | GHL CAN CALL BEFORE ADDRESS IS COMPLETE
    |--------------------------------------------------------------------------
    */

    if (
      !destination?.address1  
    ) {
      console.log(
        "Destination incomplete — returning no rate"
      );

      return res.json({
        rates: []
      });
    }

    /*
    |--------------------------------------------------------------------------
    | CALCULATE CART SUBTOTAL
    |--------------------------------------------------------------------------
    */

    const subtotal = items.reduce(
      (sum, item) => {
        const totalPrice =
          Number(item.totalPrice || 0);

        return sum + totalPrice;
      },
      0
    );

    console.log(
      "Cart subtotal:",
      `NPR ${subtotal}`
    );

    /*
    |--------------------------------------------------------------------------
    | BUILD DESTINATION ADDRESS
    |--------------------------------------------------------------------------
    */

    const address = [
      destination.address1,
      destination.city,
      destination.state,
      destination.zip,
      destination.country
    ]
      .filter(Boolean)
      .join(", ");

    console.log(
      "Address to geocode:",
      address
    );

    /*
    |--------------------------------------------------------------------------
    | FORWARD GEOCODING
    |--------------------------------------------------------------------------
    |
    | Example:
    |
    | Putalisadak, Kathmandu
    |
    | becomes:
    |
    | lat: 27.704...
    | lon: 85.322...
    |--------------------------------------------------------------------------
    */

    const geocodeUrl = new URL(
      "https://us1.locationiq.com/v1/search"
    );

    geocodeUrl.searchParams.set(
      "key",
      process.env.LOCATIONIQ_API_KEY
    );

    geocodeUrl.searchParams.set(
      "q",
      address
    );

    geocodeUrl.searchParams.set(
      "format",
      "json"
    );

    geocodeUrl.searchParams.set(
      "countrycodes",
      "np"
    );

    geocodeUrl.searchParams.set(
      "limit",
      "1"
    );

    const geocodeResponse =
      await fetch(geocodeUrl);

    if (!geocodeResponse.ok) {
      const text =
        await geocodeResponse.text();

      console.error(
        "LocationIQ geocoding error:",
        geocodeResponse.status,
        text
      );

      throw new Error(
        `LocationIQ geocoding HTTP ${geocodeResponse.status}`
      );
    }

    const results =
      await geocodeResponse.json();

    if (
      !Array.isArray(results) ||
      results.length === 0
    ) {
      console.log(
        "LocationIQ could not locate destination"
      );

      return res.json({
        rates: []
      });
    }

    const latitude =
      Number(results[0].lat);

    const longitude =
      Number(results[0].lon);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      throw new Error(
        "Invalid coordinates returned by LocationIQ"
      );
    }

    console.log(
      "Geocoded location:"
    );

    console.log(
      "Latitude:",
      latitude
    );

    console.log(
      "Longitude:",
      longitude
    );

    console.log(
      "Matched:",
      results[0].display_name
    );

    /*
    |--------------------------------------------------------------------------
    | CREATE CUSTOMER GEOJSON POINT
    |--------------------------------------------------------------------------
    |
    | IMPORTANT:
    |
    | Turf / GeoJSON order is:
    |
    | [longitude, latitude]
    |
    | NOT:
    |
    | [latitude, longitude]
    |--------------------------------------------------------------------------
    */

    const customerPoint =
      turf.point([
        longitude,
        latitude
      ]);

    /*
    |--------------------------------------------------------------------------
    | CHECK INSIDE / OUTSIDE RING ROAD
    |--------------------------------------------------------------------------
    */

    const insideRingRoad =
      turf.booleanPointInPolygon(
        customerPoint,
        ringRoadPolygon
      );

    console.log(
      "Inside Ring Road:",
      insideRingRoad
    );

    /*
    |--------------------------------------------------------------------------
    | CALCULATE DELIVERY PRICE
    |--------------------------------------------------------------------------
    */

    let deliveryPrice;
    let serviceName;

    if (insideRingRoad) {

      /*
       * INSIDE RING ROAD
       *
       * >= 1500 = FREE
       * <  1500 = Rs 100
       */

      if (
        subtotal >=
        INSIDE_FREE_THRESHOLD
      ) {
        deliveryPrice = 0;

        serviceName =
          "Inside Ring Road - Free Delivery";
      } else {
        deliveryPrice =
          INSIDE_DELIVERY_PRICE;

        serviceName =
          "Inside Ring Road Delivery";
      }

    } else {

      /*
       * OUTSIDE RING ROAD
       *
       * >= 3000 = FREE
       * <  3000 = Rs 200
       */

      if (
        subtotal >=
        OUTSIDE_FREE_THRESHOLD
      ) {
        deliveryPrice = 0;

        serviceName =
          "Outside Ring Road - Free Delivery";
      } else {
        deliveryPrice =
          OUTSIDE_DELIVERY_PRICE;

        serviceName =
          "Outside Ring Road Delivery";
      }
    }

    console.log(
      "Delivery price:",
      `NPR ${deliveryPrice}`
    );

    console.log(
      "Service:",
      serviceName
    );

    /*
    |--------------------------------------------------------------------------
    | RETURN LIVE SHIPPING RATE TO GHL
    |--------------------------------------------------------------------------
    */

    return res.json({
      rates: [
        {
          serviceName,

          amount:
            deliveryPrice,

          currency:
            rate?.currency || "NPR",

          estimatedDays: 1
        }
      ]
    });

  } catch (error) {
    console.error(
      "Shipping calculation error:",
      error.message
    );

    return res.status(500).json({
      error:
        "Unable to calculate delivery rate"
    });
  }
});

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Raindow Delivery API running on port ${PORT}`
    );
  }
);
