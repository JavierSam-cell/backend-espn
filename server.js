// server.js - VERSIÓN CON SELECTORES MEJORADOS
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

async function scrapearPartidosEnVivo() {
    const inicio = Date.now();
    const debug = {
        etapa: 'inicio',
        error: null,
        totalEnlacesEstado: 0,
        tarjetasDetectadas: false,
        tiempoTotal: 0,
        selectoresEncontrados: {},
        partidosRaw: []
    };

    let browser = null;
    let page = null;

    const urls = [
        'https://www.espn.com.mx/futbol/resultados/_/liga/fifa.world',
    ];

    try {
        console.log('🌐 Lanzando navegador...');
        
        const executablePath = await chromium.executablePath();
        console.log(`✅ Executable path: ${executablePath}`);

        const launchOptions = {
            args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            executablePath: executablePath,
            headless: chromium.headless,
        };

        console.log('🚀 Iniciando navegador...');
        browser = await puppeteerExtra.launch(launchOptions);
        console.log('✅ Navegador iniciado');

        page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 900 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

        for (const url of urls) {
            try {
                console.log(`🔗 Probando URL: ${url}`);
                
                await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000,
                });

                console.log('✅ Página cargada');

                // Esperar a que cargue el contenido
                await page.waitForSelector('body', { timeout: 5000 });

                // 🔍 BUSCAR TODOS LOS POSIBLES SELECTORES
                const resultados = await page.evaluate(() => {
                    const resultados = {
                        enlacesPartido: [],
                        enlacesEquipo: [],
                        tarjetas: [],
                        posiblesPartidos: [],
                        htmlSample: ''
                    };

                    // 1. Buscar TODOS los enlaces que contengan "partido" o "juego"
                    const enlaces = document.querySelectorAll('a');
                    enlaces.forEach(a => {
                        const href = a.getAttribute('href') || '';
                        const texto = a.textContent.trim();
                        if (href.includes('partido') || href.includes('juego') || href.includes('match')) {
                            resultados.enlacesPartido.push({ href, texto, html: a.outerHTML.slice(0, 200) });
                        }
                        if (href.includes('equipo')) {
                            resultados.enlacesEquipo.push({ href, texto });
                        }
                    });

                    // 2. Buscar tarjetas con clases comunes
                    const selectores = [
                        'div[class*="score"]',
                        'div[class*="match"]',
                        'div[class*="game"]',
                        'div[class*="event"]',
                        'li[class*="score"]',
                        'li[class*="match"]',
                        'div[class*="card"]',
                        'article'
                    ];
                    
                    selectores.forEach(sel => {
                        document.querySelectorAll(sel).forEach(el => {
                            const texto = el.textContent.trim().slice(0, 100);
                            if (texto.length > 20) {
                                resultados.tarjetas.push({
                                    selector: sel,
                                    texto: texto,
                                    clases: el.className || 'sin-clase',
                                    html: el.outerHTML.slice(0, 300)
                                });
                            }
                        });
                    });

                    // 3. Buscar partidos por estructura típica
                    const contenedores = document.querySelectorAll('div, li, article');
                    contenedores.forEach(el => {
                        const texto = el.textContent.trim();
                        // Buscar patrones de marcador como "2 - 1" o "2-1"
                        if (texto.match(/\d+\s*[-–—]\s*\d+/)) {
                            const equipos = el.querySelectorAll('a[href*="equipo"]');
                            if (equipos.length >= 2) {
                                resultados.posiblesPartidos.push({
                                    texto: texto.slice(0, 200),
                                    equipos: Array.from(equipos).map(e => e.textContent.trim()),
                                    html: el.outerHTML.slice(0, 400)
                                });
                            }
                        }
                    });

                    // 4. Sample del HTML
                    resultados.htmlSample = document.body.innerHTML.slice(0, 2000);
                    
                    return resultados;
                });

                debug.selectoresEncontrados = resultados;
                debug.partidosRaw = resultados.posiblesPartidos;

                console.log(`🔍 Enlaces de partido: ${resultados.enlacesPartido.length}`);
                console.log(`🔍 Enlaces de equipo: ${resultados.enlacesEquipo.length}`);
                console.log(`🔍 Tarjetas encontradas: ${resultados.tarjetas.length}`);
                console.log(`🔍 Posibles partidos: ${resultados.posiblesPartidos.length}`);

                // Mostrar primeros resultados
                if (resultados.enlacesPartido.length > 0) {
                    console.log('📋 Ejemplos de enlaces de partido:');
                    resultados.enlacesPartido.slice(0, 5).forEach((e, i) => {
                        console.log(`  ${i+1}. href: ${e.href}`);
                        console.log(`     texto: "${e.texto}"`);
                    });
                }

                if (resultados.posiblesPartidos.length > 0) {
                    console.log('📋 Posibles partidos encontrados:');
                    resultados.posiblesPartidos.slice(0, 5).forEach((p, i) => {
                        console.log(`  ${i+1}. ${p.equipos.join(' vs ')}`);
                        console.log(`     texto: ${p.texto.slice(0, 100)}`);
                    });
                }

                // Si encontramos partidos, intentar extraerlos
                if (resultados.posiblesPartidos.length > 0) {
                    const partidos = resultados.posiblesPartidos.map(p => {
                        const marcadorMatch = p.texto.match(/(\d+)\s*[-–—]\s*(\d+)/);
                        return {
                            equipoLocal: p.equipos[0] || 'Desconocido',
                            equipoVisitante: p.equipos[1] || 'Desconocido',
                            marcadorLocal: marcadorMatch ? marcadorMatch[1] : '0',
                            marcadorVisitante: marcadorMatch ? marcadorMatch[2] : '0',
                            estado: 'Desconocido',
                            minuto: 'Desconocido',
                            goleadores: [],
                            sede: null,
                        };
                    });

                    // Deduplicar
                    const vistos = new Set();
                    const partidosUnicos = partidos.filter((p) => {
                        const clave = `${p.equipoLocal}-${p.equipoVisitante}`.toLowerCase().trim();
                        if (vistos.has(clave)) return false;
                        vistos.add(clave);
                        return true;
                    });

                    debug.etapa = 'completado';
                    debug.tiempoTotal = Date.now() - inicio;
                    debug.totalEnlacesEstado = partidosUnicos.length;

                    console.log(`✅ Partidos encontrados: ${partidosUnicos.length}`);
                    
                    if (partidosUnicos.length > 0) {
                        return { partidos: partidosUnicos, debug };
                    }
                }

            } catch (error) {
                console.log(`❌ Error con URL ${url}:`, error.message);
            }
        }

        debug.etapa = 'completado_sin_partidos';
        debug.tiempoTotal = Date.now() - inicio;
        console.log('⚠️ No se encontraron partidos');
        return { partidos: [], debug };

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