# Hoja de Ruta — v1 Spec

## Contexto
PWA para tour managers. Dos módulos: **BOLOS** (hoja de ruta desde Google Sheets) y **LOMOQUESO** (buscador restaurantes en ruta). Código base existe en el repo.

## Stack
- Backend: Node.js 18+ / Express 4 — server.js existe, añadir endpoint Sheets
- Frontend: Vanilla JS sin framework — reescribir public/index.html desde spec
- Datos: Google Sheets API (bolos) + ORS + Overpass + Nominatim (restaurantes)
- Deploy: Railway (GitHub auto-deploy)

## Archivos
```
/ ├── server.js (existe — añadir GET /api/bolo)
  ├── package.json (existe)
  ├── railway.json (CREAR)
  └── public/
      ├── index.html (REESCRIBIR)
      ├── manifest.json (CREAR)
      └── sw.js (CREAR)
```

## Tokens diseño
```
dark:  bg=#0a0a0a surf=#141414 card=#1a1918 brd=#242220
       text=#ddd9d0 t2=#8a8480 t3=#504a46
       red=#c41a1a rBg=#1a0404 rBrd=#5a1010
       blue=#3a7ec4 blueBg=#0a1a2e blueBrd=#1a3a60
light: bg=#f4f2ed surf=#ffffff card=#ffffff brd=#e0dcd5
       text=#1a1814 t2=#6a6460 t3=#a09890
       red=#c41a1a rBg=#fdf0f0 rBrd=#edb8b8
       blue=#2070b8 blueBg=#e8f0fb blueBrd=#b0c8f0
```
Fuentes: Bebas Neue (headings), JetBrains Mono (datos), system-ui (cuerpo). Google Fonts CDN.
Dark mode por defecto. Toggle persistido en localStorage.

## Navegación
```
home → boloList → import
             └──→ boloDetail
home → comer ↔ favoritos
```
Sección bolos: solo flechas atrás. Sección comer: bottom nav (Comer | Favoritos).

---

## Pantallas

### home
Topbar: "HOJA DE RUTA" (Bebas) + toggle modo.
Dos mitades flex-column, separadas por `2px solid #c41a1a`.
- Top: "BOLOS" (Bebas 58px red) + "{n} conciertos" (12px t2). bg=dark.bg, hover ligeramente más claro.
- Bottom: "LOMOQUESO" (Bebas 46px red) + "Dónde comer en ruta" (12px t2). Mismo tratamiento.

### boloList
Topbar + botón "Importar" (icono ti-file-import, borde, top-right).
Filas: venue (Bebas 18px left) | city+date (12px t2 right) + duration (Bebas 22px red right).

### import
Input URL — validar docs.google.com/spreadsheets. Tick verde si válida.
Botón IMPORTAR (red, disabled si inválida).
Nota: "Sheet idéntico=perfecto / similar=campos interpretados / diferente=campos vacíos".
Llama a GET /api/bolo?sheetId=XXX.

### boloDetail

**Hero:**
```
[Venue Bebas 26px RED]          [Duration Bebas 26px text]
                                 [date 11px t2]
                                 [☁ weather 11px t2]
[btn Venue Maps (red)]  [btn Rider (neutral, solo si hay url)]
[🚐 ACCESO: texto en greige, sin amarillo]
```

**Secciones** — cabecera: icono red + Bebas 14px letterSpacing 2px + línea.

**Agenda** timeline vertical (columna izq: punto+línea, columna dcha: hora+label+duración):
- travel/rest/end → punto t2 8px, hora JetMono 12px t2, label 13px t2
- load/work → punto RED 10px, hora RED, label t2 peso 500
- show → punto RED 14px glow, hora+label Bebas 16px RED

**Alojamiento** — card por hotel: nombre (Bebas 17px) + addr + btn Maps (blue).
Grid 2col: check-in, check-out, habitaciones, desayuno, parking.
phoneBtn = `<a href="tel:+34XX">📞 número</a>` + `<a href="wa.me/34XX">WA</a>`

**Contactos** — grid 2col: role (10px t3 caps) + nombre + phoneBtn.

**Vehículo** — tipo + empresa + phoneBtn + grid pickup/devolución.

**Tour Party** — lista key/value simple.

### comer
Mantener lógica completa existente en index.html actual.
Inputs: origen (+geolocate), destino, hora salida, hora comida, presupuesto €/€€/€€€, cocina.
Flujo: /api/geocode → /api/route → /api/restaurants.
Resultados: lista (hora llegada, desvío, precio, ★ rating, btn Maps) + mapa Leaflet abajo.
Favoritos: localStorage {id: restaurantObj}.

---

## Backend — nuevo endpoint

### GET /api/bolo?sheetId={id}
Env requerida: GOOGLE_API_KEY.
Sheet debe ser público ("anyone with link can view").
Extraer sheetId de URL: `/spreadsheets/d/{ID}/`
Llamar: `https://sheets.googleapis.com/v4/spreadsheets/{id}/values/A1:Z60?key={key}`

**Mapeo celdas — CONFIRMAR CON USUARIO antes de implementar:**
Ofrecer generar plantilla Google Sheets descargable como primer paso.
Estructura sugerida basada en sheet Nunatak visto:
```
B1=band  D1=format  B2=venue  D2=date  B3=venueAddr  D3=duration
C4=weather  B5=acceso
Agenda: filas 8-20, cols A=hora B=label C=type D=dur
Hotel1: filas 23-30 (nombre,addr,phone,rooms,breakfast,checkin,checkout,parking,maps)
Hotel2: filas 32-39
Contactos: filas 42-55, cols A=role B=nombre C=telefono
Vehículo: filas 58-62
TourParty: filas 65-72
```

### Endpoints existentes (no modificar)
```
GET  /api/geocode?q={q}&limit={n}
GET  /api/route?start={lng,lat}&end={lng,lat}&key={key}
POST /api/restaurants  {lat,lng,radius,cuisine}
POST /api/yelp         {lat,lng,radius,cuisine,key}
```

---

## PWA

**manifest.json**
```json
{"name":"Hoja de Ruta","short_name":"HdR","start_url":"/","display":"standalone",
 "theme_color":"#0a0a0a","background_color":"#0a0a0a",
 "icons":[{"src":"/icon-192.png","sizes":"192x192"},{"src":"/icon-512.png","sizes":"512x512"}]}
```
Icono: "HDR" Bebas Neue blanco sobre #c41a1a. Generar con Canvas API en Node.

**sw.js** — cache-first estático (/, index.html, manifest, fonts), network-first /api/*.
Versión cache: `hdr-v1`.

---

## Env vars Railway
```
ORS_KEY=
GOOGLE_API_KEY=
```

## railway.json
```json
{"build":{"builder":"NIXPACKS"},"deploy":{"startCommand":"node server.js"}}
```

---

## Checklist
- [ ] Confirmar mapeo celdas Google Sheet con usuario (ofrecer plantilla descargable)
- [ ] Crear public/index.html (vanilla JS, todas las pantallas en spec)
- [ ] Añadir GET /api/bolo a server.js
- [ ] Crear manifest.json + icono HDR
- [ ] Crear sw.js + registrar en index.html
- [ ] Crear railway.json
- [ ] Test local antes de push
- [ ] Push GitHub → verificar Railway deploy
