import ExcelJS from "exceljs";
import { cookies } from "next/headers";

import { SESSION_COOKIE } from "@/lib/api";

/**
 * Builds an Excel workbook from a figure: the data on one sheet, the chart
 * itself embedded on another.
 *
 * Why a server route rather than the browser. The workbook library is heavy and
 * belongs in Node, not in every visitor's bundle, and this keeps it out of the
 * client entirely — the page posts the numbers it already has plus a picture of
 * the chart it already drew, and gets a file back. The route reads no
 * surveillance data of its own; it only formats what the caller sent, so it
 * cannot disclose anything the caller could not already see.
 *
 * On "graphs and charts as well": Excel's own chart engine cannot be authored
 * faithfully from outside Excel, so the figure travels as a high-resolution
 * image — exactly what appears on screen — alongside the full table, so a reader
 * who wants a native, editable Excel chart can build one from the data in a
 * couple of clicks. Nothing is lost and the picture is never a mystery.
 */

export const runtime = "nodejs";

interface FigurePayload {
  title: string;
  period?: string;
  source?: string;
  columns: string[];
  rows: (string | number | null)[][];
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

export async function POST(request: Request): Promise<Response> {
  // Not an anonymous endpoint. It returns only what the caller supplies, so this
  // is abuse-prevention rather than data protection, but a public compute
  // endpoint is a public compute endpoint.
  const store = await cookies();
  if (!store.get(SESSION_COOKIE)?.value) {
    return Response.json({ detail: "Not authenticated" }, { status: 401 });
  }

  let payload: FigurePayload;
  try {
    payload = (await request.json()) as FigurePayload;
  } catch {
    return badRequest("Body is not JSON.");
  }

  const { title, period, source, columns, rows, image } = payload;
  if (typeof title !== "string" || !Array.isArray(columns) || !Array.isArray(rows)) {
    return badRequest("Expected title, columns and rows.");
  }
  if (columns.length === 0 || columns.length > MAX_COLUMNS) {
    return badRequest(`columns must be between 1 and ${MAX_COLUMNS}.`);
  }
  if (rows.length > MAX_ROWS) {
    return badRequest(`rows must be at most ${MAX_ROWS}.`);
  }
  if (image && image.base64.length * 0.75 > MAX_IMAGE_BYTES) {
    return badRequest("image is too large.");
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AMRSS";
  workbook.created = new Date();

  const data = workbook.addWorksheet("Data");

  // A provenance block above the table, mirroring the CSV header, so the sheet
  // is self-describing when it is opened a year from now detached from the app.
  const meta: [string, string][] = [
    ["Figure", title],
    ...(period ? ([["Coverage period", period]] as [string, string][]) : []),
    ["Source", source ?? "AMRSS — Antimicrobial Resistance Surveillance System"],
    ["Downloaded", new Date().toISOString().slice(0, 10)],
  ];
  for (const [label, value] of meta) {
    const row = data.addRow([label, value]);
    row.getCell(1).font = { bold: true };
  }
  data.addRow([]);

  const header = data.addRow(columns);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F7A4D" } };
    cell.alignment = { vertical: "middle" };
  });

  for (const row of rows) {
    // null becomes a blank cell rather than the string "null".
    data.addRow(row.map((value) => (value === null ? null : value)));
  }

  columns.forEach((name, index) => {
    const longestValue = rows.reduce(
      (widest, row) => Math.max(widest, String(row[index] ?? "").length),
      name.length,
    );
    data.getColumn(index + 1).width = Math.min(48, Math.max(12, longestValue + 2));
  });
  data.views = [{ state: "frozen", ySplit: meta.length + 2 }];

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
