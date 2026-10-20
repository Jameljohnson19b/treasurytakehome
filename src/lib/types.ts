export type FieldStatus = "MATCH" | "REVIEW" | "MISMATCH" | "NOT_PROVIDED";
export type Verdict = "APPROVE" | "NEEDS_REVIEW" | "REJECT";
export type TextKind = "name" | "address" | "country";

export interface LabelApplication {
  application_id?: string | null;
  filename?: string | null;
  brand_name?: string | null;
  class_type?: string | null;
  alcohol_content?: string | null;
  net_contents?: string | null;
  producer_address?: string | null;
  country_of_origin?: string | null;
  is_import?: boolean;
}

export interface OcrWord {
  text: string;
  confidence: number;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  line_id?: number;
}

export interface OcrDocument {
  text: string;
  words: OcrWord[];
  mean_confidence: number;
}

export interface ImageSignals {
  warning_bold?: boolean | null;
  warning_height_px?: number | null;
  brand_height_px?: number | null;
}

export interface FieldResult {
  key: string;
  label: string;
  status: FieldStatus;
  application_value?: string | null;
  label_value?: string | null;
  score?: number | null;
  reason?: string | null;
}

export interface VerificationResult {
  filename: string;
  elapsed_ms: number;
  over_budget: boolean;
  verdict: Verdict;
  verdict_text: string;
  unreadable: boolean;
  ocr_confidence: number;
  ocr_text: string;
  fields: FieldResult[];
  attention: string[];
  image_url?: string | null;
  error?: string | null;
}

export interface SampleCase {
  id: string;
  title: string;
  description: string;
  filename: string;
  expected_verdict: Verdict;
  application: LabelApplication;
}
