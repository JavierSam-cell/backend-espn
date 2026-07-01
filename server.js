// server.js - VERSIÓN CON puppeteer + @sparticuz/chromium
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');

// 🔥 Configurar puppeteer-extra con el plugin stealth
puppeteerExtra.use(StealthPlugin());

// 🔥 HACER QUE puppeteer-extra use puppeteer en lugar de puppeteer-core
// Esto es necesario porque puppeteer-extra busca puppeteer como peer dependency
// y no encuentra puppeteer-core correctamente

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ============================================================
// CONFIGURACIÓN DE CACHÉ
// ============================================================

const CACHE_TTL_MS = 30000; // 30 segundos
let cache = { 
    payload: null, 
    ts: 0 
};
let scrapingPromise = null;

// ============================================================
// SCRAPER CON @sparticuz/chromium
// ============================================================

async function scrapearPartidosEnVivo() {
    const inicio = Date.now();
    const debug = {
        etapa: 'inicio',
        error: null,
        totalEnlacesEstado: 0,
        tarjetasDetectadas: false,
        tiempoTotal: 0,
        chromiumVersion: null
    };

    let browser = null;
    let page = null;

    try {
        console.log('🌐 Lanzando navegador con Stealth y @sparticuz/chromium...');
        
        // 🔥 Configuración de Chromium
        const executablePath = await chromium.executablePath();
        debug.chromiumVersion = chromium.version || 'desconocida';
        
        console.log(`✅ Chromium versión: ${debug.chromiumVersion}`);
        console.log(`✅ Executable path: ${executablePath}`);

        // 🔥 Usar puppeteerExtra (que usa puppeteer internamente)
        const launchOptions = {
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-component-extensions-with-background-pages',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-ipc-flooding-protection',
                '--disable-renderer-backgrounding',
                '--mute-audio',
                '--no-first-run',
                '--no-zygote',
            ],
            executablePath: executablePath,
            headless: chromium.headless,
        };

        console.log('🚀 Iniciando navegador...');
        browser = await puppeteerExtra.launch(launchOptions);
        console.log('✅ Navegador iniciado');

        page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 900 });
        
        // User Agent realista
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

        console.log('🔗 Navegando a ESPN...');
        await page.goto('https://www.espn.com.mx/futbol/resultados/_/liga/fifa.world', {
            waitUntil: 'networkidle2',
            timeout: 30000,
        });

        debug.etapa = 'navegacion_completa';

        // Esperar a que carguen los partidos
        try {
            await page.waitForSelector('a[href*="/futbol/partido/"]', { timeout: 10000 });
            debug.tarjetasDetectadas = true;
            console.log('✅ Partidos detectados');
        } catch (error) {
            console.log('⚠️ No se detectaron partidos en 10s:', error.message);
            try {
                const html = await page.content();
                console.log('📄 HTML capturado (primeros 800 chars):', html.slice(0, 800));
            } catch (e) {
                console.log('⚠️ No se pudo capturar HTML');
            }
        }

        // Extraer datos
        console.log('📊 Extrayendo datos...');
        const partidos = await page.evaluate(() => {
            const resultados = [];
            const enlacesEstado = document.querySelectorAll('a[href*="/futbol/partido/"]');
            
            enlacesEstado.forEach((enlace) => {
                const textoEstado = enlace.textContent.trim().toLowerCase();
                
                // Buscar la tarjeta del partido
                let tarjeta = enlace.closest('div, li, article');
                if (!tarjeta) return;
                
                // Buscar equipos
                const equipos = tarjeta.querySelectorAll('a[href*="/futbol/equipo/"]');
                if (equipos.length < 2) return;
                
                // Extraer marcadores
                const textoTarjeta = tarjeta.textContent.replace(/\s+/g, ' ');
                const marcadorMatch = textoTarjeta.match(/(\d+)\s*[-–—]\s*(\d+)/);
                
                // Extraer goleadores
                const goleadores = [];
                tarjeta.querySelectorAll('a[href*="/futbol/jugador/"]').forEach((j) => {
                    const contenedor = j.closest('li, p, div');
                    const texto = contenedor ? contenedor.textContent.trim() : j.textContent.trim();
                    if (texto.length > 0 && texto.length < 150) {
                        goleadores.push(texto);
                    }
                });
                
                // Extraer sede
                let sede = null;
                tarjeta.querySelectorAll('div, span').forEach((el) => {
                    const texto = el.textContent.trim();
                    if (texto.length > 0 && texto.length < 80 && /,/.test(texto) && !/\d/.test(texto)) {
                        sede = texto;
                    }
                });
                
                resultados.push({
                    equipoLocal: equipos[0]?.textContent.trim() || 'Desconocido',
                    equipoVisitante: equipos[1]?.textContent.trim() || 'Desconocido',
                    marcadorLocal: marcadorMatch ? marcadorMatch[1] : '0',
                    marcadorVisitante: marcadorMatch ? marcadorMatch[2] : '0',
                    estado: enlace.textContent.trim() || 'Desconocido',
                    minuto: textoEstado.includes('en vivo') ? 'En vivo' : enlace.textContent.trim(),
                    goleadores: [...new Set(goleadores)],
                    sede: sede,
                });
            });
            
            return resultados;
        });

        debug.etapa = 'completado';
        debug.tiempoTotal = Date.now() - inicio;
        debug.totalEnlacesEstado = partidos.length;

        console.log(`⚽ Partidos encontrados: ${partidos.length}`);

        // Deduplicar
        const vistos = new Set();
        const partidosUnicos = partidos.filter((p) => {
            const clave = `${p.equipoLocal}-${p.equipoVisitante}`.toLowerCase().trim();
            if (vistos.has(clave)) return false;
            vistos.add(clave);
            return true;
        });

        console.log(`✅ Partidos únicos: ${partidosUnicos.length}`);
        return { partidos: partidosUnicos, debug };

    } catch (error) {
        debug.etapa = 'error';
        debug.error = error.message;
        debug.tiempoTotal = Date.now() - inicio;
        
        console.error('❌ Error en scraper:', error.message);
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
        return { partidos: [], debug };
    } finally {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        console.log('🔄 Navegador cerrado');
    }
}

// ============================================================
// FUNCIÓN PARA OBTENER PARTIDOS (CON CACHÉ)
// ============================================================

async function obtenerPartidosEnVivo() {
    if (cache.payload && (Date.now() - cache.ts) < CACHE_TTL_MS) {
        const edad = Math.floor((Date.now() - cache.ts) / 1000);
        console.log(`📦 Caché fresca (${edad}s)`);
        return cache.payload;
    }

    if (scrapingPromise) {
        console.log('⏳ Scraping en curso...');
        return scrapingPromise;
    }

    console.log('🔄 Iniciando scraping con @sparticuz/chromium...');
    scrapingPromise = (async () => {
        const { partidos, debug } = await scrapearPartidosEnVivo();
        
        const payload = {
            success: true,
            data: partidos,
            total: partidos.length,
            timestamp: new Date().toISOString(),
            source: 'chromium-sparticuz',
            debug: debug
        };
        
        cache = { payload, ts: Date.now() };
        console.log(`✅ Completado: ${partidos.length} partidos`);
        return payload;
    })();

    try {
        return await scrapingPromise;
    } finally {
        scrapingPromise = null;
    }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime())
    });
});

app.get('/api/live-matches', async (req, res) => {
    try {
        const payload = await obtenerPartidosEnVivo();
        res.json(payload);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

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

app.get('/', (req, res) => {
    res.json({
        name: 'ESPN Scraper API',
        version: '1.0.0',
        description: 'Scraper con Puppeteer Stealth y @sparticuz/chromium',
        endpoints: {
            '/api/live-matches': 'Obtener partidos',
            '/api/status': 'Estado del sistema',
            '/api/health': 'Health check'
        },
        source: 'chromium-sparticuz',
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  🚀 ESPN SCRAPER - puppeteer + @sparticuz/chromium        ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  📡 Puerto:         ${PORT}`);
    console.log(`║  ⏰ Inicio:         ${new Date().toISOString()}`);
    console.log('║  🔥 Tecnología:    puppeteer + @sparticuz/chromium        ║');
    console.log('║  🛡️ Anti-detección: Activada                             ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  📌 Endpoints:                                            ║');
    console.log('║   GET /api/live-matches  - Partidos                      ║');
    console.log('║   GET /api/status        - Estado del sistema            ║');
    console.log('║   GET /api/health        - Health check                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('✅ Servidor listo!');
    console.log('');
});