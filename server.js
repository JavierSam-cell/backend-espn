// server.js - VERSIÓN CORREGIDA CON FILTROS MEJORADOS
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');

puppeteerExtra.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

const CACHE_TTL_MS = 30000;
let cache = { payload: null, ts: 0 };
let scrapingPromise = null;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scrapearPartidosEnVivo() {
    const inicio = Date.now();
    const debug = {
        etapa: 'inicio',
        error: null,
        totalEnlacesEstado: 0,
        tarjetasDetectadas: false,
        tiempoTotal: 0
    };

    let browser = null;
    let page = null;

    try {
        console.log('🌐 Lanzando navegador...');
        
        const executablePath = await chromium.executablePath();
        console.log(`✅ Executable path: ${executablePath}`);

        const launchOptions = {
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
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
                '--disable-features=ChromeWhatsNewUI,HttpsOnlyMode',
                '--disable-domain-reliability',
                '--disable-client-side-phishing-detection',
                '--disable-component-update',
                '--disable-hang-monitor',
                '--disable-prompt-on-repost',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--no-default-browser-check',
            ],
            executablePath: executablePath,
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        };

        console.log('🚀 Iniciando navegador...');
        browser = await puppeteerExtra.launch(launchOptions);
        console.log('✅ Navegador iniciado');

        page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 900 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        });

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['es-MX', 'es', 'en'] });
            window.chrome = { runtime: {} };
        });

        const url = 'https://www.espn.com.mx/futbol/resultados/_/liga/fifa.world';
        console.log(`🔗 Navegando a ${url}...`);
        
        try {
            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: 45000,
            });
        } catch (error) {
            console.log('⚠️ networkidle2 falló, intentando con domcontentloaded...');
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
        }

        console.log('✅ Página cargada');
        await sleep(3000);

        // Hacer scroll para cargar todo
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });
        await sleep(2000);

        // 🔥 NUEVO: Extraer partidos de forma más precisa
        const partidos = await page.evaluate(() => {
            const resultados = [];
            
            // Buscar TODOS los contenedores de partidos
            // En ESPN, los partidos están en divs con clases específicas
            const contenedores = document.querySelectorAll('div[class*="ScoreCell"], div[class*="match"], div[class*="game"], li[class*="score"]');
            
            contenedores.forEach(el => {
                const texto = el.textContent.trim();
                
                // Buscar patrón de marcador: "2 - 1" o "2-1" o "0 - 0"
                const marcadorMatch = texto.match(/(\d+)\s*[-–—]\s*(\d+)/);
                
                // Buscar equipos - en ESPN están como enlaces
                const equipos = el.querySelectorAll('a[href*="/futbol/equipo/"]');
                
                let equipoLocal = '';
                let equipoVisitante = '';
                let marcadorLocal = '0';
                let marcadorVisitante = '0';
                let estado = 'Desconocido';
                let minuto = '';
                
                // Si hay equipos, extraerlos
                if (equipos.length >= 2) {
                    equipoLocal = equipos[0].textContent.trim();
                    equipoVisitante = equipos[1].textContent.trim();
                }
                
                // Si encontramos marcador, usarlo
                if (marcadorMatch) {
                    marcadorLocal = marcadorMatch[1];
                    marcadorVisitante = marcadorMatch[2];
                }
                
                // Buscar estado del partido (En Vivo, Resumen, o hora)
                const estadoLink = el.querySelector('a[href*="/futbol/partido/"]');
                if (estadoLink) {
                    estado = estadoLink.textContent.trim();
                    if (estado.toLowerCase().includes('en vivo')) {
                        minuto = 'En vivo';
                    } else if (estado.match(/\d{1,2}['\u2019]/)) {
                        minuto = estado;
                    } else {
                        minuto = estado;
                    }
                }
                
                // Buscar el minuto específico (ej: "19'")
                const minutoMatch = texto.match(/(\d{1,2})['\u2019]/);
                if (minutoMatch && estado.toLowerCase().includes('en vivo')) {
                    minuto = `${minutoMatch[1]}'`;
                }
                
                // Buscar goleadores
                const goleadores = [];
                const jugadores = el.querySelectorAll('a[href*="/futbol/jugador/"]');
                jugadores.forEach(j => {
                    const textoJugador = j.closest('li, p, div');
                    if (textoJugador) {
                        const golText = textoJugador.textContent.trim();
                        if (golText && golText.length < 120) {
                            goleadores.push(golText);
                        }
                    }
                });
                
                // Buscar sede
                let sede = null;
                const sedeElements = el.querySelectorAll('div, span, p');
                sedeElements.forEach(s => {
                    const texto2 = s.textContent.trim();
                    if (texto2.length > 0 && texto2.length < 80 && /,/.test(texto2) && !/\d/.test(texto2)) {
                        sede = texto2;
                    }
                });
                
                // Solo agregar si hay al menos un equipo
                if (equipoLocal || equipoVisitante) {
                    resultados.push({
                        equipoLocal: equipoLocal || 'Desconocido',
                        equipoVisitante: equipoVisitante || 'Desconocido',
                        marcadorLocal: marcadorLocal,
                        marcadorVisitante: marcadorVisitante,
                        estado: estado || 'Desconocido',
                        minuto: minuto || estado || 'Desconocido',
                        goleadores: goleadores.filter((g, i, arr) => arr.indexOf(g) === i),
                        sede: sede,
                    });
                }
            });
            
            // 🔥 FILTRAR: Eliminar partidos con nombres raros
            const partidosFiltrados = resultados.filter(p => {
                // Eliminar si el equipo local o visitante contiene "PGGPG" o "GPEEE" (son estadísticas)
                if (p.equipoLocal.includes('PGGPG') || p.equipoVisitante.includes('PGGPG')) return false;
                if (p.equipoLocal.includes('GPEEE') || p.equipoVisitante.includes('GPEEE')) return false;
                // Eliminar si el nombre es muy corto o raro
                if (p.equipoLocal.length < 2 && p.equipoVisitante.length < 2) return false;
                return true;
            });
            
            // Deduplicar por combinación de equipos
            const vistos = new Set();
            const partidosUnicos = partidosFiltrados.filter((p) => {
                const clave = `${p.equipoLocal}-${p.equipoVisitante}`.toLowerCase().trim();
                if (vistos.has(clave)) return false;
                vistos.add(clave);
                return true;
            });
            
            return partidosUnicos;
        });

        debug.etapa = 'completado';
        debug.tiempoTotal = Date.now() - inicio;
        debug.totalEnlacesEstado = partidos.length;

        console.log(`✅ Partidos encontrados: ${partidos.length}`);

        if (partidos.length > 0) {
            console.log('📋 Partidos:');
            partidos.forEach((p, i) => {
                console.log(`  ${i+1}. ${p.equipoLocal} ${p.marcadorLocal}-${p.marcadorVisitante} ${p.equipoVisitante} (${p.minuto})`);
                if (p.goleadores.length > 0) {
                    console.log(`     Goles: ${p.goleadores.join(', ')}`);
                }
            });
        }

        return { partidos, debug };

    } catch (error) {
        debug.etapa = 'error';
        debug.error = error.message;
        debug.tiempoTotal = Date.now() - inicio;
        console.error('❌ Error en scraper:', error.message);
        return { partidos: [], debug };
    } finally {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        console.log('🔄 Navegador cerrado');
    }
}

async function obtenerPartidosEnVivo() {
    if (cache.payload && (Date.now() - cache.ts) < CACHE_TTL_MS) {
        console.log(`📦 Caché fresca`);
        return cache.payload;
    }

    if (scrapingPromise) {
        console.log('⏳ Scraping en curso...');
        return scrapingPromise;
    }

    console.log('🔄 Iniciando scraping...');
    scrapingPromise = (async () => {
        const { partidos, debug } = await scrapearPartidosEnVivo();
        const payload = {
            success: true,
            data: partidos,
            total: partidos.length,
            timestamp: new Date().toISOString(),
            source: 'chromium-sparticuz-stealth',
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

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/live-matches', async (req, res) => {
    try {
        const payload = await obtenerPartidosEnVivo();
        res.json(payload);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
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
            totalPartidos: cache.payload?.data?.length || 0
        },
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.json({
        name: 'ESPN Scraper API',
        version: '1.0.0',
        description: 'Scraper de partidos en vivo',
        endpoints: {
            '/api/live-matches': 'Obtener partidos',
            '/api/status': 'Estado del sistema',
            '/api/health': 'Health check'
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`⏰ ${new Date().toISOString()}`);
    console.log('✅ Servidor listo!');
});