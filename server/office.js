// Plain-text extraction from docx / xlsx / pptx (zip + XML), no heavy deps.
import { unzipSync, strFromU8 } from "fflate";

const decode = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&");

function docxText(xml) {
  return decode(xml
    .replace(/<\/w:p>\s*<\/w:tc>/g, "</w:tc>").replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:tc>/g, "\t").replace(/<\/w:tr>/g, "\n").replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
}

function colIndex(ref) {
  const letters = ref.replace(/\d+/g, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxText(files) {
  const shared = [];
  const ss = files["xl/sharedStrings.xml"];
  if (ss) {
    for (const si of strFromU8(ss).match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(decode((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
    }
  }
  const wb = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : "";
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => decode(m[1]));
  const sheets = Object.keys(files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort((a, b) => +a.match(/(\d+)\.xml/)[1] - +b.match(/(\d+)\.xml/)[1]);
  const out = [];
  sheets.forEach((f, i) => {
    out.push(`### ${names[i] || f}`);
    const xml = strFromU8(files[f]);
    for (const row of xml.match(/<row[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const ref = (c.match(/ r="([A-Z]+\d+)"/) || [])[1];
        const t = (c.match(/ t="(\w+)"/) || [])[1];
        let v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (t === "s" && v !== undefined) v = shared[+v];
        else if (t === "inlineStr") v = (c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
        if (v === undefined) continue;
        cells[ref ? colIndex(ref) : cells.length] = decode(String(v));
      }
      if (cells.length) out.push(Array.from(cells, (x) => x ?? "").join("\t"));
    }
  });
  return out.join("\n");
}

function pptxText(files) {
  return Object.keys(files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => +a.match(/(\d+)\.xml/)[1] - +b.match(/(\d+)\.xml/)[1])
    .map((f, i) => `### Slide ${i + 1}\n` + decode(strFromU8(files[f]).replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "")).trim())
    .join("\n\n");
}

export function extractOffice(ext, bytes) {
  try {
    const files = unzipSync(bytes);
    if (ext === "docx") return files["word/document.xml"] ? docxText(strFromU8(files["word/document.xml"])) : null;
    if (ext === "xlsx") return xlsxText(files);
    if (ext === "pptx") return pptxText(files);
  } catch {
    return null;
  }
  return null;
}
