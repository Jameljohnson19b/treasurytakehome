/** TTB mandatory health warning. The header is checked separately for all caps. */
export const GOVERNMENT_WARNING_BODY =
  "(1) According to the Surgeon General, women should not drink alcoholic " +
  "beverages during pregnancy because of the risk of birth defects. " +
  "(2) Consumption of alcoholic beverages impairs your ability to drive a " +
  "car or operate machinery, and may cause health problems.";

export const LATENCY_BUDGET_MS = 5000;
export const MAX_BATCH_FILES = 300;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const LOW_FIELD_CONFIDENCE = 60;
export const UNREADABLE_CONFIDENCE = 45;
export const UNREADABLE_MIN_ALNUM = 12;
export const FUZZY_MATCH = 95;
export const FUZZY_REVIEW = 80;
export const ABV_MATCH_TOLERANCE = 0.1;
export const ABV_REVIEW_TOLERANCE = 0.5;
export const WARNING_OCR_DISTANCE = 3;
export const TINY_WARNING_PX = 14;
export const TINY_WARNING_RATIO = 0.22;

export const VERDICT_TEXT = {
  APPROVE: "APPROVE (auto-suggested)",
  NEEDS_REVIEW: "NEEDS AGENT REVIEW",
  REJECT: "REJECT (suggested)",
} as const;

export const FIELD_LABELS: Record<string, string> = {
  brand_name: "Brand name",
  class_type: "Class / type",
  alcohol_content: "Alcohol content",
  net_contents: "Net contents",
  producer_address: "Producer address",
  country_of_origin: "Country of origin",
  government_warning: "Government warning",
};
