// server.js - VERSIÓN CON CHEERIO (SIN PUPPETEER)
const express = require('express');
const cors = require('cors');
const got = require('got');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ============================================================
// CONFIGURACIÓN DE CACHÉ
// ============================================================

const CACHE_TTL_MS = 20000; // 20 segundos
let cache = { 
    payload: null, 
    ts: 0 
};
let scrapingPromise = null;

// ============================================================
// SCRAPER CON CHEERIO (SIN PUPPETEER)
// ============================================================

async function scrapearPartidosEnVivo() {
    const inicio = Date.now();
    const debug = {
        etapa: 'inicio',
        error: null,
        totalEnlacesEstado: 0,
        tarjetasDetectadas: false,
        statusCode: 0
    };

    try {
        console.log('🌐 Conectando a ESPN...');
        
        const response = await got('https://www.espn.com.mx/futbol/resultados/_/liga/fifa.world', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
            },
            timeout: {
                request: 15000 // 15 segundos
            },
            retry: { 
                limit: 2,
                methods: ['GET'],
                statusCodes: [408, 429, 500, 502, 503, 504]
            },
            followRedirect: true,
            decompress: true,
        });

        debug.statusCode = response.statusCode;
        debug.etapa = 'html_recibido';

        console.log(`✅ HTML recibido (${(response.body.length / 1024).toFixed(1)} KB)`);

        const $ = cheerio.load(response.body);
        debug.etapa = 'html_parseado';

        const partidos = [];
        const enlacesEstado = $('a[href*="/futbol/partido/_/juegoId/"]');
        debug.totalEnlacesEstado = enlacesEstado.length;

        console.log(`🔍 Enlaces de partidos: ${enlacesEstado.length}`);

        enlacesEstado.each((i, el) => {
            const textoEstado = $(el).text().trim().toLowerCase();
            
            // Solo partidos EN VIVO
            if (!textoEstado.includes('en vivo')) {
                return;
            }

            debug.tarjetasDetectadas = true;

            // Buscar tarjeta del partido
            let tarjeta = $(el).closest('div, li, article');
            
            // Buscar equipos
            let equipos = tarjeta.find('a[href*="/futbol/equipo/"]');
            
            if (equipos.length < 2) {
                tarjeta = tarjeta.parent();
                equipos = tarjeta.find('a[href*="/futbol/equipo/"]');
                if (equipos.length < 2) return;
            }

            // Extraer datos
            const equipoLocal = $(equipos[0]).text().trim();
            const equipoVisitante = $(equipos[1]).text().trim();
            
            // Extraer marcadores
            const textoTarjeta = tarjeta.text().replace(/\s+/g, ' ');
            const marcadorMatch = textoTarjeta.match(/(\d+)\s*[-–—]\s*(\d+)/);
            const marcadorLocal = marcadorMatch ? marcadorMatch[1] : '0';
            const marcadorVisitante = marcadorMatch ? marcadorMatch[2] : '0';
            
            // Extraer goleadores
            const goleadores = [];
            tarjeta.find('a[href*="/futbol/jugador/"]').each((j, jugador) => {
                const contenedor = $(jugador).closest('li, p, div');
                const texto = contenedor.length ? contenedor.text().trim() : $(jugador).text().trim();
                if (texto.length > 0 && texto.length < 150) {
                    goleadores.push(texto);
                }
            });
            
            // Extraer sede
            let sede = null;
            tarjeta.find('div, span').each((j, el) => {
                const texto = $(el).text().trim();
                if (texto.length > 0 && texto.length < 80 && /,/.test(texto) && !/\d/.test(texto)) {
                    sede = texto;
                    return false;
                }
            });

            partidos.push({
                equipoLocal: equipoLocal || 'Desconocido',
                equipoVisitante: equipoVisitante || 'Desconocido',
                marcadorLocal: marcadorLocal,
                marcadorVisitante: marcadorVisitante,
                minuto: 'En vivo',
                goleadores: goleadores.filter((g, idx, arr) => arr.indexOf(g) === idx),
                sede: sede,
            });
        });

        debug.etapa = 'completado';
        debug.tiempoTotal = Date.now() - inicio;
        debug.partidosEncontrados = partidos.length;

        // Deduplicar
        const vistos = new Set();
        const partidosUnicos = partidos.filter((p) => {
            const clave = `${p.equipoLocal}-${p.equipoVisitante}`.toLowerCase().trim();
            if (vistos.has(clave)) return false;
            vistos.add(clave);
            return true;
        });

        console.log(`⚽ Partidos en vivo: ${partidosUnicos.length}`);

        if (partidosUnicos.length === 0) {
            const sample = $('a[href*="/futbol/equipo/"]').slice(0, 3);
            const equiposEjemplo = sample.map((i, el) => $(el).text().trim()).get().join(', ');
            console.log(`🔍 Ejemplos de equipos: ${equiposEjemplo || 'ninguno'}`);
            
            const estados = enlacesEstado.slice(0, 5).map((i, el) => $(el).text().trim()).get();
            console.log(`🔍 Estados de partidos: ${estados.join(', ')}`);
        }

        return { partidos: partidosUnicos, debug };

    } catch (error) {
        debug.etapa = 'error';
        debug.error = error.message;
        debug.tiempoTotal = Date.now() - inicio;
        
        console.error('❌ Error en scraper:', error.message);
        
        if (error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET') {
            console.error('⚠️ Timeout conectando a ESPN');
        }
        
        return { partidos: [], debug };
    }
}

// ============================================================
// FUNCIÓN PARA OBTENER PARTIDOS (CON CACHÉ)
// ============================================================

async function obtenerPartidosEnVivo() {
    // 1. Si hay caché fresca, usarla
    if (cache.payload && (Date.now() - cache.ts) < CACHE_TTL_MS) {
        const edad = Math.floor((Date.now() - cache.ts) / 1000);
        console.log(`📦 Caché fresca (${edad}s de antigüedad)`);
        return cache.payload;
    }

    // 2. Si ya hay un scraping en curso, esperar
    if (scrapingPromise) {
        console.log('⏳ Scraping en curso, esperando...');
        return scrapingPromise;
    }

    // 3. Iniciar nuevo scraping
    console.log('🔄 Iniciando scraping (Cheerio)...');
    scrapingPromise = (async () => {
        const { partidos, debug } = await scrapearPartidosEnVivo();
        
        const payload = {
            success: true,
            data: partidos,
            total: partidos.length,
            timestamp: new Date().toISOString(),
            source: 'cheerio',
            debug: debug
        };
        
        cache = { payload, ts: Date.now() };
        console.log(`✅ Scraping completado: ${partidos.length} partidos en ${debug.tiempoTotal}ms`);
        return payload;
    })();

    try {
        return await scrapingPromise;
    } finally {
        scrapingPromise = null;
    }
}

// ============================================================
// ENDPOINTS DE LA API
// ============================================================

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime())
    });
});

// Partidos en vivo
app.get('/api/live-matches', async (req, res) => {
    try {
        console.log('📡 [REQUEST] /api/live-matches');
        const payload = await obtenerPartidosEnVivo();
        res.json(payload);
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Estado del sistema
app.get('/api/status', (req, res) => {
    const cacheAge = cache.ts ? Math.floor((Date.now() - cache.ts) / 1000) : null;
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        cache: {
            tieneDatos: !!cache.payload,
            antiguedad: cacheAge !== null ? cacheAge + 's' : 'sin datos',
            totalPartidos: cache.payload?.data?.length || 0,
            source: cache.payload?.source || 'ninguno'
        },
        timestamp: new Date().toISOString()
    });
});

// Raíz
app.get('/', (req, res) => {
    res.json({
        name: 'ESPN Scraper API',
        version: '1.0.0',
        description: 'Scraper de partidos en vivo del Mundial 2026',
        endpoints: {
            '/api/live-matches': 'Obtener partidos en vivo',
            '/api/status': 'Estado del sistema',
            '/api/health': 'Health check'
        },
        source: 'cheerio (sin Puppeteer)',
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  🚀 ESPN SCRAPER - SIN PUPPETEER (Cheerio)                ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  📡 Puerto:         ${PORT}`);
    console.log(`║  ⏰ Inicio:         ${new Date().toISOString()}`);
    console.log('║  🔥 Tecnología:    Cheerio + Got                         ║');
    console.log('║  💾 Memoria:        ~30MB (vs 200MB de Puppeteer)        ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  📌 Endpoints:                                            ║');
    console.log('║   GET /api/live-matches  - Partidos en vivo              ║');
    console.log('║   GET /api/status        - Estado del sistema            ║');
    console.log('║   GET /api/health        - Health check                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('✅ Servidor listo!');
    console.log('');
});