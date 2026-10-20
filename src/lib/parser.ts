import { GOVERNMENT_WARNING_BODY, WARNING_OCR_DISTANCE } from "./constants";
import { levenshtein, partialAlignment, ratio, tokenSortRatio } from "./fuzzy";

const PERCENT_RE =
  /(\d{1,3}(?:\.\d+)?)\s*%(?:\s*(?:alc\.?\s*\/?\s*vol\.?|a\.?b\.?v\.?|alcohol(?:\s+by\s+volume)?))?/gi;
const PROOF_RE = /(\d{1,3}(?:\.\d+)?)\s*(?:°\s*)?proof\b/gi;
const VOLUME_RE =
  /(\d+(?:\.\d+)?)\s*(millilit(?:er|re)s?|m[lL]|centilit(?:er|re)s?|c[lL]|lit(?:er|re)s?|fl\.?\s*oz\.?|ounces?)\b/i;
const VOLUME_L_RE = /(\d+(?:\.\d+)?)\s*L\b/;
const WARNING_PREFIX_RE = /government\s+warning\s*:?/i;

const COUNTRY_ALIASES: Record<string, string> = {
  usa: "united states",
  us: "united states",
  "u s a": "united states",
  "u s": "united states",
  "united states of america": "united states",
  america: "united states",
  uk: "united kingdom",
  "u k": "united kingdom",
  "great britain": "united kingdom",
  britain: "united kingdom",
  england: "united kingdom",
};

export interface AlcoholReading {
  abv: number | null;
  proof: number | null;
  snippet: string | null;
  inconsistent: boolean;
  canonical_abv: number | null;
}

export interface VolumeReading {
  milliliters: number | null;
  snippet: string | null;
}

export interface WarningReading {
  present: boolean;
  prefix_raw: string | null;
  prefix_is_all_caps: boolean;
  body_exact: boolean;
  body_distance: number;
  body_snippet: string | null;
}

export function normalizeWs(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normAlnum(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function normWords(value: string): string {
  const folded = value
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/\u2019/g, "")
    .replace(/\u2018/g, "")
    .replace(/`/g, "");
  return folded.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function lettersPreservingCase(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "");
}

export function caseStyle(value: string): "empty" | "upper" | "lower" | "mixed" {
  const letters = value.replace(/[^A-Za-z]/g, "");
  if (!letters) return "empty";
  if (letters === letters.toUpperCase()) return "upper";
  if (letters === letters.toLowerCase()) return "lower";
  return "mixed";
}

function plausibleAbv(value: number): boolean {
  return value >= 0.5 && value <= 95;
}

function plausibleProof(value: number): boolean {
  return value >= 1 && value <= 190;
}

function tightSnippet(text: string, index: number, fallback: string): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const lineEnd = text.indexOf("\n", index);
  const line = normalizeWs(text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd));
  if (line && line.length <= 90) return line;
  return normalizeWs(fallback);
}

export function parseAlcohol(text: string): AlcoholReading {
  const empty: AlcoholReading = {
    abv: null,
    proof: null,
    snippet: null,
    inconsistent: false,
    canonical_abv: null,
  };
  if (!text) return empty;
  PERCENT_RE.lastIndex = 0;
  PROOF_RE.lastIndex = 0;

  const percents: { value: number; index: number; raw: string }[] = [];
  for (const match of text.matchAll(PERCENT_RE)) {
    const value = Number(match[1]);
    if (plausibleAbv(value) && match.index !== undefined) {
      percents.push({ value, index: match.index, raw: match[0] });
    }
  }
  const proofs: { value: number; index: number; raw: string }[] = [];
  for (const match of text.matchAll(PROOF_RE)) {
    const value = Number(match[1]);
    if (plausibleProof(value) && match.index !== undefined) {
      proofs.push({ value, index: match.index, raw: match[0] });
    }
  }

  let chosenPercent: number | null = null;
  for (const item of percents) {
    const head = text.slice(Math.max(0, item.index - 8), item.index + item.raw.length);
    const tail = text.slice(item.index + item.raw.length, item.index + item.raw.length + 24);
    if (/alc|abv|vol/i.test(head + tail)) {
      chosenPercent = item.value;
      break;
    }
  }
  if (chosenPercent === null && percents.length) chosenPercent = percents[0].value;
  const chosenProof = proofs.length ? proofs[0].value : null;
  const inconsistent =
    chosenPercent !== null &&
    chosenProof !== null &&
    Math.abs(chosenPercent - chosenProof / 2) > 0.3;

  const anchor = percents[0] ?? proofs[0];
  const snippet = anchor
    ? tightSnippet(text, anchor.index, [...percents, ...proofs].map((item) => item.raw.trim()).join(" · "))
    : null;
  return {
    abv: chosenPercent,
    proof: chosenProof,
    snippet,
    inconsistent,
    canonical_abv: chosenPercent ?? (chosenProof !== null ? chosenProof / 2 : null),
  };
}

export function parseVolume(text: string): VolumeReading {
  if (!text) return { milliliters: null, snippet: null };
  const match = VOLUME_RE.exec(text);
  VOLUME_RE.lastIndex = 0;
  if (match && match.index !== undefined) {
    return {
      milliliters: toMilliliters(Number(match[1]), match[2]),
      snippet: tightSnippet(text, match.index, match[0]),
    };
  }
  const liters = VOLUME_L_RE.exec(text);
  if (liters && liters.index !== undefined) {
    return {
      milliliters: Number(liters[1]) * 1000,
      snippet: tightSnippet(text, liters.index, liters[0]),
    };
  }
  return { milliliters: null, snippet: null };
}

function toMilliliters(value: number, unit: string): number {
  const key = unit.toLowerCase().replace(/[^a-z]/g, "");
  if (["ml", "milliliter", "milliliters", "millilitre", "millilitres"].includes(key)) return value;
  if (["cl", "centiliter", "centiliters", "centilitre", "centilitres"].includes(key)) return value * 10;
  if (["l", "liter", "liters", "litre", "litres"].includes(key)) return value * 1000;
  if (["floz", "oz", "ounce", "ounces"].includes(key)) return value * 29.5735295625;
  return value;
}

export function canonicalWarning(): string {
  return normalizeWs(GOVERNMENT_WARNING_BODY);
}

export function parseWarning(text: string): WarningReading {
  const squashed = normalizeWs(text);
  if (!squashed) {
    return {
      present: false,
      prefix_raw: null,
      prefix_is_all_caps: false,
      body_exact: false,
      body_distance: 999,
      body_snippet: null,
    };
  }
  const prefixMatch = WARNING_PREFIX_RE.exec(squashed);
  const prefixRaw = prefixMatch ? normalizeWs(prefixMatch[0]) : null;
  const prefixCaps = prefixRaw ? prefixIsAllCaps(prefixRaw) : false;
  const canon = canonicalWarning();
  const rest = prefixMatch
    ? squashed.slice(prefixMatch.index + prefixMatch[0].length).replace(/^[:\s]+/, "")
    : squashed;

  const exactAt = rest.indexOf(canon);
  const inFull = squashed.indexOf(canon);
  if (exactAt === 0 || (exactAt < 0 && inFull >= 0)) {
    return {
      present: true,
      prefix_raw: prefixRaw,
      prefix_is_all_caps: prefixCaps,
      body_exact: true,
      body_distance: 0,
      body_snippet: prefixRaw,
    };
  }

  const foldedIndex = rest.toLowerCase().indexOf(canon.toLowerCase());
  if (foldedIndex >= 0) {
    const snippet = rest.slice(foldedIndex, foldedIndex + canon.length);
    const sameWords = snippet.toLowerCase() === canon.toLowerCase();
    return {
      present: true,
      prefix_raw: prefixRaw,
      prefix_is_all_caps: prefixCaps,
      body_exact: snippet === canon,
      body_distance: sameWords ? 0 : levenshtein(snippet, canon),
      body_snippet: snippet,
    };
  }

  const alignment = rest ? partialAlignment(canon, rest) : null;
  if (!alignment || alignment.score < 55) {
    return {
      present: prefixRaw !== null,
      prefix_raw: prefixRaw,
      prefix_is_all_caps: prefixCaps,
      body_exact: false,
      body_distance: 999,
      body_snippet: prefixRaw,
    };
  }
  return {
    present: prefixRaw !== null || alignment.score >= 70,
    prefix_raw: prefixRaw,
    prefix_is_all_caps: prefixCaps,
    body_exact: alignment.snippet === canon,
    body_distance: alignment.distance,
    body_snippet: alignment.snippet,
  };
}

function prefixIsAllCaps(prefix: string): boolean {
  const letters = prefix.replace(/[^A-Za-z]/g, "");
  return letters === letters.toUpperCase() && letters.toLowerCase() === "governmentwarning";
}

export function warningNeedsHumanRead(distance: number): boolean {
  return distance > 0 && distance <= WARNING_OCR_DISTANCE;
}

export function textLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => normalizeWs(line))
    .filter(Boolean);
}

export function foldCountry(value: string): string {
  const cleaned = normWords(value)
    .replace(/^(product of|produced in|made in|imported from|country of origin)\s+/, "")
    .trim();
  return COUNTRY_ALIASES[cleaned] ?? cleaned;
}

export function bestWindow(
  lines: string[],
  expected: string,
  kind: "name" | "address" | "country",
): { text: string | null; score: number; start: number | null; end: number | null } {
  if (!expected.trim() || !lines.length) return { text: null, score: 0, start: null, end: null };
  let bestText: string | null = null;
  let bestScore = -1;
  let bestSpan: [number, number] = [0, 0];
  const expectedKey = kind === "country" ? foldCountry(expected) : normWords(expected);
  const maxLines = kind === "name" ? 2 : 3;
  for (let size = 1; size <= maxLines; size += 1) {
    for (let index = 0; index <= lines.length - size; index += 1) {
      const candidate = normalizeWs(lines.slice(index, index + size).join(" "));
      const candidateKey = kind === "country" ? foldCountry(candidate) : normWords(candidate);
      if (!candidateKey) continue;
      const score = kind === "address" ? tokenSortRatio(candidateKey, expectedKey) : ratio(candidateKey, expectedKey);
      const tighter = bestText !== null && candidate.length < bestText.length;
      if (score > bestScore || (score === bestScore && tighter)) {
        bestScore = score;
        bestText = candidate;
        bestSpan = [index, index + size - 1];
      }
    }
  }
  if (bestScore < 0 || bestText === null) return { text: null, score: 0, start: null, end: null };
  return { text: bestText, score: bestScore, start: bestSpan[0], end: bestSpan[1] };
}

export function guessProminentLine(lines: string[]): string | null {
  for (const line of lines) {
    if (WARNING_PREFIX_RE.test(line)) continue;
    if (parseAlcohol(line).canonical_abv !== null && line.length < 48) continue;
    if (parseVolume(line).milliliters !== null && line.length < 24) continue;
    if (normAlnum(line).length >= 3) return line;
  }
  return null;
}
