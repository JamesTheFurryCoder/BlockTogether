// External API Service (internal). The API Gateway calls this service.
import express from "express";
import cors from "cors";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 4003;
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || "tcss460-secret";

app.use(cors());
app.use(express.json());

// Serve only the test page, keeping other service files private.
app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(fileURLToPath(new URL("./index.html", import.meta.url)));
});

app.get("/health", (req, res) => res.json({ service: "external-api-service", status: "up" }));

app.get('/weather/:city', async (req, res) => {
  const cityName = req.params.city.trim();
  if (!cityName) {
    return res.status(400).json({ error: 'City name is required' });
  }

  return fetchWeather(res, cityName);
});

async function handleWeatherRequest(req, res) {
  const { city, state, country } = req.body ?? {};
  if ([city, state, country].some(value => typeof value !== 'string' || !value.trim())) {
    return res.status(400).json({ error: 'City, state, and country are required as non-empty strings' });
  }

  return fetchWeather(res, city.trim(), state.trim(), country.trim());
}

app.get("/weather", handleWeatherRequest);
app.post("/weather", handleWeatherRequest);

async function fetchWeather(res, cityName, stateName, countryName) {
  try {
    // 1. Fetch coordinates from the Geocoding API
    const isCountryCode = countryName && /^[a-z]{2}$/i.test(countryName);
    const geoParams = new URLSearchParams({
      name: stateName ? `${cityName}, ${stateName}` : cityName,
      count: countryName && !isCountryCode ? '100' : '1',
      language: 'en',
      format: 'json',
    });
    if (isCountryCode) geoParams.set('countryCode', countryName.toUpperCase());
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?${geoParams}`;
    const geoResponse = await fetch(geoUrl, { signal: AbortSignal.timeout(10_000) });
    if (!geoResponse.ok) throw new Error(`Geocoding request failed: ${geoResponse.status}`);
    const geoData = await geoResponse.json();

    // State is filtered by the search qualifier; match full country names here.
    const location = geoData.results?.find(result =>
      !countryName || isCountryCode || result.country?.toLowerCase() === countryName.toLowerCase()
    );
    if (!location) {
      return res.status(404).json({ error: 'City not found' });
    }

    const { latitude, longitude, name, country, admin1 } = location;

    // 2. Fetch weather data using the coordinates
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      daily: [
        "weather_code", "temperature_2m_max", "temperature_2m_min",
        "apparent_temperature_max", "apparent_temperature_min", "uv_index_max",
        "uv_index_clear_sky_max", "moon_phase", "moonset",
        "moonrise", "sunshine_duration", "daylight_duration",
        "sunset", "sunrise", "rain_sum",
        "showers_sum", "snowfall_sum", "precipitation_sum",
        "precipitation_hours", "precipitation_probability_max", "et0_fao_evapotranspiration",
        "shortwave_radiation_sum", "wind_direction_10m_dominant", "wind_gusts_10m_max",
        "wind_speed_10m_max",
      ].join(","),
      hourly: [
        "temperature_2m", "relative_humidity_2m", "dew_point_2m",
        "apparent_temperature", "precipitation_probability", "precipitation",
        "rain", "showers", "snowfall",
        "snow_depth", "vapour_pressure_deficit", "et0_fao_evapotranspiration",
        "evapotranspiration", "visibility", "cloud_cover_high",
        "cloud_cover_mid", "cloud_cover_low", "cloud_cover",
        "surface_pressure", "pressure_msl", "weather_code",
        "soil_temperature_0cm", "soil_temperature_18cm", "soil_temperature_6cm",
        "soil_temperature_54cm", "soil_moisture_0_to_1cm", "soil_moisture_1_to_3cm",
        "soil_moisture_3_to_9cm", "soil_moisture_9_to_27cm", "soil_moisture_27_to_81cm",
        "temperature_180m", "temperature_120m", "temperature_80m",
        "wind_gusts_10m", "wind_direction_180m", "wind_direction_120m",
        "wind_direction_80m", "wind_direction_10m", "wind_speed_180m",
        "wind_speed_120m", "wind_speed_80m", "wind_speed_10m",
      ].join(","),
      current: [
        "is_day", "rain", "showers",
        "snowfall", "precipitation", "apparent_temperature",
        "relative_humidity_2m", "temperature_2m", "weather_code",
        "cloud_cover", "pressure_msl", "surface_pressure",
        "wind_gusts_10m", "wind_direction_10m", "wind_speed_10m",
      ].join(","),
    });
    const weatherResponse = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!weatherResponse.ok) throw new Error(`Weather request failed: ${weatherResponse.status}`);
    const { current, hourly, daily } = await weatherResponse.json();

    // 3. Combine and return the data
    res.json({
      location: { name, state_or_region: admin1, country, latitude, longitude },
      weatherCurrent: current,
      weatherHourly: hourly,
      weatherDaily: daily
    });

  } catch (error) {
    console.error('Error fetching Open-Meteo data:', error);
    res.status(500).json({ error: 'Failed to retrieve weather data' });
  }
}

app.use((req, res, next) => {
  if (req.header("x-api-key") !== SERVICE_API_KEY) {
    return res.status(401).json({ error: "Missing or invalid x-api-key header." });
  }
  next();
});

// Add external API integration routes here.

app.use((req, res) => res.status(404).json({ error: "Route not found." }));
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Request body is not valid JSON." });
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => console.log(`External API Service running at http://localhost:${PORT}`));
