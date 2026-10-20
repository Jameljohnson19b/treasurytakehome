import {
  ABV_MATCH_TOLERANCE,
  ABV_REVIEW_TOLERANCE,
  FIELD_LABELS,
  FUZZY_MATCH,
  FUZZY_REVIEW,
  LOW_FIELD_CONFIDENCE,
  TINY_WARNING_PX,
  TINY_WARNING_RATIO,
  UNREADABLE_CONFIDENCE,
  UNREADABLE_MIN_ALNUM,
  VERDICT_TEXT,
  WARNING_OCR_DISTANCE,
} from "./constants";
import {
  bestWindow,
  canonicalWarning,
  caseStyle,
  foldCountry,
  guessProminentLine,
  lettersPreservingCase,
  normAlnum,
  normWords,
  parseAlcohol,
  parseVolume,
  parseWarning,
  textLines,
  warningNeedsHumanRead,
  type AlcoholReading,
} from "./parser";
import type {
  FieldResult,
  FieldStatus,
  ImageSignals,
  LabelApplication,
  OcrDocument,
  OcrWord,
  Verdict,
  VerificationResult,
} from "./types";

export function documentConfidence(document: OcrDocument): number {
  const scored = document.words.filter((word) => word.text.trim()).map((word) => word.confidence);
  if (scored.length) return scored.reduce((sum, value) => sum + value, 0) / scored.length;
  return document.mean_confidence;
}

export function isUnreadable(document: OcrDocument): boolean {
  if (normAlnum(document.text).length < UNREADABLE_MIN_ALNUM) return true;
  return documentConfidence(document) < UNREADABLE_CONFIDENCE;
}

export function verifyDocument(
  document: OcrDocument,
  application: LabelApplication,
  options: {
    filename?: string;
    elapsedMs?: number;
    signals?: ImageSignals;
    latencyBudgetMs?: number;
  } = {},
): VerificationResult {
  const signals = options.signals ?? {};
  const confidence = Math.round(documentConfidence(document) * 10) / 10;
  const filename = options.filename ?? "label";
  const elapsedMs = options.elapsedMs ?? 0;
  const budget = options.latencyBudgetMs ?? 5000;

  if (isUnreadable(document)) {
    return bundle({
      filename,
      elapsedMs,
      fields: unreadableFields(application),
      document,
      confidence,
      unreadable: true,
      budget,
    });
  }

  const lines = textLines(document.text);
  const fields = [
    textField("brand_name", application.brand_name, lines, document.words, "name", guessProminentLine(lines)),
    textField("class_type", application.class_type, lines, document.words, "name"),
    alcoholField(application.alcohol_content, document),
    volumeField(application.net_contents, document),
    textField("producer_address", application.producer_address, lines, document.words, "address"),
    textField("country_of_origin", application.country_of_origin, lines, document.words, "country"),
    warningField(document, signals),
  ];
  return bundle({ filename, elapsedMs, fields, document, confidence, unreadable: false, budget });
}

export function rollup(fields: FieldResult[]): Verdict {
  const counted = fields.filter((field) => field.status !== "NOT_PROVIDED").map((field) => field.status);
  if (counted.includes("MISMATCH")) return "REJECT";
  if (counted.includes("REVIEW")) return "NEEDS_REVIEW";
  if (counted.length && counted.every((status) => status === "MATCH")) return "APPROVE";
  return "NEEDS_REVIEW";
}

export function verdictLabel(verdict: Verdict, confirmed = false): string {
  if (verdict === "APPROVE") return confirmed ? "APPROVE (agent-confirmed)" : VERDICT_TEXT.APPROVE;
  if (verdict === "REJECT") return confirmed ? "REJECT (agent-confirmed)" : VERDICT_TEXT.REJECT;
  return VERDICT_TEXT.NEEDS_REVIEW;
}

export function applyOverrides(
  fields: FieldResult[],
  overrides: Record<string, FieldStatus | undefined>,
): FieldResult[] {
  return fields.map((field) => {
    const next = overrides[field.key];
    if (!next || field.status === "NOT_PROVIDED" || next === field.status) return field;
    return {
      ...field,
      status: next,
      reason: next === "MATCH" ? "An agent approved this as a match." : "An agent rejected this field.",
    };
  });
}

function bundle(input: {
  filename: string;
  elapsedMs: number;
  fields: FieldResult[];
  document: OcrDocument;
  confidence: number;
  unreadable: boolean;
  budget: number;
}): VerificationResult {
  let verdict = rollup(input.fields);
  let attention = unique(
    input.fields
      .filter((field) => (field.status === "REVIEW" || field.status === "MISMATCH") && field.reason)
      .map((field) => field.reason as string),
  );
  const compared = input.fields.filter(
    (field) => field.key !== "government_warning" && field.status !== "NOT_PROVIDED",
  );
  if (verdict === "APPROVE" && !compared.length) {
    verdict = "NEEDS_REVIEW";
    attention.push("No application data was entered, so this label cannot be approved automatically.");
  }
  if (input.unreadable) {
    attention = ["We could not read this photo. Ask for a clearer picture of the label."];
  }
  return {
    filename: input.filename,
    elapsed_ms: input.elapsedMs,
    over_budget: input.elapsedMs > input.budget,
    verdict,
    verdict_text: VERDICT_TEXT[verdict],
    unreadable: input.unreadable,
    ocr_confidence: input.confidence,
    ocr_text: input.document.text.trim(),
    fields: input.fields,
    attention,
  };
}

function unreadableFields(application: LabelApplication): FieldResult[] {
  const reason = "We could not read this photo. Ask for a clearer picture of the label.";
  const provided: [string, string | null | undefined][] = [
    ["brand_name", application.brand_name],
    ["class_type", application.class_type],
    ["alcohol_content", application.alcohol_content],
    ["net_contents", application.net_contents],
    ["producer_address", application.producer_address],
    ["country_of_origin", application.country_of_origin],
    ["government_warning", "Required TTB statement"],
  ];
  return provided.map(([key, value]) => ({
    key,
    label: FIELD_LABELS[key],
    status: "REVIEW",
    application_value: key === "government_warning" ? "Required TTB statement" : clean(value),
    label_value: null,
    reason,
  }));
}

function textField(
  key: string,
  expected: string | null | undefined,
  lines: string[],
  words: OcrWord[],
  kind: "name" | "address" | "country",
  fallback: string | null = null,
): FieldResult {
  const label = FIELD_LABELS[key];
  const cleaned = clean(expected);
  if (!cleaned) {
    return {
      key,
      label,
      status: "NOT_PROVIDED",
      application_value: null,
      label_value: fallback,
      reason: "Not on the application. The label was not penalized for this.",
    };
  }

  const pool = key === "brand_name" ? lines.slice(0, 2) : lines;
  const found = bestWindow(pool, cleaned, kind);
  const spanWords = wordsOnLines(words, found.start, found.end);
  if (!found.text || found.score < 50) {
    return maybeUncertain(
      {
        key,
        label,
        status: "MISMATCH",
        application_value: cleaned,
        label_value: found.text,
        score: found.text ? round1(found.score) : 0,
        reason: "Not found on the label.",
      },
      spanWords.length ? spanWords : words,
      found.text,
    );
  }

  if (kind === "country" && foldCountry(found.text) === foldCountry(cleaned)) {
    return maybeUncertain(
      { key, label, status: "MATCH", application_value: cleaned, label_value: found.text, score: 100 },
      spanWords,
      found.text,
    );
  }

  if (normAlnum(found.text) === normAlnum(cleaned)) {
    if (key === "brand_name" && brandCaseNeedsReview(found.text, cleaned)) {
      return maybeUncertain(
        {
          key,
          label,
          status: "REVIEW",
          application_value: cleaned,
          label_value: found.text,
          score: round1(found.score),
          reason: "Capitalization differs. The words are the same, so an agent should confirm this is the brand.",
        },
        spanWords,
        found.text,
      );
    }
    return maybeUncertain(
      { key, label, status: "MATCH", application_value: cleaned, label_value: found.text, score: 100 },
      spanWords,
      found.text,
    );
  }

  let status: FieldStatus;
  let reason: string | null;
  if (found.score >= FUZZY_MATCH) {
    status = "MATCH";
    reason = null;
  } else if (found.score >= FUZZY_REVIEW) {
    status = "REVIEW";
    reason = `Close, but not the same (${Math.round(found.score)}% similar). Compare the two spellings.`;
  } else {
    status = "MISMATCH";
    reason = `Does not match what is on the application (${Math.round(found.score)}% similar).`;
  }
  return maybeUncertain(
    {
      key,
      label,
      status,
      application_value: cleaned,
      label_value: found.text,
      score: round1(found.score),
      reason,
    },
    spanWords,
    found.text,
  );
}

function brandCaseNeedsReview(found: string, expected: string): boolean {
  if (lettersPreservingCase(found) === lettersPreservingCase(expected)) return false;
  const foundStyle = caseStyle(found);
  const expectedStyle = caseStyle(expected);
  if (foundStyle === expectedStyle) return false;
  return (foundStyle === "upper" || expectedStyle === "upper") && foundStyle !== expectedStyle;
}

function alcoholField(expected: string | null | undefined, document: OcrDocument): FieldResult {
  const label = FIELD_LABELS.alcohol_content;
  const reading = parseAlcohol(document.text);
  const cleaned = clean(expected);
  if (!cleaned) {
    return {
      key: "alcohol_content",
      label,
      status: "NOT_PROVIDED",
      label_value: reading.snippet,
      reason: "Not on the application. The label was not penalized for this.",
    };
  }
  const expectedReading = parseAlcohol(cleaned);
  if (expectedReading.canonical_abv === null) {
    return {
      key: "alcohol_content",
      label,
      status: "REVIEW",
      application_value: cleaned,
      label_value: reading.snippet,
      reason: "The application alcohol content could not be read as a percent or proof.",
    };
  }
  const fieldWords = wordsForSnippet(document.words, reading.snippet);
  if (reading.canonical_abv === null) {
    return maybeUncertain(
      {
        key: "alcohol_content",
        label,
        status: "MISMATCH",
        application_value: cleaned,
        label_value: null,
        score: 0,
        reason: "No alcohol content found on the label.",
      },
      fieldWords,
      reading.snippet,
    );
  }

  const difference = Math.abs(reading.canonical_abv - expectedReading.canonical_abv);
  let reason = alcoholReason(reading, expectedReading, difference);
  let status: FieldStatus;
  if (reading.inconsistent && difference <= ABV_MATCH_TOLERANCE) {
    status = "REVIEW";
    reason =
      `The label shows ${fmtAbv(reading.abv)} and ${fmtProof(reading.proof)}, which do not agree ` +
      `(${fmtProof(reading.proof)} is ${fmtAbv((reading.proof ?? 0) / 2)}). Confirm which number is official.`;
  } else if (difference <= ABV_MATCH_TOLERANCE) status = "MATCH";
  else if (difference <= ABV_REVIEW_TOLERANCE) status = "REVIEW";
  else status = "MISMATCH";

  const keepReason = status !== "MATCH" || stringsDiffer(reading.snippet, cleaned);
  return maybeUncertain(
    {
      key: "alcohol_content",
      label,
      status,
      application_value: cleaned,
      label_value: reading.snippet,
      score: status === "MATCH" ? 100 : round1(Math.max(0, 100 - difference * 20)),
      reason: keepReason ? reason : null,
    },
    fieldWords.length ? fieldWords : document.words,
    reading.snippet,
  );
}

function alcoholReason(reading: AlcoholReading, expected: AlcoholReading, difference: number): string | null {
  if (reading.canonical_abv === null || expected.canonical_abv === null) return null;
  const proofNote =
    reading.abv === null && reading.proof !== null
      ? `${fmtProof(reading.proof)} equals ${fmtAbv(reading.canonical_abv)}. `
      : "";
  if (difference <= ABV_MATCH_TOLERANCE) {
    if (proofNote) return proofNote.trim();
    if (reading.snippet && expected.snippet && normWords(reading.snippet) !== normWords(expected.snippet)) {
      return `Both sides are ${fmtAbv(reading.canonical_abv)}.`;
    }
    return null;
  }
  if (difference <= ABV_REVIEW_TOLERANCE) {
    return `Close: the label reads as ${fmtAbv(reading.canonical_abv)} and the application says ${fmtAbv(expected.canonical_abv)}.`;
  }
  return `The label reads as ${fmtAbv(reading.canonical_abv)} and the application says ${fmtAbv(expected.canonical_abv)}.`;
}

function volumeField(expected: string | null | undefined, document: OcrDocument): FieldResult {
  const label = FIELD_LABELS.net_contents;
  const reading = parseVolume(document.text);
  const cleaned = clean(expected);
  if (!cleaned) {
    return {
      key: "net_contents",
      label,
      status: "NOT_PROVIDED",
      label_value: reading.snippet,
      reason: "Not on the application. The label was not penalized for this.",
    };
  }
  const expectedReading = parseVolume(cleaned);
  if (expectedReading.milliliters === null) {
    return {
      key: "net_contents",
      label,
      status: "REVIEW",
      application_value: cleaned,
      label_value: reading.snippet,
      reason: "The application net contents could not be read as a volume.",
    };
  }
  if (reading.milliliters === null) {
    return maybeUncertain(
      {
        key: "net_contents",
        label,
        status: "MISMATCH",
        application_value: cleaned,
        label_value: null,
        score: 0,
        reason: "No net contents found on the label.",
      },
      document.words,
      null,
    );
  }
  const difference = Math.abs(reading.milliliters - expectedReading.milliliters);
  const tolerance = Math.max(2, expectedReading.milliliters * 0.01);
  const same = difference <= tolerance;
  let reason: string | null = null;
  if (same && reading.snippet && normWords(reading.snippet) !== normWords(cleaned)) {
    reason = `${reading.snippet} is ${fmtMl(reading.milliliters)}, the same as ${fmtMl(expectedReading.milliliters)}.`;
  }
  if (!same) {
    reason = `The label is ${fmtMl(reading.milliliters)} and the application is ${fmtMl(expectedReading.milliliters)}.`;
  }
  return maybeUncertain(
    {
      key: "net_contents",
      label,
      status: same ? "MATCH" : "MISMATCH",
      application_value: cleaned,
      label_value: reading.snippet,
      score: same ? 100 : 0,
      reason,
    },
    wordsForSnippet(document.words, reading.snippet).length
      ? wordsForSnippet(document.words, reading.snippet)
      : document.words,
    reading.snippet,
  );
}

function warningField(document: OcrDocument, signals: ImageSignals): FieldResult {
  const reading = parseWarning(document.text);
  const required = "GOVERNMENT WARNING:";
  const reasons: string[] = [];
  let status: FieldStatus;
  let shown: string | null;

  if (!reading.present && !reading.body_exact && reading.body_distance > WARNING_OCR_DISTANCE) {
    status = "MISMATCH";
    reasons.push("The government warning is not on this label.");
    shown = null;
  } else if (reading.prefix_raw && !reading.prefix_is_all_caps) {
    status = "MISMATCH";
    reasons.push('The header is not in all caps. It must read "GOVERNMENT WARNING:".');
    shown = reading.prefix_raw.endsWith(":") ? reading.prefix_raw : `${reading.prefix_raw}:`;
  } else if (!reading.prefix_raw) {
    status = "MISMATCH";
    reasons.push('The label is missing the "GOVERNMENT WARNING:" header.');
    shown = reading.body_snippet;
  } else if (reading.body_exact && reading.body_distance === 0) {
    status = "MATCH";
    shown = required;
  } else if (reading.body_distance === 0 && !reading.body_exact) {
    status = "REVIEW";
    reasons.push("The warning words match, but capitalization inside the statement differs.");
    shown = reading.prefix_raw;
  } else if (warningNeedsHumanRead(reading.body_distance)) {
    status = "REVIEW";
    reasons.push(
      "The warning is off by only a few characters. Compare it word for word in case the scanner missed one.",
    );
    shown = reading.prefix_raw;
  } else {
    status = "MISMATCH";
    reasons.push("The warning wording does not match the required statement.");
    const hint = diffHint(reading.body_snippet ?? "", canonicalWarning());
    if (hint) reasons.push(hint);
    shown = reading.prefix_raw || "Wording differs";
  }

  if (status === "MATCH" && signals.warning_bold === false) {
    status = "REVIEW";
    reasons.push("The header does not look bold. Confirm the type weight.");
  }
  if (status === "MATCH" && warningIsTiny(signals)) {
    status = "REVIEW";
    reasons.push("The warning type looks very small. Confirm it is easy to read.");
  }

  const warningWords = document.words.filter((word) => {
    const token = word.text.toLowerCase().replace(/:$/, "");
    return token === "government" || token === "warning" || word.text.toLowerCase().includes("surgeon");
  });
  return maybeUncertain(
    {
      key: "government_warning",
      label: FIELD_LABELS.government_warning,
      status,
      application_value: status === "MATCH" ? "Exact required statement" : required,
      label_value: status === "MATCH" ? "Exact required statement" : shown,
      score: status === "MATCH" ? 100 : 0,
      reason: reasons.length ? reasons.join(" ") : null,
    },
    warningWords.length ? warningWords : document.words,
    shown,
  );
}

function warningIsTiny(signals: ImageSignals): boolean {
  if (signals.warning_height_px == null) return false;
  if (signals.warning_height_px <= TINY_WARNING_PX) return true;
  if (signals.brand_height_px && signals.brand_height_px > 0) {
    return signals.warning_height_px / signals.brand_height_px < TINY_WARNING_RATIO;
  }
  return false;
}

function maybeUncertain(result: FieldResult, words: OcrWord[], snippet: string | null): FieldResult {
  if (result.status === "NOT_PROVIDED") return result;
  const confidence = confidenceFor(words, snippet);
  if (confidence === null || confidence >= LOW_FIELD_CONFIDENCE) return result;
  const note = "The scanner was not confident it read this correctly, so a person should compare it.";
  return {
    ...result,
    status: "REVIEW",
    reason: result.reason ? `${result.reason} ${note}` : note,
  };
}

function confidenceFor(words: OcrWord[], snippet: string | null): number | null {
  const scored = words.filter((word) => word.text.trim());
  if (!scored.length) return null;
  if (!snippet) return average(scored.map((word) => word.confidence));
  const key = normAlnum(snippet);
  const used = scored.filter((word) => key.includes(normAlnum(word.text)));
  return average((used.length ? used : scored).map((word) => word.confidence));
}

function wordsForSnippet(words: OcrWord[], snippet: string | null): OcrWord[] {
  if (!snippet) return [];
  const key = normAlnum(snippet);
  return words.filter((word) => word.text.trim() && key.includes(normAlnum(word.text)));
}

function wordsOnLines(words: OcrWord[], start: number | null, end: number | null): OcrWord[] {
  if (start === null || end === null) return [];
  return words.filter((word) => word.text.trim() && (word.line_id ?? -1) >= start && (word.line_id ?? -1) <= end);
}

function diffHint(found: string, canon: string): string {
  if (!found) return "";
  const limit = Math.min(found.length, canon.length);
  for (let index = 0; index < limit; index += 1) {
    if (found[index] !== canon[index]) {
      const start = Math.max(0, index - 24);
      const end = Math.min(found.length, index + 28);
      return `Near the difference, the label reads "${found.slice(start, end).trim()}".`;
    }
  }
  if (found.length !== canon.length) return "The statement is longer or shorter than the required text.";
  return "";
}

function clean(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function stringsDiffer(left: string | null, right: string | null): boolean {
  if (!left || !right) return true;
  return normWords(left) !== normWords(right);
}

function fmtAbv(value: number | null): string {
  if (value === null) return "an unknown strength";
  const rounded = Math.round(value * 100) / 100;
  if (rounded === Math.trunc(rounded)) return `${Math.trunc(rounded)}% ABV`;
  return `${rounded.toFixed(2)}% ABV`;
}

function fmtProof(value: number | null): string {
  if (value === null) return "unknown proof";
  if (value === Math.trunc(value)) return `${Math.trunc(value)} proof`;
  return `${value.toFixed(1)} proof`;
}

function fmtMl(value: number): string {
  if (Math.abs(value - Math.round(value)) < 0.05) return `${Math.round(value)} mL`;
  return `${value.toFixed(1)} mL`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
