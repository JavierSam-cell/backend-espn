// server.js - VERSIÓN CORREGIDA
// Usa la API JSON pública de ESPN (site.api.espn.com) en lugar de
// scrapear el HTML con Puppeteer. Esto elimina el bug de datos falsos
// (partidos inventados como "Selección Mexicana" cuando no jugaba),
// porque ya no dependemos de selectores CSS frágiles que confunden
// records de equipo tipo "(1-0-0)" con marcadores, ni enlaces de menú
// (href*="equipo") con enlaces de partido real.
//
// Ventajas extra: no necesita Chromium/Puppeteer (mucho más rápido y
// liviano en Render), no lo bloquean por anti-bot, y los datos vienen
// ya estructurados y verificados por ESPN.

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

const CACHE_TTL_MS = 30000;
let cache = { payload: null, ts: 0 };
let fetchingPromise = null;

// Liga por defecto: Copa Mundial FIFA. Se puede cambiar vía ?liga=
const LIGA_DEFAULT = 'fifa.world';

// Convierte Date -> 'YYYYMMDD' en zona horaria local del server.
function formatFecha(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}

// Mapea un "competitor" de la API de ESPN a los goleadores de ese equipo
function extraerGoleadores(details, teamId) {
    if (!Array.isArray(details)) return [];
    return details
        .filter((d) => d.scoringPlay && d.team && String(d.team.id) === String(teamId))
        .map((d) => {
            const jugador = d.athletesInvolved && d.athletesInvolved[0];
            return {
                jugador: jugador ? jugador.displayName : 'Desconocido',
                minuto: d.clock ? d.clock.displayValue : null,
                tipo: d.type ? d.type.text : null,
            };
        });
}

async function obtenerDeEspn(liga, fecha) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${liga}/scoreboard?dates=${fecha}`;
    console.log(`🔗 Consultando API ESPN: ${url}`);

    const resp = await fetch(url, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; espn-scraper-api/2.0)',
        },
        // Node 18+/20+ trae fetch nativo. Si tu Render usa Node < 18,
        // agrega "node-fetch" como dependencia y haz:
        // const fetch = require('node-fetch');
    });

    if (!resp.ok) {
        throw new Error(`ESPN API respondió ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    const events = Array.isArray(data.events) ? data.events : [];

    const partidos = events.map((ev) => {
        const comp = ev.competitions && ev.competitions[0];
        const competitors = (comp && comp.competitors) || [];
        const home = competitors.find((c) => c.homeAway === 'home') || competitors[0];
        const away = competitors.find((c) => c.homeAway === 'away') || competitors[1];
        const details = comp ? comp.details : [];
        const statusType = (comp && comp.status && comp.status.type) || {};
        const venue = comp && comp.venue;

        return {
            id: ev.id,
            equipoLocal: home && home.team ? home.team.displayName : 'Desconocido',
            equipoVisitante: away && away.team ? away.team.displayName : 'Desconocido',
            marcadorLocal: home ? home.score ?? '0' : '0',
            marcadorVisitante: away ? away.score ?? '0' : '0',
            estado: statusType.description || 'Desconocido',
            estadoCorto: statusType.shortDetail || statusType.detail || null,
            enVivo: statusType.state === 'in',
            finalizado: !!statusType.completed,
            minuto: (comp && comp.status && comp.status.displayClock) || null,
            goleadoresLocal: home ? extraerGoleadores(details, home.id) : [],
            goleadoresVisitante: away ? extraerGoleadores(details, away.id) : [],
            sede: venue
                ? {
                    nombre: venue.fullName || null,
                    ciudad: venue.address ? venue.address.city : null,
                    pais: venue.address ? venue.address.country : null,
                }
                : null,
            fechaISO: ev.date || null,
        };
    });

    return partidos;
}

async function obtenerPartidosEnVivo(liga, fecha) {
    const cacheKey = `${liga}-${fecha}`;
    if (
        cache.payload &&
        cache.key === cacheKey &&
        (Date.now() - cache.ts) < CACHE_TTL_MS
    ) {
        console.log('📦 Caché fresca');
        return cache.payload;
    }

    if (fetchingPromise) {
        console.log('⏳ Consulta en curso...');
        return fetchingPromise;
    }

    console.log(`🔄 Consultando partidos (liga=${liga}, fecha=${fecha})...`);
    const inicio = Date.now();

    fetchingPromise = (async () => {
        try {
            const partidos = await obtenerDeEspn(liga, fecha);
            const payload = {
                success: true,
                data: partidos,
                total: partidos.length,
                liga,
                fecha,
                timestamp: new Date().toISOString(),
                source: 'espn-json-api',
                tiempoMs: Date.now() - inicio,
            };
            cache = { payload, ts: Date.now(), key: cacheKey };
            console.log(`✅ Completado: ${partidos.length} partidos`);
            return payload;
        } catch (error) {
            console.error('❌ Error consultando ESPN:', error.message);
            return {
                success: false,
                data: [],
                total: 0,
                liga,
                fecha,
                error: error.message,
                timestamp: new Date().toISOString(),
                source: 'espn-json-api',
            };
        }
    })();

    try {
        return await fetchingPromise;
    } finally {
        fetchingPromise = null;
    }
}

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/live-matches', async (req, res) => {
    try {
        const liga = req.query.liga || LIGA_DEFAULT;
        // fecha en formato YYYYMMDD; por defecto, hoy
        const fecha = req.query.fecha || formatFecha(new Date());
        const payload = await obtenerPartidosEnVivo(liga, fecha);
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
            totalPartidos: cache.payload?.data?.length || 0,
        },
        timestamp: new Date().toISOString(),
    });
});

app.get('/', (req, res) => {
    res.json({
        name: 'ESPN Scraper API',
        version: '2.0.0',
        description: 'Consulta la API JSON pública de ESPN (sin Puppeteer, sin scraping HTML)',
        endpoints: {
            '/api/live-matches': 'Obtener partidos. Params opcionales: ?liga=fifa.world&fecha=YYYYMMDD',
            '/api/status': 'Estado del sistema',
            '/api/health': 'Health check',
        },
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto ${PORT}`);
    console.log(`⏰ ${new Date().toISOString()}`);
    console.log('✅ Servidor listo!');
});
