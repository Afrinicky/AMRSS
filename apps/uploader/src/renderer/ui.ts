/**
 * The renderer's building blocks.
 *
 * Two rules run through everything here:
 *
 * 1. **Nothing reaches the DOM as markup.** Every value goes in through
 *    `textContent`. A patient comment typed into WHONET is displayed text, not
 *    HTML, and there is no code path in this application that would treat it
 *    otherwise.
 * 2. **A number is never shown without what it is out of.** Percentages carry
 *    their denominators, suppressed cells say why they are suppressed, and a
 *    figure computed over too few isolates is marked rather than drawn as if it
 *    were solid.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string | number | null;
    title?: string;
    html?: never;
    attrs?: Record<string, string>;
    onClick?: (event: Event) => void;
    children?: Array<Node | null | undefined>;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.title) node.title = options.title;
  for (const [name, value] of Object.entries(options.attrs ?? {})) node.setAttribute(name, value);
  if (options.onClick) node.addEventListener("click", options.onClick);
  for (const child of options.children ?? []) if (child) node.append(child);
  return node;
}

export function svg(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

/**
 * One navigation mark.
 *
 * Stroked on a 24-unit grid and inheriting `currentColor`, so a single set of
 * shapes works against the sidebar's rest, hover and active states, and in both
 * themes, without a second copy for either. `aria-hidden` because every icon
 * here sits beside its own label — announcing it again would read the menu
 * twice to anyone using a screen reader.
 */
export function icon(path: string, size = 18): SVGElement {
  const node = svg("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.6,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "icon",
  });
  node.append(svg("path", { d: path }));
  return node;
}

export function clear(node: HTMLElement): HTMLElement {
  node.replaceChildren();
  return node;
}

/* --- Formatting -------------------------------------------------------- */

export function percent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return "never";
  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/* --- Structure ---------------------------------------------------------- */

export function card(title: string, note?: string, ...children: Array<Node | null>): HTMLElement {
  const node = el("section", { className: "card" });
  if (title) node.append(el("h3", { text: title }));
  if (note) node.append(el("p", { className: "card-note", text: note }));
  for (const child of children) if (child) node.append(child);
  return node;
}

export function stat(
  label: string,
  value: string | number,
  hint?: string | null,
): HTMLElement {
  return el("div", {
    className: "stat",
    children: [
      el("div", { className: "label", text: label }),
      el("div", {
        // A figure gets display size; a phrase does not. The cut is at nine
        // characters because that is where a number stops being one — "1,234,567"
        // still reads as a quantity, "WHONET 2025" is a label wearing a number's
        // clothes and looks absurd at 25px.
        className: String(value).length > 9 ? "value long" : "value",
        text: value,
      }),
      hint ? el("div", { className: "hint", text: hint }) : null,
    ],
  });
}

export function statRow(...stats: HTMLElement[]): HTMLElement {
  return el("div", { className: "stat-row", children: stats });
}

export function notice(tone: "ok" | "warn" | "bad" | "info", message: string): HTMLElement {
  return el("div", { className: `notice ${tone}`, text: message });
}

export function badge(tone: "ok" | "warn" | "bad" | "", text: string): HTMLElement {
  return el("span", { className: `badge ${tone}`.trim(), text });
}

export function empty(message: string): HTMLElement {
  return el("div", { className: "empty", text: message });
}

export function definitionList(entries: Array<[string, string | number | null]>): HTMLElement {
  const list = el("dl", { className: "dl" });
  for (const [term, value] of entries) {
    list.append(el("dt", { text: term }), el("dd", { text: value ?? "—" }));
  }
  return list;
}

export interface Column<T> {
  label: string;
  /** Rendered value. Return a node for anything richer than text. */
  value: (row: T) => string | number | null | Node;
  numeric?: boolean;
  sticky?: boolean;
  title?: string;
}

export function table<T>(columns: Array<Column<T>>, rows: T[], emptyMessage?: string): HTMLElement {
  if (rows.length === 0) return empty(emptyMessage ?? "Nothing to show yet.");

  const head = el("tr");
  for (const column of columns) {
    head.append(
      el("th", {
        text: column.label,
        title: column.title,
        className: [column.numeric ? "numeric" : "", column.sticky ? "sticky-col" : ""]
          .filter(Boolean)
          .join(" "),
      }),
    );
  }

  const body = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const column of columns) {
      const cell = el("td", {
        className: [column.numeric ? "numeric" : "", column.sticky ? "sticky-col" : ""]
          .filter(Boolean)
          .join(" "),
      });
      const value = column.value(row);
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value === null || value === undefined ? "—" : String(value);
      tr.append(cell);
    }
    body.append(tr);
  }

  return el("div", {
    className: "table-wrap",
    children: [
      el("table", { children: [el("thead", { children: [head] }), body] }),
    ],
  });
}

export function sirCell(category: string | null, title?: string): HTMLElement {
  if (!category) return el("span", { text: "" });
  return el("span", { className: `sir sir-${category}`, text: category, title });
}

/* --- Inputs ------------------------------------------------------------- */

export function field(
  label: string,
  input: HTMLElement,
  help?: string,
): HTMLElement {
  return el("div", {
    className: "field",
    children: [
      el("label", { text: label }),
      input,
      help ? el("div", { className: "help", text: help }) : null,
    ],
  });
}

export function textInput(
  value: string | null,
  options: { placeholder?: string; type?: string; onInput?: (value: string) => void } = {},
): HTMLInputElement {
  const input = el("input");
  input.type = options.type ?? "text";
  input.value = value ?? "";
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.onInput) {
    input.addEventListener("input", () => options.onInput!(input.value));
  }
  return input;
}

export function select(
  options: Array<{ value: string; label: string }>,
  selected: string | null,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = el("select");
  for (const option of options) {
    const item = el("option", { text: option.label });
    item.value = option.value;
    if (option.value === (selected ?? "")) item.selected = true;
    node.append(item);
  }
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

export function checkbox(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): HTMLElement {
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  const wrapper = el("label", { className: "small" });
  wrapper.style.display = "flex";
  wrapper.style.alignItems = "center";
  wrapper.style.color = "var(--ink)";
  wrapper.append(input, document.createTextNode(label));
  return wrapper;
}

export function button(
  label: string,
  onClick: () => void | Promise<void>,
  variant: "primary" | "default" | "ghost" | "danger" = "default",
  options: { small?: boolean; disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  const node = el("button", { text: label, title: options.title });
  node.className = [variant === "default" ? "" : variant, options.small ? "small" : ""]
    .filter(Boolean)
    .join(" ");
  node.disabled = Boolean(options.disabled);
  node.addEventListener("click", () => {
    void onClick();
  });
  return node;
}

export function segmented(
  options: Array<{ value: string; label: string }>,
  active: string,
  onChange: (value: string) => void,
): HTMLElement {
  const wrapper = el("div", { className: "segmented" });
  for (const option of options) {
    const node = el("button", {
      text: option.label,
      className: option.value === active ? "active" : "",
      onClick: () => onChange(option.value),
    });
    wrapper.append(node);
  }
  return wrapper;
}

export function subtabs(
  options: Array<{ value: string; label: string }>,
  active: string,
  onChange: (value: string) => void,
): HTMLElement {
  const wrapper = el("div", { className: "subtabs" });
  for (const option of options) {
    wrapper.append(
      el("button", {
        text: option.label,
        className: option.value === active ? "active" : "",
        onClick: () => onChange(option.value),
      }),
    );
  }
  return wrapper;
}

/* --- Feedback ------------------------------------------------------------ */

export function toast(message: string, tone: "ok" | "warn" | "bad" = "ok"): void {
  const host = document.getElementById("toasts");
  if (!host) return;
  const node = el("div", { className: `toast ${tone === "ok" ? "" : tone}`.trim(), text: message });
  host.append(node);
  setTimeout(() => node.remove(), tone === "bad" ? 9000 : 5000);
}

export function modal(
  title: string,
  body: HTMLElement,
  actions: HTMLElement[],
  options: { wide?: boolean } = {},
): () => void {
  const backdrop = el("div", { className: "modal-backdrop" });
  const dialog = el("div", {
    className: `modal${options.wide ? " wide" : ""}`,
    children: [
      el("h3", { text: title }),
      body,
      el("div", { className: "modal-actions", children: actions }),
    ],
  });
  backdrop.append(dialog);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  document.body.append(backdrop);

  function close(): void {
    backdrop.remove();
  }
  return close;
}

/* --- Figures -------------------------------------------------------------- *
 *
 * Drawn as inline SVG rather than through a charting library: three shapes are
 * needed, all of them simple, and a dependency that renders clinical data is a
 * dependency that has to be audited. Every figure states its denominator, and
 * anything below the reporting threshold is drawn muted with the count shown.
 */

export function barList(
  rows: Array<{ label: string; count: number; percent?: number | null; note?: string }>,
  options: { tone?: "brand" | "count" | "sir-s" | "sir-r"; suffix?: string } = {},
): HTMLElement {
  if (rows.length === 0) return empty("No data in this selection.");
  const max = Math.max(...rows.map((row) => row.count), 1);
  const wrapper = el("div");
  for (const row of rows) {
    const fill = el("div", { className: `bar-fill ${options.tone === "brand" ? "" : (options.tone ?? "")}`.trim() });
    fill.style.width = `${Math.max(2, (row.count / max) * 100)}%`;
    wrapper.append(
      el("div", {
        className: "bar-row",
        title: row.note,
        children: [
          el("div", { text: row.label, title: row.label }),
          el("div", { className: "bar-track", children: [fill] }),
          el("div", {
            className: "muted",
            text:
              row.percent === null || row.percent === undefined
                ? `${count(row.count)}${options.suffix ?? ""}`
                : `${count(row.count)} · ${percent(row.percent)}`,
          }),
        ],
      }),
    );
  }
  return wrapper;
}

export interface LinePoint {
  label: string;
  value: number | null;
  /** Sample size behind the point, drawn as a muted marker when it is thin. */
  denominator?: number;
  suppressed?: boolean;
}

export function lineChart(
  series: Array<{ name: string; points: LinePoint[]; color?: string }>,
  options: { yLabel?: string; height?: number; yMax?: number } = {},
): HTMLElement {
  const width = 720;
  const height = options.height ?? 260;
  const margin = { top: 16, right: 18, bottom: 34, left: 46 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const labels = series[0]?.points.map((point) => point.label) ?? [];
  if (labels.length === 0) return empty("Not enough dated results to draw a trend.");

  const yMax =
    options.yMax ??
    Math.max(
      10,
      ...series.flatMap((entry) => entry.points.map((point) => point.value ?? 0)),
    );

  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height });
  const plot = svg("g", { transform: `translate(${margin.left},${margin.top})` });

  for (let tick = 0; tick <= 4; tick += 1) {
    const y = innerHeight - (tick / 4) * innerHeight;
    plot.append(
      svg("line", {
        x1: 0,
        x2: innerWidth,
        y1: y,
        y2: y,
        stroke: "var(--line)",
        "stroke-width": 1,
      }),
    );
    const label = svg("text", { x: -8, y: y + 4, "text-anchor": "end" });
    label.textContent = String(Math.round((tick / 4) * yMax));
    plot.append(label);
  }

  const step = labels.length > 1 ? innerWidth / (labels.length - 1) : 0;
  labels.forEach((label, index) => {
    if (labels.length > 12 && index % Math.ceil(labels.length / 12) !== 0) return;
    const text = svg("text", {
      x: index * step,
      y: innerHeight + 20,
      "text-anchor": "middle",
    });
    text.textContent = label;
    plot.append(text);
  });

  const palette = ["var(--series-1)", "var(--series-2)", "var(--series-4)"];
  series.forEach((entry, seriesIndex) => {
    const color = entry.color ?? palette[seriesIndex % palette.length]!;
    const drawn = entry.points
      .map((point, index) => ({ point, index }))
      .filter((item) => item.point.value !== null);

    const path = drawn
      .map(
        (item, position) =>
          `${position === 0 ? "M" : "L"}${item.index * step},${
            innerHeight - ((item.point.value ?? 0) / yMax) * innerHeight
          }`,
      )
      .join(" ");

    if (path) {
      plot.append(
        svg("path", { d: path, fill: "none", stroke: color, "stroke-width": 2 }),
      );
    }

    for (const item of drawn) {
      const marker = svg("circle", {
        cx: item.index * step,
        cy: innerHeight - ((item.point.value ?? 0) / yMax) * innerHeight,
        r: item.point.suppressed ? 2.5 : 3.5,
        fill: item.point.suppressed ? "var(--surface)" : color,
        stroke: color,
        "stroke-width": 1.5,
      });
      const title = svg("title");
      title.textContent = `${item.point.label}: ${
        item.point.value === null ? "—" : item.point.value.toFixed(1)
      }${options.yLabel ? ` ${options.yLabel}` : ""}${
        item.point.denominator ? ` (n=${item.point.denominator})` : ""
      }`;
      marker.append(title);
      plot.append(marker);
    }
  });

  root.append(plot);

  const legend = el("div", { className: "legend" });
  series.forEach((entry, index) => {
    const swatch = el("span", { className: "swatch" });
    swatch.style.background = entry.color ?? palette[index % palette.length]!;
    legend.append(el("span", { children: [swatch, document.createTextNode(entry.name)] }));
  });

  return el("div", {
    className: "chart",
    children: [root, legend],
  });
}

export function donut(
  slices: Array<{ label: string; value: number; color?: string }>,
  centreLabel: string,
): HTMLElement {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total === 0) return empty("No data in this selection.");

  const size = 190;
  const radius = 74;
  const thickness = 22;
  const root = svg("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size });
  const palette = [
    "var(--series-1)",
    "var(--series-2)",
    "var(--series-3)",
    "var(--series-4)",
    "var(--series-5)",
    "var(--series-6)",
  ];

  let angle = -Math.PI / 2;
  slices.forEach((slice, index) => {
    const sweep = (slice.value / total) * Math.PI * 2;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const centre = size / 2;
    const path = svg("path", {
      d: [
        `M ${centre + radius * Math.cos(angle)} ${centre + radius * Math.sin(angle)}`,
        `A ${radius} ${radius} 0 ${large} 1 ${centre + radius * Math.cos(end)} ${
          centre + radius * Math.sin(end)
        }`,
      ].join(" "),
      fill: "none",
      stroke: slice.color ?? palette[index % palette.length]!,
      "stroke-width": thickness,
    });
    const title = svg("title");
    title.textContent = `${slice.label}: ${count(slice.value)} (${percent(
      (slice.value / total) * 100,
    )})`;
    path.append(title);
    root.append(path);
    angle = end;
  });

  const label = svg("text", {
    x: size / 2,
    y: size / 2 + 4,
    "text-anchor": "middle",
    "font-size": 15,
    fill: "var(--ink)",
  });
  label.textContent = centreLabel;
  root.append(label);

  const legend = el("div", { className: "legend" });
  slices.forEach((slice, index) => {
    const swatch = el("span", { className: "swatch" });
    swatch.style.background = slice.color ?? palette[index % palette.length]!;
    legend.append(
      el("span", {
        children: [swatch, document.createTextNode(`${slice.label} · ${count(slice.value)}`)],
      }),
    );
  });

  return el("div", { className: "chart", children: [root, legend] });
}

/** A single alert tone, used only when the connection drops. Generated rather
 * than shipped as an audio file: one oscillator is smaller, has no codec, and
 * cannot be mistaken for a resource the application fetches. */
export function beep(): void {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.32);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.34);
    oscillator.onended = () => void context.close();
  } catch {
    /* audio unavailable on this workstation — the red indicator still shows */
  }
}
