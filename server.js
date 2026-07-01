// server.js - VERSIÓN FINAL CON STEALTH MEJORADO
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');

// 🔥 Configuración más agresiva de Stealth
puppeteerExtra.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

const CACHE_TTL_MS = 30000;
let cache = { payload: null, ts: 0 };
let scrapingPromise = null;

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
        console.log('🌐 Lanzando navegador con Stealth avanzado...');
        
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
                // 🔥 Extra para evadir detección
                '--disable-features=ChromeWhatsNewUI',
                '--disable-features=HttpsOnlyMode',
                '--disable-domain-reliability',
                '--disable-client-side-phishing-detection',
                '--disable-component-update',
                '--disable-default-apps',
                '--disable-hang-monitor',
                '--disable-prompt-on-repost',
                '--disable-sync',
                '--disable-translate',
                '--disable-windows10-custom-titlebar',
                '--metrics-recording-only',
                '--no-default-browser-check',
            ],
            executablePath: executablePath,
            headless: chromium.headless,
            // 🔥 Ignorar errores de certificados
            ignoreHTTPSErrors: true,
        };

        console.log('🚀 Iniciando navegador...');
        browser = await puppeteerExtra.launch(launchOptions);
        console.log('✅ Navegador iniciado');

        page = await browser.newPage();
        
        // 🔥 Configuración avanzada de la página
        await page.setViewport({ 
            width: 1366, 
            height: 900,
            deviceScaleFactor: 1,
            hasTouch: false,
            isLandscape: true,
            isMobile: false,
        });
        
        // 🔥 User Agent muy realista
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        // 🔥 Configurar idioma y zona horaria
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0',
        });

        // 🔥 Ocultar webdriver
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['es-MX', 'es', 'en'] });
            // @ts-ignore
            window.chrome = { runtime: {} };
        });

        const url = 'https://www.espn.com.mx/futbol/resultados/_/liga/fifa.world';
        console.log(`🔗 Navegando a ${url}...`);
        
        // 🔥 Intentar con networkidle2 primero
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

        // 🔥 Esperar un poco para que cargue el contenido dinámico
        await page.waitForTimeout(3000);

        // 🔥 Hacer scroll para cargar contenido lazy
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });
        await page.waitForTimeout(2000);

        // 🔥 Intentar con múltiples selectores
        const resultados = await page.evaluate(() => {
            const data = {
                partidos: [],
                enlacesEncontrados: [],
                htmlSample: ''
            };

            // Buscar TODOS los enlaces
            const enlaces = document.querySelectorAll('a');
            enlaces.forEach(a => {
                const href = a.getAttribute('href') || '';
                const texto = a.textContent.trim();
                if (href.includes('partido') || href.includes('juego') || href.includes('match')) {
                    data.enlacesEncontrados.push({ href, texto });
                }
            });

            // Buscar partidos por estructura
            const contenedores = document.querySelectorAll('div, li, article');
            contenedores.forEach(el => {
                const texto = el.textContent.trim();
                // Buscar patrón de marcador
                if (texto.match(/\d+\s*[-–—]\s*\d+/)) {
                    const equipos = el.querySelectorAll('a[href*="equipo"]');
                    if (equipos.length >= 2) {
                        const marcadorMatch = texto.match(/(\d+)\s*[-–—]\s*(\d+)/);
                        data.partidos.push({
                            equipoLocal: equipos[0].textContent.trim(),
                            equipoVisitante: equipos[1].textContent.trim(),
                            marcadorLocal: marcadorMatch ? marcadorMatch[1] : '0',
                            marcadorVisitante: marcadorMatch ? marcadorMatch[2] : '0',
                            estado: 'Desconocido',
                            minuto: 'Desconocido',
                            goleadores: [],
                            sede: null,
                        });
                    }
                }
            });

            data.htmlSample = document.body.innerHTML.slice(0, 1000);
            return data;
        });

        debug.enlacesEncontrados = resultados.enlacesEncontrados;
        debug.htmlSample = resultados.htmlSample;

        console.log(`🔍 Enlaces encontrados: ${resultados.enlacesEncontrados.length}`);
        console.log(`🔍 Partidos encontrados: ${resultados.partidos.length}`);

        if (resultados.enlacesEncontrados.length > 0) {
            console.log('📋 Ejemplos de enlaces:');
            resultados.enlacesEncontrados.slice(0, 5).forEach((e, i) => {
                console.log(`  ${i+1}. ${e.texto} -> ${e.href}`);
            });
        }

        // Deduplicar partidos
        const vistos = new Set();
        const partidosUnicos = resultados.partidos.filter((p) => {
            const clave = `${p.equipoLocal}-${p.equipoVisitante}`.toLowerCase().trim();
            if (vistos.has(clave)) return false;
            vistos.add(clave);
            return true;
        });

        debug.etapa = 'completado';
        debug.tiempoTotal = Date.now() - inicio;
        debug.totalEnlacesEstado = partidosUnicos.length;

        console.log(`✅ Partidos únicos: ${partidosUnicos.length}`);
        return { partidos: partidosUnicos, debug };

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
        description: 'Scraper con Puppeteer Stealth avanzado',
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