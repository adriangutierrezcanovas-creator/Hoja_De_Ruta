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
  const { lat, lng, radius, cuisine } = req.body || {};
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'Faltan parámetros lat/lng' });
  }

  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return res.status(400).json({ error: 'lat/lng inválidos' });
  }
  // Radio centrado en el punto de comida: por defecto y como máximo 20km,
  // para no timeoutear buscando en zonas enormes.
  const radiusNum = Math.min(Math.max(Number(radius) || 20000, 500), 20000);

  // El nombre de cocina va dentro de un regex de Overpass QL: fuera solo dígitos/letras/espacios/guiones.
  const cuisineClean = (cuisine || '').toString().replace(/[^\p{L}\p{N} .-]/gu, '').trim();
  const cuisineFilter = cuisineClean ? `["cuisine"~"${cuisineClean}",i]` : '';
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="restaurant"]${cuisineFilter}(around:${radiusNum},${latNum},${lngNum});
      way["amenity"="restaurant"]${cuisineFilter}(around:${radiusNum},${latNum},${lngNum});
    );
    out center 60;
  `;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
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
      return res.json(data);
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await sleep(1500);
    }
  }
  res.status(502).json({ error: 'Error buscando restaurantes (el servicio de mapas está saturado, prueba de nuevo)', detail: lastErr.message });
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
//
// El sheet real de gira no es una plantilla de celdas fijas: es un formato
// libre de "etiqueta en una celda, valor en la de al lado" organizado en
// secciones (cabecera, ALOJAMIENTO 1/2, CONTACTOS, HORARIOS, EMPRESA ALQ.
// FURGO, TOUR PARTY...). Por eso el parser localiza cada sección buscando su
// etiqueta ancla (tolerante a mayúsculas/acentos/espacios) y luego lee los
// campos de esa sección en posiciones relativas fijas, en vez de asumir
// números de fila absolutos.
// ---------------------------------------------------------------------------

function norm(v) {
  return (v ?? '').toString().trim();
}

function stripLabel(text) {
  return norm(text).replace(/:\s*$/, '').trim();
}

// Busca la primera celda (fila, col) cuyo texto cumpla `regex`, dentro del
// rango de filas [fromRow, toRow) y de las columnas indicadas (por defecto todas).
function findCell(values, regex, { fromRow = 0, toRow = values.length, cols } = {}) {
  const end = Math.min(toRow, values.length);
  for (let r = fromRow; r < end; r++) {
    const row = values[r] || [];
    const colRange = cols || row.map((_, i) => i);
    for (const c of colRange) {
      const text = norm(row[c]);
      if (text && regex.test(text)) return { row: r, col: c };
    }
  }
  return null;
}

// Valor de la primera celda no vacía a la derecha de (row, col), mirando
// como máximo `maxLookahead` columnas (evita "comerse" la siguiente etiqueta
// si el valor de esta está vacío).
function valueRightOf(values, row, col, maxLookahead = 1) {
  const rowArr = values[row] || [];
  for (let c = col + 1; c <= col + maxLookahead; c++) {
    const v = norm(rowArr[c]);
    if (v) return v;
  }
  return '';
}

function cellAt(values, row, col) {
  return norm((values[row] || [])[col]);
}

function extractSheetId(input) {
  const match = input.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : input;
}

// ---------- Cabecera: banda, ciudad, venue, fecha, meteo, acceso ----------
function parseHeader(values, limitRow) {
  const header = {};

  const bandCell = findCell(values, /\bEN:?\s*$/i, { fromRow: 0, toRow: limitRow, cols: [0] });
  if (bandCell) {
    header.band = norm(cellAt(values, bandCell.row, 0)).replace(/\s*EN:?\s*$/i, '').trim();
    header.city = valueRightOf(values, bandCell.row, 0, 2);
    const formatoCell = findCell(values, /^Formato\s*banda/i, { fromRow: bandCell.row, toRow: bandCell.row + 1 });
    if (formatoCell) header.formato = valueRightOf(values, formatoCell.row, formatoCell.col, 2);
  }

  const lugarCell = findCell(values, /^LUGAR\b/i, { fromRow: 0, toRow: limitRow, cols: [0] });
  if (lugarCell) {
    header.lugar = valueRightOf(values, lugarCell.row, 0, 2);
    const direccionCell = findCell(values, /^DIRECCI[ÓO]N/i, { fromRow: lugarCell.row, toRow: lugarCell.row + 1 });
    if (direccionCell) header.direccion = valueRightOf(values, direccionCell.row, direccionCell.col, 2);
  }

  const fechaCell = findCell(values, /^FECHA\b/i, { fromRow: 0, toRow: limitRow, cols: [0] });
  if (fechaCell) {
    header.fecha = valueRightOf(values, fechaCell.row, 0, 2);
    const mapsCell = findCell(values, /^GOOGLE\s*MAPS/i, { fromRow: fechaCell.row, toRow: fechaCell.row + 1 });
    if (mapsCell) header.venueMapsUrl = valueRightOf(values, mapsCell.row, mapsCell.col, 2);
  }

  const weatherCell = findCell(values, /^Previsi[óo]n\s*meteorol/i, { fromRow: 0, toRow: limitRow, cols: [0] });
  if (weatherCell) {
    const cond = valueRightOf(values, weatherCell.row, 0, 1);
    const temp = cellAt(values, weatherCell.row, 2);
    header.weather = [cond, temp].filter(Boolean).join(' · ');
    const accesoCell = findCell(values, /^Comentarios\s*sobre\s*acceso/i, { fromRow: weatherCell.row, toRow: weatherCell.row + 1 });
    if (accesoCell) header.acceso = valueRightOf(values, accesoCell.row, accesoCell.col, 2);
  }

  return header;
}

// ---------- Alojamiento: bloque de 4 filas por hotel ----------
function parseHotelBlock(values, headerCell) {
  if (!headerCell) return null;
  const { row, col } = headerCell;
  const nombre = valueRightOf(values, row, col, 2);
  if (!nombre) return null;

  const hotel = { nombre };

  const direccionCell = findCell(values, /^DIRECCI[ÓO]N/i, { fromRow: row, toRow: row + 1 });
  if (direccionCell) hotel.addr = valueRightOf(values, direccionCell.row, direccionCell.col, 2).replace(/\s+/g, ' ');
  const mapsCell = findCell(values, /^Google\s*Maps/i, { fromRow: row, toRow: row + 1 });
  if (mapsCell) hotel.maps = valueRightOf(values, mapsCell.row, mapsCell.col, 2);

  const tlfCell = findCell(values, /^(Tlfn|Tel[ée]fono)/i, { fromRow: row + 1, toRow: row + 2, cols: [0] });
  if (tlfCell) {
    const phones = [1, 2, 3].map((off) => cellAt(values, tlfCell.row, tlfCell.col + off)).filter(Boolean);
    hotel.phone = phones.join(' / ');
  }
  const roomingCell = findCell(values, /^Rooming/i, { fromRow: row + 1, toRow: row + 2 });
  if (roomingCell) {
    hotel.rooms = valueRightOf(values, roomingCell.row, roomingCell.col, 1);
    const rowArr = values[roomingCell.row] || [];
    const breakfastIdx = rowArr.findIndex((v) => /DESAYUNO/i.test(norm(v)));
    if (breakfastIdx !== -1) hotel.breakfast = norm(rowArr[breakfastIdx]);
  }

  const parkingCell = findCell(values, /^Parking\s*hotel/i, { fromRow: row + 2, toRow: row + 3, cols: [0] });
  if (parkingCell) hotel.parking = valueRightOf(values, parkingCell.row, parkingCell.col, 1);
  const checkinCell = findCell(values, /^Check\s*[- ]?in/i, { fromRow: row + 2, toRow: row + 3 });
  if (checkinCell) hotel.checkin = valueRightOf(values, checkinCell.row, checkinCell.col, 1);

  const checkoutCell = findCell(values, /^Check\s*[- ]?out/i, { fromRow: row + 3, toRow: row + 4 });
  if (checkoutCell) hotel.checkout = valueRightOf(values, checkoutCell.row, checkoutCell.col, 1);

  return hotel;
}

// ---------- Contactos: dos bloques (genérico A-C y banda E-G) ----------
function parseContactos(values, fromRow, toRow) {
  const contactos = [];
  for (let r = fromRow; r < toRow; r++) {
    const roleA = cellAt(values, r, 0);
    const nombreA = cellAt(values, r, 1);
    if (roleA && nombreA) {
      contactos.push({ role: stripLabel(roleA), nombre: stripLabel(nombreA), telefono: cellAt(values, r, 2) });
    }
    const roleE = cellAt(values, r, 4);
    const nombreF = cellAt(values, r, 5);
    if (roleE && nombreF && !/^nombre$/i.test(nombreF)) {
      contactos.push({ role: stripLabel(roleE), nombre: stripLabel(nombreF), telefono: cellAt(values, r, 6) });
    }
  }
  return contactos;
}

// ---------- Agenda: sección HORARIOS hasta BACKLINE ----------
const AGENDA_SHOW_RE = /concierto/i;
const AGENDA_WORK_RE = /monta|soundcheck|citaci|descarga|prueba de sonido/i;

function normalizeDur(raw) {
  const s = norm(raw);
  if (!s) return '';
  const num = s.replace(/'/g, '').trim();
  return /^\d+$/.test(num) ? `${num} min` : s;
}

function cleanAgendaLabel(label, band) {
  let out = norm(label);
  if (band) out = out.replace(new RegExp(`\\s*${band.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '');
  return stripLabel(out);
}

function parseAgenda(values, fromRow, toRow, band) {
  const agenda = [];
  for (let r = fromRow; r < toRow; r++) {
    const label = cellAt(values, r, 0);
    if (!label) continue;
    const horaRaw = cellAt(values, r, 2);
    const horaMatch = horaRaw.match(/(\d{1,2}:\d{2})/);
    if (!horaMatch) continue;
    const cleanLabel = cleanAgendaLabel(label, band);
    let type = 'travel';
    if (AGENDA_SHOW_RE.test(label)) type = 'show';
    else if (AGENDA_WORK_RE.test(label)) type = 'work';
    agenda.push({ hora: horaMatch[1], label: cleanLabel, type, dur: normalizeDur(cellAt(values, r, 1)) });
  }
  return agenda;
}

// ---------- Vehículo: bloque de filas junto a "EMPRESA ALQ. FURGO:" ----------
function parseVehiculo(values, empresaCell) {
  if (!empresaCell) return {};
  const { row, col } = empresaCell;
  const vehiculo = {};
  let empresa = valueRightOf(values, row, col, 1);
  let telefono = '';

  const tlfCell = findCell(values, /^TLF\s*empresa/i, { fromRow: row + 1, toRow: row + 2 });
  if (tlfCell) {
    const raw = valueRightOf(values, tlfCell.row, tlfCell.col, 1);
    const parts = raw.split(':');
    if (parts.length > 1) {
      if (!empresa) empresa = parts[0].trim();
      telefono = parts.slice(1).join(':').trim();
    } else {
      telefono = raw;
    }
  }
  vehiculo.empresa = empresa;
  vehiculo.telefono = telefono;

  const tipoCell = findCell(values, /^TIPO\s*DE\s*VEH[ÍI]CULO/i, { fromRow: row + 2, toRow: row + 3 });
  if (tipoCell) vehiculo.tipo = valueRightOf(values, tipoCell.row, tipoCell.col, 1);

  const diaRecCell = findCell(values, /^D[ÍI]A\s*DE\s*RECOGIDA/i, { fromRow: row + 3, toRow: row + 4 });
  const diaRec = diaRecCell ? valueRightOf(values, diaRecCell.row, diaRecCell.col, 1) : '';
  const diaDevCell = findCell(values, /^D[ÍI]A\s*DE\s*DEVOLUCI[ÓO]N/i, { fromRow: row + 3, toRow: row + 4 });
  const diaDev = diaDevCell ? valueRightOf(values, diaDevCell.row, diaDevCell.col, 2) : '';

  const horaRecCell = findCell(values, /^HORA\s*DE\s*RECOGIDA/i, { fromRow: row + 4, toRow: row + 5 });
  const horaRec = horaRecCell ? valueRightOf(values, horaRecCell.row, horaRecCell.col, 1) : '';
  const horaDevCell = findCell(values, /^HORA\s*DE\s*DEVOLUCI[ÓO]N/i, { fromRow: row + 4, toRow: row + 5 });
  const horaDev = horaDevCell ? valueRightOf(values, horaDevCell.row, horaDevCell.col, 2) : '';

  vehiculo.pickup = [diaRec, horaRec].filter(Boolean).join(' ');
  vehiculo.devolucion = [diaDev, horaDev].filter(Boolean).join(' ');
  return vehiculo;
}

// ---------- Tour party: pares clave/valor bajo "TOUR PARTY" ----------
function parseTourParty(values, headerCell) {
  const tourParty = [];
  if (!headerCell) return tourParty;
  for (let r = headerCell.row + 1; r < values.length; r++) {
    const key = cellAt(values, r, headerCell.col);
    if (!key) break;
    const value = cellAt(values, r, headerCell.col + 1);
    tourParty.push({ key, value });
  }
  return tourParty;
}

function parseBolo(values) {
  const hotel1Cell = findCell(values, /^ALOJAMIENTO\s*1/i, { cols: [0] });
  const hotel2Cell = findCell(values, /^ALOJAMIENTO\s*2/i, { cols: [0] });
  const contactosCell = findCell(values, /^CONTACTOS/i, { cols: [0] });
  const horariosCell = findCell(values, /^HORARIOS/i, { cols: [0] });
  const backlineCell = findCell(values, /^BACKLINE/i, { cols: [0] });
  const empresaFurgoCell = findCell(values, /^EMPRESA\s*ALQ\.?\s*FURGO/i);
  const tourPartyCell = findCell(values, /^TOUR\s*PARTY/i);
  const riderCell = findCell(values, /rider/i);

  const headerLimit = hotel1Cell ? hotel1Cell.row : values.length;
  const header = parseHeader(values, headerLimit);

  const bolo = {
    band: header.band || '',
    format: header.formato || '',
    venue: header.city || '',
    lugar: header.lugar || '',
    date: header.fecha || '',
    venueAddr: header.direccion || '',
    venueMapsUrl: header.venueMapsUrl || '',
    weather: header.weather || '',
    acceso: header.acceso || '',
    agenda: [],
    hotels: [],
    contactos: [],
    vehiculo: {},
    tourParty: [],
    riderUrl: '',
    duration: '',
  };

  const hotel1 = parseHotelBlock(values, hotel1Cell);
  if (hotel1) bolo.hotels.push(hotel1);
  const hotel2 = parseHotelBlock(values, hotel2Cell);
  if (hotel2) bolo.hotels.push(hotel2);

  if (contactosCell) {
    const contactosEnd = horariosCell ? horariosCell.row : contactosCell.row + 15;
    bolo.contactos = parseContactos(values, contactosCell.row + 1, contactosEnd);
  }

  if (horariosCell) {
    const horariosEnd = backlineCell ? backlineCell.row : horariosCell.row + 15;
    bolo.agenda = parseAgenda(values, horariosCell.row + 1, horariosEnd, bolo.band);
    const showEntry = bolo.agenda.find((a) => a.type === 'show');
    if (showEntry && showEntry.dur) bolo.duration = showEntry.dur;
  }

  bolo.vehiculo = parseVehiculo(values, empresaFurgoCell);
  bolo.tourParty = parseTourParty(values, tourPartyCell);

  if (riderCell) {
    const riderUrl = valueRightOf(values, riderCell.row, riderCell.col, 2);
    if (/^https?:\/\//i.test(riderUrl)) bolo.riderUrl = riderUrl;
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
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A1:P100?key=${apiKey}`;
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

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Hoja de Ruta corriendo en http://localhost:${PORT}`);
  });
}

module.exports = { parseBolo };
