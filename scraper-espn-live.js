/**
 * scraper-espn-live.js
 * -----------------------------------------------------------------------
 * Scraper de resultados del Mundial FIFA 2026 (ESPN México) con Puppeteer.
 * 
 * CORRECCIÓN IMPORTANTE respecto a la versión anterior:
 *   El filtro de "en vivo" buscaba patrones de minuto tipo 45', HT, LIVE...
 *   pero ESPN MX en la página de Resultados NO muestra el minuto: muestra
 *   literalmente el texto "En Vivo" como link de acción. Los partidos
 *   terminados muestran "Resumen" en su lugar (no "Final"). Por eso el
 *   filtro anterior descartaba TODOS los partidos, incluso los que sí
 *   estaban en vivo. Ahora se detecta el texto real "En Vivo" / "EN VIVO".
 * -----------------------------------------------------------------------
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ----------------------------- CONFIGURACIÓN -----------------------------

const CONFIG = {
    url: 'https://www.espn.com.mx/futbol/resultados/_/liga/fifa.world',
    headless: process.env.HEADLESS !== 'false', // por defecto headless=true
    navigationTimeoutMs: 60000,
    contentWaitMs: 4000,
    maxRetries: 3,
    retryDelayMs: 4000,
    outputDir: __dirname,
    userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// ------------------------------ UTILIDADES --------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(emoji, msg) {
    console.log(`${emoji} ${msg}`);
}

// ------------------------------ NAVEGADOR ---------------------------------

// --- Navegador persistente ---
// En vez de lanzar (y cerrar) un Chromium nuevo en cada scraping, mantenemos
// UNA instancia viva entre llamadas. Esto ahorra la memoria y el tiempo del
// arranque (~1-2s + overhead de RAM cada vez). Si el browser se cae o se
// desconecta, se detecta y se relanza automáticamente en la siguiente llamada.
let navegadorCompartido = null;

async function obtenerNavegador() {
    if (navegadorCompartido && navegadorCompartido.isConnected()) {
        return navegadorCompartido;
    }
    if (navegadorCompartido) {
        // Estaba asignado pero ya no conectado (crash/kill) -> limpiar referencia
        try { await navegadorCompartido.close(); } catch {}
    }
    navegadorCompartido = await lanzarNavegador();
    // Si Chromium crashea solo (p. ej. OOM), limpiamos la referencia para
    // que la siguiente llamada relance uno nuevo en vez de reusar uno muerto.
    navegadorCompartido.on('disconnected', () => {
        log('⚠️', 'El navegador compartido se desconectó (posible crash/OOM).');
        navegadorCompartido = null;
    });
    return navegadorCompartido;
}

async function lanzarNavegador() {
    return puppeteer.launch({
        headless: CONFIG.headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage', // usa /tmp en vez de /dev/shm (poco espacio en contenedores)
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--disable-extensions',
            // 🔻 Flags extra para reducir memoria en contenedores pequeños (Render free = 512MB)
            '--disable-software-rasterizer',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-component-extensions-with-background-pages',
            '--disable-default-apps',
            '--disable-features=TranslateUI,BlinkGenPropertyTrees',
            '--disable-ipc-flooding-protection',
            '--disable-renderer-backgrounding',
            '--mute-audio',
            // ❌ Quitado: '--single-process'. En contenedores con poca RAM es MENOS
            // estable que el modo multi-proceso normal (fuerza browser+renderer a
            // compartir un solo proceso, lo que puede disparar picos de memoria).
        ],
    });
}

async function prepararPagina(browser) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setUserAgent(CONFIG.userAgent);

    // Oculta la propiedad webdriver para reducir detección de automatización
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Bloquear recursos pesados (imágenes/fuentes) para acelerar la carga
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const type = req.resourceType();
        if (type === 'image' || type === 'font' || type === 'media') {
            req.abort();
        } else {
            req.continue();
        }
    });

    return page;
}

async function navegarConReintentos(page, url) {
    let ultimoError;
    for (let intento = 1; intento <= CONFIG.maxRetries; intento++) {
        try {
            log('🔗', `Navegando a ${url} (intento ${intento}/${CONFIG.maxRetries})...`);
            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: CONFIG.navigationTimeoutMs,
            });
            return;
        } catch (err) {
            ultimoError = err;
            log('⚠️', `Falló intento ${intento}: ${err.message}`);
            if (intento < CONFIG.maxRetries) {
                await sleep(CONFIG.retryDelayMs);
            }
        }
    }
    throw ultimoError;
}

// ------------------------------ EXTRACCIÓN --------------------------------

/**
 * Se ejecuta dentro del contexto del navegador (page.evaluate).
 *
 * Estrategia (basada en la estructura real de espn.com.mx/futbol/resultados):
 *  1. Cada partido es una tarjeta que contiene enlaces a equipos
 *     (href que incluye "/futbol/equipo/").
 *  2. Dentro de cada tarjeta, el estado real se determina por el LINK de
 *     acción: "En Vivo" = partido en curso. "Resumen" = ya terminó.
 *     Una fecha/hora visible sin ninguno de los dos = aún no comienza.
 *  3. El marcador de cada equipo es el último número que aparece en su
 *     bloque (ESPN MX muestra "Equipo (W-D-L) N").
 *  4. Los goleadores son enlaces a "/futbol/jugador/" dentro de la tarjeta,
 *     normalmente con el formato "Nombre - 6', 39',".
 */
function extraerPartidosEnNavegador() {
    const normalizar = (s) =>
        (s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '') // quita acentos
            .trim()
            .toLowerCase();

    const SELECTOR_ESTADO = 'a[href*="/futbol/partido/_/juegoId/"]';

    // El indicador de estado más confiable de ESPN MX es el link que apunta
    // al detalle del partido: /futbol/partido/_/juegoId/XXXXXX
    // Su texto es "En Vivo" si el partido está en curso, o "Resumen" si ya
    // terminó.
    const enlacesEstado = Array.from(document.querySelectorAll(SELECTOR_ESTADO));

    /**
     * Encuentra la tarjeta EXACTA de un partido subiendo por el DOM desde
     * su link de estado, hasta llegar al nivel donde las tarjetas de
     * partido se repiten como hermanas (siblings). No depende de contar
     * equipos ni de adivinar clases CSS: simplemente busca el primer
     * ancestro cuyo padre tenga 2+ hijos que cada uno contenga SU PROPIO
     * link de estado — eso es, por definición, la lista de partidos. El
     * hijo específico que contiene nuestro link es la tarjeta de ESTE
     * partido, sin mezclar con los demás.
     */
    function encontrarTarjeta(enlaceEstado) {
        let actual = enlaceEstado;
        let padre = actual.parentElement;
        let profundidad = 0;
        while (padre && profundidad < 20) {
            const hijosConEstado = Array.from(padre.children).filter(
                (hijo) => hijo.querySelector(SELECTOR_ESTADO) !== null
            );
            if (hijosConEstado.length >= 2) {
                return actual; // "actual" es el hermano que contiene nuestro link
            }
            actual = padre;
            padre = padre.parentElement;
            profundidad++;
        }
        return actual; // fallback: lo más alto que se alcanzó
    }

    const debugEstados = []; // para diagnóstico, viaja junto con los resultados
    const debugTarjetas = []; // info detallada de cada tarjeta evaluada
    const resultados = [];
    const tarjetasVistas = new Set();

    enlacesEstado.forEach((enlaceEstado) => {
        const textoEstado = normalizar(enlaceEstado.textContent);
        debugEstados.push(textoEstado);

        const esEnVivo = textoEstado.includes('en vivo');
        if (!esEnVivo) return; // solo nos interesan los partidos EN VIVO

        const tarjeta = encontrarTarjeta(enlaceEstado);
        if (!tarjeta || tarjetasVistas.has(tarjeta)) return;
        tarjetasVistas.add(tarjeta);

        // --- Equipos y marcador ---
        const enlacesEquipoTarjeta = Array.from(
            new Map(
                Array.from(tarjeta.querySelectorAll('a[href*="/futbol/equipo/"]')).map((a) => [a.href, a])
            ).values()
        );

        const debugInfo = {
            textoEstado,
            cantidadEquiposEncontrados: enlacesEquipoTarjeta.length,
            nombresEquipos: enlacesEquipoTarjeta.map((a) => a.textContent.trim()),
            cantidadJugadoresEncontrados: tarjeta.querySelectorAll('a[href*="/futbol/jugador/"]').length,
            textoTarjetaResumido: tarjeta.textContent.replace(/\s+/g, ' ').trim().slice(0, 200),
        };
        debugTarjetas.push(debugInfo);

        if (enlacesEquipoTarjeta.length < 2) return;

        /**
         * Encuentra el marcador real de un equipo. El número del marcador
         * NO siempre vive dentro del contenedor inmediato del link del
         * equipo (ej. closest('div')) — a veces es un elemento HERMANO en
         * un nivel superior (fila: [bandera][nombre]....[marcador]).
         * Por eso subimos nivel por nivel buscando el primer elemento
         * "hoja" (sin hijos) cuyo texto sea un número puro (0-99), que es
         * inequívocamente el marcador y no se confunde con minutos
         * ("45'"), récords ("1-0-0") ni nombres de goleadores.
         */
        function buscarMarcador(enlaceEquipo) {
            let nodo = enlaceEquipo.parentElement;
            for (let nivel = 0; nivel < 6 && nodo; nivel++) {
                const candidatos = Array.from(nodo.querySelectorAll('*')).filter(
                    (el) => el.children.length === 0 && /^\d{1,2}$/.test(el.textContent.trim())
                );
                if (candidatos.length > 0) {
                    return candidatos[0].textContent.trim();
                }
                nodo = nodo.parentElement;
            }
            return null;
        }

        const equipos = enlacesEquipoTarjeta.slice(0, 2).map((a) => ({
            nombre: a.textContent.trim(),
            marcador: buscarMarcador(a) ?? '0',
        }));

        // --- Minuto / periodo (si el sitio lo expone como reloj aparte) ---
        const elementoReloj = tarjeta.querySelector('[class*="clock" i], [class*="status" i], [class*="time" i]');
        const minuto = elementoReloj ? elementoReloj.textContent.trim() : null;

        // --- Goleadores ---
        const enlacesJugador = Array.from(tarjeta.querySelectorAll('a[href*="/futbol/jugador/"]'));
        const goleadores = enlacesJugador
            .map((a) => {
                const contenedor = a.closest('li, p, div') || a.parentElement;
                const texto = (contenedor ? contenedor.textContent : a.textContent).replace(/\s+/g, ' ').trim();
                return texto;
            })
            .filter((t, i, arr) => t.length > 0 && t.length < 120 && arr.indexOf(t) === i);

        // --- Estadio / sede (si está disponible) ---
        let sede = null;
        const posibleSede = Array.from(tarjeta.querySelectorAll('div, span')).find((el) => {
            const t = el.textContent.trim();
            return t.length > 0 && t.length < 60 && /,/.test(t) && !/\d/.test(t) && el.children.length === 0;
        });
        if (posibleSede) sede = posibleSede.textContent.trim();

        resultados.push({
            equipoLocal: equipos[0].nombre,
            equipoVisitante: equipos[1].nombre,
            marcadorLocal: equipos[0].marcador,
            marcadorVisitante: equipos[1].marcador,
            minuto: minuto || 'En vivo',
            goleadores,
            sede,
        });
    });

    // Deduplicar por combinación de equipos: ESPN a veces renderiza una
    // tarjeta oculta extra (versión móvil/escritorio) para el mismo
    // partido, con datos capturados en momentos ligeramente distintos.
    const vistos = new Set();
    const resultadosUnicos = resultados.filter((p) => {
        const clave = normalizar(`${p.equipoLocal}-${p.equipoVisitante}`);
        if (vistos.has(clave)) return false;
        vistos.add(clave);
        return true;
    });

    return { resultados: resultadosUnicos, debugEstados, debugTarjetas };
}

// ------------------------------- PRINCIPAL --------------------------------

async function scrapearPartidosEnVivo() {
    let browser;
    // 🔍 debug viaja SIEMPRE con el resultado, aunque haya 0 partidos o un error,
    // para poder diagnosticar desde afuera (curl) sin acceso a los logs de Render.
    const debug = {
        etapa: 'inicio',
        error: null,
        tarjetasDetectadas: false,
        totalEnlacesEstado: 0,
        debugEstados: [],
        debugTarjetas: [],
        htmlSnippet: null,
    };

    let page;
    try {
        log('🌐', 'Obteniendo navegador...');
        browser = await obtenerNavegador();
        debug.etapa = 'navegador_lanzado';
        page = await prepararPagina(browser);

        await navegarConReintentos(page, CONFIG.url);
        debug.etapa = 'navegacion_completa';

        log('⏳', 'Esperando a que cargue el contenido dinámico...');
        await sleep(CONFIG.contentWaitMs);

        try {
            await page.waitForSelector('a[href*="/futbol/equipo/"]', { timeout: 10000 });
            log('✅', 'Tarjetas de partidos detectadas.');
            debug.tarjetasDetectadas = true;
        } catch {
            log('⚠️', 'No se detectaron tarjetas de partidos en el tiempo esperado, continuando...');
            debug.tarjetasDetectadas = false;
            // Si no aparecieron ni las tarjetas normales, probablemente ESPN
            // bloqueó/challengeó esta IP o cambió el layout. Guardamos un
            // fragmento del HTML real recibido para poder inspeccionarlo.
            try {
                const html = await page.content();
                debug.htmlSnippet = html.replace(/\s+/g, ' ').trim().slice(0, 1500);
            } catch {}
        }

        // 🔥 Screenshot + HTML completo SOLO si se activa explícitamente con
        // DEBUG_ARTIFACTS=true. En producción esto es peso muerto: consume RAM
        // extra para renderizar el screenshot full-page y escribe a un disco
        // efímero (Render free) que no sirve para nada persistente. Se deja
        // disponible para depuración manual, pero apagado por defecto.
        if (process.env.DEBUG_ARTIFACTS === 'true') {
            try {
                const screenshotPath = path.join(CONFIG.outputDir, 'espn-screen.png');
                const htmlPath = path.join(CONFIG.outputDir, 'espn-full.html');
                await page.screenshot({ path: screenshotPath, fullPage: true });
                fs.writeFileSync(htmlPath, await page.content());
                log('📸', `Screenshot guardado en ${screenshotPath}`);
                log('📄', `HTML guardado en ${htmlPath}`);
            } catch (e) {
                log('⚠️', 'No se pudieron guardar archivos de debug (normal en Render)');
            }
        }

        const { resultados: partidosEnVivo, debugEstados, debugTarjetas } = await page.evaluate(
            extraerPartidosEnNavegador
        );

        debug.etapa = 'evaluate_completo';
        debug.totalEnlacesEstado = debugEstados.length;
        debug.debugEstados = debugEstados;
        debug.debugTarjetas = debugTarjetas;

        // Diagnóstico
        log('🔍', `Estados de partido detectados (${debugEstados.length}): ${JSON.stringify(debugEstados)}`);
        if (debugTarjetas.length > 0) {
            log('🔍', 'Detalle de tarjetas en vivo evaluadas:');
            debugTarjetas.forEach((d, i) => {
                console.log(`   [${i}] equipos=${d.cantidadEquiposEncontrados} (${d.nombresEquipos.join(', ')}) | jugadores=${d.cantidadJugadoresEncontrados}`);
                console.log(`       texto: "${d.textoTarjetaResumido}..."`);
            });
        }

        // 🔥 MODIFICACIÓN: No guardamos archivos JSON en Render
        // Solo devolvemos los datos
        mostrarResultados(partidosEnVivo);

        return { partidos: partidosEnVivo, debug };
    } catch (error) {
        console.error('❌ Error durante el scraping:', error.message);
        debug.etapa = 'error';
        debug.error = error.message;
        return { partidos: [], debug };
    } finally {
        // Solo cerramos la PÁGINA, no el navegador: se mantiene vivo entre
        // llamadas para no pagar el costo de relanzar Chromium cada vez.
        if (page) {
            try {
                await page.close();
            } catch {}
        }
        log('🔄', 'Página cerrada (navegador se mantiene activo).');
    }
}

function mostrarResultados(partidos) {
    console.log('\n⚽ PARTIDOS EN VIVO — MUNDIAL FIFA 2026:');
    if (partidos.length === 0) {
        log('❌', 'No hay partidos en vivo en este momento.');
        return;
    }

    partidos.forEach((p) => {
        console.log('🔴 ' + '='.repeat(45));
        console.log(`   ${p.equipoLocal}  ${p.marcadorLocal} - ${p.marcadorVisitante}  ${p.equipoVisitante}`);
        console.log(`   ⏱️  Estado: ${p.minuto}`);
        if (p.sede) console.log(`   📍 Sede: ${p.sede}`);
        if (p.goleadores.length > 0) {
            console.log('   ⚽ Goles:');
            p.goleadores.forEach((g) => console.log(`      - ${g}`));
        } else {
            console.log('   ⚽ Goles: sin goles registrados aún');
        }
    });
    console.log('🔴 ' + '='.repeat(45));
    console.log(`\n✅ TOTAL EN VIVO: ${partidos.length} partido(s)`);
}

// ------------------------------- EXPORTACIÓN --------------------------------

// 🔥 EXPORTAR PARA QUE server.js PUEDA USARLO
module.exports = { scrapearPartidosEnVivo };

// Si se ejecuta directamente (no como módulo), correr el scraper
if (require.main === module) {
    scrapearPartidosEnVivo();
}