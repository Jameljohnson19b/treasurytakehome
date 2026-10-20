import type { FieldResult, FieldStatus, VerificationResult, Verdict } from "@/lib/types";
import { applyOverrides, rollup, verdictLabel } from "@/lib/verifier";

const STATUS_CLASS: Record<FieldStatus, string> = {
  MATCH: "bg-emerald-50 text-match border-match",
  REVIEW: "bg-amber-50 text-review border-review",
  MISMATCH: "bg-red-50 text-mismatch border-mismatch",
  NOT_PROVIDED: "bg-stone-100 text-stone-600 border-stone-300",
};

const VERDICT_CLASS: Record<Verdict, string> = {
  APPROVE: "bg-emerald-50 border-match text-match",
  NEEDS_REVIEW: "bg-amber-50 border-review text-review",
  REJECT: "bg-red-50 border-mismatch text-mismatch",
};

export function Checklist({
  result,
  overrides,
  agentVerdict,
  onOverride,
  onAgentVerdict,
}: {
  result: VerificationResult;
  overrides: Record<string, FieldStatus | undefined>;
  agentVerdict?: Verdict | null;
  onOverride: (key: string, status: FieldStatus) => void;
  onAgentVerdict: (verdict: Verdict | null) => void;
}) {
  const fields = applyOverrides(result.fields, overrides);
  const verdict = agentVerdict ?? rollup(fields);
  const seconds = (result.elapsed_ms / 1000).toFixed(1);
  const notes = result.unreadable
    ? result.attention
    : [...new Set(fields.filter((field) => field.status === "REVIEW" || field.status === "MISMATCH").map((field) => field.reason).filter(Boolean) as string[])];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(260px,380px)_minmax(0,1fr)]">
      <div>
        {result.image_url ? (
          <img
            src={result.image_url}
            alt={`Label photo ${result.filename}`}
            className="w-full rounded-xl border border-line bg-white"
          />
        ) : (
          <div className="rounded-xl border border-line bg-white p-6 text-stone-600">No photo saved for this row.</div>
        )}
        <p className={`mt-3 text-base ${result.over_budget ? "font-semibold text-review" : "text-stone-600"}`}>
          Checked in {seconds} seconds.
          {result.over_budget ? " That is past the 5 second goal." : " Within the 5 second goal."}
        </p>
      </div>

      <div>
        <div className={`rounded-xl border-2 p-5 ${VERDICT_CLASS[verdict]}`}>
          <p className="text-sm font-semibold uppercase tracking-wide">Verdict</p>
          <p className="mt-1 text-3xl font-semibold leading-tight">{verdictLabel(verdict, Boolean(agentVerdict))}</p>
          {notes.length > 0 && (
            <ul className="mt-3 space-y-1 text-base text-ink">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" className="min-h-12 rounded-lg bg-navy px-4 py-2 font-semibold text-white" onClick={() => onAgentVerdict("APPROVE")}>
              Confirm approve
            </button>
            <button type="button" className="min-h-12 rounded-lg bg-white px-4 py-2 font-semibold text-mismatch ring-2 ring-mismatch" onClick={() => onAgentVerdict("REJECT")}>
              Reject this label
            </button>
            <button type="button" className="min-h-12 rounded-lg bg-white px-4 py-2 font-semibold text-ink ring-2 ring-line" onClick={() => onAgentVerdict("NEEDS_REVIEW")}>
              Flag for review
            </button>
          </div>
        </div>

        <ol className="mt-4 space-y-3">
          {fields.map((field) => (
            <li key={field.key} className="rounded-xl border border-line bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-xl font-semibold">{field.label}</h3>
                <span className={`rounded-full border px-3 py-1 text-sm font-bold tracking-wide ${STATUS_CLASS[field.status]}`}>
                  {statusWord(field.status)}
                </span>
              </div>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-sm font-semibold uppercase tracking-wide text-stone-500">Application</dt>
                  <dd className="mt-1 break-words">{field.application_value || "—"}</dd>
                </div>
                <div>
                  <dt className="text-sm font-semibold uppercase tracking-wide text-stone-500">On the label</dt>
                  <dd className="mt-1 break-words">{field.label_value || "—"}</dd>
                </div>
              </dl>
              {field.reason && <p className="mt-3 text-base text-ink">{field.reason}</p>}
              {field.status === "REVIEW" && (
                <div className="mt-3 flex flex-wrap gap-3">
                  <button type="button" className="min-h-12 rounded-lg bg-match px-4 py-2 font-semibold text-white" onClick={() => onOverride(field.key, "MATCH")}>
                    Approve as a match
                  </button>
                  <button type="button" className="min-h-12 rounded-lg bg-white px-4 py-2 font-semibold text-mismatch ring-2 ring-mismatch" onClick={() => onOverride(field.key, "MISMATCH")}>
                    Reject this field
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>

        {result.ocr_text && (
          <details className="mt-4 rounded-xl border border-line bg-white p-4">
            <summary className="cursor-pointer text-lg font-semibold">Text the scanner read</summary>
            <pre className="mt-3 whitespace-pre-wrap font-sans text-base">{result.ocr_text}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function statusWord(status: FieldStatus): string {
  if (status === "NOT_PROVIDED") return "NOT IN APPLICATION";
  return status;
}

export type { FieldResult };
