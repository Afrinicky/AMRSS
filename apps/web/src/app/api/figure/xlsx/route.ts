import ExcelJS from "exceljs";

/**
 * Builds an Excel workbook from a figure: the data on one or more sheets, the
 * chart itself embedded on another.
 *
 * Why a server route rather than the browser. The workbook library is heavy and
 * belongs in Node, not in every visitor's bundle, and this keeps it out of the
 * client entirely — the page posts the numbers it already has plus a picture of
 * the chart it already drew, and gets a file back. The route reads no
 * surveillance data of its own; it only formats what the caller sent, so it
 * cannot disclose anything the caller could not already see. That is also why it
 * needs no session: there is nothing here to protect, and the public dashboard —
 * which has no session — must be able to take its figures away too. The size
 * bounds below are the abuse guard the login used to be.
 *
 * On "graphs and charts as well": Excel's own chart engine cannot be authored
 * faithfully from outside Excel, so the figure travels as a high-resolution
 * image — exactly what appears on screen — alongside the full table, so a reader
 * who wants a native, editable Excel chart can build one from the data in a
 * couple of clicks. Nothing is lost and the picture is never a mystery.
 */

export const runtime = "nodejs";

interface SheetPayload {
  name: string;
  columns: string[];
  rows: (string | number | null)[][];
}

interface FigurePayload {
  title: string;
  period?: string;
  source?: string;
  columns: string[];
  rows: (string | number | null)[][];
  /** Further tables, each its own sheet — e.g. prevalence and per-organism
   *  detail alongside the primary coverage table. */
  extraSheets?: SheetPayload[];
  image?: { base64: string; width: number; height: number };
}

// Bounds, so this cannot be turned into a way to spend the function's memory.
// A surveillance figure is tens of rows and a chart a few hundred KB; these are
// far above that and far below trouble.
const MAX_ROWS = 20_000;
const MAX_COLUMNS = 100;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

function badRequest(message: string): Response {
  return Response.json({ detail: message }, { status: 400 });
}

/** Sanitise a sheet name to Excel's rules: 31 chars, none of `\ / ? * [ ] :`. */
function sheetName(name: string, fallback: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31);
  return cleaned || fallback;
}

/** One data worksheet: a provenance block, a styled header, the rows, and
 *  column widths sized to the content. Shared by the primary table and every
 *  extra sheet so they all look and read the same. */
function addDataSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: string[],
  rows: (string | number | null)[][],
  meta: [string, string][],
): void {
  const sheet = workbook.addWorksheet(name);
  for (const [label, value] of meta) {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true };
  }
  sheet.addRow([]);

  const header = sheet.addRow(columns);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F7A4D" } };
    cell.alignment = { vertical: "middle" };
  });

  for (const row of rows) {
    // null becomes a blank cell rather than the string "null".
    sheet.addRow(row.map((value) => (value === null ? null : value)));
  }

  columns.forEach((column, index) => {
    const longestValue = rows.reduce(
      (widest, row) => Math.max(widest, String(row[index] ?? "").length),
      column.length,
    );
    sheet.getColumn(index + 1).width = Math.min(48, Math.max(12, longestValue + 2));
  });
  sheet.views = [{ state: "frozen", ySplit: meta.length + 2 }];
}

export async function POST(request: Request): Promise<Response> {
  let payload: FigurePayload;
  try {
    payload = (await request.json()) as FigurePayload;
  } catch {
    return badRequest("Body is not JSON.");
  }

  const { title, period, source, columns, rows, extraSheets, image } = payload;
  if (typeof title !== "string" || !Array.isArray(columns) || !Array.isArray(rows)) {
    return badRequest("Expected title, columns and rows.");
  }
  if (columns.length === 0 || columns.length > MAX_COLUMNS) {
    return badRequest(`columns must be between 1 and ${MAX_COLUMNS}.`);
  }
  if (rows.length > MAX_ROWS) {
    return badRequest(`rows must be at most ${MAX_ROWS}.`);
  }
  const sheets = Array.isArray(extraSheets) ? extraSheets : [];
  for (const sheet of sheets) {
    if (
      typeof sheet?.name !== "string" ||
      !Array.isArray(sheet.columns) ||
      !Array.isArray(sheet.rows) ||
      sheet.columns.length === 0 ||
      sheet.columns.length > MAX_COLUMNS ||
      sheet.rows.length > MAX_ROWS
    ) {
      return badRequest("Each extra sheet needs a name, columns and rows within bounds.");
    }
  }
  if (image && image.base64.length * 0.75 > MAX_IMAGE_BYTES) {
    return badRequest("image is too large.");
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AMRSS";
  workbook.created = new Date();

  // A provenance block above every table, mirroring the CSV header, so a sheet is
  // self-describing when it is opened a year from now detached from the app.
  const meta: [string, string][] = [
    ["Figure", title],
    ...(period ? ([["Coverage period", period]] as [string, string][]) : []),
    ["Source", source ?? "AMRSS — Antimicrobial Resistance Surveillance System"],
    ["Downloaded", new Date().toISOString().slice(0, 10)],
  ];

  const usedNames = new Set<string>(["Data"]);
  addDataSheet(workbook, "Data", columns, rows, meta);
  sheets.forEach((sheet, index) => {
    let name = sheetName(sheet.name, `Sheet ${index + 2}`);
    while (usedNames.has(name)) name = sheetName(`${name} ${index + 2}`, `Sheet ${index + 2}`);
    usedNames.add(name);
    addDataSheet(workbook, name, sheet.columns, sheet.rows, meta);
  });

  if (image?.base64) {
    const chart = workbook.addWorksheet("Chart");
    const imageId = workbook.addImage({ base64: image.base64, extension: "png" });
    // The pixel size the chart was exported at, so it is neither stretched nor
    // shrunk — it is the same figure the screen showed.
    chart.addImage(imageId, {
      tl: { col: 0, row: 0 },
      ext: { width: image.width, height: image.height },
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const filename =
    (title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "figure") + ".xlsx";

  return new Response(buffer, {
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
