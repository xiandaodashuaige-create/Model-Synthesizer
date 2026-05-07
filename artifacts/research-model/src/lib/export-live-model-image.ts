// PNG export of the live model — drawn directly from the data, NOT from the
// rendered DOM.
//
// Why we don't use html-to-image / dom-to-image any more: those libraries walk
// `document.styleSheets`, attempt to inline every CSS rule, and fetch external
// resources (background-images, @font-face URLs). On Replit they consistently
// fail because:
//   (a) the dev preview is iframed under a different origin than the page's
//       Google Fonts CSS, so reading `.cssRules` throws a SecurityError,
//   (b) Replit's proxy occasionally returns 520 for the font/image fetches,
//       which the cloning library surfaces as a hard crash,
//   (c) any single SecurityError or network failure aborts the whole snapshot,
//       producing a blank or zero-byte PNG with no useful error.
//
// This module sidesteps all of that. We render an SVG string from the live
// model's typed nodes/edges, then rasterize it through a self-contained
// `<img src="data:image/svg+xml,…"> → <canvas>.drawImage → toDataURL` pipeline.
// Because the SVG embeds NO external resources (no <image href>, no @font-face
// imports, no @import urls), the canvas never gets tainted and `toDataURL`
// succeeds in every browser.
//
// The layout intentionally mirrors `EditableModelGraph`'s look (rounded boxes,
// colour-coded by variable type, bezier edges with arrow markers, dashed
// moderator lines that land on the midpoint of the path they moderate) so the
// exported figure is recognisable as the same model the user just curated.

const NODE_W = 200;
const NODE_H = 64;
const PADDING = 60;

const TYPE_COLORS: Record<string, { border: string; fill: string }> = {
  independent: { border: "#2563eb", fill: "#dbeafe" },
  mediator:    { border: "#d97706", fill: "#fef3c7" },
  moderator:   { border: "#7c3aed", fill: "#ede9fe" },
  dependent:   { border: "#16a34a", fill: "#dcfce7" },
};
const DEFAULT_COLOR = { border: "#475569", fill: "#f1f5f9" };

const REL_LABEL: Record<string, string> = {
  positive: "+",
  negative: "−",
  mediates:  "→",
  moderates: "M",
};

const REL_COLOR: Record<string, string> = {
  positive:  "#16a34a",
  negative:  "#dc2626",
  mediates:  "#0f172a",
  moderates: "#7c3aed",
};

export interface ExportNode {
  id: number;
  variableId: number;
  variableName: string;
  variableType: string;
  positionX: number | null;
  positionY: number | null;
}

export interface ExportEdge {
  id: number;
  fromVariableId: number;
  toVariableId: number;
  relationship: "positive" | "negative" | "mediates" | "moderates";
  moderatesEdgeId?: number | null;
  hTag?: string;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "\"": return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// Decide x/y for every node. Two cases:
//   1. The user has dragged at least one node — use persisted coordinates and
//      grid-fill the rest beneath the bounding box. This matches what
//      `EditableModelGraph` does on first paint.
//   2. Nothing has been dragged yet — fall back to a deterministic columnar
//      layout by variable type (independent → mediator → moderator →
//      dependent). We deliberately avoid pulling dagre into this code path
//      because the export must work even if the user has never opened the
//      live-model page (e.g. exporting straight from a freshly imported model).
function layoutNodes(
  nodes: ExportNode[],
): Map<number, { x: number; y: number }> {
  const out = new Map<number, { x: number; y: number }>();
  if (nodes.length === 0) return out;

  const hasAnyPersisted = nodes.some(
    (n) => typeof n.positionX === "number" && typeof n.positionY === "number",
  );
  if (hasAnyPersisted) {
    const pinned = nodes.filter(
      (n) => typeof n.positionX === "number" && typeof n.positionY === "number",
    );
    const maxY = pinned.reduce((m, n) => Math.max(m, (n.positionY as number) + NODE_H), 0);
    const minX = pinned.reduce((m, n) => Math.min(m, n.positionX as number), Infinity);
    const baseX = Number.isFinite(minX) ? minX : 24;
    let i = 0;
    for (const n of nodes) {
      if (typeof n.positionX === "number" && typeof n.positionY === "number") {
        out.set(n.id, { x: n.positionX, y: n.positionY });
      } else {
        out.set(n.id, {
          x: baseX + (i % 4) * (NODE_W + 24),
          y: maxY + 40 + Math.floor(i / 4) * (NODE_H + 24),
        });
        i++;
      }
    }
    return out;
  }

  const colOf: Record<string, number> = { independent: 0, mediator: 1, moderator: 2, dependent: 3 };
  const COL_GAP = NODE_W + 80;
  const ROW_GAP = NODE_H + 28;
  const buckets = new Map<number, ExportNode[]>();
  for (const n of nodes) {
    const c = colOf[n.variableType] ?? 0;
    const arr = buckets.get(c) ?? [];
    arr.push(n);
    buckets.set(c, arr);
  }
  for (const [col, list] of buckets) {
    list.forEach((n, row) => out.set(n.id, { x: col * COL_GAP, y: row * ROW_GAP }));
  }
  return out;
}

function labelBubble(x: number, y: number, sym: string, color: string, hTag?: string): string {
  const text = hTag ? `${hTag} ${sym}` : sym;
  if (!text.trim()) return "";
  const w = 14 + text.length * 7;
  const h = 18;
  const rx = x - w / 2;
  const ry = y - h / 2;
  return (
    `<g>` +
      `<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${w}" height="${h}" rx="9" ry="9" fill="#ffffff" stroke="${color}" stroke-width="1"/>` +
      `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-size="11" fill="${color}" font-weight="600">${escapeXml(text)}</text>` +
    `</g>`
  );
}

export function renderModelSvg(
  rawNodes: ExportNode[],
  rawEdges: ExportEdge[],
  opts: { title?: string } = {},
): string {
  const positions = layoutNodes(rawNodes);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of rawNodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x + NODE_W > maxX) maxX = p.x + NODE_W;
    if (p.y + NODE_H > maxY) maxY = p.y + NODE_H;
  }
  if (!isFinite(minX)) {
    minX = 0; minY = 0; maxX = NODE_W; maxY = NODE_H;
  }
  const titleHeight = opts.title ? 32 : 0;
  const width = Math.ceil(maxX - minX + PADDING * 2);
  const height = Math.ceil(maxY - minY + PADDING * 2 + titleHeight);
  const ox = PADDING - minX;
  const oy = PADDING - minY + titleHeight;

  const variableIdToNodeId = new Map<number, number>();
  for (const n of rawNodes) variableIdToNodeId.set(n.variableId, n.id);

  const centerOf = (variableId: number): { cx: number; cy: number } | null => {
    const nid = variableIdToNodeId.get(variableId);
    if (nid == null) return null;
    const p = positions.get(nid);
    if (!p) return null;
    return { cx: ox + p.x + NODE_W / 2, cy: oy + p.y + NODE_H / 2 };
  };

  const edgeMid = new Map<number, { x: number; y: number }>();
  for (const e of rawEdges) {
    if (e.relationship === "moderates") continue;
    const a = centerOf(e.fromVariableId);
    const b = centerOf(e.toVariableId);
    if (!a || !b) continue;
    edgeMid.set(e.id, { x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2 });
  }

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<defs>`);
  for (const rel of Object.keys(REL_COLOR)) {
    const c = REL_COLOR[rel];
    parts.push(
      `<marker id="arrow-${rel}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">` +
        `<path d="M0,0 L10,5 L0,10 z" fill="${c}"/>` +
      `</marker>`,
    );
  }
  parts.push(`</defs>`);

  if (opts.title) {
    parts.push(
      `<text x="${PADDING}" y="${PADDING - 8}" font-size="15" fill="#0f172a" font-weight="600">${escapeXml(opts.title)}</text>`,
    );
  }

  // Edges drawn first so node rectangles paint on top.
  for (const e of rawEdges) {
    const color = REL_COLOR[e.relationship] ?? "#0f172a";
    if (e.relationship === "moderates") {
      const a = centerOf(e.fromVariableId);
      if (!a) continue;
      // Preferred target: the midpoint of the path this moderator conditions.
      // Fallbacks (in order): the midpoint of any non-moderator edge landing
      // on the recorded `toVariableId`, then the centre of `toVariableId`
      // itself. Without this fallback chain a single dangling FK silently
      // drops the moderator from the export — diverges from canvas behaviour
      // which always renders something for every edge.
      let tx: number | null = null;
      let ty: number | null = null;
      if (e.moderatesEdgeId != null) {
        const target = edgeMid.get(Number(e.moderatesEdgeId));
        if (target) { tx = target.x; ty = target.y; }
      }
      if (tx == null || ty == null) {
        const fallbackEdge = rawEdges.find(
          (oe) => oe.relationship !== "moderates" && oe.toVariableId === e.toVariableId,
        );
        if (fallbackEdge) {
          const fm = edgeMid.get(fallbackEdge.id);
          if (fm) { tx = fm.x; ty = fm.y; }
        }
      }
      if (tx == null || ty == null) {
        const c = centerOf(e.toVariableId);
        if (c) { tx = c.cx; ty = c.cy; }
      }
      if (tx == null || ty == null) continue;
      parts.push(
        `<line x1="${a.cx.toFixed(1)}" y1="${a.cy.toFixed(1)}" x2="${tx.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="${color}" stroke-width="1.5" stroke-dasharray="6 4"/>`,
      );
      parts.push(
        labelBubble((a.cx + tx) / 2, (a.cy + ty) / 2, REL_LABEL["moderates"]!, color, e.hTag),
      );
      continue;
    }
    const a = centerOf(e.fromVariableId);
    const b = centerOf(e.toVariableId);
    if (!a || !b) continue;
    const dx = Math.max(40, Math.abs(b.cx - a.cx) / 2);
    const c1x = a.cx + dx, c1y = a.cy;
    const c2x = b.cx - dx, c2y = b.cy;
    parts.push(
      `<path d="M${a.cx.toFixed(1)},${a.cy.toFixed(1)} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${b.cx.toFixed(1)},${b.cy.toFixed(1)}" fill="none" stroke="${color}" stroke-width="1.8" marker-end="url(#arrow-${e.relationship})"/>`,
    );
    parts.push(
      labelBubble((a.cx + b.cx) / 2, (a.cy + b.cy) / 2, REL_LABEL[e.relationship] ?? "", color, e.hTag),
    );
  }

  // Nodes.
  for (const n of rawNodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    const x = ox + p.x;
    const y = oy + p.y;
    const colors = TYPE_COLORS[n.variableType] ?? DEFAULT_COLOR;
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${NODE_W}" height="${NODE_H}" rx="8" ry="8" fill="${colors.fill}" stroke="${colors.border}" stroke-width="1.5"/>`,
    );
    parts.push(
      `<text x="${(x + 8).toFixed(1)}" y="${(y + 14).toFixed(1)}" font-size="9" fill="${colors.border}" font-weight="700">${escapeXml(n.variableType.toUpperCase())}</text>`,
    );
    parts.push(
      `<text x="${(x + NODE_W / 2).toFixed(1)}" y="${(y + NODE_H / 2 + 6).toFixed(1)}" text-anchor="middle" font-size="14" fill="#0f172a">${escapeXml(truncate(n.variableName, 22))}</text>`,
    );
  }

  parts.push(`</svg>`);
  return parts.join("");
}

// Convert an SVG string to a PNG data URL. Self-contained: no external fetches,
// no canvas tainting. Works in every modern browser.
export async function svgToPngDataUrl(svg: string, scale: number = 2): Promise<string> {
  const widthMatch = svg.match(/<svg[^>]*\swidth="(\d+)"/);
  const heightMatch = svg.match(/<svg[^>]*\sheight="(\d+)"/);
  const w = widthMatch ? parseInt(widthMatch[1]!, 10) : 1024;
  const h = heightMatch ? parseInt(heightMatch[1]!, 10) : 768;

  // data: URLs sidestep blob: tainting issues that some Chromium builds still
  // hit when the SVG contains foreignObject — which we don't, but defensive.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("SVG image load failed"));
    im.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w * scale));
  canvas.height = Math.max(1, Math.ceil(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
