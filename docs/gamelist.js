// Lee y escribe el gamelist.xml de una consola igual que EmulationStation de Batocera:
// <gameList><game><path>./juego.gba</path><name>…</name><image>./images/juego-image.png</image>…</game></gameList>
//
// Con roms.download_enabled, Batocera monta roms/ con downloads/ encima: si la consola modificó el gamelist,
// la copia que vale es la de downloads/<consola>/. Por eso se lee y se escribe esa, si existe.

export const MEDIA_TAGS = ['image', 'thumbnail', 'marquee', 'video', 'fanart', 'titleshot', 'boxart', 'boxback', 'wheel',
  'cartridge', 'map', 'manual', 'magazine', 'bezel', 'mix'];
export const TEXT_TAGS = ['name', 'desc', 'releasedate', 'developer', 'publisher', 'genre', 'players', 'region'];
// Nombre del archivo que usa Batocera para cada imagen: <juego>-<sufijo>.<ext> en images/.
export const SUFFIX = { image: 'image', thumbnail: 'thumb', marquee: 'marquee', video: 'video', fanart: 'fanart', titleshot: 'titleshot',
  boxart: 'box', boxback: 'boxback', wheel: 'wheel', cartridge: 'cartridge', map: 'map', manual: 'manual', magazine: 'magazine', bezel: 'bezel' };
export const MEDIA_DIRS = ['images', 'videos', 'manuals', 'magazines', 'downloaded_images', 'downloaded_videos', 'downloaded_wheels', 'downloaded_marquees'];

const BACKUP = 'gamelist.xml.antes-k36';

export function pathKey(text, folder) {
  let p = (text || '').trim().replace(/\\/g, '/');
  p = p.replace(new RegExp(`^/userdata/roms/${folder}/`, 'i'), '').replace(/^\.\//, '');
  return p.toLowerCase();
}

async function readText(dir, name) {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch { return null; }
}

// sysDirs: { roms: carpeta roms/<consola>, downloads: carpeta downloads/<consola> o null }
export async function openGamelist(folder, sysDirs) {
  let dir = null, text = null;
  if (sysDirs.downloads) { text = await readText(sysDirs.downloads, 'gamelist.xml'); if (text != null) dir = sysDirs.downloads; }
  if (text == null && sysDirs.roms) { text = await readText(sysDirs.roms, 'gamelist.xml'); if (text != null) dir = sysDirs.roms; }
  const gl = { folder, dir: dir || sysDirs.roms, original: text, games: new Map(), dirty: false };
  if (text == null || !text.trim()) {
    gl.doc = new DOMParser().parseFromString('<gameList>\n</gameList>', 'application/xml');
  } else {
    gl.doc = new DOMParser().parseFromString(text, 'application/xml');
    if (gl.doc.querySelector('parsererror') || gl.doc.documentElement.nodeName !== 'gameList') {
      throw new Error(`El gamelist.xml de ${folder} está dañado y no lo quiero tocar. Revisalo a mano o borralo para empezar de cero.`);
    }
  }
  for (const el of gl.doc.documentElement.children) {
    if (el.nodeName !== 'game') continue;
    const k = pathKey(child(el, 'path')?.textContent, folder);
    if (k && !gl.games.has(k)) gl.games.set(k, el);
  }
  return gl;
}

const child = (el, tag) => [...el.children].find((c) => c.nodeName === tag) || null;

export function getMeta(gl, relPath) {
  const el = gl.games.get(relPath.toLowerCase());
  if (!el) return null;
  const m = {};
  for (const c of el.children) m[c.nodeName] = c.textContent;
  return m;
}

// Agrega un hijo con la sangría de EmulationStation (tabs).
function setChild(doc, el, tag, value) {
  let c = child(el, tag);
  if (value == null || value === '') {
    if (c) { const prev = c.previousSibling; if (prev?.nodeType === 3) prev.remove(); c.remove(); }
    return;
  }
  if (!c) {
    c = doc.createElement(tag);
    const last = el.lastChild?.nodeType === 3 ? el.lastChild : null;
    el.insertBefore(doc.createTextNode('\n\t\t'), last);
    el.insertBefore(c, last);
    if (!last) el.appendChild(doc.createTextNode('\n\t'));
  }
  c.textContent = value;
}

export function setMeta(gl, relPath, meta) {
  const k = relPath.toLowerCase();
  let el = gl.games.get(k);
  const doc = gl.doc, root = doc.documentElement;
  if (!el) {
    el = doc.createElement('game');
    el.appendChild(doc.createTextNode('\n\t'));
    const last = root.lastChild?.nodeType === 3 ? root.lastChild : null;
    root.insertBefore(doc.createTextNode('\n\t'), last);
    root.insertBefore(el, last);
    if (!last) root.appendChild(doc.createTextNode('\n'));
    setChild(doc, el, 'path', './' + relPath);
    gl.games.set(k, el);
  }
  for (const [tag, v] of Object.entries(meta)) setChild(doc, el, tag, v);
  gl.dirty = true;
}

// Saca la entrada y devuelve las imágenes que solo usaba ese juego.
export function removeEntry(gl, relPath) {
  const k = relPath.toLowerCase();
  const el = gl.games.get(k);
  if (!el) return [];
  const media = MEDIA_TAGS.map((t) => child(el, t)?.textContent?.trim()).filter(Boolean);
  const prev = el.previousSibling; if (prev?.nodeType === 3) prev.remove();
  el.remove();
  gl.games.delete(k);
  gl.dirty = true;
  const stillUsed = new Set();
  for (const g of gl.games.values()) for (const t of MEDIA_TAGS) { const v = child(g, t)?.textContent?.trim(); if (v) stillUsed.add(v); }
  return media.filter((m) => !stillUsed.has(m));
}

export async function saveGamelist(gl) {
  if (!gl.dirty) return;
  if (gl.original != null && !(await readText(gl.dir, BACKUP))) {
    const w = await (await gl.dir.getFileHandle(BACKUP, { create: true })).createWritable();
    await w.write(gl.original); await w.close();
  }
  const xml = '<?xml version="1.0"?>\n' + new XMLSerializer().serializeToString(gl.doc.documentElement) + '\n';
  const w = await (await gl.dir.getFileHandle('gamelist.xml', { create: true })).createWritable();
  await w.write(xml); await w.close();
  gl.original = xml;
  gl.dirty = false;
}

// Ruta de imagen del gamelist (./images/x.png) → archivo, buscando primero en downloads/ y después en roms/.
export async function resolveMedia(sysDirs, mediaPath, folder) {
  const rel = pathKey(mediaPath, folder);
  if (!rel || rel.startsWith('/') || rel.includes('..')) return null;
  const parts = mediaPath.trim().replace(/\\/g, '/').replace(new RegExp(`^/userdata/roms/${folder}/`, 'i'), '').replace(/^\.\//, '').split('/');
  for (const base of [sysDirs.downloads, sysDirs.roms]) {
    if (!base) continue;
    let d = base;
    try {
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
      const h = await d.getFileHandle(parts.at(-1));
      return { dir: d, name: parts.at(-1), handle: h };
    } catch {}
  }
  return null;
}
