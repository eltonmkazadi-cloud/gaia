// api/weather.js — Météo en temps réel via OpenWeatherMap (CommonJS)
//
// Usage : GET /api/weather?lat=48.85&lon=2.35
// Variable Vercel requise : OPENWEATHER_API_KEY
//   (gratuit : https://home.openweathermap.org/users/sign_up — clé instant)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.OPENWEATHER_API_KEY) {
    return res.status(500).json({
      error:
        'OPENWEATHER_API_KEY manquante (gratuit sur openweathermap.org/api)',
    });
  }

  try {
    const u = new URL(req.url, 'http://x');
    const lat = parseFloat(u.searchParams.get('lat'));
    const lon = parseFloat(u.searchParams.get('lon'));

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'lat & lon requis (numbers)' });
    }

    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      units: 'metric',
      lang: 'fr',
      appid: process.env.OPENWEATHER_API_KEY,
    });

    const r = await fetch(`https://api.openweathermap.org/data/2.5/weather?${params}`);
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data.message || 'Erreur météo' });
    }

    const weather = data.weather?.[0] || {};
    return res.status(200).json({
      city: data.name || '',
      country: data.sys?.country || '',
      temp: Math.round(data.main?.temp ?? 0),
      feels: Math.round(data.main?.feels_like ?? 0),
      humidity: data.main?.humidity ?? 0,
      wind: Math.round((data.wind?.speed ?? 0) * 3.6), // m/s → km/h
      description: weather.description || '',
      main: weather.main || '',
      icon: weather.icon || '',
      sunrise: data.sys?.sunrise ? data.sys.sunrise * 1000 : null,
      sunset: data.sys?.sunset ? data.sys.sunset * 1000 : null,
    });
  } catch (err) {
    console.error('Weather error:', err);
    return res.status(500).json({ error: err.message });
  }
};
