import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
  AlignmentType,
} from "docx";

// Minimal shape we need from the live-model GET response. We deliberately
// don't import the generated client type so this helper compiles even if
// the API spec is regenerated with extra optional fields.
export interface LiveModelEdge {
  id: number;
  fromVariableName: string;
  toVariableName: string;
  relationship: string;
  hasProvenance?: boolean;
  provenanceCitationText?: string | null;
  provenancePaperTitle?: string | null;
  provenancePaperAuthors?: string[] | null;
  provenancePaperYear?: number | null;
  userAdded?: boolean;
}
export interface LiveModelNode {
  id: number;
  variableName: string;
  variableType: string;
}
export interface LiveModelDetail {
  nodes: LiveModelNode[];
  edges: LiveModelEdge[];
  unsupportedEdgeCount?: number;
}

const REL_LABEL: Record<string, string> = {
  positive: "+ (positive)",
  negative: "− (negative)",
  moderates: "M (moderates)",
  mediates: "→ (mediates)",
};

const TYPE_LABEL: Record<string, string> = {
  independent: "IV",
  mediator: "Med",
  moderator: "Mod",
  dependent: "DV",
};

function safeFilename(s: string): string {
  return (s || "research-model").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 80) || "research-model";
}

function nowDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatProvenance(e: LiveModelEdge): string {
  if (!e.hasProvenance || !e.provenanceCitationText) return "(no source attached)";
  const author = (e.provenancePaperAuthors ?? [])[0] ?? "Unknown";
  const yr = e.provenancePaperYear ? `, ${e.provenancePaperYear}` : "";
  const title = e.provenancePaperTitle ? ` — ${e.provenancePaperTitle}` : "";
  return `"${e.provenanceCitationText}" (${author}${yr}${title})`;
}

export function buildMarkdown(detail: LiveModelDetail, sessionName: string): string {
  const lines: string[] = [];
  lines.push(`# ${sessionName || "Research Model"}`);
  lines.push("");
  lines.push(`_Exported on ${nowDate()} from Research Model Builder._`);
  lines.push("");
  lines.push(`**Summary:** ${detail.nodes.length} variables, ${detail.edges.length} relationships` +
    (detail.unsupportedEdgeCount ? `, ${detail.unsupportedEdgeCount} without source` : "") + ".");
  lines.push("");

  lines.push("## Variables");
  lines.push("");
  if (detail.nodes.length === 0) {
    lines.push("_(none)_");
  } else {
    lines.push("| # | Variable | Role |");
    lines.push("|---|---|---|");
    detail.nodes.forEach((n, i) => {
      lines.push(`| ${i + 1} | ${n.variableName} | ${TYPE_LABEL[n.variableType] ?? n.variableType} |`);
    });
  }
  lines.push("");

  lines.push("## Relationships");
  lines.push("");
  if (detail.edges.length === 0) {
    lines.push("_(none)_");
  } else {
    detail.edges.forEach((e, i) => {
      const tag = `H${i + 1}`;
      lines.push(`### ${tag}. ${e.fromVariableName} ${REL_LABEL[e.relationship] ?? e.relationship} ${e.toVariableName}`);
      lines.push("");
      lines.push(`- **Relationship:** ${REL_LABEL[e.relationship] ?? e.relationship}`);
      if (e.userAdded) lines.push(`- **Source:** manually added by the researcher`);
      lines.push(`- **Evidence:** ${formatProvenance(e)}`);
      lines.push("");
    });
  }

  return lines.join("\n");
}

export async function buildDocxBlob(detail: LiveModelDetail, sessionName: string): Promise<Blob> {
  const heading = (text: string, level: typeof HeadingLevel[keyof typeof HeadingLevel]) =>
    new Paragraph({ heading: level, children: [new TextRun({ text })] });
  const para = (text: string, opts: { italic?: boolean; bold?: boolean } = {}) =>
    new Paragraph({ children: [new TextRun({ text, italics: opts.italic, bold: opts.bold })] });

  const headerCell = (text: string) =>
    new TableCell({
      width: { size: 33, type: WidthType.PERCENTAGE },
      children: [new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text, bold: true })] })],
    });
  const cell = (text: string) =>
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text })] })] });

  const variableTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: [headerCell("#"), headerCell("Variable"), headerCell("Role")] }),
      ...detail.nodes.map((n, i) => new TableRow({
        children: [cell(String(i + 1)), cell(n.variableName), cell(TYPE_LABEL[n.variableType] ?? n.variableType)],
      })),
    ],
  });

  const edgeBlocks: Paragraph[] = [];
  detail.edges.forEach((e, i) => {
    const tag = `H${i + 1}`;
    edgeBlocks.push(new Paragraph({
      heading: HeadingLevel.HEADING_3,
      children: [new TextRun({ text: `${tag}. ${e.fromVariableName} ${REL_LABEL[e.relationship] ?? e.relationship} ${e.toVariableName}` })],
    }));
    edgeBlocks.push(new Paragraph({ children: [
      new TextRun({ text: "Relationship: ", bold: true }),
      new TextRun({ text: REL_LABEL[e.relationship] ?? e.relationship }),
    ] }));
    if (e.userAdded) {
      edgeBlocks.push(para("Source: manually added by the researcher", { italic: true }));
    }
    edgeBlocks.push(new Paragraph({ children: [
      new TextRun({ text: "Evidence: ", bold: true }),
      new TextRun({ text: formatProvenance(e) }),
    ] }));
    edgeBlocks.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
  });

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        heading(sessionName || "Research Model", HeadingLevel.TITLE),
        para(`Exported on ${nowDate()} from Research Model Builder.`, { italic: true }),
        para(`Summary: ${detail.nodes.length} variables, ${detail.edges.length} relationships` +
          (detail.unsupportedEdgeCount ? `, ${detail.unsupportedEdgeCount} without source` : "") + "."),
        new Paragraph({ children: [new TextRun({ text: "" })] }),
        heading("Variables", HeadingLevel.HEADING_1),
        ...(detail.nodes.length === 0 ? [para("(none)", { italic: true })] : [variableTable]),
        new Paragraph({ children: [new TextRun({ text: "" })] }),
        heading("Relationships", HeadingLevel.HEADING_1),
        ...(detail.edges.length === 0 ? [para("(none)", { italic: true })] : edgeBlocks),
      ],
    }],
  });

  return await Packer.toBlob(doc);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on next tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportMarkdown(detail: LiveModelDetail, sessionName: string): string {
  const md = buildMarkdown(detail, sessionName);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const filename = `${safeFilename(sessionName)}.md`;
  downloadBlob(blob, filename);
  return filename;
}

export async function exportDocx(detail: LiveModelDetail, sessionName: string): Promise<string> {
  const blob = await buildDocxBlob(detail, sessionName);
  const filename = `${safeFilename(sessionName)}.docx`;
  downloadBlob(blob, filename);
  return filename;
}
