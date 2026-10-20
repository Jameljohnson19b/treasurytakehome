import type { FieldResult, FieldStatus, VerificationResult, Verdict } from "./types";
import { applyOverrides, rollup, verdictLabel } from "./verifier";

export interface ExportRow {
  result: VerificationResult;
  overrides: Record<string, FieldStatus | undefined>;
  agentVerdict?: Verdict | null;
}

const COLUMNS = [
  "brand_name",
  "class_type",
  "alcohol_content",
  "net_contents",
  "producer_address",
  "country_of_origin",
  "government_warning",
] as const;

export function resultsToCsv(rows: ExportRow[]): string {
  const header = [
    "filename",
    "verdict",
    "seconds",
    "over_5_seconds",
    "notes",
    ...COLUMNS.flatMap((key) => [`${key}_status`, `${key}_application`, `${key}_label`, `${key}_reason`]),
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    const fields = applyOverrides(row.result.fields, row.overrides);
    const verdict = row.agentVerdict ?? rollup(fields.length ? fields : row.result.fields);
    const byKey = new Map(fields.map((field) => [field.key, field]));
    const values = [
      row.result.filename,
      verdictLabel(verdict, Boolean(row.agentVerdict)),
      (row.result.elapsed_ms / 1000).toFixed(1),
      row.result.over_budget ? "yes" : "no",
      row.result.error ?? row.result.attention.join(" | "),
      ...COLUMNS.flatMap((key) => {
        const field = byKey.get(key);
        return [field?.status ?? "", field?.application_value ?? "", field?.label_value ?? "", field?.reason ?? ""];
      }),
    ];
    lines.push(values.map((value) => csvCell(String(value))).join(","));
  }
  return lines.join("\n");
}

export function downloadCsv(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\n]/.test(safe)) return `"${safe.replaceAll('"', '""')}"`;
  return safe;
}

export function fieldMap(fields: FieldResult[]): Map<string, FieldResult> {
  return new Map(fields.map((field) => [field.key, field]));
}
