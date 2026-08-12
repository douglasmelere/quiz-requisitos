'use strict';

/**
 * Persistência em arquivo JSON (sem dependências).
 * Aponte DATA_DIR para um volume do Coolify para sobreviver a redeploys.
 * Se o diretório não for gravável, o app continua funcionando só em memória.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

let writable = true;

function init() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    console.log(`   Dados:         ${DATA_DIR} (persistente)`);
  } catch (err) {
    writable = false;
    console.warn(`   ⚠  ${DATA_DIR} não é gravável (${err.code}). Rodando só em memória.`);
    console.warn('      No Coolify: monte um volume nesse caminho e confira o dono do diretório.');
  }
}

const file = (name) => path.join(DATA_DIR, name);

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

/** Escrita atômica: grava em .tmp e renomeia, evitando arquivo pela metade. */
function writeNow(name, data) {
  if (!writable) return false;
  const target = file(name);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    console.error(`falha ao gravar ${name}:`, err.message);
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

const timers = new Map();

/** Agrupa gravações seguidas num único write. */
function write(name, getData, delay = 1200) {
  if (!writable) return;
  clearTimeout(timers.get(name));
  timers.set(name, setTimeout(() => {
    timers.delete(name);
    writeNow(name, getData());
  }, delay).unref());
}

function flush(name, data) {
  clearTimeout(timers.get(name));
  timers.delete(name);
  return writeNow(name, data);
}

function remove(name) {
  clearTimeout(timers.get(name));
  timers.delete(name);
  try { fs.unlinkSync(file(name)); return true; } catch { return false; }
}

module.exports = { init, read, write, flush, remove, DATA_DIR, isWritable: () => writable };
