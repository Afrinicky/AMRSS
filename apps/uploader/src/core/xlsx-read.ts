/**
 * Reading .xlsx workbooks, with no dependency.
 *
 * A laboratory's breakpoint tables and its code lists arrive as Excel files,
 * because that is what CLSI publishes into and what a data steward maintains.
 * Asking someone to convert a workbook to CSV before the software will look at
 * it is asking them to do a job the software can do.
 *
 * An .xlsx is a ZIP of XML parts, and both halves are in Node's standard
 * library once the ZIP central directory is walked by hand. The reader is
 * deliberately small and gives back exactly what a spreadsheet is: sheets of
 * rows of strings. Types, formulas, styles and merged cells are not
 * interpreted — a breakpoint is read as the text a person typed, which is the
 * only reading that cannot silently round "≤0.06" into something else.
 */

import { inflateRawSync } from "node:zlib";

export interface Workbook {
  sheetNames: string[];
  sheet(name: string): string[][];
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Walk the ZIP central directory rather than scanning for local headers: a
 * stored file's contents can contain anything, header signatures included. */
function readZip(buffer: Buffer): Map<string, Buffer> {
  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) throw new Error("This file is not a valid .xlsx workbook (no ZIP directory).");

  const entryCount = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    // The local header repeats the name and extra field, and its extra field
    // length can differ from the directory's — so it is read, not assumed.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record is at the end, but a trailing comment can push it back by up to
  // 64 KB, so the tail is scanned backwards for the signature.
  const earliest = Math.max(0, buffer.length - 66_000);
  for (let index = buffer.length - 22; index >= earliest; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity] ?? whole;
  });
}

/** All the text inside one element, with tags dropped. Shared strings are rich
 * text — several `<t>` runs inside one entry — and a breakpoint split across
 * runs by a stray format change must come back as one value. */
function textOf(fragment: string): string {
  const parts = [...fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) =>
    decodeXml(match[1] ?? ""),
  );
  return parts.join("");
}

function readSharedStrings(entries: Map<string, Buffer>): string[] {
  const part = entries.get("xl/sharedStrings.xml");
  if (!part) return [];
  const xml = part.toString("utf8");
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textOf(match[1] ?? ""));
}

/** A1 -> 0, B1 -> 1, AA1 -> 26. Cells are addressed rather than counted,
 * because a row's empty cells are simply absent from the XML. */
function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference)?.[1] ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function readSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];

  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c([^>]*)\/>|<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1] ?? cellMatch[2] ?? "";
      const body = cellMatch[3] ?? "";
      const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1] ?? "";
      const type = /t="([^"]+)"/.exec(attributes)?.[1] ?? "";

      let value = "";
      if (type === "s") {
        const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "-1");
        value = shared[index] ?? "";
      } else if (type === "inlineStr") {
        value = textOf(body);
      } else {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
      }

      const at = reference ? columnIndex(reference) : cells.length;
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }
    rows.push(cells);
  }

  return rows;
}

export function readWorkbook(buffer: Buffer): Workbook {
  const entries = readZip(buffer);
  const workbookXml = entries.get("xl/workbook.xml")?.toString("utf8");
  if (!workbookXml) throw new Error("This file is not a valid .xlsx workbook.");

  const relsXml = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const targets = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship([^>]*)\/>/g)) {
    const attributes = match[1] ?? "";
    const id = /Id="([^"]+)"/.exec(attributes)?.[1];
    const target = /Target="([^"]+)"/.exec(attributes)?.[1];
    if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, ""));
  }

  const shared = readSharedStrings(entries);
  const sheets = new Map<string, string[][]>();
  const sheetNames: string[] = [];

  for (const match of workbookXml.matchAll(/<sheet([^>]*)\/>/g)) {
    const attributes = match[1] ?? "";
    const name = decodeXml(/name="([^"]*)"/.exec(attributes)?.[1] ?? "");
    const relationId = /r:id="([^"]+)"/.exec(attributes)?.[1] ?? "";
    const target = targets.get(relationId) ?? `worksheets/sheet${sheetNames.length + 1}.xml`;
    const part = entries.get(`xl/${target}`);
    sheetNames.push(name);
    sheets.set(name, part ? readSheet(part.toString("utf8"), shared) : []);
  }

  return {
    sheetNames,
    sheet(name: string): string[][] {
      return sheets.get(name) ?? [];
    },
  };
}
