const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// GET /api/geocode?q={q}&limit={n}
// Proxy a Nominatim (OpenStreetMap) para geocodificar direcciones.
// ---------------------------------------------------------------------------
app.get('/api/geocode', async (req, res) => {
  const { q, limit = 5 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta parámetro q' });

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=${encodeURIComponent(limit)}&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'HojaDeRuta/1.0 (tour manager app)' },
    });
    if (!r.ok) throw new Error(`Nominatim respondió ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Error geocodificando', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/route?start={lng,lat}&end={lng,lat}&key={key}
// Proxy a OpenRouteService (directions, perfil driving-car).
// ---------------------------------------------------------------------------
app.get('/api/route', async (req, res) => {
  const { start, end, key } = req.query;
  const orsKey = key || process.env.ORS_KEY;
  if (!start || !end) return res.status(400).json({ error: 'Faltan parámetros start/end' });
  if (!orsKey) return res.status(500).json({ error: 'Falta ORS_KEY' });

  try {
    const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${encodeURIComponent(orsKey)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`ORS respondió ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Error calculando ruta', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/restaurants  {lat,lng,radius,cuisine}
// Proxy a Overpass API (OpenStreetMap) para buscar restaurantes cercanos.
// ---------------------------------------------------------------------------
app.post('/api/restaurants', async (req, res) => {
  const { lat, lng, radius = 1500, cuisine } = req.body || {};
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'Faltan parámetros lat/lng' });
  }

  const cuisineFilter = cuisine ? `["cuisine"~"${cuisine}",i]` : '';
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="restaurant"]${cuisineFilter}(around:${radius},${lat},${lng});
      way["amenity"="restaurant"]${cuisineFilter}(around:${radius},${lat},${lng});
    );
    out center;
  `;

  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Accept: '*/*',
        'User-Agent': 'HojaDeRuta/1.0 (tour manager app)',
      },
      body: query,
    });
    if (!r.ok) throw new Error(`Overpass respondió ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Error buscando restaurantes', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/yelp  {lat,lng,radius,cuisine,key}
// Proxy a Yelp Fusion API (fuente alternativa de restaurantes).
// ---------------------------------------------------------------------------
app.post('/api/yelp', async (req, res) => {
  const { lat, lng, radius = 1500, cuisine, key } = req.body || {};
  const yelpKey = key || process.env.YELP_KEY;
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'Faltan parámetros lat/lng' });
  }
  if (!yelpKey) return res.status(500).json({ error: 'Falta YELP_KEY' });

  try {
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lng,
      radius: Math.min(radius, 40000),
      categories: 'restaurants',
    });
    if (cuisine) params.set('term', cuisine);

    const r = await fetch(`https://api.yelp.com/v3/businesses/search?${params}`, {
      headers: { Authorization: `Bearer ${yelpKey}` },
    });
    if (!r.ok) throw new Error(`Yelp respondió ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Error buscando en Yelp', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/bolo?sheetId={id}
// Lee un Google Sheet público y lo mapea a la estructura de un "bolo".
// Mapeo de celdas confirmado en plantilla_hoja_de_ruta.xlsx.
// ---------------------------------------------------------------------------
const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'];

function cell(values, row, colLetter) {
  const colIdx = COLS.indexOf(colLetter);
  const rowArr = values[row - 1];
  if (!rowArr) return '';
  return (rowArr[colIdx] ?? '').toString().trim();
}

function extractSheetId(input) {
  const match = input.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : input;
}

function parseHotel(values, startRow) {
  const hotel = {
    nombre: cell(values, startRow, 'B'),
    addr: cell(values, startRow + 1, 'B'),
    phone: cell(values, startRow + 2, 'B'),
    checkin: cell(values, startRow + 3, 'B'),
    checkout: cell(values, startRow + 3, 'D'),
    rooms: cell(values, startRow + 4, 'B'),
    breakfast: cell(values, startRow + 4, 'D'),
    parking: cell(values, startRow + 5, 'B'),
    maps: cell(values, startRow + 6, 'B'),
  };
  return hotel.nombre ? hotel : null;
}

function parseBolo(values) {
  const bolo = {
    band: cell(values, 1, 'B'),
    format: cell(values, 1, 'D'),
    venue: cell(values, 2, 'B'),
    date: cell(values, 2, 'D'),
    venueAddr: cell(values, 3, 'B'),
    duration: cell(values, 3, 'D'),
    weather: cell(values, 4, 'C'),
    acceso: cell(values, 5, 'B'),
    agenda: [],
    hotels: [],
    contactos: [],
    vehiculo: {},
    tourParty: [],
  };

  for (let row = 8; row <= 20; row++) {
    const hora = cell(values, row, 'A');
    if (!hora) continue;
    bolo.agenda.push({
      hora,
      label: cell(values, row, 'B'),
      type: cell(values, row, 'C'),
      dur: cell(values, row, 'D'),
    });
  }

  const hotel1 = parseHotel(values, 23);
  if (hotel1) bolo.hotels.push(hotel1);
  const hotel2 = parseHotel(values, 32);
  if (hotel2) bolo.hotels.push(hotel2);

  for (let row = 42; row <= 55; row++) {
    const role = cell(values, row, 'A');
    const nombre = cell(values, row, 'B');
    if (!role && !nombre) continue;
    bolo.contactos.push({
      role,
      nombre,
      telefono: cell(values, row, 'C'),
    });
  }

  bolo.vehiculo = {
    tipo: cell(values, 58, 'B'),
    empresa: cell(values, 59, 'B'),
    telefono: cell(values, 60, 'B'),
    pickup: cell(values, 61, 'B'),
    devolucion: cell(values, 62, 'B'),
  };

  for (let row = 65; row <= 72; row++) {
    const key = cell(values, row, 'A');
    const value = cell(values, row, 'B');
    if (!key && !value) continue;
    bolo.tourParty.push({ key, value });
  }

  return bolo;
}

app.get('/api/bolo', async (req, res) => {
  const { sheetId } = req.query;
  if (!sheetId) return res.status(400).json({ error: 'Falta parámetro sheetId' });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Falta GOOGLE_API_KEY' });

  const id = extractSheetId(sheetId);

  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A1:Z60?key=${apiKey}`;
    const r = await fetch(url);
    if (!r.ok) {
      const detail = await r.text();
      return res.status(r.status === 404 ? 404 : 502).json({
        error: 'No se pudo leer el Google Sheet (¿es público?)',
        detail,
      });
    }
    const data = await r.json();
    const bolo = parseBolo(data.values || []);
    res.json(bolo);
  } catch (err) {
    res.status(502).json({ error: 'Error leyendo el Sheet', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Hoja de Ruta corriendo en http://localhost:${PORT}`);
});
