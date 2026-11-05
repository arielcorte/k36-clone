import { SYSTEMS } from './systems.js';
import * as S from './scraper.js';
import * as G from './gamelist.js';

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
      copying: 'Copiando…', done: `Copiado a roms/${item.system}/${item.art ? ' · ' + item.art : ''}`, skipped: 'Salteado: ya estaba en la tarjeta', error: item.msg,
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
  const wantArt = $('#add-scrape').checked;
  if (wantArt) S.prepareTranslator('en');
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
  if (wantArt) await scrapeCopied(ready);
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
  const opts = '<option value="">Elegí una consola</option>' + card.systems
    .slice().sort((a, b) => a[1].localeCompare(b[1], 'es'))
    .map((s) => `<option value="${s[0]}">${esc(s[1])} (${s[0]})</option>`).join('');
  $('#remove-system').innerHTML = opts;
  $('#art-system').innerHTML = opts;
}

async function scanSystem(folder) {
  const token = ++scanToken;
  games = []; selected.clear(); renderGames();
  const info = $('#remove-status');
  const found = await collectGames(folder, info, () => token === scanToken);
  if (!found) return;
  games = found;
  info.textContent = games.length ? `${games.length} juegos en ${sysName(folder)}.` : `No hay juegos en ${sysName(folder)}.`;
  $('#remove-search').disabled = !games.length;
  renderGames();
}

// Juegos de una consola, en roms/ y downloads/, con los .bin agrupados bajo su .cue. Devuelve null si se canceló.
async function collectGames(folder, info, current) {
  const sys = SYSTEMS.find((s) => s[0] === folder);
  const exts = new Set(sys[2]);
  const found = [];
  const sources = [['roms', await getDir(card.roms, folder)], ['downloads', await getDir(card.downloads, folder)]];
  let n = 0;
  for (const [where, dir] of sources) {
    if (!dir) continue;
    for await (const f of walk(dir)) {
      if (!current()) return null;
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
  if (!current()) return null;
  return found.filter((g) => !hidden.has(g.key)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
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
    let removed = 0; const failed = []; const gone = [];
    for (const g of chosen) {
      try {
        for (const p of g.parts) await p.dir.removeEntry(p.name);
        await g.dir.removeEntry(g.name);
        removed++; gone.push(g);
      } catch (e) { failed.push(`${g.name}: ${explainError(e)}`); }
    }
    if (wantSaves) for (const s of saves) { try { await s.dir.removeEntry(s.name); } catch {} }
    let artNote = '';
    if (gone.length) {
      info.textContent = 'Borrando sus carátulas…';
      try {
        const n = await removeArt(folder, gone, games.filter((g) => !gone.includes(g)));
        if (n) artNote = ` También se borraron ${n} imagen(es) y video(s).`;
      } catch (e) { artNote = ` No pude borrar sus carátulas: ${e.message || explainError(e)}`; }
    }
    const backupNote = wantBackup && saves.length ? ` Se descargó una copia de ${saves.length} partida(s) en tu carpeta Descargas.` : '';
    if (failed.length) toast(`Se borraron ${removed}, fallaron ${failed.length}: ${failed[0]}`, 'bad');
    else toast(`Se borraron ${removed} juego(s).${artNote}${backupNote}`, 'ok');
  } catch (e) {
    toast(explainError(e), 'bad');
  }
  guardUnload(false);
  await scanSystem(folder);
}


// ---------- Carátulas y datos (gamelist.xml) ----------
async function sysDirsFor(folder, create = false) {
  return { roms: await getDir(card.roms, folder, create), downloads: await getDir(card.downloads, folder) };
}

// Guarda una imagen como lo hace Batocera: images/<juego>-<sufijo>.<ext>. Devuelve la ruta para el gamelist.
async function writeMedia(sysDirs, stem, kind, img) {
  const dir = await getDir(sysDirs.roms, 'images', true);
  const suffix = G.SUFFIX[kind];
  const dlImages = await getDir(sysDirs.downloads, 'images');
  for (const ext of ['png', 'jpg', 'jpeg']) {
    const old = `${stem}-${suffix}.${ext}`;
    if (ext !== img.ext) { try { await dir.removeEntry(old); } catch {} }
    // Una imagen con el mismo nombre en downloads/ taparía la nueva.
    if (dlImages) { try { await dlImages.removeEntry(old); } catch {} }
  }
  const name = `${stem}-${suffix}.${img.ext}`;
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(img.blob); await w.close();
  return `./images/${name}`;
}

async function deleteMedia(sysDirs, folder, mediaPath) {
  let n = 0;
  for (let i = 0; i < 2; i++) {
    const f = await G.resolveMedia(sysDirs, mediaPath, folder);
    if (!f) break;
    try { await f.dir.removeEntry(f.name); n++; } catch { break; }
  }
  return n;
}

// Al quitar juegos: su entrada del gamelist, las imágenes que figuran ahí y las que siguen la convención de nombres.
async function removeArt(folder, gone, remaining) {
  const sysDirs = await sysDirsFor(folder);
  let n = 0;
  const gl = await G.openGamelist(folder, sysDirs);
  for (const g of gone) for (const m of G.removeEntry(gl, [...g.path, g.name].join('/'))) n += await deleteMedia(sysDirs, folder, m);
  await G.saveGamelist(gl);
  const keep = new Set(remaining.map((g) => baseOf(g.name).toLowerCase()));
  const stems = [...new Set(gone.map((g) => baseOf(g.name).toLowerCase()))].filter((st) => !keep.has(st));
  if (!stems.length) return n;
  const suffixes = Object.values(G.SUFFIX).join('|');
  for (const base of [sysDirs.roms, sysDirs.downloads]) {
    for (const dname of G.MEDIA_DIRS) {
      const d = await getDir(base, dname);
      if (!d) continue;
      const names = [];
      for await (const [name, h] of d.entries()) if (h.kind === 'file') names.push(name);
      for (const name of names) {
        const low = name.toLowerCase();
        const st = stems.find((x) => low.startsWith(x) && new RegExp(`^(-(${suffixes}))?\\.[a-z0-9]+$`).test(low.slice(x.length)));
        if (st) { try { await d.removeEntry(name); n++; } catch {} }
      }
    }
  }
  return n;
}

// Busca y escribe carátulas y datos de un juego. Con keep, no pisa lo que ya tiene.
async function scrapeGame(folder, sysDirs, gl, relPath, file, { wiki = true, keep = false, onStatus } = {}) {
  const fileName = relPath.split('/').pop();
  const hit = await S.identify(folder, fileName, file, onStatus);
  if (!hit) return null;
  const old = (keep && G.getMeta(gl, relPath)) || {};
  const meta = S.metaFrom(hit.rec);
  const stem = baseOf(fileName);
  for (const kind of ['image', 'thumbnail', 'marquee']) {
    if (old[kind]) continue;
    const img = await S.fetchImage(S.thumbUrls(folder, hit.rec, kind), kind);
    if (img) meta[kind] = await writeMedia(sysDirs, stem, kind, img);
  }
  if (wiki && !old.desc) {
    const d = await S.wikiDescription(meta.name, sysName(folder));
    if (d) meta.desc = d.text;
  }
  for (const k of Object.keys(meta)) if (old[k]) delete meta[k];
  G.setMeta(gl, relPath, meta);
  return { name: meta.name || old.name || S.cleanName(hit.rec), images: ['image', 'thumbnail', 'marquee'].filter((k) => meta[k]).length };
}

// Después de copiar: carátula y datos de cada juego nuevo, consola por consola.
async function scrapeCopied(ready) {
  const items = ready.filter((q) => q.state === 'done' && !q.owner && S.canScrape(q.system));
  const bySys = new Map();
  for (const q of items) { if (!bySys.has(q.system)) bySys.set(q.system, []); bySys.get(q.system).push(q); }
  for (const [folder, list] of bySys) {
    let gl, sysDirs;
    try {
      sysDirs = await sysDirsFor(folder, true);
      gl = await G.openGamelist(folder, sysDirs);
    } catch (e) {
      list.forEach((q) => (q.art = `No se buscó la carátula: ${e.message}`));
      renderQueue();
      continue;
    }
    for (const q of list) {
      q.art = 'buscando la carátula…'; renderQueue();
      try {
        const disc = q.ext === 'cue' ? queue.find((p) => p.owner === q && sameName(p.file.name, q.refs[0] || '')) : null;
        const r = await scrapeGame(folder, sysDirs, gl, q.file.name, (disc || q).file, { onStatus: (m) => { q.art = m; renderQueue(); } });
        q.art = r ? `con carátula y datos de «${r.name}»` : 'no encontré su carátula (la podés poner en Carátulas y datos)';
      } catch (e) {
        q.art = `no se pudo buscar la carátula: ${e.message || e}`;
      }
      renderQueue();
    }
    try { await G.saveGamelist(gl); } catch (e) { list.forEach((q) => (q.art = `no se pudo guardar el gamelist.xml: ${explainError(e)}`)); }
    renderQueue();
  }
}

// ---------- Pestaña Carátulas y datos ----------
const art = { folder: '', games: [], gl: null, sysDirs: null, token: 0, stop: false, urls: [] };
const relOf = (g) => [...g.path, g.name].join('/');
const LANG_NAME = { pt: 'portugués', en: 'inglés', fr: 'francés', it: 'italiano', de: 'alemán' };

async function loadArt(folder) {
  const token = ++art.token;
  art.folder = folder; art.games = []; art.gl = null;
  renderArt();
  const info = $('#art-status');
  if (!folder) { info.textContent = ''; return; }
  const found = await collectGames(folder, info, () => token === art.token);
  if (!found) return;
  try {
    art.sysDirs = await sysDirsFor(folder);
    art.gl = await G.openGamelist(folder, art.sysDirs);
  } catch (e) {
    info.textContent = e.message || explainError(e);
    return;
  }
  art.games = found;
  updateArtStatus();
  $('#art-search').disabled = !found.length;
  renderArt();
}

function artInfo(g) {
  const m = art.gl && G.getMeta(art.gl, relOf(g));
  const lang = m?.desc ? S.guessLang(m.desc) : null;
  return { m, cover: m?.thumbnail || m?.image || '', lang };
}

function updateArtStatus() {
  const info = $('#art-status');
  if (!art.games.length) { info.textContent = art.folder ? `No hay juegos en ${sysName(art.folder)}.` : ''; return; }
  let noArt = 0, foreign = 0, noDesc = 0;
  for (const g of art.games) { const i = artInfo(g); if (!i.cover) noArt++; if (!i.m?.desc) noDesc++; if (i.lang && i.lang !== 'es') foreign++; }
  info.textContent = `${art.games.length} juegos en ${sysName(art.folder)}. ${noArt ? `${noArt} sin carátula.` : 'Todos tienen carátula.'}${noDesc ? ` ${noDesc} sin descripción.` : ''}${foreign ? ` ${foreign} con la descripción en otro idioma.` : ''}`
    + (S.canScrape(art.folder) ? '' : ' Para esta consola no hay búsqueda automática: se pueden editar a mano.');
  $('#art-fill').disabled = busy || !artTodo().length || !S.canScrape(art.folder);
  $('#art-translate').disabled = busy || !foreign;
}

const coverObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const img = e.target; coverObserver.unobserve(img);
    G.resolveMedia(art.sysDirs, img.dataset.media, art.folder).then(async (f) => {
      if (!f) return img.replaceWith(Object.assign(document.createElement('span'), { className: 'cover none', textContent: 'falta' }));
      const url = URL.createObjectURL(await f.handle.getFile());
      art.urls.push(url); img.src = url;
    }).catch(() => {});
  }
}, { rootMargin: '200px' });

function renderArt() {
  art.urls.forEach((u) => URL.revokeObjectURL(u)); art.urls = [];
  const q = norm($('#art-search').value.trim());
  const list = $('#art-list');
  const rows = art.games.map((g) => ({ g, ...artInfo(g) }))
    .filter(({ g, m }) => !q || norm(g.name).includes(q) || norm(m?.name || '').includes(q));
  const LIMIT = 300;
  list.innerHTML = rows.slice(0, LIMIT).map(({ g, m, cover, lang }, i) => {
    const notes = [!cover ? 'sin carátula' : '', !m?.desc ? 'sin descripción' : lang && lang !== 'es' ? `descripción en ${LANG_NAME[lang] || lang}` : ''].filter(Boolean);
    return `<li><span class="cover-box">${cover ? `<img class="cover" alt="" data-media="${esc(cover)}">` : '<span class="cover none">sin imagen</span>'}</span>
      <span><span class="name">${esc(m?.name || baseOf(g.name))}</span><br><span class="sub ${notes.length ? 'bad' : ''}">${esc([g.name, ...notes].join(' · '))}</span></span>
      <button class="btn" data-edit="${art.games.indexOf(g)}">Editar</button></li>`;
  }).join('') + (rows.length > LIMIT ? `<li class="sub">Se muestran ${LIMIT} de ${rows.length}. Usá el buscador para encontrar el resto.</li>` : '');
  list.querySelectorAll('img[data-media]').forEach((img) => coverObserver.observe(img));
  $('#art-tools').hidden = !art.games.length;
}

function artProgress(done, total, text) {
  const bar = $('#art-progress');
  bar.hidden = total === 0;
  bar.querySelector('i').style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
  if (text) $('#art-status').textContent = text;
}

function artBusy(on) {
  guardUnload(on);
  $('#art-stop').hidden = !on; $('#art-stop').disabled = false; art.stop = false;
  for (const id of ['#art-fill', '#art-translate', '#art-translate-all', '#art-system']) $(id).disabled = on;
  if (!on) updateArtStatus();
}

// Juegos a los que les falta la carátula, o la descripción si se pidió buscarla.
const artTodo = () => art.games.filter((g) => { const i = artInfo(g); return !i.cover || ($('#art-wiki').checked && !i.m?.desc); });

async function onArtFill() {
  S.prepareTranslator('en');
  const folder = art.folder, gl = art.gl, sysDirs = await sysDirsFor(folder, true);
  const todo = artTodo();
  if (!todo.length) return;
  artBusy(true);
  let done = 0, found = 0, next = 0;
  const wiki = $('#art-wiki').checked;
  const worker = async () => {
    while (next < todo.length && !art.stop) {
      const g = todo[next++];
      try {
        const file = await (g.parts[0] || g).handle.getFile();
        if (await scrapeGame(folder, sysDirs, gl, relOf(g), file, { wiki, keep: true, onStatus: (m) => artProgress(done, todo.length, m) })) found++;
      } catch {}
      done++;
      artProgress(done, todo.length, `Buscando: ${done} de ${todo.length}. Encontrados: ${found}.`);
      if (done % 20 === 0) await G.saveGamelist(gl).catch(() => {});
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  try { await G.saveGamelist(gl); } catch (e) { toast(`No se pudo guardar el gamelist.xml: ${explainError(e)}`, 'bad'); }
  artBusy(false); artProgress(0, 0);
  toast(`${art.stop ? 'Búsqueda detenida. ' : ''}Encontré datos de ${found} de ${done} juego(s).${found < done ? ' Los que faltan los podés completar con Editar.' : ''}`, found ? 'ok' : '');
  renderArt();
}

async function prepareTranslation() {
  if (!S.canTranslate()) {
    toast('Este navegador no trae el traductor incorporado. Abrí la página en Google Chrome 138 o más nuevo, en una computadora.', 'bad');
    return false;
  }
  const ok = await Promise.all([S.prepareTranslator('pt'), S.prepareTranslator('en')]);
  if (!ok.some(Boolean)) { toast('Chrome no pudo preparar el traductor. Probá de nuevo en un rato (la primera vez baja los idiomas).', 'bad'); return false; }
  return true;
}

// Traduce al español las descripciones de un gamelist. Devuelve cuántas cambió.
async function translateGamelist(gl, onEach) {
  let n = 0, i = 0;
  const keys = [...gl.games.keys()];
  for (const k of keys) {
    if (art.stop) break;
    i++;
    const desc = G.getMeta(gl, k)?.desc;
    const lang = desc && (await S.detectLang(desc));
    if (lang && lang !== 'es' && LANG_NAME[lang]) {
      const t = await S.translate(desc, lang);
      if (t && t !== desc) { G.setMeta(gl, k, { desc: t }); n++; }
      if (n && n % 25 === 0) await G.saveGamelist(gl).catch(() => {});
    }
    onEach?.(i, keys.length, n);
  }
  await G.saveGamelist(gl);
  return n;
}

async function onArtTranslate() {
  if (!(await prepareTranslation())) return;
  artBusy(true);
  try {
    const n = await translateGamelist(art.gl, (i, total, n) => artProgress(i, total, `Traduciendo: ${i} de ${total}. Traducidas: ${n}.`));
    toast(`Listo: se tradujeron ${n} descripción(es) de ${sysName(art.folder)}.`, 'ok');
  } catch (e) { toast(`No se pudo terminar: ${e.message || explainError(e)}`, 'bad'); }
  artBusy(false); artProgress(0, 0); renderArt();
}

async function onArtTranslateAll() {
  if (!(await prepareTranslation())) return;
  artBusy(true);
  let total = 0, sysDone = 0;
  try {
    for (const [folder] of card.systems) {
      if (art.stop) break;
      sysDone++;
      const sysDirs = await sysDirsFor(folder);
      let gl;
      try { gl = await G.openGamelist(folder, sysDirs); } catch { continue; }
      if (gl.original == null) continue;
      total += await translateGamelist(gl, (i, n, t) => artProgress(sysDone, card.systems.length,
        `${sysName(folder)} (${sysDone} de ${card.systems.length} consolas): ${i} de ${n} juegos. Traducidas en total: ${total + t}.`));
    }
    toast(`Listo: se tradujeron ${total} descripción(es) en todas las consolas.`, 'ok');
  } catch (e) { toast(`No se pudo terminar: ${e.message || explainError(e)}`, 'bad'); }
  artBusy(false); artProgress(0, 0);
  if (art.folder) await loadArt(art.folder);
}

// ---------- Editar un juego ----------
const KIND_LABEL = { thumbnail: 'Caja', image: 'Captura', marquee: 'Logo' };
let edit = null;

async function previewMedia(kind, src) {
  const fig = $(`#art-dialog figure[data-kind=${kind}]`);
  const img = fig.querySelector('img');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  img.removeAttribute('src'); delete img.dataset.url;
  fig.classList.toggle('empty', !src);
  if (!src) return;
  const blob = src instanceof Blob ? src : await (await G.resolveMedia(art.sysDirs, src, art.folder))?.handle.getFile();
  if (!blob) { fig.classList.add('empty'); return; }
  img.dataset.url = img.src = URL.createObjectURL(blob);
}

function openEdit(g) {
  const m = G.getMeta(art.gl, relOf(g)) || {};
  edit = { g, rel: relOf(g), pending: {} };
  $('#art-d-file').textContent = `${sysName(art.folder)} · ${g.name}`;
  $('#art-d-name').value = m.name || baseOf(g.name);
  $('#art-d-desc').value = m.desc || '';
  $('#art-d-year').value = (m.releasedate || '').slice(0, 4).replace(/\D/g, '');
  $('#art-d-genre').value = m.genre || '';
  $('#art-d-dev').value = m.developer || '';
  $('#art-d-pub').value = m.publisher || '';
  $('#art-d-players').value = m.players || '';
  $('#art-d-q').value = m.name || baseOf(g.name).replace(/\s*[([][^)\]]*[)\]]/g, '');
  $('#art-d-results').innerHTML = '';
  $('#art-d-find-box').hidden = !S.canScrape(art.folder);
  $('#art-d-msg').textContent = '';
  for (const kind of Object.keys(KIND_LABEL)) previewMedia(kind, m[kind] || '');
  $('#art-dialog').showModal();
}

async function onEditFind() {
  const q = $('#art-d-q').value.trim();
  const box = $('#art-d-results');
  if (!q) return;
  box.innerHTML = '<li class="sub">Buscando…</li>';
  try {
    const res = await S.searchTitles(art.folder, q, (m) => (box.innerHTML = `<li class="sub">${esc(m)}</li>`));
    edit.results = res.map((r) => r.rec);
    box.innerHTML = res.length ? res.map((r, i) => `<li><img alt="" loading="lazy" src="${esc(S.thumbUrls(art.folder, r.rec, 'thumbnail')[0])}" onerror="this.style.visibility='hidden'">
      <span>${esc(r.rec.name)}${r.rec.releaseyear ? ` <span class="sub">${r.rec.releaseyear}</span>` : ''}</span>
      <button type="button" class="btn" data-use="${i}">Usar este</button></li>`).join('')
      : '<li class="sub">No encontré nada con ese nombre. Probá con menos palabras o con el nombre en inglés.</li>';
  } catch (e) { box.innerHTML = `<li class="sub">${esc(e.message || String(e))}</li>`; }
}

async function onEditUse(rec) {
  const msg = $('#art-d-msg');
  msg.textContent = 'Bajando las imágenes y los datos…';
  const m = S.metaFrom(rec);
  $('#art-d-name').value = m.name;
  $('#art-d-year').value = (m.releasedate || '').slice(0, 4);
  $('#art-d-genre').value = m.genre || '';
  $('#art-d-dev').value = m.developer || '';
  $('#art-d-pub').value = m.publisher || '';
  $('#art-d-players').value = m.players || '';
  edit.region = m.region;
  let got = 0;
  await Promise.all(Object.keys(KIND_LABEL).map(async (kind) => {
    const img = await S.fetchImage(S.thumbUrls(art.folder, rec, kind), kind);
    if (img) { edit.pending[kind] = img; got++; previewMedia(kind, img.blob); }
  }));
  const cur = $('#art-d-desc').value.trim();
  if ($('#art-wiki').checked && (!cur || S.guessLang(cur) !== 'es')) {
    msg.textContent = 'Buscando la descripción en Wikipedia…';
    const d = await S.wikiDescription(m.name, sysName(art.folder));
    if (d) $('#art-d-desc').value = d.text;
  }
  msg.textContent = `Listo: ${got} imagen(es). Revisá los datos y tocá Guardar.`;
}

async function onEditSave() {
  const sysDirs = await sysDirsFor(art.folder, true);
  const stem = baseOf(edit.g.name);
  const old = G.getMeta(art.gl, edit.rel) || {};
  const year = $('#art-d-year').value.trim();
  const meta = {
    name: $('#art-d-name').value.trim(), desc: $('#art-d-desc').value.trim(),
    genre: $('#art-d-genre').value.trim(), developer: $('#art-d-dev').value.trim(),
    publisher: $('#art-d-pub').value.trim(), players: $('#art-d-players').value.trim(),
    releasedate: !year ? '' : (old.releasedate || '').startsWith(year) ? old.releasedate : `${year}0101T000000`,
  };
  if (edit.region && !old.region) meta.region = edit.region;
  for (const [kind, v] of Object.entries(edit.pending)) {
    if (v === 'clear') { if (old[kind]) await deleteMedia(sysDirs, art.folder, old[kind]); meta[kind] = ''; }
    else meta[kind] = await writeMedia(sysDirs, stem, kind, v);
  }
  G.setMeta(art.gl, edit.rel, meta);
  await G.saveGamelist(art.gl);
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
$('#art-system').addEventListener('change', (e) => loadArt(e.target.value));
$('#art-search').addEventListener('input', renderArt);
$('#art-wiki').addEventListener('change', updateArtStatus);
$('#art-fill').addEventListener('click', onArtFill);
$('#art-translate').addEventListener('click', onArtTranslate);
$('#art-translate-all').addEventListener('click', onArtTranslateAll);
$('#art-stop').addEventListener('click', () => { art.stop = true; $('#art-stop').disabled = true; });
$('#art-list').addEventListener('click', (e) => { const i = e.target.dataset.edit; if (i !== undefined) openEdit(art.games[+i]); });
$('#art-d-find').addEventListener('click', onEditFind);
$('#art-d-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onEditFind(); } });
$('#art-d-results').addEventListener('click', (e) => { const i = e.target.dataset.use; if (i !== undefined) onEditUse(edit.results[+i]); });
$('#art-dialog').addEventListener('click', (e) => {
  const fig = e.target.closest('figure[data-kind]');
  if (!fig || !e.target.dataset.act) return;
  edit.target = fig.dataset.kind;
  if (e.target.dataset.act === 'pick') $('#art-d-image').click();
  else { edit.pending[edit.target] = 'clear'; previewMedia(edit.target, ''); }
});
$('#art-d-image').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const img = await S.prepareImage(f, edit.target); edit.pending[edit.target] = img; previewMedia(edit.target, img.blob); }
  catch { $('#art-d-msg').textContent = 'No pude abrir esa imagen. Probá con un .png o .jpg.'; }
});
$('#art-d-translate').addEventListener('click', async () => {
  const d = $('#art-d-desc'), msg = $('#art-d-msg');
  const lang = await S.detectLang(d.value);
  if (!lang || lang === 'es') { msg.textContent = 'La descripción ya está en español (o es muy corta para saberlo).'; return; }
  if (!(await prepareTranslation())) return;
  msg.textContent = 'Traduciendo…';
  const t = await S.translate(d.value, lang);
  msg.textContent = t ? 'Traducida. Revisala y tocá Guardar.' : 'No se pudo traducir.';
  if (t) d.value = t;
});
$('#art-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'save') return;
  e.preventDefault();
  const btn = $('#art-d-save'); btn.disabled = true;
  try { await onEditSave(); $('#art-dialog').close(); toast('Guardado. La consola lo va a mostrar la próxima vez que la prendas.', 'ok'); renderArt(); updateArtStatus(); }
  catch (err) { $('#art-d-msg').textContent = `No se pudo guardar: ${err.message || explainError(err)}`; }
  btn.disabled = false;
});


checkBrowser();
