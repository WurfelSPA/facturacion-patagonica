import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

function parseCMap(cmapText) {
  const mapping = {};
  const rangeSection = cmapText.match(/beginbfrange([\s\S]*?)endbfrange/g) || [];
  for (const section of rangeSection) {
    const matches = section.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g);
    for (const [, s, e, d] of matches) {
      const si = parseInt(s,16), ei = parseInt(e,16), di = parseInt(d,16);
      for (let i = 0; i <= ei-si; i++) mapping[si+i] = String.fromCodePoint(di+i);
    }
  }
  const charSection = cmapText.match(/beginbfchar([\s\S]*?)endbfchar/g) || [];
  for (const section of charSection) {
    const matches = section.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g);
    for (const [, src, dst] of matches) {
      try {
        const code = parseInt(src, 16);
        const dstBytes = Buffer.from(dst, "hex");
        mapping[code] = "";
        for (let i = 0; i < dstBytes.length; i += 2)
          mapping[code] += String.fromCodePoint(dstBytes.readUInt16BE(i));
      } catch {}
    }
  }
  return mapping;
}

function extractPDFText(pdfBuffer) {
  const str = pdfBuffer.toString("latin1");
  const streamRegex = /stream\r?\n([\s\S]*?)endstream/g;
  const streams = [];
  let m;
  while ((m = streamRegex.exec(str)) !== null)
    streams.push(Buffer.from(m[1], "latin1"));

  const mapping = {};
  for (const s of streams) {
    try {
      const d = require("zlib").inflateSync(s).toString("latin1");
      if (d.includes("beginbfchar") || d.includes("beginbfrange"))
        Object.assign(mapping, parseCMap(d));
    } catch {}
  }

  let text = "";
  for (const s of streams) {
    try {
      const d = require("zlib").inflateSync(s).toString("latin1");
      for (const [, h] of d.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) {
        const code = parseInt(h, 16);
        text += mapping[code] !== undefined ? mapping[code]
              : (code >= 32 && code < 127 ? String.fromCharCode(code) : " ");
      }
    } catch {}
  }
  return text.replace(/\s+/g, " ").trim();
}

// ← Cambia la ruta a donde tengas el PDF
const buf = readFileSync("F-14633_A3D.pdf");
const text = extractPDFText(buf);
console.log("TEXTO EXTRAÍDO:");
console.log(text);
