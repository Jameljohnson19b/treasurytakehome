"use client";

import { useEffect, useMemo, useState } from "react";
import { Checklist } from "@/components/Checklist";
import { checkLabel } from "@/lib/check";
import { MAX_BATCH_FILES } from "@/lib/constants";
import { CSV_TEMPLATE, pairApplications, parseApplications } from "@/lib/pairing";
import { downloadCsv, resultsToCsv } from "@/lib/csv";
import { isImageFile } from "@/lib/image";
import { loadScanner } from "@/lib/ocr";
import type { FieldStatus, LabelApplication, SampleCase, VerificationResult, Verdict } from "@/lib/types";

interface Row {
  id: string;
  result: VerificationResult;
}

const EMPTY: LabelApplication = {
  brand_name: "",
  class_type: "",
  alcohol_content: "",
  net_contents: "",
  producer_address: "",
  country_of_origin: "",
  is_import: false,
};

export function Checker() {
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [large, setLarge] = useState(false);
  const [form, setForm] = useState<LabelApplication>(EMPTY);
  const [files, setFiles] = useState<File[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [spreadsheetText, setSpreadsheetText] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [samples, setSamples] = useState<SampleCase[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, Record<string, FieldStatus>>>({});
  const [agentVerdicts, setAgentVerdicts] = useState<Record<string, Verdict | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scannerReady, setScannerReady] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number; name: string; started: number } | null>(null);
  const [tick, setTick] = useState(Date.now());

  useEffect(() => {
    document.documentElement.classList.toggle("large-type", large);
  }, [large]);

  useEffect(() => {
    fetch("/samples/catalog.json")
      .then((response) => (response.ok ? response.json() : { samples: [] }))
      .then((payload: { samples?: SampleCase[] }) => setSamples(payload.samples ?? []))
      .catch(() => setSamples([]));
  }, []);

  useEffect(() => {
    if (!progress) return;
    const timer = window.setInterval(() => setTick(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [progress]);

  const selectedRow = rows[selected] ?? null;
  const elapsed = progress ? (tick - progress.started) / 1000 : 0;

  const summary = useMemo(() => {
    if (!rows.length) return null;
    const times = rows.map((row) => row.result.elapsed_ms).sort((a, b) => a - b);
    const average = times.reduce((sum, value) => sum + value, 0) / times.length;
    const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
    const slow = times.filter((value) => value > 5000).length;
    return { average, p95, slow };
  }, [rows]);

  function acceptFiles(list: FileList | File[]) {
    const images: File[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(list)) {
      if (!file.name || file.name.startsWith(".")) continue;
      if (isImageFile(file)) images.push(file);
      else rejected.push(file.name);
    }
    setSkipped(rejected);
    if (mode === "single") {
      setFiles(images.slice(0, 1));
      setError(images.length ? null : "Choose a JPG or PNG photo of the label.");
      return;
    }
    if (images.length > MAX_BATCH_FILES) {
      setFiles([]);
      setError(`300 labels is the maximum for one batch. You selected ${images.length}. Split them into groups of 300.`);
      return;
    }
    setFiles(images);
    setError(rejected.length ? `${rejected.length} file${rejected.length === 1 ? "" : "s"} skipped because they are not images.` : null);
  }

  async function ensureScanner() {
    if (scannerReady) return;
    await loadScanner();
    setScannerReady(true);
  }

  async function runFiles(nextFiles: File[], applicationFor: (file: File, index: number) => LabelApplication) {
    setBusy(true);
    setError(null);
    setRows((current) => {
      for (const row of current) {
        if (row.result.image_url?.startsWith("blob:")) URL.revokeObjectURL(row.result.image_url);
      }
      return [];
    });
    setSelected(0);
    setOverrides({});
    setAgentVerdicts({});
    const collected: Row[] = [];
    try {
      await ensureScanner();
      for (let index = 0; index < nextFiles.length; index += 1) {
        const file = nextFiles[index];
        const started = Date.now();
        setProgress({ index: index + 1, total: nextFiles.length, name: file.name, started });
        setTick(started);
        const preview = URL.createObjectURL(file);
        try {
          const result = await checkLabel(file, applicationFor(file, index), file.name);
          result.image_url = preview;
          collected.push({ id: `${file.name}-${index}`, result });
        } catch (caught) {
          URL.revokeObjectURL(preview);
          const message = caught instanceof Error ? caught.message : "This label could not be checked.";
          collected.push({
            id: `${file.name}-${index}`,
            result: {
              filename: file.name,
              elapsed_ms: Date.now() - started,
              over_budget: Date.now() - started > 5000,
              verdict: "NEEDS_REVIEW",
              verdict_text: "NEEDS AGENT REVIEW",
              unreadable: true,
              ocr_confidence: 0,
              ocr_text: "",
              fields: [],
              attention: [message],
              error: message,
              image_url: URL.createObjectURL(file),
            },
          });
        }
        setRows([...collected]);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The scanner could not start.";
      console.error(caught);
      setError(message);
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  async function checkSingle() {
    if (!files[0]) {
      setError("Drop a label image first.");
      return;
    }
    const application = blankToNull(form);
    await runFiles(files, () => application);
  }

  async function checkBatch() {
    if (!files.length) {
      setError("Drop label images first.");
      return;
    }
    let applications;
    try {
      applications = parseApplications(jsonText, spreadsheetText);
      pairApplications(files.map((file) => file.name), applications);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The application data could not be read.");
      return;
    }
    const paired = pairApplications(
      files.map((file) => file.name),
      applications,
    );
    await runFiles(files, (_file, index) => paired[index] ?? {});
  }

  async function runSample(sample: SampleCase) {
    setMode("single");
    setForm({ ...EMPTY, ...sample.application });
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/samples/${sample.filename}`);
      if (!response.ok) throw new Error("That example image is missing.");
      const blob = await response.blob();
      const file = new File([blob], sample.filename, { type: "image/png" });
      setFiles([file]);
      await runFiles([file], () => sample.application);
    } catch (caught) {
      setBusy(false);
      setError(caught instanceof Error ? caught.message : "The example could not be opened.");
    }
  }

  function exportBatch() {
    downloadCsv(
      "deskcheck-results.csv",
      resultsToCsv(
        rows.map((row) => ({
          result: row.result,
          overrides: overrides[row.id] ?? {},
          agentVerdict: agentVerdicts[row.id],
        })),
      ),
    );
  }

  return (
    <div className="min-h-screen">
      <header className="bg-navy text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5">
          <div>
            <p className="font-serif text-4xl leading-none">DeskCheck</p>
            <p className="mt-2 text-lg text-stone-100">Label checklist for COLA review</p>
          </div>
          <button
            type="button"
            aria-pressed={large}
            className="min-h-12 rounded-lg bg-white px-4 py-2 font-semibold text-navy"
            onClick={() => setLarge((value) => !value)}
          >
            {large ? "Regular text" : "Larger text"}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-6">
        <p className="max-w-3xl text-xl leading-snug">
          Drop a label. The checklist shows what matches, what does not, and what you should decide.
        </p>
        <p className="mt-2 max-w-3xl text-base text-stone-700">
          The check runs in this browser. The photo is not uploaded, and nothing is sent to an outside service.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            className={`min-h-14 rounded-xl border-2 px-4 py-3 text-left text-xl font-semibold ${mode === "single" ? "border-navy bg-white" : "border-line bg-white/60"}`}
            onClick={() => setMode("single")}
          >
            Single label
          </button>
          <button
            type="button"
            className={`min-h-14 rounded-xl border-2 px-4 py-3 text-left text-xl font-semibold ${mode === "batch" ? "border-navy bg-white" : "border-line bg-white/60"}`}
            onClick={() => setMode("batch")}
          >
            Batch upload
          </button>
        </div>

        <section className="mt-4 rounded-2xl border border-line bg-white p-5">
          <label
            className="flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-xl border-4 border-dashed border-navy/40 bg-paper px-4 py-8 text-center"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (event.dataTransfer.files.length) acceptFiles(event.dataTransfer.files);
            }}
          >
            <span className="text-2xl font-semibold leading-snug">
              Drop a label image — or a whole folder (up to 300).
            </span>
            <span className="mt-2 text-base text-stone-600">JPG or PNG. Click here to choose a file.</span>
            <input
              className="sr-only"
              type="file"
              accept="image/*"
              multiple={mode === "batch"}
              onChange={(event) => {
                if (event.target.files) acceptFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
          {mode === "batch" && (
            <label className="mt-3 inline-flex min-h-12 cursor-pointer items-center rounded-lg bg-paper px-4 py-2 font-semibold ring-2 ring-line">
              Choose a folder
              <input
                className="sr-only"
                type="file"
                accept="image/*"
                multiple
                // Folder upload is supported by the browsers agents use.
                {...{ webkitdirectory: "", directory: "" }}
                onChange={(event) => {
                  if (event.target.files) acceptFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
          )}
          {files.length > 0 && (
            <p className="mt-3 text-lg">
              {files.length === 1 ? files[0].name : `${files.length} labels ready`}
            </p>
          )}
          {skipped.length > 0 && mode === "batch" && (
            <p className="mt-2 text-review">Skipped {skipped.slice(0, 4).join(", ")} — not an image.</p>
          )}
        </section>

        {mode === "single" ? (
          <section className="mt-4 rounded-2xl border border-line bg-white p-5">
            <h2 className="text-2xl font-semibold">Application</h2>
            <p className="mt-1 text-base text-stone-600">Leave a box blank if the application does not have that field.</p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Field label="Brand name" value={form.brand_name ?? ""} onChange={(value) => setForm({ ...form, brand_name: value })} placeholder="OLD TOM DISTILLERY" />
              <Field label="Class / type" value={form.class_type ?? ""} onChange={(value) => setForm({ ...form, class_type: value })} placeholder="Kentucky Straight Bourbon Whiskey" />
              <Field label="Alcohol content" value={form.alcohol_content ?? ""} onChange={(value) => setForm({ ...form, alcohol_content: value })} placeholder="45% Alc./Vol. (90 Proof)" />
              <Field label="Net contents" value={form.net_contents ?? ""} onChange={(value) => setForm({ ...form, net_contents: value })} placeholder="750 mL" />
              <Field label="Producer address" value={form.producer_address ?? ""} onChange={(value) => setForm({ ...form, producer_address: value })} placeholder="100 Distillery Lane, Louisville, KY 40202" />
              <Field label="Country of origin" value={form.country_of_origin ?? ""} onChange={(value) => setForm({ ...form, country_of_origin: value })} placeholder="United States" />
            </div>
            <label className="mt-4 flex min-h-12 items-center gap-3 text-lg">
              <input
                type="checkbox"
                className="h-6 w-6"
                checked={Boolean(form.is_import)}
                onChange={(event) => setForm({ ...form, is_import: event.target.checked })}
              />
              This is an import
            </label>
            <button
              type="button"
              disabled={busy}
              className="mt-5 min-h-14 w-full rounded-xl bg-navy px-4 py-3 text-xl font-semibold text-white disabled:opacity-60 sm:w-auto"
              onClick={() => void checkSingle()}
            >
              Check this label
            </button>
          </section>
        ) : (
          <section className="mt-4 rounded-2xl border border-line bg-white p-5">
            <h2 className="text-2xl font-semibold">Application rows</h2>
            <p className="mt-1 text-base text-stone-600">
              Upload a spreadsheet with a filename column, or paste JSON. Without it, only the government warning is checked.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <label className="inline-flex min-h-12 cursor-pointer items-center rounded-lg bg-paper px-4 py-2 font-semibold ring-2 ring-line">
                Upload spreadsheet
                <input
                  className="sr-only"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (file) setSpreadsheetText(await file.text());
                    event.target.value = "";
                  }}
                />
              </label>
              <button
                type="button"
                className="min-h-12 rounded-lg px-4 py-2 font-semibold text-navy underline"
                onClick={() => downloadCsv("deskcheck-applications.csv", CSV_TEMPLATE)}
              >
                Download a blank spreadsheet
              </button>
            </div>
            {spreadsheetText && <p className="mt-3">Spreadsheet loaded.</p>}
            <label className="mt-4 block text-lg font-semibold" htmlFor="json-apps">
              Or paste JSON
            </label>
            <textarea
              id="json-apps"
              className="mt-2 min-h-28 w-full rounded-lg border border-line p-3"
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
              placeholder='[{"filename":"label.png","brand_name":"OLD TOM DISTILLERY","alcohol_content":"45% ABV","net_contents":"750 mL"}]'
            />
            <button
              type="button"
              disabled={busy}
              className="mt-4 min-h-14 rounded-xl bg-navy px-4 py-3 text-xl font-semibold text-white disabled:opacity-60"
              onClick={() => void checkBatch()}
            >
              Check all labels
            </button>
          </section>
        )}

        <section className="mt-4">
          <h2 className="text-2xl font-semibold">Try an example</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {samples.map((sample) => (
              <button
                key={sample.id}
                type="button"
                disabled={busy}
                className="min-h-12 rounded-full bg-white px-4 py-2 text-left ring-2 ring-line disabled:opacity-60"
                onClick={() => void runSample(sample)}
              >
                {sample.title}
              </button>
            ))}
            {!samples.length && <p className="text-stone-600">Example labels are not on this page yet.</p>}
          </div>
        </section>

        {error && (
          <p role="alert" className="mt-4 rounded-xl border-2 border-mismatch bg-red-50 p-4 text-lg text-mismatch">
            {error}
          </p>
        )}

        {progress && (
          <div className="mt-6 rounded-2xl border border-line bg-white p-6" role="status">
            <div className="spinner" />
            <p className="mt-4 text-2xl font-semibold">
              {scannerReady ? `Checking label ${progress.index} of ${progress.total}` : "Loading the scanner — this happens once."}
            </p>
            <p className="mt-2 text-lg">{progress.name}</p>
            <p className={`mt-2 text-xl ${elapsed > 5 ? "font-semibold text-review" : ""}`}>
              {elapsed.toFixed(1)} seconds on this label
              {elapsed > 5 ? " — past the 5 second goal" : ""}
            </p>
          </div>
        )}

        {summary && mode === "batch" && rows.length > 0 && (
          <section className="mt-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold">Batch results</h2>
                <p className="mt-1 text-base text-stone-700">
                  Average {(summary.average / 1000).toFixed(1)}s · 95th percentile {(summary.p95 / 1000).toFixed(1)}s
                  {summary.slow ? ` · ${summary.slow} over 5 seconds` : ""}
                </p>
              </div>
              <button type="button" className="min-h-12 rounded-lg bg-navy px-4 py-2 font-semibold text-white" onClick={exportBatch}>
                Download spreadsheet
              </button>
            </div>
            <div className="mt-3 overflow-x-auto rounded-xl border border-line bg-white">
              <table className="w-full min-w-[640px] text-left">
                <thead className="bg-paper">
                  <tr>
                    <th className="px-4 py-3">Label</th>
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">Verdict</th>
                    <th className="px-4 py-3">What to look at</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr
                      key={row.id}
                      className={`cursor-pointer border-t border-line ${index === selected ? "bg-amber-50" : ""}`}
                      onClick={() => setSelected(index)}
                    >
                      <td className="px-4 py-3 font-semibold">{row.result.filename}</td>
                      <td className={`px-4 py-3 ${row.result.over_budget ? "font-semibold text-review" : ""}`}>
                        {(row.result.elapsed_ms / 1000).toFixed(1)}s
                      </td>
                      <td className="px-4 py-3">{verdictWord(agentVerdicts[row.id] ?? row.result.verdict)}</td>
                      <td className="px-4 py-3">{row.result.error ?? row.result.attention[0] ?? "All fields match"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {selectedRow && !selectedRow.result.error && (
          <section className="mt-6">
            {mode === "batch" && <h2 className="mb-3 text-2xl font-semibold">{selectedRow.result.filename}</h2>}
            <Checklist
              result={selectedRow.result}
              overrides={overrides[selectedRow.id] ?? {}}
              agentVerdict={agentVerdicts[selectedRow.id]}
              onOverride={(key, status) =>
                setOverrides((current) => ({
                  ...current,
                  [selectedRow.id]: { ...current[selectedRow.id], [key]: status },
                }))
              }
              onAgentVerdict={(verdict) =>
                setAgentVerdicts((current) => ({ ...current, [selectedRow.id]: verdict }))
              }
            />
          </section>
        )}
        {selectedRow?.result.error && (
          <p role="alert" className="mt-6 rounded-xl border-2 border-review bg-amber-50 p-4 text-lg">
            {selectedRow.result.filename}: {selectedRow.result.error} The other labels were still checked.
          </p>
        )}
      </main>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const id = label.replace(/\s+/g, "-").toLowerCase();
  return (
    <label className="block" htmlFor={id}>
      <span className="font-semibold">{label}</span>
      <input
        id={id}
        className="mt-1 min-h-12 w-full rounded-lg border border-line px-3 py-2"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function blankToNull(form: LabelApplication): LabelApplication {
  const next: LabelApplication = { is_import: Boolean(form.is_import) };
  for (const key of ["brand_name", "class_type", "alcohol_content", "net_contents", "producer_address", "country_of_origin"] as const) {
    const value = form[key]?.trim();
    if (value) next[key] = value;
  }
  return next;
}

function verdictWord(verdict: Verdict): string {
  if (verdict === "APPROVE") return "Approve";
  if (verdict === "REJECT") return "Reject";
  return "Needs review";
}
