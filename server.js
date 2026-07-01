const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Caché + candado para evitar navegadores concurrentes ---
const CACHE_TTL_MS = 20000; // 20s: ajusta según qué tan "en vivo" lo necesites
let cache = { payload: null, ts: 0 };
let scrapingPromise = null; // si ya hay un scraping en curso, todas las requests lo reutilizan

async function obtenerPartidosEnVivo() {
  // 1. Si hay caché fresca, úsala
  if (cache.payload && (Date.now() - cache.ts) < CACHE_TTL_MS) {
    return cache.payload;
  }

  // 2. Si ya hay un scraping en curso, espera ese mismo resultado
  //    (evita lanzar un segundo/tercer Chromium en paralelo)
  if (scrapingPromise) {
    return scrapingPromise;
  }

  // 3. Lanzar un scraping nuevo
  scrapingPromise = (async () => {
    const { scrapearPartidosEnVivo } = require('./scraper-espn-live');
    const { partidos, debug } = await scrapearPartidosEnVivo();
    const payload = {
      success: true,
      data: partidos,
      total: partidos.length,
      timestamp: new Date().toISOString(),
      // 🔍 Temporal mientras se depura por qué no aparecen partidos en vivo.
      // Quítalo (o pon detrás de ?debug=1) una vez resuelto.
      debug
    };
    cache = { payload, ts: Date.now() };
    return payload;
  })();

  try {
    return await scrapingPromise;
  } finally {
    scrapingPromise = null; // libera el candado, haya salido bien o mal
  }
}

// Partidos en vivo
app.get('/api/live-matches', async (req, res) => {
  try {
    const payload = await obtenerPartidosEnVivo();
    res.json(payload);
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'API funcionando' });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});