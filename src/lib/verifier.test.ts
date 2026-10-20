import { describe, expect, it } from "vitest";
import { GOVERNMENT_WARNING_BODY } from "./constants";
import { foldCountry, normWords, parseAlcohol, parseVolume, parseWarning } from "./parser";
import type { LabelApplication, OcrDocument, OcrWord } from "./types";
import { rollup, verifyDocument } from "./verifier";

const WARNING = `GOVERNMENT WARNING: ${GOVERNMENT_WARNING_BODY}`;

function document(text: string, confidence = 96, height = 28): OcrDocument {
  const words: OcrWord[] = [];
  text.split("\n").forEach((line, lineId) => {
    line.split(/\s+/).filter(Boolean).forEach((token) => {
      words.push({ text: token, confidence, height, line_id: lineId });
    });
  });
  return { text, words, mean_confidence: confidence };
}

function application(overrides: Partial<LabelApplication> = {}): LabelApplication {
  return {
    brand_name: "OLD TOM DISTILLERY",
    class_type: "Kentucky Straight Bourbon Whiskey",
    alcohol_content: "45% Alc./Vol. (90 Proof)",
    net_contents: "750 mL",
    producer_address: "Old Tom Distillery, 100 Distillery Lane, Louisville, KY 40202",
    country_of_origin: "United States",
    is_import: false,
    ...overrides,
  };
}

function label(options: {
  brand?: string;
  alcohol?: string;
  volume?: string;
  warning?: string;
  producer?: [string, string, string];
  country?: string;
  klass?: string;
} = {}): string {
  const producer = options.producer ?? ["Old Tom Distillery", "100 Distillery Lane", "Louisville, KY 40202"];
  return [
    options.brand ?? "OLD TOM DISTILLERY",
    options.klass ?? "Kentucky Straight Bourbon Whiskey",
    options.alcohol ?? "45% Alc./Vol. (90 Proof)",
    options.volume ?? "750 mL",
    ...producer,
    options.country ?? "United States",
    options.warning ?? WARNING,
  ].join("\n");
}

function field(result: ReturnType<typeof verifyDocument>, key: string) {
  const found = result.fields.find((item) => item.key === key);
  if (!found) throw new Error(key);
  return found;
}

describe("parser", () => {
  it("reads percent and proof together", () => {
    const reading = parseAlcohol("45% Alc./Vol. (90 Proof)");
    expect(reading.abv).toBe(45);
    expect(reading.proof).toBe(90);
    expect(reading.canonical_abv).toBe(45);
    expect(reading.inconsistent).toBe(false);
  });

  it("turns proof into ABV", () => {
    expect(parseAlcohol("Bottled at 90 Proof").canonical_abv).toBe(45);
  });

  it("normalizes volume units", () => {
    expect(parseVolume("750 mL").milliliters).toBe(750);
    expect(parseVolume("75 cL").milliliters).toBe(750);
    expect(parseVolume("0.75 L").milliliters).toBe(750);
  });

  it("accepts a wrapped warning", () => {
    const wrapped =
      "GOVERNMENT WARNING: (1) According to the Surgeon General, women should not drink alcoholic\n" +
      "beverages during pregnancy because of the risk of birth defects. (2) Consumption of\n" +
      "alcoholic beverages impairs your ability to drive a car or operate machinery, and may\n" +
      "cause health problems.";
    const reading = parseWarning(wrapped);
    expect(reading.body_exact).toBe(true);
    expect(reading.prefix_is_all_caps).toBe(true);
  });

  it("flags a title-case warning header", () => {
    const reading = parseWarning(`Government Warning: ${GOVERNMENT_WARNING_BODY}`);
    expect(reading.prefix_is_all_caps).toBe(false);
    expect(reading.body_exact).toBe(true);
  });

  it("folds country aliases", () => {
    expect(foldCountry("USA")).toBe("united states");
    expect(normWords("STONE'S THROW")).toBe("stones throw");
  });
});

describe("verifier", () => {
  it("approves a perfect label", () => {
    const result = verifyDocument(document(label()), application());
    expect(result.verdict).toBe("APPROVE");
    expect(result.fields.every((item) => item.status === "MATCH")).toBe(true);
  });

  it("sends an all-caps brand to review", () => {
    const text = label({
      brand: "STONE'S THROW",
      producer: ["Stone's Throw Distillery", "100 River Road", "Seattle, WA 98101"],
    });
    const result = verifyDocument(
      document(text),
      application({
        brand_name: "Stone's Throw",
        producer_address: "Stone's Throw Distillery, 100 River Road, Seattle, WA 98101",
      }),
    );
    expect(field(result, "brand_name").status).toBe("REVIEW");
    expect(field(result, "brand_name").reason ?? "").toMatch(/apital/);
    expect(field(result, "class_type").status).toBe("MATCH");
    expect(result.verdict).toBe("NEEDS_REVIEW");
  });

  it("still matches a single lowercase letter inside a mixed-case brand", () => {
    const result = verifyDocument(
      document(label({ brand: "Old Tom Distillery" })),
      application({ brand_name: "Old Tom distillery" }),
    );
    expect(field(result, "brand_name").status).toBe("MATCH");
  });

  it("rejects alcohol that is off by a point", () => {
    const result = verifyDocument(document(label({ alcohol: "46% Alc./Vol. (92 Proof)" })), application());
    expect(field(result, "alcohol_content").status).toBe("MISMATCH");
    expect(result.verdict).toBe("REJECT");
  });

  it("treats 75 cL as 750 mL", () => {
    const result = verifyDocument(document(label({ volume: "75 cL" })), application({ net_contents: "750 mL" }));
    expect(field(result, "net_contents").status).toBe("MATCH");
    expect(field(result, "net_contents").reason ?? "").toContain("750");
  });

  it("treats 90 proof as 45% ABV", () => {
    const result = verifyDocument(document(label({ alcohol: "90 Proof" })), application({ alcohol_content: "45% ABV" }));
    expect(field(result, "alcohol_content").status).toBe("MATCH");
    expect(result.verdict).toBe("APPROVE");
  });

  it("rejects a warning header that is not all caps", () => {
    const result = verifyDocument(
      document(label({ warning: `Government Warning: ${GOVERNMENT_WARNING_BODY}` })),
      application(),
    );
    expect(field(result, "government_warning").status).toBe("MISMATCH");
    expect(field(result, "government_warning").reason ?? "").toMatch(/all caps/);
    expect(result.verdict).toBe("REJECT");
  });

  it("rejects altered warning wording", () => {
    const altered = GOVERNMENT_WARNING_BODY.replace("women should not", "people should not");
    const result = verifyDocument(document(label({ warning: `GOVERNMENT WARNING: ${altered}` })), application());
    expect(field(result, "government_warning").status).toBe("MISMATCH");
    expect(field(result, "government_warning").reason ?? "").toMatch(/wording/);
  });

  it("rejects a missing warning", () => {
    const result = verifyDocument(document(label({ warning: "Enjoy responsibly." })), application());
    expect(field(result, "government_warning").status).toBe("MISMATCH");
    expect(result.verdict).toBe("REJECT");
  });

  it("routes an unreadable image to review", () => {
    const result = verifyDocument(document("??", 12), application());
    expect(result.unreadable).toBe(true);
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(result.fields.every((item) => item.status === "REVIEW")).toBe(true);
  });

  it("does not auto-match a field the scanner is unsure about", () => {
    const text = label();
    const words: OcrWord[] = [];
    text.split("\n").forEach((line, lineId) => {
      line.split(/\s+/).filter(Boolean).forEach((token) => {
        words.push({
          text: token,
          confidence: ["OLD", "TOM", "DISTILLERY"].includes(token) ? 42 : 96,
          height: 28,
          line_id: lineId,
        });
      });
    });
    const result = verifyDocument({ text, words, mean_confidence: 90 }, application());
    expect(field(result, "brand_name").status).toBe("REVIEW");
    expect(field(result, "class_type").status).toBe("MATCH");
  });

  it("does not penalize a blank application field", () => {
    const result = verifyDocument(document(label()), application({ country_of_origin: null }));
    expect(field(result, "country_of_origin").status).toBe("NOT_PROVIDED");
    expect(result.verdict).toBe("APPROVE");
  });

  it("does not auto-approve when no application was entered", () => {
    const result = verifyDocument(document(label()), {});
    expect(result.verdict).toBe("NEEDS_REVIEW");
    expect(field(result, "government_warning").status).toBe("MATCH");
  });

  it("reviews a shortened class designation", () => {
    const result = verifyDocument(document(label({ klass: "Kentucky Straight Bourbon" })), application());
    expect(field(result, "class_type").status).toBe("REVIEW");
  });

  it("mismatches a different brand", () => {
    const result = verifyDocument(document(label({ brand: "NEW RIVER SPIRITS" })), application());
    expect(field(result, "brand_name").status).toBe("MISMATCH");
    expect(result.verdict).toBe("REJECT");
  });

  it("matches USA to United States", () => {
    const result = verifyDocument(document(label({ country: "USA" })), application());
    expect(field(result, "country_of_origin").status).toBe("MATCH");
  });

  it("reviews tiny warning type", () => {
    const result = verifyDocument(document(label()), application(), {
      signals: { warning_bold: true, warning_height_px: 11, brand_height_px: 64 },
    });
    expect(field(result, "government_warning").status).toBe("REVIEW");
    expect(field(result, "government_warning").reason ?? "").toMatch(/small/);
  });

  it("reviews a header that is not bold", () => {
    const result = verifyDocument(document(label()), application(), {
      signals: { warning_bold: false, warning_height_px: 24, brand_height_px: 64 },
    });
    expect(field(result, "government_warning").reason ?? "").toMatch(/bold/);
  });

  it("reviews a label whose proof and percent disagree", () => {
    const result = verifyDocument(
      document(label({ alcohol: "45% ABV (80 Proof)" })),
      application({ alcohol_content: "45% ABV" }),
    );
    expect(field(result, "alcohol_content").status).toBe("REVIEW");
  });

  it("lets a mismatch outrank a review", () => {
    expect(
      rollup([
        { key: "a", label: "A", status: "REVIEW" },
        { key: "b", label: "B", status: "MISMATCH" },
        { key: "c", label: "C", status: "NOT_PROVIDED" },
      ]),
    ).toBe("REJECT");
  });
});
