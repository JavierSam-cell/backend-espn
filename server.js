// server.js
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
const CACHE_TTL_MS = 20000; // 20s
let cache = { payload: null, ts: 0 };
let scrapingPromise = null;
let navegadorCalentado = false;

// Función para calentar el navegador en background
async function calentarNavegador() {
  if (navegadorCalentado) {
    console.log('🔥 Navegador ya calentado, saltando...');
    return;
  }
  
  console.log('🔥 [INICIO] Calentando navegador en background...');
  console.log('⏳ Esto puede tomar 5-10 segundos...');
  
  try {
    // Importar el scraper
    const { scrapearPartidosEnVivo } = require('./scraper-espn-live');
    
    // Hacer una petición "fake" para iniciar el navegador
    // y mantenerlo vivo en memoria
    const resultado = await scrapearPartidosEnVivo();
    
    navegadorCalentado = true;
    console.log(`✅ Navegador calentado exitosamente (${resultado.partidos.length} partidos)`);
    console.log(`📊 Caché inicializada con ${resultado.partidos.length} partidos`);
    
    // Actualizar caché con el resultado
    cache = {
      payload: {
        success: true,
        data: resultado.partidos,
        total: resultado.partidos.length,
        timestamp: new Date().toISOString(),
        warmed: true,
        debug: resultado.debug
      },
      ts: Date.now()
    };
    
  } catch (error) {
    console.error('❌ Error calentando navegador:', error.message);
    console.log('⚠️ El navegador se calentará en la primera petición');
    navegadorCalentado = false;
  }
  
  console.log('🔥 [FIN] Calentamiento completado');
}

async function obtenerPartidosEnVivo() {
  // 1. Si hay caché fresca, úsala
  if (cache.payload && (Date.now() - cache.ts) < CACHE_TTL_MS) {
    console.log('📦 [CACHE] Devolviendo caché fresca');
    return cache.payload;
  }

  // 2. Si ya hay un scraping en curso, espera ese mismo resultado
  if (scrapingPromise) {
    console.log('⏳ [CACHE] Scraping en curso, esperando...');
    return scrapingPromise;
  }

  // 3. Lanzar un scraping nuevo
  console.log('🔄 [SCRAPING] Iniciando nuevo scraping...');
  scrapingPromise = (async () => {
    const { scrapearPartidosEnVivo } = require('./scraper-espn-live');
    const { partidos, debug } = await scrapearPartidosEnVivo();
    
    const payload = {
      success: true,
      data: partidos,
      total: partidos.length,
      timestamp: new Date().toISOString(),
      warmed: navegadorCalentado,
      debug: debug // Puedes quitarlo después de depurar
    };
    
    cache = { payload, ts: Date.now() };
    console.log(`✅ [SCRAPING] Completado: ${partidos.length} partidos`);
    return payload;
  })();

  try {
    return await scrapingPromise;
  } finally {
    scrapingPromise = null;
  }
}

// Partidos en vivo
app.get('/api/live-matches', async (req, res) => {
  try {
    console.log('📡 [REQUEST] /api/live-matches');
    const payload = await obtenerPartidosEnVivo();
    res.json(payload);
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para ver estado del caché y navegador
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    navegadorCalentado: navegadorCalentado,
    cache: {
      tieneDatos: !!cache.payload,
      antiguedad: cache.ts ? Math.floor((Date.now() - cache.ts) / 1000) + 's' : 'sin datos',
      totalPartidos: cache.payload?.data?.length || 0
    },
    timestamp: new Date().toISOString()
  });
});

// Iniciar servidor
app.listen(PORT, async () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
  console.log(`⏰ ${new Date().toISOString()}`);
  console.log('📡 Endpoints disponibles:');
  console.log('   GET /api/live-matches - Obtener partidos en vivo');
  console.log('   GET /api/status - Estado del sistema');
  console.log('   GET /api/health - Health check');
  
  // 🔥 CALENTAR EL NAVEGADOR EN BACKGROUND
  // Esto no bloquea el servidor, se ejecuta en paralelo
  setTimeout(() => {
    calentarNavegador();
  }, 1000); // Esperar 1 segundo para que el servidor esté listo
});