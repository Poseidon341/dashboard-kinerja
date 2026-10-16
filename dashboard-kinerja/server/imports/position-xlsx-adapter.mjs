import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';

const REQUIRED_HEADERS = Object.freeze([
  'Posisi', 'Segmentasi BPR', 'Produk', 'Nama Cabang', 'Nama Uker', 'Jumlah Rekening', 'Saldo',
]);
const local = (name) => name.slice(name.lastIndexOf(':') + 1);

async function checksumFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function openWorkbook(path) {
  const zip = await new Promise((ok, fail) => yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true },
    (error, file) => error ? fail(error) : ok(file)));
  const entries = new Map();
  try {
    await new Promise((ok, fail) => {
      zip.on('entry', (entry) => { entries.set(entry.fileName, entry); zip.readEntry(); });
      zip.once('end', ok);
      zip.once('error', fail);
      zip.readEntry();
    });
    return { zip, entries };
  } catch (error) {
    zip.close();
    throw error;
  }
}

async function entryStream(book, name, required = true) {
  const entry = book.entries.get(name);
  if (!entry) {
    if (!required) return null;
    throw new Error('Workbook component missing.');
  }
  return new Promise((ok, fail) => book.zip.openReadStream(entry, (error, stream) => error ? fail(error) : ok(stream)));
}

async function parseEntry(book, name, handlers, required = true) {
  const stream = await entryStream(book, name, required);
  if (!stream) return false;
  const parser = new SaxesParser();
  const decoder = new StringDecoder('utf8');
  for (const [event, handler] of Object.entries(handlers)) parser.on(event, handler);
  for await (const chunk of stream) parser.write(decoder.write(chunk));
  parser.write(decoder.end());
  parser.close();
  return true;
}

function columnNumber(reference) {
  const letters = /^([A-Z]+)/.exec(reference ?? '')?.[1];
  if (!letters) throw new Error('Worksheet cell reference invalid.');
  let number = 0;
  for (const letter of letters) number = number * 26 + letter.charCodeAt(0) - 64;
  return number;
}

async function worksheetMetadata(book) {
  let wantedRelationship = null;
  let date1904 = false;
  await parseEntry(book, 'xl/workbook.xml', {
    opentag(node) {
      if (local(node.name) === 'workbookPr') date1904 = ['1', 'true'].includes(node.attributes.date1904);
      if (local(node.name) === 'sheet' && node.attributes.name === 'segmen_data') {
        wantedRelationship = node.attributes['r:id'];
      }
    },
  });
  if (!wantedRelationship) throw new Error('Worksheet segmen_data not found.');
  let target = null;
  await parseEntry(book, 'xl/_rels/workbook.xml.rels', {
    opentag(node) {
      if (local(node.name) === 'Relationship' && node.attributes.Id === wantedRelationship) target = node.attributes.Target;
    },
  });
  if (!target) throw new Error('Worksheet relationship invalid.');
  const name = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target));
  if (!name.startsWith('xl/') || name.includes('..')) throw new Error('Worksheet relationship invalid.');
  return { name, date1904 };
}

async function sharedStrings(book) {
  const strings = [];
  let inside = false; let text = ''; let textDepth = 0;
  await parseEntry(book, 'xl/sharedStrings.xml', {
    opentag(node) {
      const tag = local(node.name);
      if (tag === 'si') { inside = true; text = ''; }
      if (inside && tag === 't') textDepth++;
    },
    text(value) { if (inside && textDepth) text += value; },
    closetag(node) {
      const tag = local(node.name);
      if (inside && tag === 't') textDepth--;
      if (tag === 'si') { strings.push(text); inside = false; }
    },
  }, false);
  return strings;
}

async function dateStyles(book) {
  const formats = new Map(); const styleFormats = [];
  let inCellXfs = false;
  await parseEntry(book, 'xl/styles.xml', {
    opentag(node) {
      const tag = local(node.name);
      if (tag === 'numFmt') formats.set(Number(node.attributes.numFmtId), node.attributes.formatCode ?? '');
      if (tag === 'cellXfs') inCellXfs = true;
      if (inCellXfs && tag === 'xf') styleFormats.push(Number(node.attributes.numFmtId ?? 0));
    },
    closetag(node) { if (local(node.name) === 'cellXfs') inCellXfs = false; },
  }, false);
  return new Set(styleFormats.flatMap((id, index) => (
    (id >= 14 && id <= 22) || /(^|[^\\])[dmy]/i.test(formats.get(id) ?? '') ? [index] : []
  )));
}

function cellToken(cell, strings) {
  if (cell.type === 'e') throw new Error('Workbook contains a stored cell error.');
  if (cell.formula && (cell.raw === null || !cell.raw.trim())) throw new Error('Workbook formula cache is missing.');
  if (cell.type === 'inlineStr') return JSON.stringify(cell.inline);
  if (cell.raw === null || cell.raw === '') return 'null';
  if (cell.type === 's') {
    const index = Number(cell.raw);
    if (!Number.isSafeInteger(index) || index < 0 || index >= strings.length) throw new Error('Shared string index invalid.');
    return JSON.stringify(strings[index]);
  }
  if (cell.type === 'str' || cell.type === 'd') return JSON.stringify(cell.raw);
  if (cell.type === 'b') {
    if (cell.raw === '1') return 'true';
    if (cell.raw === '0') return 'false';
    throw new Error('Boolean cell token invalid.');
  }
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/.test(cell.raw)) throw new Error('Numeric cell token invalid.');
  return cell.raw;
}

async function writeChunk(stream, value) {
  if (!stream.write(value)) await once(stream, 'drain');
}

async function materializeSheet(book, sheetName, strings, styles, date1904, output, { limit, maxRows, maxMaterializedBytes }) {
  let rowNumber = 0; let cell = null; let capture = null; let cells = new Map();
  let headers = new Map(); let maxColumn = 0; let positionColumn = 0;
  let rowCount = 0; let bytes = 2; let written = 0; let batch = [];
  const ready = [];
  const processRow = (physicalRow, rowCells) => {
    if (physicalRow === 1) {
      for (const [column, value] of rowCells) {
        const token = cellToken(value, strings);
        if (token === 'null') continue;
        const header = String(JSON.parse(token));
        if (header.trim()) { headers.set(column, header); maxColumn = Math.max(maxColumn, column); }
      }
      const missing = REQUIRED_HEADERS.filter(header => ![...headers.values()].includes(header));
      if (missing.length) throw new Error(`Required worksheet headers missing: ${missing.join(', ')}`);
      for (const [column, header] of headers) if (header === 'Posisi') positionColumn = column;
      return;
    }
    if (physicalRow < 2) return;
    const parts = []; let hasValue = false;
    for (let column = 1; column <= maxColumn; column++) {
      const header = headers.get(column);
      if (!header) throw new Error('Worksheet header has an unnamed interior column.');
      const token = rowCells.has(column) ? cellToken(rowCells.get(column), strings) : 'null';
      if (token !== 'null' && token !== '""') hasValue = true;
      parts.push(`${JSON.stringify(header)}:${token}`);
    }
    for (const [column, value] of rowCells) {
      if (column > maxColumn && !['null', '""'].includes(cellToken(value, strings))) {
        throw new Error('Data found outside named worksheet headers.');
      }
    }
    if (!hasValue) return;
    parts.push(`"__source_row_number":${physicalRow}`);
    const position = rowCells.get(positionColumn);
    if (position && !['s', 'inlineStr', 'str', 'd'].includes(position.type) && styles.has(position.style)) {
      parts.push('"__excel_date_serial":true');
      parts.push(`"__excel_date_1904":${date1904}`);
    }
    ready.push(`{${parts.join(',')}}`);
  };
  const stream = await entryStream(book, sheetName);
  const parser = new SaxesParser();
  const decoder = new StringDecoder('utf8');
  parser.on('opentag', (node) => {
    const tag = local(node.name);
    if (tag === 'row') { rowNumber = Number(node.attributes.r); cells = new Map(); }
    if (tag === 'c') cell = { column: columnNumber(node.attributes.r), type: node.attributes.t ?? '', style: Number(node.attributes.s ?? 0), raw: null, inline: '', formula: false };
    if (!cell) return;
    if (tag === 'f') cell.formula = true;
    if (tag === 'v' || (tag === 't' && cell.type === 'inlineStr')) capture = tag;
  });
  parser.on('text', value => {
    if (!cell || !capture) return;
    if (capture === 'v') cell.raw = (cell.raw ?? '') + value;
    else cell.inline += value;
  });
  parser.on('closetag', (node) => {
    const tag = local(node.name);
    if (tag === capture) capture = null;
    if (tag === 'c') { cells.set(cell.column, cell); cell = null; }
    if (tag === 'row') processRow(rowNumber, cells);
  });
  for await (const chunk of stream) {
    parser.write(decoder.write(chunk));
    for (const row of ready.splice(0)) {
      if (limit && rowCount >= limit) break;
      bytes += Buffer.byteLength(row, 'utf8') + (rowCount ? 1 : 0);
      if (rowCount >= maxRows || bytes > maxMaterializedBytes) throw new Error('Sheet segmen_data melebihi batas aman pemrosesan.');
      batch.push(row); rowCount++;
      if (batch.length >= 1000) {
        await writeChunk(output, (written ? ',' : '') + batch.join(','));
        written += batch.length; batch = [];
      }
    }
    if (limit && rowCount >= limit) { stream.destroy(); break; }
  }
  if (!(limit && rowCount >= limit)) { parser.write(decoder.end()); parser.close(); }
  if (batch.length) await writeChunk(output, (written ? ',' : '') + batch.join(','));
  if (!maxColumn || !rowCount) throw new Error('Sheet segmen_data tidak menghasilkan baris.');
  return rowCount;
}

export async function materializePositionWorkbook(filePath, {
  limit = 0, maxRows = 2_000_000, maxMaterializedBytes = 800 * 1024 * 1024,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Limit XLSX harus bilangan bulat nonnegatif.');
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxMaterializedBytes) || maxMaterializedBytes < 1) {
    throw new Error('Batas ukuran materialisasi XLSX tidak valid.');
  }
  const sourcePath = resolve(filePath);
  const [sourceInfo, checksum] = await Promise.all([stat(sourcePath), checksumFile(sourcePath)]);
  const directory = await mkdtemp(join(tmpdir(), 'dashboard-position-xlsx-'));
  const tempPath = join(directory, 'position-rows.tmp');
  const output = createWriteStream(tempPath, { encoding: 'utf8' });
  let book;
  try {
    book = await openWorkbook(sourcePath);
    const [{ name, date1904 }, strings, styles] = await Promise.all([
      worksheetMetadata(book), sharedStrings(book), dateStyles(book),
    ]);
    await writeChunk(output, '[');
    const rowCount = await materializeSheet(book, name, strings, styles, date1904, output,
      { limit, maxRows, maxMaterializedBytes });
    output.end(']');
    await once(output, 'finish');
    return {
      path: tempPath, rowCount, headers: [...REQUIRED_HEADERS], checksum, sourceSizeBytes: sourceInfo.size,
      limited: limit > 0,
      async verifyUnchanged() { return (await checksumFile(sourcePath)) === checksum; },
      async cleanup() { await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) {
    output.destroy();
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    book?.zip.close();
  }
}
