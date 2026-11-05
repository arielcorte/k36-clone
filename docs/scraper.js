// Busca carátulas y datos de juegos, como el scraper de Batocera, pero con fuentes abiertas que funcionan
// desde el navegador: la base de datos y las imágenes de libretro (RetroArch) y Wikipedia.

const DB_URL = 'https://raw.githubusercontent.com/libretro/libretro-database/master/rdb/';
const THUMBS_URL = 'https://raw.githubusercontent.com/libretro-thumbnails/';
const ARCADE_DBS = ['FBNeo - Arcade Games', 'MAME 2003-Plus'];
const ARCADE_THUMBS = ['FBNeo - Arcade Games', 'MAME'];

// Carpeta de Batocera → bases de libretro (en orden) y repositorios de imágenes.
const LIBRETRO = {};
const map = (folders, dbs, thumbs = dbs, arcade = false) => {
  for (const f of folders.split(' ')) LIBRETRO[f] = { dbs, thumbs, arcade };
};
map('gb gb2players', ['Nintendo - Game Boy']);
map('gbc gbc2players', ['Nintendo - Game Boy Color']);
map('gba', ['Nintendo - Game Boy Advance']);
map('nes famicom', ['Nintendo - Nintendo Entertainment System']);
map('fds', ['Nintendo - Family Computer Disk System']);
map('snes sfc', ['Nintendo - Super Nintendo Entertainment System']);
map('n64', ['Nintendo - Nintendo 64']);
map('nds', ['Nintendo - Nintendo DS']);
map('virtualboy', ['Nintendo - Virtual Boy']);
map('pokemini', ['Nintendo - Pokemon Mini']);
map('megadrive genesis', ['Sega - Mega Drive - Genesis']);
map('mastersystem', ['Sega - Master System - Mark III']);
map('gamegear', ['Sega - Game Gear']);
map('sg1000', ['Sega - SG-1000']);
map('megacd segacd', ['Sega - Mega-CD - Sega CD']);
map('sega32x', ['Sega - 32X']);
map('saturn', ['Sega - Saturn']);
map('dreamcast', ['Sega - Dreamcast']);
map('psx', ['Sony - PlayStation']);
map('psp pspminis', ['Sony - PlayStation Portable']);
map('pcengine', ['NEC - PC Engine - TurboGrafx 16']);
map('pcenginecd', ['NEC - PC Engine CD - TurboGrafx-CD']);
map('supergrafx', ['NEC - PC Engine SuperGrafx']);
map('ngp', ['SNK - Neo Geo Pocket']);
map('ngpc', ['SNK - Neo Geo Pocket Color']);
map('neogeocd', ['SNK - Neo Geo CD']);
map('atari2600', ['Atari - 2600']);
map('atari5200', ['Atari - 5200']);
map('atari7800', ['Atari - 7800']);
map('lynx', ['Atari - Lynx']);
map('jaguar', ['Atari - Jaguar']);
map('wswan', ['Bandai - WonderSwan']);
map('wswanc', ['Bandai - WonderSwan Color']);
map('colecovision', ['Coleco - ColecoVision']);
map('intellivision', ['Mattel - Intellivision']);
map('msx1 msx', ['Microsoft - MSX']);
map('msx2', ['Microsoft - MSX2']);
map('c64', ['Commodore - 64']);
map('amstradcpc', ['Amstrad - CPC']);
map('vectrex', ['GCE - Vectrex']);
map('naomi', ['Sega - Naomi']);
map('arcade fbneo neogeo cps1 cps2 cps3', ARCADE_DBS, ARCADE_THUMBS, true);
map('mame mame2003', ['MAME 2003-Plus', 'FBNeo - Arcade Games'], ['MAME', 'FBNeo - Arcade Games'], true);

export const canScrape = (folder) => folder in LIBRETRO;

// ---------- Lectura de las bases .rdb de libretro (MessagePack) ----------
const KEEP = new Set(['name', 'rom_name', 'crc', 'serial', 'developer', 'publisher', 'genre', 'releaseyear', 'releasemonth', 'users']);
const utf8 = new TextDecoder();

function parseRdb(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  if (utf8.decode(b.subarray(0, 7)) !== 'RARCHDB') throw new Error('Base de datos con formato desconocido');
  let p = 16;
  const str = (n) => { const s = utf8.decode(b.subarray(p, p + n)); p += n; return s; };
  const raw = (n) => { const s = b.subarray(p, p + n); p += n; return s; };
  function read() {
    const t = b[p++];
    if (t <= 0x7f) return t;
    if (t >= 0xe0) return t - 256;
    if ((t & 0xf0) === 0x80) return readMap(t & 0x0f);
    if ((t & 0xf0) === 0x90) return readArr(t & 0x0f);
    if ((t & 0xe0) === 0xa0) return str(t & 0x1f);
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return raw(b[p++]);
      case 0xc5: { const n = dv.getUint16(p); p += 2; return raw(n); }
      case 0xc6: { const n = dv.getUint32(p); p += 4; return raw(n); }
      case 0xcc: return b[p++];
      case 0xcd: { const v = dv.getUint16(p); p += 2; return v; }
      case 0xce: { const v = dv.getUint32(p); p += 4; return v; }
      case 0xcf: { const v = Number(dv.getBigUint64(p)); p += 8; return v; }
      case 0xd0: return dv.getInt8(p++);
      case 0xd1: { const v = dv.getInt16(p); p += 2; return v; }
      case 0xd2: { const v = dv.getInt32(p); p += 4; return v; }
      case 0xd3: { const v = Number(dv.getBigInt64(p)); p += 8; return v; }
      case 0xd9: return str(b[p++]);
      case 0xda: { const n = dv.getUint16(p); p += 2; return str(n); }
      case 0xdb: { const n = dv.getUint32(p); p += 4; return str(n); }
      case 0xdc: { const n = dv.getUint16(p); p += 2; return readArr(n); }
      case 0xdd: { const n = dv.getUint32(p); p += 4; return readArr(n); }
      case 0xde: { const n = dv.getUint16(p); p += 2; return readMap(n); }
      case 0xdf: { const n = dv.getUint32(p); p += 4; return readMap(n); }
      default: throw new Error(`MessagePack: tipo ${t.toString(16)} no soportado`);
    }
  }
  function readArr(n) { const a = []; for (let i = 0; i < n; i++) a.push(read()); return a; }
  function readMap(n) {
    const o = {};
    for (let i = 0; i < n; i++) {
      const k = read(), v = read();
      if (KEEP.has(k)) o[k] = v;
    }
    return o;
  }
  const out = [];
  while (p < b.length && b[p] !== 0xc0) {
    const r = read();
    if (!r || !r.name) continue;
    if (r.crc instanceof Uint8Array) r.crc = [...r.crc].map((x) => x.toString(16).padStart(2, '0')).join('');
    if (r.serial instanceof Uint8Array) r.serial = String.fromCharCode(...r.serial);
    out.push(r);
  }
  return out;
}

// Normaliza un título para comparar: sin etiquetas (USA), sin acentos ni signos, "the" al final o al principio.
export function normTitle(s) {
  return s.replace(/\s*[([][^)\]]*[)\]]/g, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/^the\s+|,\s*the\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const dbCache = new Map();
async function loadDb(name, onStatus) {
  if (dbCache.has(name)) return dbCache.get(name);
  const promise = (async () => {
    const url = DB_URL + encodeURIComponent(name) + '.rdb';
    let res;
    const cache = 'caches' in self ? await caches.open('k36-libretro-db-v1') : null;
    res = cache && (await cache.match(url));
    if (!res) {
      onStatus?.(`Bajando la base de datos de ${name} (se hace una sola vez)…`);
      res = await fetch(url);
      if (!res.ok) throw new Error(`No se pudo bajar la base de datos de ${name}`);
      if (cache) await cache.put(url, res.clone()).catch(() => {});
    }
    const recs = parseRdb(await res.arrayBuffer());
    const byCrc = new Map(), bySerial = new Map(), byRom = new Map(), byTitle = new Map();
    for (const r of recs) {
      if (r.crc && !byCrc.has(r.crc)) byCrc.set(r.crc, r);
      if (r.serial) bySerial.set(r.serial.toUpperCase().replace(/[^A-Z0-9]/g, ''), r);
      if (r.rom_name) {
        const rn = r.rom_name.toLowerCase();
        if (!byRom.has(rn)) byRom.set(rn, r);
      }
      const t = normTitle(r.name);
      if (!byTitle.has(t)) byTitle.set(t, []);
      byTitle.get(t).push(r);
    }
    return { name, recs, byCrc, bySerial, byRom, byTitle };
  })();
  dbCache.set(name, promise);
  promise.catch(() => dbCache.delete(name));
  return promise;
}

// ---------- Identificar un juego ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
async function crcOfFile(file) {
  let c = 0xffffffff;
  const CH = 8 * 1024 * 1024;
  for (let off = 0; off < file.size; off += CH) {
    const buf = new Uint8Array(await file.slice(off, off + CH).arrayBuffer());
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

// CRC de los archivos dentro de un .zip, leídos del directorio central (sin descomprimir).
async function zipCrcs(file) {
  const tailLen = Math.min(file.size, 66000);
  const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
  const dvT = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (dvT.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return [];
  const count = dvT.getUint16(eocd + 10, true), size = dvT.getUint32(eocd + 12, true), offset = dvT.getUint32(eocd + 16, true);
  if (offset + size > file.size) return [];
  const cd = new DataView(await file.slice(offset, offset + size).arrayBuffer());
  const out = [];
  for (let p = 0, i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const crc = cd.getUint32(p + 16, true), usize = cd.getUint32(p + 24, true);
    const n = cd.getUint16(p + 28, true), x = cd.getUint16(p + 30, true), c = cd.getUint16(p + 32, true);
    out.push({ crc: crc.toString(16).padStart(8, '0'), size: usize });
    p += 46 + n + x + c;
  }
  return out.sort((a, b) => b.size - a.size);
}

// Código del disco (SLUS-00707, ULUS-10041…) leído de SYSTEM.CNF o UMD_DATA.BIN, al principio de la imagen.
async function discSerial(file) {
  const text = new TextDecoder('latin1').decode(await file.slice(0, 2 * 1024 * 1024).arrayBuffer());
  const ps1 = text.match(/BOOT2?\s*=\s*cdrom0?:\\?([A-Z]{4})[_-](\d{3})\.(\d{2})/i);
  if (ps1) return (ps1[1] + ps1[2] + ps1[3]).toUpperCase();
  const psp = text.match(/\b([A-Z]{4})-(\d{5})\|/);
  if (psp) return psp[1] + psp[2];
  return null;
}

const REGION_ORDER = ['usa', 'world', 'europe', 'spain', 'brazil', 'japan'];
function regionRank(name) {
  const tags = (name.match(/\(([^)]*)\)/g) || []).join(' ').toLowerCase();
  const i = REGION_ORDER.findIndex((r) => tags.includes(r));
  const extra = /\b(beta|proto|demo|sample|hack|pirate|unl|kiosk)\b/.test(tags) ? 50 : 0;
  return (i < 0 ? REGION_ORDER.length : i) + extra + (name.match(/\(/g) || []).length * 0.1;
}
const bestOf = (recs) => recs.slice().sort((a, b) => regionRank(a.name) - regionRank(b.name))[0];

// Devuelve { rec, db, how } o null. file: File del juego (o del primer .bin si es un .cue).
export async function identify(folder, fileName, file, onStatus) {
  const conf = LIBRETRO[folder];
  if (!conf) return null;
  const ext = fileName.split('.').pop().toLowerCase();
  const stem = fileName.replace(/\.[^.]+$/, '');
  const dbs = [];
  for (const name of conf.dbs) { try { dbs.push(await loadDb(name, onStatus)); } catch (e) { if (!dbs.length && name === conf.dbs.at(-1)) throw e; } }

  if (conf.arcade) {
    for (const db of dbs) { const r = db.byRom.get(fileName.toLowerCase()); if (r) return { rec: r, db, how: 'nombre del archivo' }; }
  }
  if (file) {
    let crcs = [];
    if (ext === 'zip' && !conf.arcade) crcs = (await zipCrcs(file)).map((z) => z.crc);
    else if (!['zip', '7z', 'chd', 'cso', 'pbp', 'cue', 'm3u', 'iso', 'bin', 'img'].includes(ext) && file.size <= 128 * 1024 * 1024) crcs = [await crcOfFile(file)];
    for (const crc of crcs) for (const db of dbs) { const r = db.byCrc.get(crc); if (r) return { rec: r, db, how: 'contenido del archivo' }; }
    if (['bin', 'iso', 'img', 'cue'].includes(ext)) {
      const serial = await discSerial(file).catch(() => null);
      if (serial) for (const db of dbs) { const r = db.bySerial.get(serial); if (r) return { rec: r, db, how: 'código del disco' }; }
    }
  }
  const t = normTitle(stem.replace(/_/g, ' '));
  for (const db of dbs) {
    const recs = db.byTitle.get(t);
    if (recs) return { rec: bestOf(recs), db, how: 'nombre' };
  }
  // Nombre casi igual: solo le falta una palabra de relleno ("Pokemon Emerald" → "Pokemon - Emerald Version").
  const q = t.split(' ');
  for (const db of dbs) {
    for (const [title, recs] of db.byTitle) {
      const w = title.split(' ');
      if (w.length !== q.length + 1 || !q.every((x) => w.includes(x))) continue;
      if (GENERIC.has(w.find((x) => !q.includes(x)))) return { rec: bestOf(recs), db, how: 'nombre' };
    }
  }
  return null;
}
const GENERIC = new Set(['version', 'edition', 'the', 'game', 'a']);

// Para editar a mano: juegos de la base cuyo nombre se parece a lo que se busca.
export async function searchTitles(folder, query, onStatus, limit = 12) {
  const conf = LIBRETRO[folder];
  if (!conf) return [];
  const q = normTitle(query).split(' ').filter(Boolean);
  if (!q.length) return [];
  const out = [];
  for (const name of conf.dbs) {
    let db; try { db = await loadDb(name, onStatus); } catch { continue; }
    for (const [t, recs] of db.byTitle) {
      const words = t.split(' ');
      const hits = q.filter((w) => words.some((x) => x.startsWith(w))).length;
      if (hits === q.length) out.push({ score: words.length - hits + (t.startsWith(q[0]) ? 0 : 2), rec: bestOf(recs), db });
    }
  }
  return out.sort((a, b) => a.score - b.score || a.rec.name.localeCompare(b.rec.name)).slice(0, limit);
}

// ---------- Datos y descripción ----------
export function cleanName(rec) {
  return rec.name.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+-\s+/, ': ').replace(/^(.*), (The|A|An)(?=$|:)/, '$2 $1').trim();
}

// Géneros de libretro en español, como los muestra Batocera con el idioma en español.
const GENRES = [
  [/role.?playing|rpg/i, 'Rol (RPG)'], [/platform/i, 'Plataformas'], [/beat.?'?em.?up/i, 'Beat \'em up'], [/fight/i, 'Lucha'],
  [/shoot/i, 'Disparos'], [/racing|driving/i, 'Carreras'], [/sport/i, 'Deportes'], [/puzzle/i, 'Puzle'], [/strateg/i, 'Estrategia'],
  [/simulat/i, 'Simulación'], [/horror/i, 'Terror'], [/adventure/i, 'Aventura'], [/action/i, 'Acción'], [/music|rhythm/i, 'Música'],
  [/board|card|casino/i, 'Mesa'], [/educat/i, 'Educativo'], [/pinball/i, 'Pinball'], [/quiz|trivia/i, 'Preguntas'], [/compilation/i, 'Compilado'],
];
const genreEs = (g) => (GENRES.find(([re]) => re.test(g)) || [null, g])[1];
const tidy = (s) => String(s).replace(/\s*\?+$/, '').trim();

export function metaFrom(rec) {
  const m = { name: cleanName(rec) };
  if (rec.developer) m.developer = tidy(rec.developer);
  if (rec.publisher) m.publisher = tidy(rec.publisher);
  if (rec.genre) m.genre = genreEs(rec.genre);
  if (rec.users) m.players = rec.users > 1 ? `1-${rec.users}` : '1';
  if (rec.releaseyear) {
    const mm = String(rec.releasemonth || 1).padStart(2, '0');
    m.releasedate = `${rec.releaseyear}${mm}01T000000`;
  }
  const region = (rec.name.match(/\(([^)]*(?:USA|Europe|Japan|World|Spain|Brazil)[^)]*)\)/) || [])[1];
  if (region) m.region = region.split(',')[0].trim().toLowerCase().replace('europe', 'eu').replace('japan', 'jp').replace('world', 'wor').replace('usa', 'us').replace('spain', 'sp').replace('brazil', 'br');
  return m;
}

// ---------- Imágenes ----------
const safeThumb = (name) => name.replace(/[&*/:`<>?\\|"]/g, '_');
const KINDS = { image: 'Named_Snaps', thumbnail: 'Named_Boxarts', marquee: 'Named_Logos' };

export function thumbUrls(folder, rec, kind) {
  const conf = LIBRETRO[folder];
  if (!conf) return [];
  return conf.thumbs.map((repo) => `${THUMBS_URL}${encodeURIComponent(repo.replace(/ /g, '_'))}/master/${KINDS[kind]}/${encodeURIComponent(safeThumb(rec.name))}.png`);
}

// Achica la imagen para la pantalla de la consola (640×480) y la guarda en JPG si es una foto de caja.
async function shrink(blob, kind) {
  const max = kind === 'marquee' ? 480 : 512;
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const asJpg = kind === 'thumbnail';
  if (scale === 1 && !asJpg) { bmp.close(); return { blob, ext: 'png' }; }
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  if (asJpg) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await c.convertToBlob(asJpg ? { type: 'image/jpeg', quality: 0.85 } : { type: 'image/png' });
  return { blob: out, ext: asJpg ? 'jpg' : 'png' };
}

export async function fetchImage(urls, kind) {
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) return await shrink(await res.blob(), kind);
    } catch {}
  }
  return null;
}

// Imagen elegida por el usuario (archivo de la computadora).
export const prepareImage = (blob, kind) => shrink(blob, kind);

// ---------- Descripción desde Wikipedia ----------
const WIKI = { es: 'videojuego', en: 'video game' };
const words = (s) => new Set(normTitle(s).split(' ').filter((w) => w.length > 1));

async function wikiSearch(lang, title, platform) {
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const q = `${title} ${WIKI[lang]} ${platform}`;
  const s = await (await fetch(`${api}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=6&format=json&origin=*`)).json();
  const want = words(title);
  for (const hit of s?.query?.search || []) {
    const paren = (hit.title.match(/\(([^)]*)\)\s*$/) || [])[1] || '';
    if (paren && !/videojuego|video game|\d{4}/i.test(paren)) continue;
    const got = words(hit.title.replace(/\s*\([^)]*\)\s*$/, ''));
    const common = [...got].filter((w) => want.has(w)).length;
    if (!got.size || common / Math.max(got.size, want.size) < 0.75) continue;
    const r = await (await fetch(`${api}?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(hit.title)}&format=json&origin=*`)).json();
    const page = Object.values(r?.query?.pages || {})[0];
    const text = (page?.extract || '').trim();
    if (text.length > 80 && new RegExp(WIKI[lang], 'i').test(text)) return trimText(text);
  }
  return null;
}

function trimText(text, max = 1100) {
  text = text.replace(/[\u200b\u200e]/g, '').replace(/\s*\([^)]*[\u3040-\u30ff\u4e00-\u9fff][^)]*\)/g, '')
    .replace(/\s*\n+\s*/g, '\n').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return (end > 200 ? cut.slice(0, end + 1) : cut + '…').trim();
}

export async function wikiDescription(title, platform) {
  try {
    const es = await wikiSearch('es', title, platform);
    if (es) return { text: es, lang: 'es' };
    const en = await wikiSearch('en', title, platform);
    if (en) {
      const t = await translate(en, 'en');
      if (t) return { text: t, lang: 'es' };
    }
  } catch {}
  return null;
}

// ---------- Traducción (Translator API de Chrome, funciona en la computadora sin mandar el texto a nadie) ----------
const translators = new Map();
export const canTranslate = () => 'Translator' in self;

// Llamar dentro del clic del usuario: Chrome puede necesitar bajar el idioma y eso requiere un clic.
export async function prepareTranslator(from) {
  if (!canTranslate()) return false;
  if (translators.has(from)) return true;
  try {
    const a = await Translator.availability({ sourceLanguage: from, targetLanguage: 'es' });
    if (a === 'unavailable') return false;
    translators.set(from, Translator.create({ sourceLanguage: from, targetLanguage: 'es' }));
    await translators.get(from);
    return true;
  } catch { translators.delete(from); return false; }
}

export async function translate(text, from) {
  if (!translators.has(from) && !(await prepareTranslator(from))) return null;
  try {
    const t = await translators.get(from);
    const parts = text.split(/\n/);
    const out = [];
    for (const p of parts) out.push(p.trim() ? await t.translate(p) : p);
    return out.join('\n');
  } catch { return null; }
}

// Idioma de un texto: portugués, inglés, español u otro. Usa el detector de Chrome si está, si no cuenta palabras típicas.
const wordRe = (list, tails) => new RegExp(`(?<!\\p{L})(?:${list.join('|')})(?!\\p{L})|\\p{L}(?:${tails.join('|')})(?!\\p{L})`, 'giu');
const MARKS = {
  pt: wordRe(['não', 'você', 'são', 'também', 'jogo', 'jogos', 'jogador', 'uma', 'seu', 'sua', 'pelo', 'pela', 'até', 'então', 'através', 'ele', 'ela', 'isso', 'esse', 'essa', 'em', 'do', 'da', 'dos', 'das', 'é', 'com', 'mais'], ['ção', 'ções', 'ões', 'ão']),
  es: wordRe(['el', 'los', 'las', 'una', 'juego', 'juegos', 'jugador', 'también', 'está', 'del', 'al', 'que', 'su', 'sus', 'es', 'con', 'para', 'por', 'como', 'muy', 'pero', 'y'], ['ción', 'ciones', 'ñ\\p{L}*']),
  en: wordRe(['the', 'and', 'of', 'to', 'is', 'in', 'player', 'players', 'game', 'with', 'your', 'you', 'his', 'her', 'this', 'that', 'for', 'from'], ['ing']),
};
export async function detectLang(text) {
  if (!text || text.trim().length < 20) return null;
  if ('LanguageDetector' in self) {
    try {
      const d = await (detectLang.d ||= LanguageDetector.create());
      const [top] = await d.detect(text);
      if (top && top.confidence > 0.6) return top.detectedLanguage.slice(0, 2);
    } catch {}
  }
  return guessLang(text);
}

export function guessLang(text) {
  if (!text || text.trim().length < 20) return null;
  const score = Object.fromEntries(Object.entries(MARKS).map(([k, re]) => [k, (text.match(re) || []).length]));
  const [best, n] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return n >= 3 ? best : null;
}
