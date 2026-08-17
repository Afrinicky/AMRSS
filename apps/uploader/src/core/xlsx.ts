/**
 * Writing Excel workbooks, with no dependency.
 *
 * Everything a laboratory looks at here — the grid, the antibiogram, a trend, a
 * validation queue — downloads as .xlsx, because that is the format the data
 * will actually be worked in: pasted into a monthly report, sent to a clinician,
 * checked against the bench book. CSV loses the sheets, the number formats and
 * the header, and a laboratory opening a CSV of zone diameters in Excel gets
 * dates.
 *
 * An .xlsx file is a ZIP of XML parts, both of which Node's standard library
 * already provides (`zlib` for deflate, and CRC-32 is twenty lines). Pulling in
 * a spreadsheet library for this would add a dependency to software that runs on
 * clinical workstations and de-identifies patient data, and the whole point of
 * the packaging rules in electron-builder.yml is that there is as little of that
 * as possible.
 */

import { deflateRawSync } from "node:zlib";

export type CellValue = string | number | null | undefined;

export interface Sheet {
  name: string;
  /** First row is the header. Written frozen and bold. */
  header: string[];
  rows: CellValue[][];
  /** Column widths in characters. Defaults to something readable. */
  columnWidths?: number[];
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = -1;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ -1) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Store-or-deflate ZIP writer. Deflate is used only when it actually helps,
 * which for XML is always, but a tiny part can inflate. */
function zip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1 Jan 1980, fixed for reproducibility
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, payload);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(payload.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42); // offset of this entry's local header
    central.push(directory, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, centralBuffer, end]);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    // Control characters are not representable in XML 1.0 and Excel refuses the
    // whole file over one of them. A laboratory comment pasted from another
    // system is exactly where one turns up.
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function columnName(index: number): string {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - remainder) / 26);
  }
  return name;
}

function cellXml(value: CellValue, row: number, column: number, style: number): string {
  const reference = `${columnName(column)}${row}`;
  const styleAttribute = style > 0 ? ` s="${style}"` : "";
  if (value === null || value === undefined || value === "") {
    return `<c r="${reference}"${styleAttribute}/>`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${reference}"${styleAttribute}><v>${value}</v></c>`;
  }
  return `<c r="${reference}"${styleAttribute} t="inlineStr"><is><t xml:space="preserve">${escapeXml(
    String(value),
  )}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const widths = sheet.header.map((label, index) => {
    const declared = sheet.columnWidths?.[index];
    if (declared) return declared;
    const longest = Math.max(
      label.length,
      ...sheet.rows.slice(0, 200).map((row) => String(row[index] ?? "").length),
    );
    return Math.min(Math.max(longest + 2, 9), 46);
  });

  const columns = widths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join("");

  const header = `<row r="1">${sheet.header
    .map((label, index) => cellXml(label, 1, index, 1))
    .join("")}</row>`;

  const body = sheet.rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 2}">${row
          .map((value, columnIndex) => cellXml(value, rowIndex + 2, columnIndex, 0))
          .join("")}</row>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${columns}</cols>
<sheetData>${header}${body}</sheetData>
</worksheet>`;
}

/** Sheet names Excel will accept: 31 characters, none of []:*?/\ */
export function safeSheetName(name: string, fallback = "Sheet"): string {
  const cleaned = name.replaceAll(/[[\]:*?/\\]/g, " ").trim();
  return (cleaned === "" ? fallback : cleaned).slice(0, 31);
}

export function buildWorkbook(sheets: Sheet[]): Buffer {
  if (sheets.length === 0) throw new Error("A workbook needs at least one sheet.");

  const used = new Set<string>();
  const named = sheets.map((sheet, index) => {
    let name = safeSheetName(sheet.name, `Sheet${index + 1}`);
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      name = safeSheetName(`${name.slice(0, 27)} (${suffix})`);
      suffix += 1;
    }
    used.add(name.toLowerCase());
    return { ...sheet, name };
  });

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named
  .map(
    (_sheet, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join("\n")}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("")}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named
  .map(
    (_sheet, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  )
  .join("\n")}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  // Two styles: the default, and a bold header on a light fill.
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF12211A"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF6EF"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>`;

  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(workbookRels, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(styles, "utf8") },
    ...named.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: Buffer.from(sheetXml(sheet), "utf8"),
    })),
  ]);
}
