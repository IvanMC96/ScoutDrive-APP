/**
 * ════════════════════════════════════════════════════════════════
 *  SCOUTDRIVE · PUENTE DE SINCRONIZACIÓN CON GOOGLE SHEETS
 * ════════════════════════════════════════════════════════════════
 *  Este archivo se carga con <script src="sync-bridge.js"> al final
 *  de tu index.html, justo antes de </body>. NUNCA se pega a mano
 *  dentro de tu HTML — así, si algo de este archivo fallara, jamás
 *  puede romper la sintaxis de tu app principal.
 *
 *  Qué hace:
 *  1. Después de que guardarJ()/guardarE() hagan su trabajo normal
 *     (guardar en jDB/eDB + localStorage, igual que siempre), manda
 *     una copia a tu Google Sheet en segundo plano, sin bloquear ni
 *     ralentizar el guardado que ya tenías.
 *  2. Si no hay conexión, encola el envío y lo reintenta solo cuando
 *     vuelve internet.
 *  3. Al abrir la app, pregunta al Sheet si hay jugadores/equipos
 *     nuevos (añadidos desde otro dispositivo, por ejemplo) y los
 *     trae a tu lista local automáticamente.
 *
 *  Qué NO hace:
 *  - No sustituye tu almacenamiento local. Sigues funcionando 100%
 *    offline igual que siempre; esto es un añadido por encima.
 *  - No modifica ninguna función tuya por dentro — solo "envuelve"
 *    guardarJ y guardarE para añadir un paso extra después.
 * ════════════════════════════════════════════════════════════════
 */

// ════════════════════════════════════════════════════════════════
//  CONFIGURACIÓN
// ════════════════════════════════════════════════════════════════
const SCOUT_API_URL = 'https://script.google.com/macros/s/AKfycbzvcazJAfKj6LuL4QfsdyzdkFm27AvbHNwC3fANZ0aDDYpS4IZgaoPw9pJR2eYoUFQG/exec';

/** Convierte cualquier enlace de Drive (uc?export=view&id=..., file/d/.../view,
 *  open?id=...) al formato que Google SÍ deja insertar de forma fiable
 *  dentro de una etiqueta <img>. El formato "uc?export=view" que usaba
 *  antes el backend funciona al abrirlo directamente en el navegador,
 *  pero Google lo bloquea a menudo cuando se carga como imagen incrustada
 *  (por eso se veía bien en el Sheet pero no dentro de la app). */
function _driveURLViewable(url) {
  if (!url || typeof url !== 'string') return url;
  if (!url.includes('drive.google.com') && !url.includes('googleusercontent.com')) return url;
  const m = url.match(/[-\w]{25,}/);
  if (!m) return url;
  return `https://lh3.googleusercontent.com/d/${m[0]}=s0`;
}

// Pon esto en false desde la consola si alguna vez quieres trabajar
// offline puro sin que intente conectar (vuelve a true al recargar).
let SCOUT_SYNC_ENABLED = true;

const SYNC_COLA_KEY = 'scout_cola_offline_v1';
const SYNC_META_KEY = 'scout_ultima_sync_v1';

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════
function _scoutToast(msg, err) {
  if (typeof toast === 'function') toast(msg, !!err);
  else console.log('[Scoutdrive sync]', msg);
}

function _scoutCargarCola() {
  try { return JSON.parse(localStorage.getItem(SYNC_COLA_KEY) || '[]'); }
  catch (e) { return []; }
}
function _scoutGuardarCola(cola) {
  try { localStorage.setItem(SYNC_COLA_KEY, JSON.stringify(cola)); } catch (e) {}
}

// ════════════════════════════════════════════════════════════════
//  PETICIONES A LA WEB APP
// ════════════════════════════════════════════════════════════════
async function scoutApiPost(accion, datos) {
  if (!SCOUT_SYNC_ENABLED) return { ok: false, offline: true, motivo: 'Sync desactivada' };
  try {
    const res = await fetch(SCOUT_API_URL, {
      method: 'POST',
      // text/plain evita el preflight CORS que Apps Script no soporta bien
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ accion, datos }),
    });
    if (!res.ok) return { ok: false, offline: false, motivo: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { ok: false, offline: true, motivo: String(err) };
  }
}

async function scoutApiGet(params) {
  if (!SCOUT_SYNC_ENABLED) return { ok: false, offline: true };
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${SCOUT_API_URL}?${qs}`, { method: 'GET' });
    if (!res.ok) return { ok: false, offline: false, motivo: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { ok: false, offline: true, motivo: String(err) };
  }
}

// ════════════════════════════════════════════════════════════════
//  COLA OFFLINE — reintento automático
// ════════════════════════════════════════════════════════════════
function scoutEncolar(accion, datos) {
  const cola = _scoutCargarCola();
  cola.push({ accion, datos, intentos: 0, encolado: new Date().toISOString() });
  _scoutGuardarCola(cola);
  _scoutActualizarBadge(cola.length);
}

async function scoutProcesarCola() {
  const cola = _scoutCargarCola();
  if (!cola.length) return;

  const pendientes = [];
  for (const item of cola) {
    const resultado = await scoutApiPost(item.accion, item.datos);
    if (!resultado.ok) {
      item.intentos = (item.intentos || 0) + 1;
      if (item.intentos < 10) pendientes.push(item);
    }
  }
  _scoutGuardarCola(pendientes);
  _scoutActualizarBadge(pendientes.length);

  if (pendientes.length === 0 && cola.length > 0) {
    _scoutToast('☁️ Todo sincronizado con Google Sheets');
  }
}

// Pequeño indicador visual en la barra superior — no toca tu CSS,
// se crea solo y se actualiza solo. Se puede tocar/pulsar para forzar un
// reintento inmediato (antes había que esperar hasta 60s, o recuperar
// conexión, sin ninguna forma de decir "va, prueba ya").
function _scoutActualizarBadge(pendientesCount) {
  let badge = document.getElementById('scout-sync-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'scout-sync-badge';
    badge.title = 'Cambios que aún no se han podido subir a Google Sheets — toca para reintentar ahora';
    badge.style.cssText = `
      font-size:10px;font-weight:700;padding:3px 9px;border-radius:10px;
      margin-left:8px;display:none;cursor:pointer;white-space:nowrap;
    `;
    badge.onclick = () => {
      _scoutToast('🔄 Reintentando sincronización...');
      scoutProcesarCola();
    };
    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.appendChild(badge);
  }
  if (pendientesCount > 0) {
    badge.textContent = `☁️ ${pendientesCount} pendiente${pendientesCount !== 1 ? 's' : ''}`;
    badge.style.background = 'rgba(210,153,34,.15)';
    badge.style.color = '#e3b341';
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

window.addEventListener('online', () => {
  _scoutToast('🌐 Conexión recuperada, sincronizando...');
  scoutProcesarCola();
});
setInterval(scoutProcesarCola, 60000);

// ════════════════════════════════════════════════════════════════
//  ENGANCHE A guardarJ() / guardarE()
// ════════════════════════════════════════════════════════════════
//  Esperamos a que el DOM esté listo y las funciones originales ya
//  existan (las define tu script principal, que se carga ANTES que
//  este archivo) para poder envolverlas sin pisarlas.
// ════════════════════════════════════════════════════════════════
(function engancharGuardado() {
  if (typeof guardarJ !== 'function' || typeof guardarE !== 'function') {
    // Si por algún motivo este script se cargara antes de tiempo,
    // reintentamos en el siguiente tick en vez de fallar en silencio.
    setTimeout(engancharGuardado, 50);
    return;
  }

  const _guardarJ_original = guardarJ;
  guardarJ = function () {
    _guardarJ_original();
    const j = (typeof jDB !== 'undefined' && typeof jId !== 'undefined')
      ? jDB.find(x => x.id === jId) : null;
    if (j) scoutSincronizarJugador(j);
  };

  const _guardarE_original = guardarE;
  guardarE = function () {
    _guardarE_original();
    // Buscar el equipo recién guardado — puede estar en eDB o ser el actual eId
    const id = typeof eId !== 'undefined' ? eId : null;
    if (!id) return;
    const eq = (typeof eDB !== 'undefined') ? eDB.find(x => String(x.id) === String(id)) : null;
    if (eq) scoutSincronizarEquipo(eq);
    else console.warn('[Scoutdrive sync] Equipo no encontrado en eDB tras guardar:', id);
  };

  // guardarPartido / borrarPartido puede que aún no existan en este punto
  // (viven en el bloque de Partidos, más abajo en el archivo) — se
  // enganchan igual, más adelante, en engancharPartidos().
  console.log('[Scoutdrive sync] Conectado: guardarJ() y guardarE() ahora sincronizan con Google Sheets.');
})();

(function engancharPartidos() {
  if (typeof guardarPartido !== 'function' || typeof borrarPartido !== 'function') {
    setTimeout(engancharPartidos, 50);
    return;
  }

  const _guardarPartido_original = guardarPartido;
  guardarPartido = async function () {
    const editIdAntes = document.getElementById('ap-edit-id') ? document.getElementById('ap-edit-id').value : '';
    _guardarPartido_original();
    const id = editIdAntes || (typeof pDB !== 'undefined' && pDB.length ? pDB[0].id : null);
    const p = (typeof pDB !== 'undefined') ? pDB.find(x => String(x.id) === String(id)) : null;
    if (p) {
      // Antes de sincronizar: si algún gol tiene clip pero se guardó sin
      // portada, se genera una automática (foto del jugador + escudo del
      // equipo + patrocinador, ver _generarPortadaAutoGol en index.html)
      // — así ya sale con portada la primera vez, sin tener que editar el
      // partido otra vez a mano solo para eso. Se hace aquí (y no dentro
      // de guardarPartido()) para no romper el resto del guardado: el
      // wrapper de abajo asume que _guardarPartido_original() deja pDB ya
      // actualizado de forma síncrona.
      if (typeof _scoutGenerarPortadasAutoGoles === 'function') {
        try {
          const huboAutoPortada = await _scoutGenerarPortadasAutoGoles(p);
          if (huboAutoPortada) {
            if (typeof savePDB === 'function') savePDB();
            if (typeof sincronizarTacticaDesdePartidos === 'function') sincronizarTacticaDesdePartidos();
          }
        } catch (e) {
          console.warn('[Scoutdrive sync] No se pudo generar la portada automática de algún gol:', e);
        }
      }
      // IMPORTANTE: se espera a que termine scoutSincronizarPartidoVideo()
      // antes de subir jugadores/equipos. Esa función sustituye, en local,
      // el base64 de la portada de cada gol por la URL de Drive ya subida
      // (y refresca con ella las copias-espejo en jDB/eDB). Si en vez de
      // esperar se lanzaran las dos sincronizaciones a la vez (como antes),
      // scoutSincronizarJugadoresYEquiposDePartido() subiría jDB/eDB con el
      // base64 TODAVÍA sin sustituir — el mismo vídeo/portada se subiría
      // dos veces a Drive como dos archivos distintos.
      await scoutSincronizarPartidoVideo(p);
      // guardarPartido() ya reparte la taxonomía/clips de cada gol a la
      // ficha del jugador (jDB) y del equipo (eDB) que marcó
      // (sincronizarTacticaDesdePartidos(), dentro de index.html) — pero
      // eso solo actualiza jDB/eDB en este dispositivo (localStorage). Si
      // no subimos también esos jugadores/equipos aquí, el cambio se
      // queda solo en este dispositivo y nunca llega a los demás — mismo
      // tipo de fallo de sincronización que el de borrar equipos/jugadores
      // que ya se corrigió antes.
      scoutSincronizarJugadoresYEquiposDePartido(p);
    }
  };

  // borrarPartido() NO se envuelve aquí: el borrado es asíncrono (espera
  // a que el usuario confirme un modal), así que envolverlo con un
  // "esperar 300ms y comprobar" no funcionaba — esos 300ms casi siempre
  // pasaban antes de que el usuario llegara a confirmar, y el borrado
  // nunca llegaba a mandarse al Sheet (el partido "borrado" reaparecía en
  // la siguiente sincronización). Ahora borrarPartido(), dentro de
  // index.html, llama directamente a scoutEliminarPartidoVideoRemoto()
  // en el momento exacto en que el usuario confirma — así no hay carrera
  // posible. Esta función queda expuesta globalmente para que pueda
  // llamarla desde allí.
  console.log('[Scoutdrive sync] Conectado: guardarPartido()/borrarPartido() ahora sincronizan con Google Sheets.');
})();

(function engancharAnuncios() {
  if (typeof guardarAnuncio !== 'function' || typeof borrarAnuncio !== 'function') {
    setTimeout(engancharAnuncios, 50);
    return;
  }

  const _guardarAnuncio_original = guardarAnuncio;
  guardarAnuncio = function () {
    const editIdAntes = document.getElementById('an-edit-id') ? document.getElementById('an-edit-id').value : '';
    _guardarAnuncio_original();
    const id = editIdAntes || (typeof adsDB !== 'undefined' && adsDB.length ? adsDB[0].id : null);
    const a = (typeof adsDB !== 'undefined') ? adsDB.find(x => String(x.id) === String(id)) : null;
    if (a) scoutSincronizarAnuncio(a);
  };

  // borrarAnuncio() ya NO se envuelve aquí — mismo motivo que
  // borrarPartido() arriba: el borrado se confirma en un modal asíncrono,
  // así que el antiguo "esperar 300ms y comprobar si sigue existiendo"
  // casi nunca llegaba a tiempo y el anuncio "borrado" volvía a aparecer
  // al sincronizar. Ahora borrarAnuncio(), en index.html, llama
  // directamente a scoutEliminarAnuncioRemoto() en el momento real de la
  // confirmación.
  console.log('[Scoutdrive sync] Conectado: guardarAnuncio()/borrarAnuncio() ahora sincronizan con Google Sheets.');
})();

(function engancharConfig() {
  if (typeof guardarCfg !== 'function') {
    setTimeout(engancharConfig, 50);
    return;
  }
  const _guardarCfg_original = guardarCfg;
  guardarCfg = function () {
    _guardarCfg_original();
    if (typeof cfg !== 'undefined') scoutSincronizarConfig(cfg);
  };
  console.log('[Scoutdrive sync] Conectado: guardarCfg() ahora sincroniza con Google Sheets.');
})();

async function scoutSincronizarJugador(j) {
  const resultado = await scoutApiPost('guardarJugador', j);
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('guardarJugador', j);
  } else if (resultado.ok) {
    _scoutToast('☁️ Jugador sincronizado con Google Sheets');
    _scoutActualizarURLsImagen('jDB', j.id, resultado.resultado);
  } else {
    const detalle = resultado.motivo || resultado.error || 'error desconocido';
    console.warn('[Scoutdrive sync] Error al sincronizar jugador:', detalle);
    _scoutToast('⚠️ No se pudo subir el jugador al Sheet: ' + detalle, true);
  }
}

async function scoutSincronizarEquipo(eq) {
  const resultado = await scoutApiPost('guardarEquipo', eq);
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('guardarEquipo', eq);
  } else if (resultado.ok) {
    _scoutToast('☁️ Equipo sincronizado con Google Sheets');
    _scoutActualizarURLsImagen('eDB', eq.id, resultado.resultado);
  } else {
    const detalle = resultado.motivo || resultado.error || 'error desconocido';
    console.warn('[Scoutdrive sync] Error al sincronizar equipo:', detalle);
    _scoutToast('⚠️ No se pudo subir el equipo al Sheet: ' + detalle, true);
  }
}

async function scoutSincronizarPartidoVideo(p) {
  const resultado = await scoutApiPost('guardarPartidoVideo', p);
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('guardarPartidoVideo', p);
  } else if (resultado.ok) {
    _scoutToast('☁️ Partido sincronizado con Google Sheets');
    if (resultado.resultado && typeof pDB !== 'undefined') {
      const idx = pDB.findIndex(x => x.id === p.id);
      if (idx >= 0) {
        let cambiado = false;
        if (resultado.resultado.thumbURL) {
          pDB[idx].thumb = _driveURLViewable(resultado.resultado.thumbURL);
          cambiado = true;
        }
        // Las portadas de los clips de cada gol también se suben a Drive
        // en el backend (subirGolesYObtenerConURL_) — sin este parcheo,
        // este dispositivo se quedaría con el base64 original para
        // siempre y lo volvería a subir como archivo NUEVO cada vez que
        // se vuelva a guardar el partido (o se sincronice hacia la ficha
        // del jugador/equipo, justo después de esta función), duplicando
        // espacio en Drive sin parar.
        const golesRemoto = resultado.resultado.goles;
        if (Array.isArray(golesRemoto)) {
          (pDB[idx].goles || []).forEach((gLocal, i) => {
            const gRemoto = golesRemoto[i];
            if (gLocal && gLocal.clip && gLocal.clip.portada && typeof gLocal.clip.portada === 'string'
                && gLocal.clip.portada.startsWith('data:') && gRemoto && gRemoto.clip && gRemoto.clip.portada) {
              gLocal.clip.portada = _driveURLViewable(gRemoto.clip.portada);
              cambiado = true;
            }
          });
        }
        if (cambiado) {
          if (typeof savePDB === 'function') savePDB();
          // Refresca las copias-espejo del gol en jDB/eDB (ficha jugador/
          // equipo) con la URL ya corregida — así, cuando justo después se
          // llame a scoutSincronizarJugadoresYEquiposDePartido(), esas
          // fichas suben la URL corta y no el base64 original.
          if (typeof sincronizarTacticaDesdePartidos === 'function') sincronizarTacticaDesdePartidos();
        }
      }
    }
  } else {
    const detalle = resultado.motivo || resultado.error || 'error desconocido';
    console.warn('[Scoutdrive sync] Error al sincronizar partido:', detalle);
    _scoutToast('⚠️ No se pudo subir el partido al Sheet: ' + detalle, true);
  }
}

// Tras guardar un partido, sube a Google Sheets los jugadores y equipos
// que sincronizarTacticaDesdePartidos() acaba de actualizar en local
// (goles con taxonomía + clips en jDB, golesGF en eDB) — si no, esos
// cambios se quedan solo en este dispositivo. Se recalculan los
// afectados a partir de los propios goles/equipos del partido (misma
// resolución jugadorIdPorNombre()/_buscarEquipoPorNombre() que usa
// sincronizarTacticaDesdePartidos(), para subir justo a quien haya
// podido cambiar).
//
// IMPORTANTE: además de los goleadores/porteros, un partido con acta
// importada ("📋 Importar acta") actualiza en local, vía
// recalcularStatsDesdePartidos(), el PJ/PT/PS/Minutos/Amarillas/Rojas de
// CUALQUIER jugador que fuera titular o suplente esa jornada — no solo
// de quien marcó gol. Sin incluirlos aquí, esos jugadores se quedaban
// con el dato actualizado SOLO en este dispositivo hasta que alguien
// abriera su ficha a mano y la volviera a guardar (el mismo tipo de
// fallo de sincronización ya corregido para equipos/goles antes).
async function scoutSincronizarJugadoresYEquiposDePartido(p) {
  if (typeof jDB === 'undefined' || typeof eDB === 'undefined') return;
  const idsJugadores = new Set();
  const nombresJugadores = new Set();
  (p.goles || []).forEach(g => { if (g.jugador) nombresJugadores.add(g.jugador); if (g.portero) nombresJugadores.add(g.portero); });
  nombresJugadores.forEach(nom => {
    const jid = (typeof jugadorIdPorNombre === 'function') ? jugadorIdPorNombre(nom) : null;
    if (jid) idsJugadores.add(jid);
  });
  if (p.alineacion) {
    ['local', 'visitante'].forEach(lado => {
      const bloque = p.alineacion[lado];
      if (!bloque) return;
      ['titulares', 'suplentes'].forEach(tipo => {
        (bloque[tipo] || []).forEach(f => { if (f && f.jugadorId) idsJugadores.add(f.jugadorId); });
      });
    });
  }
  idsJugadores.forEach(jid => {
    const j = jDB.find(x => String(x.id) === String(jid));
    if (j) scoutSincronizarJugador(j);
  });
  [p.local, p.visitante].forEach(nomEq => {
    const eq = (typeof _buscarEquipoPorNombre === 'function') ? _buscarEquipoPorNombre(nomEq, p.temp) : null;
    if (eq) scoutSincronizarEquipo(eq);
  });
}

async function scoutEliminarPartidoVideoRemoto(id) {
  const resultado = await scoutApiPost('eliminarPartidoVideo', { id });
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('eliminarPartidoVideo', { id });
  } else if (!resultado.ok) {
    console.warn('[Scoutdrive sync] Error al eliminar partido en el Sheet:', resultado.motivo || resultado.error);
  }
}

// Nombre/subtítulo/pie/logo de la plataforma (Configuración › "Guardar
// configuración") — antes solo se guardaba en el localStorage de quien
// lo tocaba, así que el resto de dispositivos/usuarios nunca lo veían.
async function scoutSincronizarConfig(c) {
  const resultado = await scoutApiPost('guardarConfig', c);
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('guardarConfig', c);
  } else if (resultado.ok) {
    _scoutToast('☁️ Configuración sincronizada con Google Sheets');
    if (resultado.resultado && resultado.resultado.logoURL && typeof cfg !== 'undefined') {
      cfg.logo = resultado.resultado.logoURL;
      if (typeof saveCfg === 'function') saveCfg();
    }
  } else {
    const detalle = resultado.motivo || resultado.error || 'error desconocido';
    console.warn('[Scoutdrive sync] Error al sincronizar configuración:', detalle);
    _scoutToast('⚠️ No se pudo subir la configuración al Sheet: ' + detalle, true);
  }
}

async function scoutSincronizarAnuncio(a) {
  const resultado = await scoutApiPost('guardarAnuncio', a);
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('guardarAnuncio', a);
  } else if (resultado.ok) {
    _scoutToast('☁️ Anuncio sincronizado con Google Sheets');
    if (resultado.resultado && resultado.resultado.imgURL && typeof adsDB !== 'undefined') {
      const idx = adsDB.findIndex(x => x.id === a.id);
      if (idx >= 0) { adsDB[idx].img = _driveURLViewable(resultado.resultado.imgURL); if (typeof saveAds === 'function') saveAds(); }
    }
  } else {
    const detalle = resultado.motivo || resultado.error || 'error desconocido';
    console.warn('[Scoutdrive sync] Error al sincronizar anuncio:', detalle);
    _scoutToast('⚠️ No se pudo subir el anuncio al Sheet: ' + detalle, true);
  }
}

async function scoutEliminarAnuncioRemoto(id) {
  const resultado = await scoutApiPost('eliminarAnuncio', { id });
  if (!resultado.ok && resultado.offline) {
    scoutEncolar('eliminarAnuncio', { id });
  } else if (!resultado.ok) {
    console.warn('[Scoutdrive sync] Error al eliminar anuncio en el Sheet:', resultado.motivo || resultado.error);
  }
}

// ════════════════════════════════════════════════════════════════
//  RESUBIDA MASIVA — útil una sola vez tras arreglar/cambiar el
//  backend, para subir todo lo que ya tienes guardado en local
//  (p.ej. en la tablet) y que quedó sin llegar nunca a la nube.
//  Sube uno a uno (sin solaparse) para no saturar Apps Script.
// ════════════════════════════════════════════════════════════════
async function scoutForzarResubidaTotal() {
  if (typeof jDB === 'undefined' || typeof eDB === 'undefined') return;
  const totalPartidos = (typeof pDB !== 'undefined') ? pDB.length : 0;
  const totalAds = (typeof adsDB !== 'undefined') ? adsDB.length : 0;
  const total = jDB.length + eDB.length + totalPartidos + totalAds;
  if (total === 0) { _scoutToast('No hay nada local que resubir', true); return; }

  const btn = document.getElementById('btn-resubida-total');
  if (btn) { btn.disabled = true; }

  let hechos = 0, fallos = 0;
  let primerError = '';

  for (const j of jDB) {
    if (btn) btn.textContent = `⏳ Subiendo jugadores... (${hechos + fallos + 1}/${total})`;
    const resultado = await scoutApiPost('guardarJugador', j);
    if (resultado.ok) { hechos++; _scoutActualizarURLsImagen('jDB', j.id, resultado.resultado); }
    else {
      fallos++;
      const detalle = resultado.motivo || resultado.error || 'error desconocido';
      if (!primerError) primerError = detalle;
      console.warn('[Scoutdrive] Fallo al resubir jugador', j.id, detalle);
    }
  }

  for (const eq of eDB) {
    if (btn) btn.textContent = `⏳ Subiendo equipos... (${hechos + fallos + 1}/${total})`;
    const resultado = await scoutApiPost('guardarEquipo', eq);
    if (resultado.ok) { hechos++; _scoutActualizarURLsImagen('eDB', eq.id, resultado.resultado); }
    else {
      fallos++;
      const detalle = resultado.motivo || resultado.error || 'error desconocido';
      if (!primerError) primerError = detalle;
      console.warn('[Scoutdrive] Fallo al resubir equipo', eq.id, detalle);
    }
  }

  if (typeof pDB !== 'undefined') {
    for (const p of pDB) {
      if (btn) btn.textContent = `⏳ Subiendo partidos... (${hechos + fallos + 1}/${total})`;
      const resultado = await scoutApiPost('guardarPartidoVideo', p);
      if (resultado.ok) {
        hechos++;
        if (resultado.resultado && resultado.resultado.thumbURL) p.thumb = _driveURLViewable(resultado.resultado.thumbURL);
      } else {
        fallos++;
        const detalle = resultado.motivo || resultado.error || 'error desconocido';
        if (!primerError) primerError = detalle;
        console.warn('[Scoutdrive] Fallo al resubir partido', p.id, detalle);
      }
    }
  }

  if (typeof adsDB !== 'undefined') {
    for (const a of adsDB) {
      if (btn) btn.textContent = `⏳ Subiendo publicidad... (${hechos + fallos + 1}/${total})`;
      const resultado = await scoutApiPost('guardarAnuncio', a);
      if (resultado.ok) {
        hechos++;
        if (resultado.resultado && resultado.resultado.imgURL) a.img = _driveURLViewable(resultado.resultado.imgURL);
      } else {
        fallos++;
        const detalle = resultado.motivo || resultado.error || 'error desconocido';
        if (!primerError) primerError = detalle;
        console.warn('[Scoutdrive] Fallo al resubir anuncio', a.id, detalle);
      }
    }
  }

  if (typeof saveJDB === 'function') saveJDB();
  if (typeof saveEDB === 'function') saveEDB();
  if (typeof savePDB === 'function') savePDB();
  if (typeof saveAds === 'function') saveAds();

  if (btn) { btn.disabled = false; btn.textContent = '☁️ Forzar resubida de todo lo local'; }

  if (fallos === 0) {
    _scoutToast(`✅ Resubida completa: ${hechos} elemento${hechos !== 1 ? 's' : ''} enviado${hechos !== 1 ? 's' : ''} al Sheet`);
  } else {
    _scoutToast(`⚠️ ${hechos} ok, ${fallos} con error. Motivo: ${primerError}`, true);
  }
}

/** jDB/eDB son "let" a nivel superior de index.html, así que no existen
 *  como propiedades de "window" — hay que referenciarlas por su nombre
 *  directamente. Pequeño despachador para poder elegir el array correcto
 *  a partir de un string ("jDB"/"eDB"), como hacía (mal) window[nombre]. */
function _scoutArrayPorNombre(nombre) {
  if (nombre === 'jDB') return (typeof jDB !== 'undefined') ? jDB : null;
  if (nombre === 'eDB') return (typeof eDB !== 'undefined') ? eDB : null;
  return null;
}

/** Tras subir imágenes a Drive, el backend devuelve fotoURL/escudoURL (y,
 *  desde ahora, también los clips ya con la portada subida a Drive).
 *  Sustituimos el base64 local por esas URLs para que las próximas
 *  sincronizaciones sean más ligeras — y, sobre todo, para que este mismo
 *  dispositivo no se quede con el base64 original para siempre: si no se
 *  sustituye aquí, cada vez que se vuelva a guardar esta ficha se
 *  reconoce como "todavía es base64" y se vuelve a subir a Drive como un
 *  archivo NUEVO, duplicando espacio sin parar. */
function _scoutActualizarURLsImagen(arrayName, id, resultadoBackend) {
  if (!resultadoBackend) return;
  // OJO: jDB/eDB se declaran con "let" en index.html, así que NO cuelgan
  // de "window" (a diferencia de una variable declarada con "var") aunque
  // sí son visibles por su nombre desde cualquier <script> clásico de la
  // misma página — "window[arrayName]" aquí siempre devolvía undefined y
  // esta función nunca llegaba a parchear nada, ni siquiera fotoURL/
  // escudoURL. _scoutArrayPorNombre() referencia la variable diréctamente.
  const arr = _scoutArrayPorNombre(arrayName);
  if (!Array.isArray(arr)) return;
  const registro = arr.find(x => x.id === id);
  if (!registro) return;
  let cambiado = false;
  if (resultadoBackend.fotoURL && registro.imgJug && registro.imgJug.startsWith('data:')) {
    registro.imgJug = _driveURLViewable(resultadoBackend.fotoURL); cambiado = true;
  }
  if (resultadoBackend.escudoURL && registro.imgEsc && registro.imgEsc.startsWith('data:')) {
    registro.imgEsc = _driveURLViewable(resultadoBackend.escudoURL); cambiado = true;
  }
  if (_scoutParchearPortadasClips(registro.clips, resultadoBackend.clips)) cambiado = true;
  if (_scoutParchearPortadasClips(registro.clipsGC, resultadoBackend.clipsGC)) cambiado = true;
  if (cambiado) {
    if (arrayName === 'jDB' && typeof saveJDB === 'function') saveJDB();
    if (arrayName === 'eDB' && typeof saveEDB === 'function') saveEDB();
  }
}

/** Sustituye, en un array local de clips, la portada base64 de cada clip
 *  por la URL de Drive ya subida que haya devuelto el backend en el mismo
 *  índice (el backend construye su array con .map() sobre el mismo array
 *  que se le mandó, así que el orden se conserva 1 a 1). Se usa tanto
 *  para clips de jugador/equipo como para clipsGC ("goles en contra"). */
function _scoutParchearPortadasClips(clipsLocal, clipsRemotoConURL) {
  if (!Array.isArray(clipsLocal) || !Array.isArray(clipsRemotoConURL)) return false;
  let cambiado = false;
  clipsLocal.forEach((c, i) => {
    const remoto = clipsRemotoConURL[i];
    if (c && c.portada && typeof c.portada === 'string' && c.portada.startsWith('data:') && remoto && remoto.portada) {
      c.portada = _driveURLViewable(remoto.portada);
      cambiado = true;
    }
  });
  return cambiado;
}

// ════════════════════════════════════════════════════════════════
//  SINCRONIZACIÓN AL ABRIR LA APP (INCREMENTAL — YA NO SE USA SOLA)
// ════════════════════════════════════════════════════════════════
//  IMPORTANTE: esta versión solo trae lo CREADO/EDITADO desde la última
//  vez (accion "cambiosDesde"), nunca lo BORRADO — el Sheet no guarda
//  ningún rastro de una fila que ya se borró, así que una respuesta
//  incremental nunca puede decir "esto ya no existe". Por eso, si algo
//  se borraba en un dispositivo, en cualquier otro que ya lo tuviera
//  cacheado localmente se quedaba ahí para siempre, aunque el resto de
//  cambios sí llegaran bien — es el bug que reportó Iván ("borro un
//  equipo y le sigue saliendo a los demás").
//  Se deja esta función definida por si en el futuro hace falta un
//  sync ligero, pero scoutSyncInicial() ya NO la llama: ahora usa
//  siempre scoutSyncCompleto(), que trae el listado COMPLETO y actual
//  del Sheet y por tanto sí puede podar lo que ya no está (ver
//  _scoutPodarBorrados en scoutSyncCompleto). Con los tamaños de datos
//  de este club (unos pocos cientos de filas como mucho) traer todo en
//  cada apertura es perfectamente rápido, y así un borrado sí llega de
//  verdad a todos los dispositivos la siguiente vez que abran la app.
// ════════════════════════════════════════════════════════════════
async function scoutSincronizarAlAbrir() {
  if (!SCOUT_SYNC_ENABLED) return;
  if (typeof jDB === 'undefined' || typeof eDB === 'undefined') return;

  const ultimaSync = localStorage.getItem(SYNC_META_KEY) || '1970-01-01T00:00:00Z';
  const respuesta = await scoutApiGet({ accion: 'cambiosDesde', desde: ultimaSync });

  if (!respuesta.ok) return; // sin conexión al abrir, no pasa nada

  let huboNovedades = false;

  if (respuesta.jugadores && respuesta.jugadores.length) {
    respuesta.jugadores.forEach(r => {
      const remoto = _normalizarRegistro(r);
      if (!remoto.id) return;
      const idx = jDB.findIndex(x => x.id === remoto.id);
      const fechaLocal = idx >= 0 ? new Date(jDB[idx].fecha || 0).getTime() : 0;
      const fechaRemota = new Date(remoto.fechaActualizacion || 0).getTime();
      if (idx < 0) {
        // Registro que no existe en local todavía (p.ej. dispositivo nuevo):
        // lo añadimos siempre. No exigimos nombre aquí — si lo exigiéramos,
        // un fallo de mapeo de columnas en el Sheet dejaría el dispositivo
        // sin datos en vez de con datos "sin nombre" (que sí se pueden ver
        // y arreglar desde la app).
        jDB.unshift(remoto); huboNovedades = true;
      } else if (fechaRemota > fechaLocal) {
        // Aquí sí protegemos: nunca dejamos que un remoto sin nombre/apellidos
        // borre uno local que sí los tiene — evita que un jugador "se quede
        // sin nombre" por una fila incompleta o mal mapeada en el Sheet.
        if (_scoutFusionarSeguro(jDB, idx, remoto, ['nom', 'ape'], ['imgJug', 'imgEsc'], ['orig', 'statsManualBase'])) huboNovedades = true;
      }
    });
  }
  if (respuesta.equipos && respuesta.equipos.length) {
    respuesta.equipos.forEach(r => {
      const remoto = _normalizarRegistro(r);
      if (!remoto.id) return;
      const idx = eDB.findIndex(x => x.id === remoto.id);
      const fechaLocal = idx >= 0 ? new Date(eDB[idx].fecha || 0).getTime() : 0;
      const fechaRemota = new Date(remoto.fechaActualizacion || 0).getTime();
      if (idx < 0) {
        eDB.unshift(remoto); huboNovedades = true;
      } else if (fechaRemota > fechaLocal) {
        if (_scoutFusionarSeguro(eDB, idx, remoto, ['nom'], ['imgEsc'], ['orig', 'campoOverrides', 'campoSponsor', 'alineaciones', 'statsManualBase'])) huboNovedades = true;
      }
    });
  }
  if (respuesta.partidosVideo && respuesta.partidosVideo.length && typeof pDB !== 'undefined') {
    respuesta.partidosVideo.forEach(r => {
      const remoto = _normalizarRegistro(r);
      if (!remoto.id) return;
      const idx = pDB.findIndex(x => x.id === remoto.id);
      const fechaLocal = idx >= 0 ? new Date(pDB[idx].fechaReg || 0).getTime() : 0;
      const fechaRemota = new Date(remoto.fechaActualizacion || 0).getTime();
      if (idx < 0) {
        if (remoto.local || remoto.visitante) { pDB.unshift(remoto); huboNovedades = true; }
      } else if (fechaRemota > fechaLocal) {
        if (_scoutFusionarSeguro(pDB, idx, remoto, ['local', 'visitante'], ['thumb'])) huboNovedades = true;
      }
    });
  }
  if (respuesta.anuncios && respuesta.anuncios.length && typeof adsDB !== 'undefined') {
    respuesta.anuncios.forEach(r => {
      const remoto = _normalizarRegistro(r);
      if (!remoto.id) return;
      const idx = adsDB.findIndex(x => x.id === remoto.id);
      if (idx < 0) { adsDB.unshift(remoto); huboNovedades = true; }
      else { adsDB[idx] = remoto; huboNovedades = true; }
    });
  }

  localStorage.setItem(SYNC_META_KEY, respuesta.timestamp || new Date().toISOString());

  if (huboNovedades) {
    if (typeof saveJDB === 'function') saveJDB();
    if (typeof saveEDB === 'function') saveEDB();
    if (typeof savePDB === 'function') savePDB();
    if (typeof saveAds === 'function') saveAds();
    // IMPORTANTE: el "stats"/"orig" de cada jugador/equipo que llega del
    // Sheet es solo una FOTO de lo que había en el dispositivo que lo
    // subió por última vez — si aquí ha llegado también un partido nuevo
    // (pDB), ese jugador/equipo puede quedarse con un PJ/goles ya
    // desactualizado hasta que alguien vuelva a abrir y guardar su ficha
    // a mano. Por eso, justo después de fusionar todo (incluido pDB, que
    // es la fuente real), se recalculan stats/táctica en local a partir
    // de los partidos que YA tenemos completos — así la ficha y el
    // listado de Equipos/Jugadores quedan sincronizados de verdad tras
    // cada sync, no solo el propio partido. "statsManualBase" (la base
    // congelada de la que parte este recálculo) va protegido arriba en
    // _scoutFusionarSeguro para que esto nunca duplique goles ya contados.
    if (typeof recalcularStatsDesdePartidos === 'function') recalcularStatsDesdePartidos();
    if (typeof sincronizarTacticaDesdePartidos === 'function') sincronizarTacticaDesdePartidos();
    if (typeof renderBannerAdsGlobal === 'function') renderBannerAdsGlobal();
    if (typeof currentSection !== 'undefined') {
      if (currentSection === 'jugadores-db' && typeof renderJDB === 'function') renderJDB();
      if (currentSection === 'equipos-db' && typeof renderEDB === 'function') renderEDB();
      if (currentSection === 'partidos' && typeof renderPartidos === 'function') renderPartidos();
      if (currentSection === 'inicio' && typeof renderInicio === 'function') renderInicio();
    }
    _scoutToast('☁️ Datos actualizados desde Google Sheets');
  }
}

/** Sustituye arr[idx] por "remoto", pero:
 *  1) si remoto no trae ninguno de los "camposClave" (p.ej. nom/ape)
 *     mientras el local sí los tenía, conserva esos campos del local
 *     en vez de dejar el registro sin nombre.
 *  2) si remoto no trae imagen en alguno de "camposImagen" (escudo,
 *     foto, miniatura...) pero el local SÍ la tenía, conserva la
 *     imagen local — esto es justo lo que evita que un escudo/foto que
 *     ya estaba bien subido se borre al sincronizar con una fila del
 *     Sheet que se guardó a medias (p.ej. por un fallo anterior).
 *  3) si remoto no trae valor en alguno de "camposObjeto" (objetos
 *     anidados como el "orig" del radar de estilo de juego, o el
 *     "campoOverrides" del campograma) pero el local sí, conserva el
 *     del local. Estos campos van dentro de "jsonCompleto" en el
 *     Sheet, que tiene un límite de 50.000 caracteres por celda —  si
 *     el registro es grande (p.ej. por un escudo/foto en base64), se
 *     puede guardar truncado y el JSON.parse falla; en ese caso
 *     _normalizarRegistro() cae al mapeo manual de columnas planas,
 *     que no incluye estos campos, y sin esta protección la fila
 *     remota "vacía" en ese campo borraría silenciosamente el dato
 *     local en cada sincronización completa. */
function _scoutFusionarSeguro(arr, idx, remoto, camposClave, camposImagen, camposObjeto) {
  const local = arr[idx];
  const remotoTieneAlgunCampo = camposClave.some(c => remoto[c]);
  const localTieneAlgunCampo = camposClave.some(c => local[c]);
  const fusionado = { ...remoto };
  if (!remotoTieneAlgunCampo && localTieneAlgunCampo) {
    camposClave.forEach(c => { fusionado[c] = local[c]; });
    console.warn('[Scoutdrive sync] Fila remota sin nombre; se conserva el nombre local para', local.id);
  }
  (camposImagen || []).forEach(c => {
    if (!remoto[c] && local[c]) {
      fusionado[c] = local[c];
      console.warn('[Scoutdrive sync] Fila remota sin imagen (' + c + '); se conserva la local para', local.id);
    }
  });
  (camposObjeto || []).forEach(c => {
    const remotoVacio = !remoto[c] || (typeof remoto[c] === 'object' && Object.keys(remoto[c]).length === 0);
    const localConValor = local[c] && typeof local[c] === 'object' && Object.keys(local[c]).length > 0;
    if (remotoVacio && localConValor) {
      fusionado[c] = local[c];
      console.warn('[Scoutdrive sync] Fila remota sin ' + c + '; se conserva el local para', local.id);
    }
  });
  arr[idx] = fusionado;
  return true;
}

// ════════════════════════════════════════════════════════════════
//  NORMALIZACIÓN — convierte columnas del Sheet al formato de la app
// ════════════════════════════════════════════════════════════════
function _normalizarRegistro(r) {
  // Si tiene jsonCompleto, esa es la fuente de verdad — contiene el
  // objeto exacto tal como lo generó guardarJ()/guardarE()
  if (r.jsonCompleto) {
    try {
      const obj = JSON.parse(r.jsonCompleto);
      // IMPORTANTE: aunque jsonCompleto traiga imgJug/imgEsc/thumb/img,
      // preferimos siempre la URL de Drive de las columnas planas
      // (fotoURL/escudoURL/thumbURL/imgURL) si existe. Las celdas de
      // Google Sheets tienen un límite de 50.000 caracteres; si la foto
      // era grande en base64, jsonCompleto pudo guardarse truncado, aunque
      // el resto de la ficha esté perfectamente bien. La URL de Drive no
      // tiene ese problema porque es un texto corto.
      if (r.fotoURL)   obj.imgJug = _driveURLViewable(r.fotoURL);
      if (r.escudoURL) obj.imgEsc = _driveURLViewable(r.escudoURL);
      if (r.thumbURL)  obj.thumb  = _driveURLViewable(r.thumbURL);
      if (r.imgURL)    obj.img    = _driveURLViewable(r.imgURL);
      // Por si el jsonCompleto trae directamente una URL de Drive (sin
      // columna plana), la arreglamos también aquí.
      if (obj.imgJug) obj.imgJug = _driveURLViewable(obj.imgJug);
      if (obj.imgEsc) obj.imgEsc = _driveURLViewable(obj.imgEsc);
      if (obj.thumb)  obj.thumb  = _driveURLViewable(obj.thumb);
      if (obj.img)    obj.img    = _driveURLViewable(obj.img);
      // El jsonCompleto ya tiene la estructura correcta (nom, ape, etc.)
      return { ...obj, _sincronizado: true };
    } catch(e) {}
  }

  // Si no hay jsonCompleto (objeto incompleto del Sheet), hacemos el
  // mapeo manual de columnas planas → campos que usa la app
  const normalizado = { ...r, _sincronizado: true };

  // Jugador: columnas del Sheet → campos de la app
  if (r.nombre !== undefined && r.nom === undefined) normalizado.nom = r.nombre;
  if (r.apellidos !== undefined && r.ape === undefined) normalizado.ape = r.apellidos;
  if (r.posicion !== undefined && r.pos === undefined) normalizado.pos = r.posicion;
  if (r.temporada !== undefined && r.temp === undefined) normalizado.temp = r.temporada;
  if (r.nacionalidad !== undefined && r.nac === undefined) normalizado.nac = r.nacionalidad;
  if (r.notaTecnica !== undefined && r.nota === undefined) normalizado.nota = r.notaTecnica;
  if (r.fotoURL !== undefined && !normalizado.imgJug) normalizado.imgJug = _driveURLViewable(r.fotoURL);
  if (r.escudoURL !== undefined && !normalizado.imgEsc) normalizado.imgEsc = _driveURLViewable(r.escudoURL);

  // Equipo: columnas del Sheet → campos de la app
  if (r.nombre !== undefined && r.nom === undefined) normalizado.nom = r.nombre;
  if (r.temporada !== undefined && r.temp === undefined) normalizado.temp = r.temporada;
  if (r.entrenador !== undefined && r.ent === undefined) normalizado.ent = r.entrenador;
  if (r.sistema !== undefined && r.sist === undefined) normalizado.sist = r.sistema;
  if (r.notaTactica !== undefined && r.nota === undefined) normalizado.nota = r.notaTactica;
  if (r.escudoURL !== undefined && !normalizado.imgEsc) normalizado.imgEsc = _driveURLViewable(r.escudoURL);

  // PartidoVideo / Anuncio: columnas planas → campos de la app
  if (r.thumbURL !== undefined && !normalizado.thumb) normalizado.thumb = _driveURLViewable(r.thumbURL);
  if (r.imgURL !== undefined && !normalizado.img) normalizado.img = _driveURLViewable(r.imgURL);

  // Stats del equipo
  if (!normalizado.stats && (r.pj !== undefined)) {
    normalizado.stats = {
      pj: +r.pj||0, v: +r.victorias||0, e: +r.empates||0,
      d: +r.derrotas||0, gf: +r.golesFavor||0, gc: +r.golesContra||0
    };
  }

  return normalizado;
}

/** Quita de "arr" cualquier registro cuyo id ya NO exista en el Sheet
 *  (idsRemotos) — es decir, que otro dispositivo/usuario lo borró desde
 *  que este dispositivo lo cacheó. Sin esto, un borrado nunca "llegaba"
 *  a los demás dispositivos: sync completo y cambiosDesde solo sabían
 *  AÑADIR o ACTUALIZAR por id, nunca quitar algo que ya no estaba en la
 *  respuesta remota, así que lo borrado localmente en un sitio seguía
 *  viéndose para siempre en cualquier otro dispositivo que ya lo tuviera
 *  cacheado (aunque el borrado sí se hubiera guardado bien en el Sheet).
 *  idsPendientes protege lo creado offline y aún no subido: si un id
 *  tiene un envío pendiente en la cola, NUNCA se poda, aunque todavía no
 *  aparezca en el Sheet (si no, se borraría localmente algo que el
 *  usuario acaba de crear sin conexión, antes de que le diera tiempo a
 *  subirse). */
function _scoutPodarBorrados(arr, idsRemotos, idsPendientes) {
  if (!Array.isArray(arr)) return 0;
  let podados = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const id = arr[i] && arr[i].id;
    if (id === undefined || id === null) continue;
    const idStr = String(id);
    if (!idsRemotos.has(idStr) && !idsPendientes.has(idStr)) {
      arr.splice(i, 1);
      podados++;
    }
  }
  return podados;
}

// ════════════════════════════════════════════════════════════════
//  SINCRONIZACIÓN COMPLETA — trae TODO del Sheet
//  (útil al abrir desde un dispositivo nuevo, y también en cada
//  apertura normal — ver scoutSyncInicial más abajo: es la única forma
//  de que un borrado hecho en otro dispositivo se refleje aquí, porque
//  es la única llamada que trae la lista COMPLETA y actual de lo que
//  existe de verdad en el Sheet, así que es la única que puede podar
//  con seguridad lo que ya no está)
// ════════════════════════════════════════════════════════════════
async function scoutSyncCompleto(silencioso) {
  if (!SCOUT_SYNC_ENABLED) return;

  const btn = document.getElementById('btn-sync-manual');
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

  const respuesta = await scoutApiGet({ accion: 'sync' });

  if (!respuesta.ok) {
    if (!silencioso) _scoutToast('Sin conexión con Google Sheets', true);
    if (btn) { btn.textContent = '🔄'; btn.disabled = false; }
    return;
  }

  let cambios = 0;

  // Ids con un envío aún pendiente (creado/editado offline, todavía sin
  // llegar al Sheet) — nunca se podan aunque el Sheet aún no los tenga.
  const idsPendientes = new Set(
    _scoutCargarCola().map(item => item && item.datos && item.datos.id).filter(Boolean).map(String)
  );

  if (respuesta.jugadores && respuesta.jugadores.length) {
    const reconstruidos = respuesta.jugadores.map(_normalizarRegistro);
    // Reemplazar o añadir — el Sheet es la fuente de verdad en sync completo
    reconstruidos.forEach(remoto => {
      if (!remoto.id) return;
      const idx = (typeof jDB !== 'undefined') ? jDB.findIndex(x => x.id === remoto.id) : -1;
      if (idx >= 0) { _scoutFusionarSeguro(jDB, idx, remoto, ['nom', 'ape'], ['imgJug', 'imgEsc'], ['orig', 'statsManualBase']); cambios++; }
      else if (typeof jDB !== 'undefined') { jDB.unshift(remoto); cambios++; }
    });
  }
  if (Array.isArray(respuesta.jugadores) && typeof jDB !== 'undefined') {
    const idsRemotos = new Set(respuesta.jugadores.map(r => String(r.id)));
    cambios += _scoutPodarBorrados(jDB, idsRemotos, idsPendientes);
  }

  if (respuesta.equipos && respuesta.equipos.length) {
    const reconstruidos = respuesta.equipos.map(_normalizarRegistro);
    reconstruidos.forEach(remoto => {
      if (!remoto.id) return;
      const idx = (typeof eDB !== 'undefined') ? eDB.findIndex(x => x.id === remoto.id) : -1;
      if (idx >= 0) { _scoutFusionarSeguro(eDB, idx, remoto, ['nom'], ['imgEsc'], ['orig', 'campoOverrides', 'campoSponsor', 'alineaciones', 'statsManualBase']); cambios++; }
      else if (typeof eDB !== 'undefined') { eDB.unshift(remoto); cambios++; }
    });
  }
  if (Array.isArray(respuesta.equipos) && typeof eDB !== 'undefined') {
    const idsRemotos = new Set(respuesta.equipos.map(r => String(r.id)));
    cambios += _scoutPodarBorrados(eDB, idsRemotos, idsPendientes);
  }

  if (respuesta.partidosVideo && respuesta.partidosVideo.length && typeof pDB !== 'undefined') {
    const reconstruidos = respuesta.partidosVideo.map(_normalizarRegistro);
    reconstruidos.forEach(remoto => {
      if (!remoto.id) return;
      const idx = pDB.findIndex(x => x.id === remoto.id);
      if (idx >= 0) { _scoutFusionarSeguro(pDB, idx, remoto, ['local', 'visitante'], ['thumb']); cambios++; }
      else { pDB.unshift(remoto); cambios++; }
    });
  }
  if (Array.isArray(respuesta.partidosVideo) && typeof pDB !== 'undefined') {
    const idsRemotos = new Set(respuesta.partidosVideo.map(r => String(r.id)));
    cambios += _scoutPodarBorrados(pDB, idsRemotos, idsPendientes);
  }

  if (respuesta.anuncios && respuesta.anuncios.length && typeof adsDB !== 'undefined') {
    const reconstruidos = respuesta.anuncios.map(_normalizarRegistro);
    reconstruidos.forEach(remoto => {
      if (!remoto.id) return;
      const idx = adsDB.findIndex(x => x.id === remoto.id);
      if (idx >= 0) { adsDB[idx] = remoto; cambios++; }
      else { adsDB.unshift(remoto); cambios++; }
    });
  }
  if (Array.isArray(respuesta.anuncios) && typeof adsDB !== 'undefined') {
    const idsRemotos = new Set(respuesta.anuncios.map(r => String(r.id)));
    cambios += _scoutPodarBorrados(adsDB, idsRemotos, idsPendientes);
  }

  // Nombre/subtítulo/pie/logo de la plataforma — objeto único (no un
  // array con ids como todo lo demás), así que se compara y aplica
  // aparte en vez de pasar por _scoutFusionarSeguro/_scoutPodarBorrados.
  // Si el Sheet aún no tiene ninguna configuración guardada (nadie ha
  // usado "Guardar configuración" todavía), respuesta.cfg viene null y
  // no se toca nada de lo que ya hubiera en local.
  let cambioCfg = false;
  if (respuesta.cfg && typeof cfg !== 'undefined') {
    const remotoCfg = respuesta.cfg;
    cambioCfg = (remotoCfg.nombre || '') !== (cfg.nombre || '')
      || (remotoCfg.sub || '') !== (cfg.sub || '')
      || (remotoCfg.footer || '') !== (cfg.footer || '')
      || (remotoCfg.logo || '') !== (cfg.logo || '');
    if (cambioCfg) {
      cfg.nombre = remotoCfg.nombre || cfg.nombre;
      cfg.sub = remotoCfg.sub || cfg.sub;
      cfg.footer = remotoCfg.footer || cfg.footer;
      cfg.logo = remotoCfg.logo || null;
      if (typeof saveCfg === 'function') saveCfg();
      if (typeof applyCfg === 'function') applyCfg();
      cambios++;
    }
  }

  localStorage.setItem(SYNC_META_KEY, respuesta.timestamp || new Date().toISOString());

  if (cambios > 0) {
    if (typeof saveJDB === 'function') saveJDB();
    if (typeof saveEDB === 'function') saveEDB();
    if (typeof savePDB === 'function') savePDB();
    if (typeof saveAds === 'function') saveAds();
    // Mismo motivo que en scoutSincronizarAlAbrir(): el "stats" de cada
    // jugador/equipo que trae el Sheet es solo la foto de cuando se
    // guardó por última vez SU PROPIA ficha — no se actualiza solo
    // porque aquí también haya llegado un partido nuevo. sync completo
    // es justo el que más hace falta esto, porque trae SIEMPRE la
    // lista entera (incluidos partidos añadidos desde otro dispositivo
    // sin pasar por "Editar Equipo"/"Editar Jugador"), así que
    // recalculamos aquí también antes de pintar nada.
    if (typeof recalcularStatsDesdePartidos === 'function') recalcularStatsDesdePartidos();
    if (typeof sincronizarTacticaDesdePartidos === 'function') sincronizarTacticaDesdePartidos();
    if (typeof renderJDB === 'function') renderJDB();
    if (typeof renderEDB === 'function') renderEDB();
    if (typeof renderBannerAdsGlobal === 'function') renderBannerAdsGlobal();
    if (typeof currentSection !== 'undefined' && currentSection === 'partidos' && typeof renderPartidos === 'function') renderPartidos();
    if (typeof currentSection !== 'undefined' && currentSection === 'inicio' && typeof renderInicio === 'function') renderInicio();
    _scoutToast(`☁️ ${cambios} elemento${cambios !== 1 ? 's' : ''} sincronizado${cambios !== 1 ? 's' : ''}`);
  } else {
    if (!silencioso) _scoutToast('✅ Todo actualizado');
  }

  if (btn) { btn.textContent = '🔄'; btn.disabled = false; }
}



// Antes esto se disparaba solo a los 1.2s de cargar la página — es decir,
// justo mientras el usuario está escribiendo el usuario/contraseña. En
// móviles con conexión lenta, esa sincronización de fondo competía por
// la red con el propio envío del login, y todo se sentía lento.
// Ahora esperamos a que el login haya terminado (ver window.scoutSyncInicial,
// llamado desde el bloque de login en index.html) para no interferir.
window.scoutSyncInicial = async function scoutSyncInicial() {
  // Si el localStorage está vacío (dispositivo nuevo), traer todo del Sheet
  const tieneJugadores = localStorage.getItem('scout_j_v1');
  const tieneEquipos   = localStorage.getItem('scout_e_v1');
  const estaVacio = (!tieneJugadores || tieneJugadores === '[]') &&
                    (!tieneEquipos   || tieneEquipos   === '[]');

  if (estaVacio) {
    // Dispositivo nuevo: sync completo automático (con mensajes, para
    // que se note que está trayendo todos los datos por primera vez)
    await scoutSyncCompleto(false);
  } else {
    // Dispositivo conocido: TAMBIÉN sync completo (en silencio) — no el
    // incremental scoutSincronizarAlAbrir(). Ver el comentario grande
    // encima de scoutSincronizarAlAbrir() para el motivo: solo el sync
    // completo trae el listado actual entero, así que es el único que
    // puede darse cuenta de que algo se borró en otro dispositivo y
    // quitarlo también de aquí.
    await scoutSyncCompleto(true);
  }
  await scoutProcesarCola();
};
