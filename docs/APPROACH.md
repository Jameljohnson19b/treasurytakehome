# Approach

DeskCheck compares a label photo with the fields on an application and prints a checklist. The work is mostly matching, so the result is a set of rules an agent can explain, not a model score with no reason attached.

## Tools

- **Next.js** for the single page. Vercel builds it from this repository.
- **Tesseract.js** in the browser, with the English trained data and the WebAssembly core copied into `public/ocr` at build time. The page loads those files from its own host.
- **A small rules module** (`src/lib/parser.ts`, `src/lib/verifier.ts`) for alcohol, volume, names, and the government warning. The same cases are covered by Vitest.
- **Python** (`backend/`) keeps the same thresholds for a future server on a machine that can install Tesseract. It is not on the request path of the public site.

## Assumptions

- The agent has the application fields, either typed in or provided as CSV/JSON. This tool does not sign into COLA.
- The government warning is checked against the statutory sentence, not against a field the applicant typed.
- `750 mL`, `75 cL`, and `0.75 L` are the same net contents. `90 proof` is `45%` alcohol by volume, within a tenth of a percent.
- A brand that is the same letters in all caps on the label and mixed case on the form is a review, not a rejection.
- If the scanner is unsure about a field, the field is a review even when the strings look identical or very different.
- Images are not stored. Closing the tab drops them. The public site has no account and no database.

## How a label is checked

1. Scale the photo so the long side stays under about 1400 pixels.
2. If a small tilt makes the text lines clearer, straighten it.
3. Stretch contrast, then read the text with Tesseract (page segmentation mode 4, which keeps the brand line).
4. Pull alcohol, volume, and the warning with patterns. Find the brand in the top lines, and the class, address, and country in the rest.
5. Mark each field and roll the marks up to one verdict.
6. Show both values, the reason, and buttons for the agent to approve or reject a judgment call.

## Latency

The budget is 5 seconds per label. The screen shows the running time and flags anything slower. Pre-scaling the photo is what keeps the scanner inside that budget on a normal laptop. A batch does not try to read 300 labels at once; it reads them in order and says which one it is on.
