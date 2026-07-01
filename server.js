// server.js - VERSIÓN DE DIAGNÓSTICO: Inspecciona la estructura de ESPN
const express = require('express');
const cors = require('cors');
const axios = require('axios');
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
// SCRAPER DE DIAGNÓSTICO - MUESTRA TODOS LOS ENLACES
// ============================================================

async function diagnosticarEstructura() {
    const debug = {
        etapa: 'inicio',
        error: null,
        statusCode: 0,
        enlacesEncontrados: [],
        posiblesSelectores: {}
    };

    try {
        console.log('🔍 [DIAGNÓSTICO] Conectando a ESPN...');
        
        const response = await axios({
            method: 'GET',
            url: 'https://www.espn.com.mx/futbol/resultados/_/liga/fifa.world',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
            },
            timeout: 15000,
            maxRedirects: 5,
        });

        debug.statusCode = response.status;
        debug.etapa = 'html_recibido';

        console.log(`✅ Status: ${response.status} - HTML: ${(response.data.length / 1024).toFixed(1)} KB`);

        const $ = cheerio.load(response.data);
        
        // 🔍 1. Buscar TODOS los enlaces que contengan "partido" o "juego"
        const todosLosEnlaces = [];
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const texto = $(el).text().trim();
            if (href && (href.includes('partido') || href.includes('juego') || href.includes('match'))) {
                todosLosEnlaces.push({ href, texto, html: $(el).html()?.slice(0, 100) });
            }
        });

        debug.enlacesEncontrados = todosLosEnlaces.slice(0, 20); // Guardar los primeros 20

        console.log(`🔍 Enlaces con "partido"/"juego"/"match": ${todosLosEnlaces.length}`);

        // Mostrar los primeros 5 enlaces
        console.log('📋 Ejemplos de enlaces encontrados:');
        todosLosEnlaces.slice(0, 5).forEach((e, i) => {
            console.log(`   ${i + 1}. href: ${e.href}`);
            console.log(`      texto: "${e.texto}"`);
            console.log(`      html: ${e.html}`);
            console.log('');
        });

        // 🔍 2. Buscar todas las tarjetas de partido (divs con clases comunes)
        const posiblesTarjetas = [];
        $('div[class*="score"], div[class*="match"], div[class*="game"], div[class*="event"], li[class*="score"], li[class*="match"]').each((i, el) => {
            const clases = $(el).attr('class') || '';
            const texto = $(el).text().trim().slice(0, 100);
            posiblesTarjetas.push({ clases, texto, html: $(el).html()?.slice(0, 150) });
        });

        debug.posiblesSelectores.tarjetasEncontradas = posiblesTarjetas.length;
        console.log(`🔍 Tarjetas con clases comunes: ${posiblesTarjetas.length}`);

        if (posiblesTarjetas.length > 0) {
            console.log('📋 Ejemplos de tarjetas:');
            posiblesTarjetas.slice(0, 3).forEach((t, i) => {
                console.log(`   ${i + 1}. clases: ${t.clases}`);
                console.log(`      texto: "${t.texto}"`);
                console.log('');
            });
        }

        // 🔍 3. Buscar específicamente los equipos (enlaces a /futbol/equipo/)
        const enlacesEquipos = [];
        $('a[href*="/futbol/equipo/"]').each((i, el) => {
            const href = $(el).attr('href');
            const texto = $(el).text().trim();
            const padre = $(el).closest('div, li, article');
            const padreClases = padre.attr('class') || '';
            enlacesEquipos.push({ href, texto, padreClases, padreTexto: padre.text().trim().slice(0, 100) });
        });

        debug.posiblesSelectores.equiposEncontrados = enlacesEquipos.length;
        console.log(`🔍 Enlaces a equipos: ${enlacesEquipos.length}`);

        if (enlacesEquipos.length > 0) {
            console.log('📋 Ejemplos de equipos:');
            enlacesEquipos.slice(0, 5).forEach((e, i) => {
                console.log(`   ${i + 1}. ${e.texto} -> ${e.href}`);
                console.log(`      padre: ${e.padreClases}`);
                console.log(`      contexto: "${e.padreTexto}"`);
                console.log('');
            });
        }

        debug.etapa = 'diagnostico_completado';

        return { debug };

    } catch (error) {
        debug.etapa = 'error';
        debug.error = error.message;
        console.error('❌ Error en diagnóstico:', error.message);
        return { debug };
    }
}

// ============================================================
// ENDPOINT DE DIAGNÓSTICO
// ============================================================

app.get('/api/diagnostico', async (req, res) => {
    try {
        console.log('🔍 [DIAGNÓSTICO] Iniciando...');
        const { debug } = await diagnosticarEstructura();
        res.json({
            success: true,
            mensaje: 'Diagnóstico completado - Revisa los logs de Render para ver los detalles',
            debug: debug,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================
// ENDPOINTS NORMALES (por si acaso)
// ============================================================

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/live-matches', (req, res) => {
    res.json({
        success: true,
        mensaje: 'Usa /api/diagnostico para inspeccionar la estructura de ESPN',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.json({
        name: 'ESPN Scraper API - DIAGNÓSTICO',
        version: '1.0.0',
        endpoints: {
            '/api/diagnostico': 'Inspecciona la estructura de ESPN y muestra enlaces encontrados',
            '/api/health': 'Health check',
            '/api/status': 'Estado del sistema'
        },
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  🔍 ESPN SCRAPER - MODO DIAGNÓSTICO                       ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  📡 Puerto:         ${PORT}`);
    console.log(`║  ⏰ Inicio:         ${new Date().toISOString()}`);
    console.log('║  📋 Usa /api/diagnostico para inspeccionar la estructura  ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  📌 Endpoints:                                            ║');
    console.log('║   GET /api/diagnostico  - Inspecciona ESPN                ║');
    console.log('║   GET /api/health       - Health check                    ║');
    console.log('║   GET /api/status       - Estado del sistema              ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('✅ Servidor listo!');
    console.log('');
});