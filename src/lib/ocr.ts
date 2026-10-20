import type { ImageSignals, OcrDocument, OcrWord } from "./types";

type TessWorker = {
  recognize: (image: HTMLCanvasElement) => Promise<{ data: TessData }>;
  setParameters: (params: Record<string, string>) => Promise<unknown>;
  terminate: () => Promise<unknown>;
};

type TessData = {
  text: string;
  lines?: { text: string; words?: TessWord[] }[];
  words?: TessWord[];
};

type TessWord = {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};

let workerPromise: Promise<TessWorker> | null = null;

export function loadScanner(): Promise<TessWorker> {
  if (!workerPromise) {
    workerPromise = startWorker().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function startWorker(): Promise<TessWorker> {
  const { createWorker } = await import("tesseract.js");
  const worker = (await createWorker("eng", 1, {
    workerPath: "/ocr/worker.min.js",
    corePath: "/ocr/tesseract-core-simd-lstm.wasm.js",
    langPath: "/ocr",
    gzip: true,
    workerBlobURL: false,
  })) as unknown as TessWorker;
  await worker.setParameters({ tessedit_pageseg_mode: "4" });
  return worker;
}

export async function recognizeCanvas(canvas: HTMLCanvasElement): Promise<OcrDocument> {
  const worker = await loadScanner();
  let document = toDocument(await worker.recognize(canvas));
  if (isWeak(document)) {
    await worker.setParameters({ tessedit_pageseg_mode: "3" });
    const alternate = toDocument(await worker.recognize(canvas));
    await worker.setParameters({ tessedit_pageseg_mode: "4" });
    if (richness(alternate) > richness(document)) document = alternate;
  }
  return document;
}

export function signalsFrom(document: OcrDocument): ImageSignals {
  const lines = new Map<number, OcrWord[]>();
  for (const word of document.words) {
    const lineId = word.line_id ?? 0;
    const row = lines.get(lineId) ?? [];
    row.push(word);
    lines.set(lineId, row);
  }
  const heights = [...lines.values()]
    .map((words) => median(words.map((word) => word.height ?? 0).filter((value) => value > 0)))
    .filter((value): value is number => value !== null);
  let warningHeight: number | null = null;
  for (const words of lines.values()) {
    const text = words.map((word) => word.text).join(" ").toLowerCase();
    if (text.includes("government warning")) {
      warningHeight = median(words.map((word) => word.height ?? 0).filter((value) => value > 0));
      break;
    }
  }
  return {
    warning_bold: null,
    warning_height_px: warningHeight,
    brand_height_px: heights.length ? Math.max(...heights) : null,
  };
}

function toDocument(payload: { data: TessData }): OcrDocument {
  const data = payload.data;
  const words: OcrWord[] = [];
  const lineTexts: string[] = [];
  const sourceLines = data.lines?.length
    ? data.lines
    : [{ text: data.text, words: data.words ?? [] }];
  sourceLines.forEach((line, lineId) => {
    const text = (line.text || "").replace(/\s+/g, " ").trim();
    if (text) lineTexts.push(text);
    for (const word of line.words ?? []) {
      const token = word.text?.trim();
      if (!token) continue;
      words.push({
        text: token,
        confidence: Number(word.confidence) || 0,
        left: word.bbox?.x0 ?? 0,
        top: word.bbox?.y0 ?? 0,
        width: Math.max(0, (word.bbox?.x1 ?? 0) - (word.bbox?.x0 ?? 0)),
        height: Math.max(0, (word.bbox?.y1 ?? 0) - (word.bbox?.y0 ?? 0)),
        line_id: lineId,
      });
    }
  });
  const confidences = words.map((word) => word.confidence);
  const mean = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : 0;
  return {
    text: lineTexts.join("\n") || data.text || "",
    words,
    mean_confidence: mean,
  };
}

function isWeak(document: OcrDocument): boolean {
  const letters = document.text.replace(/[^A-Za-z0-9]/g, "").length;
  return letters < 12 || document.mean_confidence < 45;
}

function richness(document: OcrDocument): number {
  return document.text.replace(/[^A-Za-z0-9]/g, "").length + document.mean_confidence;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}
