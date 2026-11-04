// xlsx-writer.js — minimal, dependency-free .xlsx (Excel) file builder.
//
// An .xlsx file is just a ZIP archive containing a handful of XML files (the OOXML
// spreadsheet format). This builds the minimum valid set of those XML files by hand and
// zips them with zip-writer.js — no npm library (like exceljs or xlsx) needed.
// Uses inline strings (not a shared-strings table) to keep this simple; perfectly valid
// per the OOXML spec and opens fine in Excel, Google Sheets, and LibreOffice.
'use strict';
const { buildZip } = require('./zip-writer.js');

function xmlEscape(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function colLetter(n) {
  // 0-indexed column number -> Excel column letter (0 -> A, 25 -> Z, 26 -> AA, ...)
  let s = '';
  n += 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellXml(value, colIdx, rowIdx) {
  const ref = `${colLetter(colIdx)}${rowIdx}`;
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  // Everything else (including dates/booleans) is written as an inline string —
  // simplest and most compatible choice for a hand-rolled writer like this one.
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function rowXml(values, rowIdx) {
  const cells = values.map((v, i) => cellXml(v, i, rowIdx)).join('');
  return `<row r="${rowIdx}">${cells}</row>`;
}

// Builds a single-sheet .xlsx file buffer.
// headers: array of column header strings.
// rows: array of arrays (each inner array = one row of cell values, same order as headers).
function buildXlsx(sheetName, headers, rows) {
  const allRows = [headers, ...rows];
  const rowsXml = allRows.map((r, idx) => rowXml(r, idx + 1)).join('');
  const colCount = headers.length;
  const dimensionRef = colCount > 0 ? `A1:${colLetter(colCount - 1)}${allRows.length}` : 'A1';

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="${dimensionRef}"/>
<sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<sheetData>${rowsXml}</sheetData>
</worksheet>`;

  const safeSheetName = xmlEscape(sheetName).slice(0, 31) || 'Sheet1';

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${safeSheetName}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRelsXml, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRelsXml, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ];
  return buildZip(entries);
}

module.exports = { buildXlsx };
