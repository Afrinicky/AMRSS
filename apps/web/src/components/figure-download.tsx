"use client";

import { useRef, useState } from "react";

/**
 * A figure that can be taken away — as a vector image, a high-resolution
 * raster, or the numbers behind it.
 *
 * This exists because the figures on this dashboard are meant to end up in
 * reports and papers, not only on a screen. Each of those three formats answers
 * a different downstream need:
 *
 *   SVG  the honest one for publication — vector, so it scales to any journal's
 *        column width without softening, and stays editable in Illustrator or
 *        Inkscape.
 *   PNG  for a slide or a Word document, where a vector is awkward. Rendered at
 *        three times display size so it is still crisp when enlarged.
 *   CSV  the data itself, so a reader can re-plot it, check it, or cite exact
 *        numbers rather than reading them off a bar.
 *
 * Every export carries its provenance — the title, the coverage period, and the
 * source — stamped into the image and written into the CSV header. A figure
 * that travels without saying what it is and when it covers is a figure that
 * gets misattributed, and in surveillance that is not a small thing.
 */

/** The numbers behind a figure, ready to become a CSV a reader can cite. */
export interface FigureData {
  /** Column headers, in order. */
  columns: string[];
  /** One array per row, aligned to `columns`. */
  rows: (string | number | null)[][];
}

export interface FigureDownloadProps {
  /** Names the figure in every format and in the downloaded file name. */
  title: string;
  /** The coverage period, e.g. "13 Aug 2025 – 11 Aug 2026". Stamped for
   *  provenance; a surveillance figure without its period is unattributable. */
  period?: string;
  /** Who produced it, for the attribution line. */
  source?: string;
  /** The numbers, when the figure has a table behind it. Omit to hide CSV. */
  data?: FigureData;
  children: React.ReactNode;
}

/** The visual properties that must survive leaving the page.
 *
 * The figures colour themselves with CSS custom properties — `fill:
 * var(--color-sir-r)` and the like — which resolve against `:root` and mean
 * nothing to an SVG that has been lifted out of the document. Left alone, an
 * exported chart comes out with black or missing bars. `getComputedStyle`
 * resolves each variable to a concrete colour, and copying the resolved value
 * onto the clone makes the export look exactly like the screen. */
const CARRIED_STYLES = [
  "fill",
  "stroke",
  "stroke-width",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "opacity",
  "text-decoration",
] as const;

function inlineComputedStyles(source: SVGElement, clone: SVGElement): void {
  const computed = window.getComputedStyle(source);
  const declarations = CARRIED_STYLES.map((property) => {
    const value = computed.getPropertyValue(property);
    // Drop the original presentation attribute we are resolving, so the
    // exported file carries only concrete colours — no dangling
    // `fill="var(--color-sir-r)"` that means nothing outside this page. The
    // inline style below would win at render either way, but a publication
    // file should be clean, not merely correct.
    if (value && clone.hasAttribute(property)) clone.removeAttribute(property);
    return value ? `${property}:${value}` : "";
  })
    .filter(Boolean)
    .join(";");
  if (declarations) clone.setAttribute("style", declarations);

  const sourceChildren = source.children;
  const cloneChildren = clone.children;
  for (let index = 0; index < sourceChildren.length; index += 1) {
    inlineComputedStyles(
      sourceChildren[index] as SVGElement,
      cloneChildren[index] as SVGElement,
    );
  }
}

/** A standalone, self-describing copy of the on-screen SVG.
 *
 * The clone gets an explicit white background (the page's surface is a theme
 * token that would export as nothing), a namespace so a browser opens the file
 * directly, and a provenance footer beneath the artwork. */
function buildExportSvg(
  live: SVGSVGElement,
  { title, period, source }: { title: string; period?: string; source?: string },
): SVGSVGElement {
  const clone = live.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(live, clone);

  const viewBox = (live.getAttribute("viewBox") ?? "0 0 800 400").split(/\s+/).map(Number);
  const [, , vbWidth, vbHeight] = viewBox;
  const footerLines = [title, period, source].filter(Boolean) as string[];
  const footerHeight = 16 + footerLines.length * 14;

  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("viewBox", `0 0 ${vbWidth} ${vbHeight + footerHeight}`);
  clone.setAttribute("width", String(vbWidth));
  clone.setAttribute("height", String(vbHeight + footerHeight));
  clone.removeAttribute("style");

  const ns = "http://www.w3.org/2000/svg";
  const background = document.createElementNS(ns, "rect");
  background.setAttribute("x", "0");
  background.setAttribute("y", "0");
  background.setAttribute("width", String(vbWidth));
  background.setAttribute("height", String(vbHeight + footerHeight));
  background.setAttribute("fill", "#ffffff");
  clone.insertBefore(background, clone.firstChild);

  footerLines.forEach((line, index) => {
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", "4");
    text.setAttribute("y", String(vbHeight + 14 + index * 14));
    text.setAttribute("font-size", index === 0 ? "12" : "10");
    text.setAttribute("font-family", "system-ui, sans-serif");
    text.setAttribute("font-weight", index === 0 ? "600" : "400");
    text.setAttribute("fill", index === 0 ? "#1a1a1a" : "#666666");
    text.textContent = line;
    clone.appendChild(text);
  });

  return clone;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick, not synchronously: some browsers have not started
  // reading the blob by the time click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "figure"
  );
}

/** RFC 4180 quoting: wrap in quotes when the value could break a cell, and
 *  double any quotes inside it. A facility named `St John's, Sunyani` must not
 *  become two columns. */
function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function FigureDownload({
  title,
  period,
  source = "AMRSS — Antimicrobial Resistance Surveillance System",
  data,
  children,
}: FigureDownloadProps) {
  const content = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Scoped to the content region, never the whole component: the toolbar's own
  // download-arrow icon is also an <svg>, and it renders first, so a query
  // across the whole component would export the icon instead of the chart.
  const liveSvg = () => content.current?.querySelector("svg") ?? null;

  function downloadSvg(): void {
    const svg = liveSvg();
    if (!svg) return;
    const exported = buildExportSvg(svg, { title, period, source });
    const markup = new XMLSerializer().serializeToString(exported);
    triggerDownload(
      new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${markup}`], {
        type: "image/svg+xml",
      }),
      `${slugify(title)}.svg`,
    );
  }

  async function downloadPng(): Promise<void> {
    const svg = liveSvg();
    if (!svg) return;
    setBusy(true);
    try {
      const exported = buildExportSvg(svg, { title, period, source });
      const width = Number(exported.getAttribute("width"));
      const height = Number(exported.getAttribute("height"));
      const markup = new XMLSerializer().serializeToString(exported);
      const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

      const scale = 3; // crisp when enlarged in a slide or on paper
      const image = new Image();
      image.width = width;
      image.height = height;
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("SVG could not be rasterised"));
        image.src = svgUrl;
      });

      const canvas = document.createElement("canvas");
      canvas.width = width * scale;
      canvas.height = height * scale;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable");
      context.scale(scale, scale);
      context.drawImage(image, 0, 0);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (blob) triggerDownload(blob, `${slugify(title)}.png`);
    } finally {
      setBusy(false);
    }
  }

  function downloadCsv(): void {
    if (!data) return;
    // A header block, commented with '#', carries the same provenance the image
    // does. A reader opening the CSV a year later still knows what it is.
    const preamble = [
      `# ${title}`,
      period ? `# Coverage period: ${period}` : "",
      `# Source: ${source}`,
      `# Downloaded: ${new Date().toISOString().slice(0, 10)}`,
    ].filter(Boolean);
    const body = [
      data.columns.map(csvCell).join(","),
      ...data.rows.map((row) => row.map(csvCell).join(",")),
    ];
    triggerDownload(
      new Blob([[...preamble, "", ...body].join("\n")], { type: "text/csv;charset=utf-8" }),
      `${slugify(title)}.csv`,
    );
  }

  return (
    <div className="relative">
      <div className="mb-2 flex justify-end">
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-haspopup="menu"
            aria-expanded={open}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink"
          >
            <DownloadIcon />
            {busy ? "Preparing…" : "Download"}
          </button>

          {open ? (
            <>
              {/* A click anywhere else closes the menu without a global listener. */}
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                onClick={() => setOpen(false)}
                className="fixed inset-0 z-10 cursor-default"
              />
              <div
                role="menu"
                className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
              >
                <MenuItem
                  onClick={() => {
                    setOpen(false);
                    downloadSvg();
                  }}
                  label="Vector image (SVG)"
                  hint="For publication — scales without loss"
                />
                <MenuItem
                  onClick={() => {
                    setOpen(false);
                    void downloadPng();
                  }}
                  label="Image (PNG)"
                  hint="For slides and documents — high resolution"
                />
                {data ? (
                  <MenuItem
                    onClick={() => {
                      setOpen(false);
                      downloadCsv();
                    }}
                    label="Data (CSV)"
                    hint="The numbers behind the figure"
                  />
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div ref={content}>{children}</div>
    </div>
  );
}

function MenuItem({
  onClick,
  label,
  hint,
}: {
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full px-3 py-2 text-left hover:bg-surface-muted"
    >
      <span className="block text-sm text-ink">{label}</span>
      <span className="block text-xs text-ink-muted">{hint}</span>
    </button>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
