// External API Service (internal). The API Gateway calls this service.
// It wraps the free Open-Meteo APIs (no API key needed) and returns weather for a place.
import express from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";
import { readFileSync } from "node:fs";
import { fileURLToPath as toPath } from "node:url";
import cors from "cors";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 4003;
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || "tcss460-secret";

app.use(cors());
app.use(express.json());

// Public: test page and health check (the API key check comes after these).
app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(fileURLToPath(new URL("./index.html", import.meta.url)));
});
app.get("/health", (req, res) => res.json({ service: "external-api-service", status: "up" }));

// Swagger UI (open without a key, like /health).
const openApiDocument = YAML.parse(readFileSync(toPath(new URL("./openapi.yaml", import.meta.url)), "utf8"));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

// Everything below this line requires the x-api-key header.
app.use((req, res, next) => {
  if (req.header("x-api-key") !== SERVICE_API_KEY) {
    return res.status(401).json({ error: "Missing or invalid x-api-key header." });
  }
  next();
});

const clean = (value) => (typeof value === "string" ? value.trim() : "");

// GET /weather?city=Tacoma&state=Washington&country=US  (state and country are optional)
app.get("/weather", (req, res) => {
  const city = clean(req.query.city);
  if (!city) return res.status(400).json({ error: "The city query parameter is required." });
  return fetchWeather(res, city, clean(req.query.state), clean(req.query.country));
});

// POST /weather with JSON {"city","state","country"} (used by the test page)
app.post("/weather", (req, res) => {
  const { city, state, country } = req.body ?? {};
  if (!clean(city)) return res.status(400).json({ error: "The city field is required." });
  return fetchWeather(res, clean(city), clean(state), clean(country));
});

// GET /weather/Tacoma (city only)
app.get("/weather/:city", (req, res) => {
  const city = clean(req.params.city);
  if (!city) return res.status(400).json({ error: "City name is required." });
  return fetchWeather(res, city);
});

async function fetchWeather(res, cityName, stateName, countryName) {
  try {
    // 1. Look up coordinates with the Open-Meteo Geocoding API
    const isCountryCode = countryName && /^[a-z]{2}$/i.test(countryName);
    const geoParams = new URLSearchParams({
      name: stateName ? `${cityName}, ${stateName}` : cityName,
      count: countryName && !isCountryCode ? "100" : "1",
      language: "en",
      format: "json",
    });
    if (isCountryCode) geoParams.set("countryCode", countryName.toUpperCase());
    const geoResponse = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${geoParams}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!geoResponse.ok) throw new Error(`Geocoding request failed: ${geoResponse.status}`);
    const geoData = await geoResponse.json();

    // State is handled by the search text; full country names are matched here.
    const location = geoData.results?.find((result) =>
      !countryName || isCountryCode || result.country?.toLowerCase() === countryName.toLowerCase()
    );
    if (!location) return res.status(404).json({ error: "City not found." });

    const { latitude, longitude, name, country, admin1 } = location;

    // 2. Get the weather for those coordinates (only the fields the game needs)
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      current: [
        "is_day", "temperature_2m", "apparent_temperature", "relative_humidity_2m",
        "precipitation", "rain", "showers", "snowfall", "weather_code",
        "cloud_cover", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
        "pressure_msl",
      ].join(","),
      hourly: [
        "temperature_2m", "precipitation_probability", "weather_code",
        "cloud_cover", "wind_speed_10m",
      ].join(","),
      daily: [
        "weather_code", "temperature_2m_max", "temperature_2m_min", "sunrise",
        "sunset", "precipitation_sum", "precipitation_probability_max", "uv_index_max",
      ].join(","),
      forecast_days: "3",
      timezone: "auto",
    });
    const weatherResponse = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!weatherResponse.ok) throw new Error(`Weather request failed: ${weatherResponse.status}`);
    const { current, hourly, daily } = await weatherResponse.json();

    // 3. Return a compact response
    res.json({
      location: { name, state_or_region: admin1, country, latitude, longitude },
      weatherCurrent: current,
      weatherHourly: hourly,
      weatherDaily: daily,
    });
  } catch (error) {
    console.error("Open-Meteo request failed:", error.message);
    res.status(502).json({ error: "The weather provider (Open-Meteo) could not be reached." });
  }
}

app.use((req, res) => res.status(404).json({ error: "Route not found." }));
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Request body is not valid JSON." });
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => console.log(`External API Service running at http://localhost:${PORT}`));
