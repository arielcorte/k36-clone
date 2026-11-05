import { SYSTEMS } from './systems.js';

// ---------- Constantes ----------
const PREFERRED = ['gba', 'gbc', 'gb', 'snes', 'sfc', 'nes', 'megadrive', 'genesis', 'mastersystem', 'gamegear',
  'psx', 'neogeo', 'arcade', 'mame2003', 'fbneo', 'mame', 'pcengine', 'n64', 'nds', 'psp', 'dreamcast'];
const WEAK = new Set(['psp', 'nds', 'dreamcast', 'n64', 'saturn', 'ps2', 'gamecube', 'wii', '3ds', 'naomi', 'atomiswave']);
const SKIP_DIRS = new Set(['images', 'videos', 'manuals', 'downloaded_images', 'downloaded_videos', 'media', 'thumbnails', '.tmp']);
const SKIP_FILES = new Set(['_info.txt', 'gamelist.xml', 'readme.txt', 'lisez-moi.txt']);
const SAVE_RE = /\.(srm|sav|rtc|eep|sra|fla|mpk|mcd|mcr|dsv|ppst|state(\d+|\.auto)?)(\.png)?$/i;
const FAT32_MAX = 4 * 1024 ** 3 - 1;

const $ = (s) => document.querySelector(s);
const card = { root: null, roms: null, downloads: null, saves: null, systems: [] };
let busy = false;

// ---------- Utilidades ----------
const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
const baseOf = (name) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name);
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const sysName = (folder) => (SYSTEMS.find((s) => s[0] === folder) || [folder, folder])[1];
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}

function status(el, html, kind = '') {
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = html;
}

function explainError(e) {
  const n = e?.name || '';
  if (n === 'QuotaExceededError') return 'La tarjeta se quedó sin espacio.';
  if (n === 'NotFoundError') return 'No encontré el archivo o la carpeta. ¿Se desconectó la tarjeta?';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'El navegador no dio permiso. Volvé a elegir la unidad GAMES y tocá Permitir.';
  if (n === 'NoModificationAllowedError' || n === 'InvalidModificationError') return 'No se pudo escribir. ¿La tarjeta está protegida contra escritura (traba lateral del adaptador)?';
  if (n === 'InvalidStateError') return 'La tarjeta cambió mientras trabajaba. Volvé a elegirla.';
  return `Error inesperado: ${e?.message || e}. Puede que la tarjeta esté llena o se haya desconectado.`;
}

async function getDir(parent, name, create = false) {
  if (!parent) return null;
  try { return await parent.getDirectoryHandle(name, { create }); } catch { return null; }
}

async function fileExists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch { return false; }
}

// Recorre una carpeta y devuelve {dir, path, name, handle} de cada archivo.
async function* walk(dir, path = [], skipMedia = true) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory') {
      if (skipMedia && SKIP_DIRS.has(name.toLowerCase())) continue;
      if (name === 'System Volume Information') continue;
      yield* walk(h, [...path, name], skipMedia);
    } else {
      yield { dir, path, name, handle: h };
    }
  }
}

async function dirAt(base, path) {
  let d = base;
  for (const p of path) { d = await getDir(d, p); if (!d) return null; }
  return d;
}

function guardUnload(on) {
  busy = on;
  window.onbeforeunload = on ? () => 'Hay una copia en curso.' : null;
}

// ---------- ZIP sin compresión (las partidas ya son chicas) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(ms) {
  const d = new Date(ms);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
function makeZip(entries) { // entries: [{path, data: Uint8Array, mtime}]
  const enc = new TextEncoder();
  const parts = []; const central = []; let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const crc = crc32(e.data); const { time, date } = dosTime(e.mtime);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(8, 0, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, e.data.length, true); h.setUint32(22, e.data.length, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h, name, e.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, e.data.length, true); c.setUint32(24, e.data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(c, name);
    offset += 30 + name.length + e.data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
const today = () => new Date().toLocaleDateString('sv');  // AAAA-MM-DD en hora local

// ---------- Paso 1: elegir la tarjeta ----------
async function checkBrowser() {
  if ('showDirectoryPicker' in window) return true;
  $('#browser-warning').hidden = false;
  if (navigator.brave && (await navigator.brave.isBrave().catch(() => false))) $('#brave-tip').hidden = false;
  $('#pick-root').disabled = true;
  return false;
}

async function pick(id) {
  try {
    return await window.showDirectoryPicker({ id, mode: 'readwrite' });
  } catch (e) {
    if (e.name === 'AbortError') return null;
    throw e;
  }
}

async function onPickRoot() {
  const st = $('#card-status');
  let h;
  try {
    h = await pick('k36-games');
  } catch (e) {
    status(st, `<b>No se pudo abrir.</b> ${esc(explainError(e))} Probá con el botón Elegir la carpeta roms, más abajo.`, 'bad');
    $('#pick-fallback').hidden = false;
    return;
  }
  if (!h) return;
  const roms = await getDir(h, 'roms');
  if (!roms) {
    if (h.name.toLowerCase() === 'roms') return useCard(null, h);
    status(st, `<b>Esa no es la unidad GAMES.</b> En ${esc(h.name || 'la carpeta elegida')} no hay una carpeta <code>roms</code>. En la ventana, abrí Este equipo y elegí la unidad que se llama GAMES.`, 'bad');
    $('#pick-fallback').hidden = false;
    return;
  }
  await useCard(h, roms);
}

async function onPickRoms() {
  let h;
  try { h = await pick('k36-roms'); } catch (e) { return toast(explainError(e), 'bad'); }
  if (!h) return;
  if (h.name.toLowerCase() !== 'roms' && !(await getDir(h, 'gba')) && !(await getDir(h, 'snes'))) {
    return status($('#card-status'), `<b>Esa no es la carpeta roms.</b> ${esc(h.name)} no tiene carpetas de consolas adentro.`, 'bad');
  }
  await useCard(null, h);
}

async function useCard(root, roms) {
  const st = $('#card-status');
  status(st, 'Revisando la tarjeta…');
  card.root = root; card.roms = roms;
  card.downloads = await getDir(root, 'downloads');
  card.saves = await getDir(root, 'saves');
  const folders = new Set();
  for await (const [name, h] of roms.entries()) if (h.kind === 'directory') folders.add(name);
  card.systems = SYSTEMS.filter((s) => folders.has(s[0]));
  if (!card.systems.length) {
    return status(st, '<b>No encontré consolas.</b> La carpeta <code>roms</code> no tiene carpetas como <code>gba</code> o <code>snes</code>. ¿Es la tarjeta de la consola?', 'bad');
  }
  const savesNote = card.root
    ? (card.saves
      ? 'También están las carpetas de partidas, <code>downloads/</code> y <code>saves/</code>.'
      : 'No hay carpeta <code>saves/</code>. Las partidas de los juegos (en <code>downloads/</code>) se respaldan igual, pero los estados guardados quedan en una partición que Windows no puede leer.')
    : 'Elegiste solo <code>roms</code>. Para respaldar partidas, la página te va a pedir las otras carpetas.';
  status(st, `<p><b>Tarjeta lista.</b> Tiene carpetas para ${card.systems.length} consolas.</p><p>${savesNote}</p>`, 'ok');
  $('#pick-root').textContent = 'Elegir otra unidad';
  $('#paso-2').hidden = false;
  $('#paso-3').hidden = false;
  fillRemoveSystems();
  $('#paso-2').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- Pestañas ----------
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.dataset.panel !== name));
}

// ---------- Agregar juegos ----------
const queue = [];
const lastChoice = JSON.parse(localStorage.getItem('k36-last-choice') || '{}');

function candidatesFor(ext) {
  const c = card.systems.filter((s) => s[2].includes(ext)).map((s) => s[0]);
  return c.sort((a, b) => {
    const ia = PREFERRED.indexOf(a), ib = PREFERRED.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || sysName(a).localeCompare(sysName(b), 'es');
  });
}

const baseName = (path) => path.split(/[\\/]/).pop();
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const DISC_EXTS = new Set(['bin', 'iso', 'img']);

// Lee el comienzo de un disco y reconoce la consola por la firma que trae grabada.
async function sniffDisc(file) {
  const text = new TextDecoder('latin1').decode(await file.slice(0, 20 * 2352).arrayBuffer());
  if (text.includes('SEGADISCSYSTEM')) return 'segacd';
  if (text.includes('SEGA SEGASATURN')) return 'saturn';
  if (text.includes('PSP GAME')) return 'psp';
  if (text.includes('PLAYSTATION')) return 'psx';
  return null;
}

async function addFiles(files) {
  const added = [];
  for (const file of files) {
    if (queue.some((q) => q.file.name === file.name && q.file.size === file.size)) continue;
    const ext = extOf(file.name);
    const item = { file, ext, candidates: candidatesFor(ext), system: null, state: 'pending', msg: '', refs: [], owner: null };
    if (file.size > FAT32_MAX) { item.state = 'error'; item.msg = 'Pesa más de 4 GB y la tarjeta (FAT32) no admite archivos tan grandes.'; }
    else if (!item.candidates.length) { item.state = 'error'; item.msg = `Ninguna consola de la tarjeta usa archivos .${ext || '(sin extensión)'}.`; }
    else if (item.candidates.length === 1) item.system = item.candidates[0];
    if (['cue', 'm3u'].includes(ext)) {
      const text = await file.text();
      item.refs = (ext === 'cue'
        ? [...text.matchAll(/FILE\s+"([^"]+)"/gi)].map((m) => m[1])
        : text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))).map(baseName);
    }
    queue.push(item);
    added.push(item);
  }
  linkDiscFiles();
  for (const item of added.filter((q) => q.state === 'pending' && !q.system && !q.owner)) {
    const disc = item.ext === 'cue'
      ? queue.find((q) => item.refs[0] && sameName(q.file.name, item.refs[0]))
      : DISC_EXTS.has(item.ext) ? item : null;
    const found = disc && (await sniffDisc(disc.file));
    if (item.candidates.includes(found)) item.system = found;
    else if (item.candidates.includes(lastChoice[item.ext])) item.system = lastChoice[item.ext];
  }
  linkDiscFiles();
  renderQueue();
}

// Los .bin de un .cue (y los discos de un .m3u) van a la misma consola que el índice.
function linkDiscFiles() {
  for (const owner of queue.filter((q) => q.refs.length)) {
    for (const part of queue.filter((q) => q !== owner && owner.refs.some((r) => sameName(r, q.file.name)))) {
      if (part.owner && part.owner !== owner) continue;
      part.owner = owner;
      part.system = owner.system;
    }
  }
}

function itemWarning(item) {
  if (item.state === 'error') return '';
  const notes = [];
  if (item.system && WEAK.has(item.system)) notes.push(`Los juegos de ${sysName(item.system)} suelen andar mal en esta consola.`);
  const missing = item.refs.filter((r) => !queue.some((q) => sameName(q.file.name, r)));
  if (missing.length && item.ext === 'cue') notes.push(`Este .cue necesita también ${missing.join(', ')}. Agregalos en el mismo paso.`);
  if (['zip', '7z'].includes(item.ext) && item.state === 'pending') notes.push(`Si es un juego de PlayStation (o de otra consola de discos), no lo cargues comprimido: la consola no lo va a reconocer. Descomprimilo y agregá el .cue con sus .bin, o convertilo a .chd.`);
  return notes.join(' ');
}

function renderQueue() {
  const box = $('#queue');
  box.innerHTML = '';
  queue.forEach((item, i) => {
    const el = document.createElement('li');
    const needs = item.state === 'pending' && !item.system && !item.owner;
    if (needs) el.className = 'needs';
    let right = '';
    if (item.state === 'pending' && item.candidates.length > 1 && !item.owner) {
      right = `<select data-i="${i}" aria-label="Consola de ${esc(item.file.name)}"><option value="">¿De qué consola es?</option>${item.candidates
        .map((c) => `<option value="${c}" ${c === item.system ? 'selected' : ''}>${esc(sysName(c))}</option>`).join('')}</select>`;
    }
    if (item.state === 'pending' || item.state === 'error') right += ` <button class="x" data-del="${i}">Quitar</button>`;
    const stateText = {
      pending: item.owner
        ? (item.system ? `Va con ${item.owner.file.name} a ${sysName(item.system)}` : `Va con ${item.owner.file.name}: elegí la consola ahí`)
        : (item.system ? `Va a ${sysName(item.system)}` : 'Elegí la consola'),
      copying: 'Copiando…', done: `Copiado a roms/${item.system}/`, skipped: 'Salteado: ya estaba en la tarjeta', error: item.msg,
    }[item.state];
    const warn = itemWarning(item);
    el.innerHTML = `<div><div class="name">${esc(item.file.name)}</div>
      <div class="sub ${item.state === 'error' || needs ? 'bad' : ''}">${fmtSize(item.file.size)} · ${esc(stateText)}</div></div>
      <div>${right}</div>${warn ? `<div class="warn">${esc(warn)}</div>` : ''}
      ${['copying', 'done'].includes(item.state) ? `<div class="bar-k36"><i style="width:${item.state === 'done' ? 100 : item.progress || 0}%"></i></div>` : ''}`;
    item.el = el;
    box.append(el);
  });
  const pending = queue.filter((q) => q.state === 'pending');
  const ready = pending.filter((q) => q.system);
  $('#queue-actions').hidden = !queue.length;
  $('#copy-all').disabled = busy || !ready.length;
  const total = ready.reduce((s, q) => s + q.file.size, 0);
  $('#queue-summary').textContent = pending.length
    ? `${ready.length} de ${pending.length} listos (${fmtSize(total)})${ready.length < pending.length ? ' · falta elegir la consola de algunos' : ''}`
    : '';
}

async function copyOne(item) {
  const dir = await getDir(card.roms, item.system, true);
  const existed = await fileExists(dir, item.file.name);
  item.existed = existed;
  let writable;
  try {
    const fh = await dir.getFileHandle(item.file.name, { create: true });
    writable = await fh.createWritable();
    const reader = item.file.stream().getReader();
    let done = 0, lastPaint = 0;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      await writable.write(value);
      done += value.byteLength;
      item.progress = Math.round((done / item.file.size) * 100);
      if (Date.now() - lastPaint > 150) { item.el.querySelector('.bar-k36 i').style.width = `${item.progress}%`; lastPaint = Date.now(); }
    }
    await writable.close();
    item.state = 'done';
  } catch (e) {
    try { await writable?.abort(); } catch {}
    if (!existed) { try { await dir.removeEntry(item.file.name); } catch {} }
    item.state = 'error';
    item.msg = explainError(e);
  }
}

async function onCopyAll() {
  const ready = queue.filter((q) => q.state === 'pending' && q.system);
  if (!ready.length) return;
  const conflicts = [];
  for (const q of ready) {
    const dir = await getDir(card.roms, q.system);
    if (dir && (await fileExists(dir, q.file.name))) conflicts.push(q);
  }
  if (conflicts.length) {
    const replace = confirm(`${conflicts.length} juego(s) ya están en la tarjeta:\n\n${conflicts.slice(0, 8).map((q) => '• ' + q.file.name).join('\n')}${conflicts.length > 8 ? '\n…' : ''}\n\n¿Reemplazarlos?\nAceptar = reemplazar · Cancelar = saltearlos`);
    if (!replace) conflicts.forEach((q) => (q.state = 'skipped'));
  }
  guardUnload(true);
  renderQueue();
  let ok = 0, bad = 0;
  // Primero los .bin y después su .cue: si falta espacio para el disco, no queda un .cue suelto en la tarjeta.
  const order = ready.filter((q) => q.state === 'pending').sort((a, b) => (b.owner ? 1 : 0) - (a.owner ? 1 : 0));
  for (const item of order) {
    if (item.state !== 'pending') continue;
    const parts = queue.filter((q) => q.owner === item);
    if (parts.some((q) => q.state === 'error')) {
      item.state = 'error'; item.msg = 'No se copió porque faltaron archivos del disco.'; bad++;
      continue;
    }
    item.state = 'copying';
    renderQueue();
    await copyOne(item);
    item.state === 'done' ? ok++ : bad++;
    renderQueue();
    if (item.state === 'error' && /espacio|llena/.test(item.msg)) {
      queue.filter((q) => q.state === 'pending').forEach((q) => { q.state = 'error'; q.msg = 'No se copió porque la tarjeta se llenó.'; });
      break;
    }
  }
  // Si un disco quedó a medias, borrar las partes que sí se copiaron para no dejar juegos rotos.
  for (const owner of queue.filter((q) => q.refs.length && q.state === 'error')) {
    for (const part of queue.filter((q) => q.owner === owner && q.state === 'done' && !q.existed)) {
      try { await (await getDir(card.roms, part.system)).removeEntry(part.file.name); } catch {}
      part.state = 'error'; part.msg = 'Se borró de la tarjeta porque el disco no entró completo.';
    }
  }
  guardUnload(false);
  renderQueue();
  ok = ready.filter((q) => q.state === 'done').length;
  bad = ready.filter((q) => q.state === 'error').length;
  if (bad) toast(`Se copiaron ${ok} archivo(s), pero ${bad} fallaron. Mirá los mensajes en rojo.`, 'bad');
  else toast(`Listo: se copiaron ${ok} archivo(s). Cuando termines, expulsá la tarjeta (paso 3).`, 'ok');
}

// ---------- Quitar juegos ----------
let games = []; const selected = new Set(); let scanToken = 0;

function fillRemoveSystems() {
  const sel = $('#remove-system');
  sel.innerHTML = '<option value="">Elegí una consola</option>' + card.systems
    .slice().sort((a, b) => a[1].localeCompare(b[1], 'es'))
    .map((s) => `<option value="${s[0]}">${esc(s[1])} (${s[0]})</option>`).join('');
}

async function scanSystem(folder) {
  const token = ++scanToken;
  games = []; selected.clear(); renderGames();
  const info = $('#remove-status');
  const sys = SYSTEMS.find((s) => s[0] === folder);
  const exts = new Set(sys[2]);
  const found = [];
  const sources = [['roms', await getDir(card.roms, folder)], ['downloads', await getDir(card.downloads, folder)]];
  let n = 0;
  for (const [where, dir] of sources) {
    if (!dir) continue;
    for await (const f of walk(dir)) {
      if (token !== scanToken) return;
      if (SKIP_FILES.has(f.name.toLowerCase()) || !exts.has(extOf(f.name)) || SAVE_RE.test(f.name)) continue;
      found.push({ ...f, where, key: `${where}/${[...f.path, f.name].join('/')}`, parts: [] });
      if (++n % 200 === 0) info.textContent = `Buscando juegos… van ${n}.`;
    }
  }
  // Agrupa los .bin que pertenecen a un .cue/.m3u de la misma carpeta.
  const hidden = new Set();
  for (const g of found.filter((x) => ['cue', 'm3u'].includes(extOf(x.name)))) {
    try {
      const text = await (await g.handle.getFile()).text();
      const refs = extOf(g.name) === 'cue'
        ? [...text.matchAll(/FILE\s+"([^"]+)"/gi)].map((m) => m[1])
        : text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      for (const r of refs) {
        const part = found.find((x) => x.dir === g.dir && x.name === r);
        if (part) { g.parts.push(part); hidden.add(part.key); }
      }
    } catch {}
  }
  if (token !== scanToken) return;
  games = found.filter((g) => !hidden.has(g.key)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  info.textContent = games.length ? `${games.length} juegos en ${sysName(folder)}.` : `No hay juegos en ${sysName(folder)}.`;
  $('#remove-search').disabled = !games.length;
  renderGames();
}

function renderGames() {
  const q = norm($('#remove-search').value.trim());
  const list = $('#game-list');
  const shown = games.filter((g) => !q || norm(g.name).includes(q) || norm(g.path.join('/')).includes(q));
  const LIMIT = 400;
  list.innerHTML = shown.slice(0, LIMIT).map((g) => {
    const where = [g.where === 'downloads' ? 'agregado desde la consola' : '', g.path.join('/'), g.parts.length ? `${g.parts.length + 1} archivos` : '']
      .filter(Boolean).join(' · ');
    return `<li><label><input type="checkbox" data-key="${esc(g.key)}" ${selected.has(g.key) ? 'checked' : ''}>
      <span><span class="name">${esc(g.name)}</span>${where ? `<br><span class="sub">${esc(where)}</span>` : ''}</span></label></li>`;
  }).join('') + (shown.length > LIMIT ? `<li class="sub">Se muestran ${LIMIT} de ${shown.length}. Usá el buscador para encontrar el resto.</li>` : '');
  $('#remove-actions').hidden = !games.length;
  $('#remove-go').disabled = busy || !selected.size;
  $('#remove-summary').textContent = selected.size ? `${selected.size} seleccionado(s)` : '';
}

// Partidas de un juego: mismo nombre base, en roms/, downloads/ y saves/.
async function savesFor(game, folder) {
  const base = baseOf(game.name);
  const out = [];
  const places = [
    ['roms', await dirAt(await getDir(card.roms, folder), game.path)],
    ['downloads', await dirAt(await getDir(card.downloads, folder), game.path)],
    ['saves', await getDir(card.saves, folder)],
  ];
  for (const [where, dir] of places) {
    if (!dir) continue;
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'file' && name.startsWith(base + '.') && SAVE_RE.test(name)) {
        const rel = where === 'saves' ? [where, folder, name] : [where, folder, ...game.path, name];
        out.push({ dir, name, handle: h, rel: rel.join('/') });
      }
    }
  }
  return out;
}

async function onRemove() {
  const folder = $('#remove-system').value;
  const chosen = games.filter((g) => selected.has(g.key));
  if (!chosen.length) return;
  const wantBackup = $('#remove-backup').checked;
  const wantSaves = $('#remove-saves').checked;
  const msg = `¿Borrar ${chosen.length} juego(s) de ${sysName(folder)}?\n\n${chosen.slice(0, 8).map((g) => '• ' + g.name).join('\n')}${chosen.length > 8 ? '\n…' : ''}\n\n${wantSaves ? 'También se van a borrar sus partidas.' : 'Sus partidas quedan en la tarjeta.'}\nEsto no se puede deshacer.`;
  if (!confirm(msg)) return;
  guardUnload(true); renderGames();
  const info = $('#remove-status');
  try {
    const saves = [];
    for (const g of chosen) saves.push(...(await savesFor(g, folder)));
    if (wantBackup && saves.length) {
      info.textContent = `Guardando una copia de ${saves.length} partida(s)…`;
      const entries = [];
      for (const s of saves) { const f = await s.handle.getFile(); entries.push({ path: s.rel, data: new Uint8Array(await f.arrayBuffer()), mtime: f.lastModified }); }
      download(makeZip(entries), `partidas-${folder}-${today()}.zip`);
    }
    let removed = 0; const failed = [];
    for (const g of chosen) {
      try {
        for (const p of g.parts) await p.dir.removeEntry(p.name);
        await g.dir.removeEntry(g.name);
        removed++;
      } catch (e) { failed.push(`${g.name}: ${explainError(e)}`); }
    }
    if (wantSaves) for (const s of saves) { try { await s.dir.removeEntry(s.name); } catch {} }
    const backupNote = wantBackup && saves.length ? ` Se descargó una copia de ${saves.length} partida(s) en tu carpeta Descargas.` : '';
    if (failed.length) toast(`Se borraron ${removed}, fallaron ${failed.length}: ${failed[0]}`, 'bad');
    else toast(`Se borraron ${removed} juego(s).${backupNote}`, 'ok');
  } catch (e) {
    toast(explainError(e), 'bad');
  }
  guardUnload(false);
  await scanSystem(folder);
}

// ---------- Respaldar partidas ----------
async function ensureSaveDirs() {
  if (card.root) return true;
  toast('Elegí la carpeta downloads de la unidad GAMES (o Cancelar si no existe).');
  try { card.downloads = card.downloads || (await pick('k36-downloads')); } catch {}
  toast('Ahora elegí la carpeta saves de la unidad GAMES (o Cancelar si no existe).');
  try { card.saves = card.saves || (await pick('k36-saves')); } catch {}
  return true;
}

async function onBackup() {
  const st = $('#backup-status');
  await ensureSaveDirs();
  guardUnload(true); $('#backup-go').disabled = true;
  try {
    const found = [];
    const scan = async (where, dir, filter) => {
      if (!dir) return;
      let n = 0;
      for await (const f of walk(dir, [], where !== 'saves')) {
        if (++n % 300 === 0) status(st, `Revisando <code>${where}/</code>: ${n} archivos, ${found.length} partidas encontradas.`);
        if (filter(f.name)) found.push({ ...f, rel: [where, ...f.path, f.name].join('/') });
      }
    };
    status(st, 'Revisando <code>saves/</code>…');
    await scan('saves', card.saves, (n) => !SKIP_FILES.has(n.toLowerCase()));
    status(st, 'Revisando <code>downloads/</code>…');
    await scan('downloads', card.downloads, (n) => SAVE_RE.test(n));
    status(st, 'Revisando <code>roms/</code>. Con muchos juegos puede tardar un par de minutos.');
    await scan('roms', card.roms, (n) => SAVE_RE.test(n));
    if (!found.length) {
      status(st, '<b>No hay partidas.</b> No encontré partidas guardadas en la tarjeta. Si recién empezaste a jugar, puede que todavía no haya ninguna.');
    } else {
      status(st, `Armando el .zip con ${found.length} archivos…`);
      const entries = []; let total = 0;
      for (const f of found) {
        const file = await f.handle.getFile();
        total += file.size;
        entries.push({ path: f.rel, data: new Uint8Array(await file.arrayBuffer()), mtime: file.lastModified });
      }
      const name = `partidas-k36-${today()}.zip`;
      download(makeZip(entries), name);
      const bySys = {};
      for (const f of found) { const s = f.rel.split('/')[1] || '?'; bySys[s] = (bySys[s] || 0) + 1; }
      status(st, `<p><b>Copia lista.</b> ${found.length} archivos (${fmtSize(total)}) en ${name}, en la carpeta Descargas.</p>
        <p class="note">${Object.entries(bySys).sort().map(([s, n]) => `${esc(sysName(s))}: ${n}`).join(' · ')}</p>`, 'ok');
      toast('Se descargó la copia de las partidas.', 'ok');
    }
  } catch (e) {
    status(st, `<b>No se pudo.</b> ${esc(explainError(e))}`, 'bad');
  }
  guardUnload(false); $('#backup-go').disabled = false;
}

// ---------- Eventos ----------
$('#pick-root').addEventListener('click', onPickRoot);
$('#pick-roms').addEventListener('click', onPickRoms);
document.querySelectorAll('.tabs button').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

const drop = $('#drop');
$('#file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('#file-input').click(); });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });

$('#queue').addEventListener('change', (e) => {
  if (!e.target.matches('select')) return;
  const item = queue[+e.target.dataset.i];
  item.system = e.target.value || null;
  if (item.system) {
    lastChoice[item.ext] = item.system;
    localStorage.setItem('k36-last-choice', JSON.stringify(lastChoice));
    for (const q of queue) {
      if (q.state === 'pending' && !q.system && !q.owner && q.ext === item.ext && q.candidates.includes(item.system)) q.system = item.system;
    }
  }
  linkDiscFiles(); renderQueue();
});
$('#queue').addEventListener('click', (e) => {
  const i = e.target.dataset.del;
  if (i === undefined) return;
  const [gone] = queue.splice(+i, 1);
  for (const q of queue.filter((q) => q.owner === gone)) { q.owner = null; q.system = q.candidates.length === 1 ? q.candidates[0] : null; }
  linkDiscFiles(); renderQueue();
});
$('#copy-all').addEventListener('click', onCopyAll);
$('#clear-queue').addEventListener('click', () => {
  if (busy) return;
  queue.splice(0, queue.length); renderQueue();
});

$('#remove-system').addEventListener('change', (e) => { if (e.target.value) scanSystem(e.target.value); else { games = []; renderGames(); } });
$('#remove-search').addEventListener('input', renderGames);
$('#game-list').addEventListener('change', (e) => {
  const k = e.target.dataset.key;
  if (!k) return;
  e.target.checked ? selected.add(k) : selected.delete(k);
  $('#remove-go').disabled = busy || !selected.size;
  $('#remove-summary').textContent = selected.size ? `${selected.size} seleccionado(s)` : '';
});
$('#remove-go').addEventListener('click', onRemove);
$('#backup-go').addEventListener('click', onBackup);

checkBrowser();
