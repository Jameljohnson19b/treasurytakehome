import type { LabelApplication } from "./types";

const ALIASES: Record<string, keyof LabelApplication> = {
  brand: "brand_name",
  "brand name": "brand_name",
  brand_name: "brand_name",
  class: "class_type",
  "class/type": "class_type",
  "class / type": "class_type",
  class_type: "class_type",
  type: "class_type",
  abv: "alcohol_content",
  alcohol: "alcohol_content",
  "alcohol content": "alcohol_content",
  alcohol_content: "alcohol_content",
  proof: "alcohol_content",
  "net contents": "net_contents",
  net_contents: "net_contents",
  volume: "net_contents",
  contents: "net_contents",
  producer: "producer_address",
  "producer address": "producer_address",
  producer_address: "producer_address",
  address: "producer_address",
  country: "country_of_origin",
  "country of origin": "country_of_origin",
  country_of_origin: "country_of_origin",
  filename: "filename",
  file: "filename",
  "file name": "filename",
  id: "application_id",
  application_id: "application_id",
  is_import: "is_import",
  import: "is_import",
};

export function parseApplications(jsonText: string, csvText: string): LabelApplication[] {
  const records: LabelApplication[] = [];
  if (jsonText.trim()) records.push(...fromJson(jsonText));
  if (csvText.trim()) records.push(...fromCsv(csvText));
  return records;
}

export function pairApplications(filenames: string[], applications: LabelApplication[]): LabelApplication[] {
  if (!applications.length) return filenames.map((filename) => ({ filename }));
  const named = applications.filter((item) => item.filename?.trim());
  if (named.length) {
    const byName = new Map(named.map((item) => [keyOf(item.filename ?? ""), item]));
    const missing = filenames.filter((name) => !byName.has(keyOf(name)));
    if (missing.length && named.length !== filenames.length) {
      throw new Error(
        `Some images have no row in the spreadsheet. Missing: ${missing.slice(0, 3).join(", ")}. Use a filename column that matches each image name.`,
      );
    }
    return filenames.map((name) => byName.get(keyOf(name)) ?? { filename: name });
  }
  if (applications.length === 1 && filenames.length === 1) return applications;
  if (applications.length !== filenames.length) {
    throw new Error(
      `The application data has ${applications.length} row${applications.length === 1 ? "" : "s"} but you uploaded ${filenames.length} image${filenames.length === 1 ? "" : "s"}. Use the same number of rows as images, or add a filename column.`,
    );
  }
  return applications;
}

function fromJson(raw: string): LabelApplication[] {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("The application data isn't valid JSON.");
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "application" in payload) {
    payload = (payload as { application: unknown }).application;
  }
  if (Array.isArray(payload)) return payload.map((item) => model(item));
  if (payload && typeof payload === "object") return [model(payload)];
  throw new Error("Application JSON should be one object or a list of objects.");
}

function fromCsv(raw: string): LabelApplication[] {
  const rows = parseCsvRows(raw.replace(/^\uFEFF/, ""));
  if (!rows.length) throw new Error("The spreadsheet needs a header row.");
  const [header, ...body] = rows;
  return body
    .filter((row) => row.some((cell) => cell.trim()))
    .map((row) => {
      const record: Record<string, string> = {};
      header.forEach((name, index) => {
        const canonical = ALIASES[name.trim().toLowerCase()];
        if (canonical) record[canonical] = (row[index] ?? "").trim();
      });
      return model(record);
    });
}

function model(input: unknown): LabelApplication {
  if (!input || typeof input !== "object") throw new Error("Each application record needs to be an object.");
  const application: LabelApplication = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const canonical = ALIASES[rawKey.trim().toLowerCase()] ?? (rawKey as keyof LabelApplication);
    if (!(canonical in ALIASES) && !["brand_name", "class_type", "alcohol_content", "net_contents", "producer_address", "country_of_origin", "filename", "application_id", "is_import"].includes(canonical)) {
      continue;
    }
    if (canonical === "is_import") {
      application.is_import = ["1", "true", "yes", "y", "import"].includes(String(rawValue).trim().toLowerCase()) || rawValue === true;
      continue;
    }
    if (rawValue == null) continue;
    const text = String(rawValue).trim();
    if (text) (application as Record<string, string>)[canonical] = text;
  }
  return application;
}

function keyOf(filename: string): string {
  return filename.replaceAll("\\", "/").split("/").pop()?.trim().toLowerCase() ?? "";
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") cell += character;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export const CSV_TEMPLATE =
  "filename,brand_name,class_type,alcohol_content,net_contents,producer_address,country_of_origin,is_import\n" +
  'old-tom.png,OLD TOM DISTILLERY,Kentucky Straight Bourbon Whiskey,45% Alc./Vol. (90 Proof),750 mL,"Old Tom Distillery, 100 Distillery Lane, Louisville, KY 40202",United States,no\n';
