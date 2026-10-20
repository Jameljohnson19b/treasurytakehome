# DeskCheck

A label checklist for alcohol-beverage applications. An agent drops a label photo, types or uploads the application fields, and gets a match / review / mismatch result in a few seconds. Close calls stay with the person. The photo never leaves the browser, and the check does not call an outside service.

Live site: [https://treasurytakehome.vercel.app](https://treasurytakehome.vercel.app)

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The first check loads the scanner from this app (about 10 MB, once). After that, each label is read on the computer you are using.

```bash
npm test
```

Python unit tests for the same rules, from `backend/`:

```bash
pip install -r backend/requirements-dev.txt
cd backend && pytest
```

The Python API is the shape an internal host would run. This prototype’s public site is the browser app, because the host (Vercel) cannot install the Tesseract binary and the agency network cannot call a vendor ML endpoint.

## What a result means

| Mark | Meaning |
| --- | --- |
| MATCH | The label and the application say the same thing. |
| REVIEW | A person should look. Capitalization, a near miss, or a weak scan. |
| MISMATCH | The values disagree, or the government warning breaks a hard rule. |

The label verdict is **Approve** only when every provided field matches. Any review becomes **Needs agent review**. Any mismatch becomes **Reject (suggested)** until an agent confirms it. A blank application field is not held against the label. An unreadable photo is never approved.

## Try the examples

The page includes ten labels:

1. Correct bourbon label — approve
2. `STONE'S THROW` vs `Stone's Throw` — review the brand only
3. 46% vs 45% — reject
4. 75 cL vs 750 mL — approve
5. 90 proof vs 45% ABV — approve
6. `Government Warning` instead of `GOVERNMENT WARNING:` — reject
7. Warning wording changed — reject
8. Washed-out photo — review, no crash
9. Crooked photo — straighten a small tilt, then approve
10. Warning missing — reject

Batch mode accepts up to 300 images plus a CSV or JSON file of application rows, shows progress, and downloads a results spreadsheet.

## Architecture

```
Browser
  Drop a label (one, or up to 300)
        │
        ▼
  Prepare the photo (scale, straighten a small tilt, contrast)
        │
        ▼
  Tesseract.js  ·  English data served by this same site
        │
        ▼
  Rules: exact warning, ABV/proof, unit conversion, fuzzy names
        │
        ▼
  Checklist: match / review / mismatch, with agent override
```

Nothing in that path opens a connection to an OCR vendor or a model API.

## Decisions

See [docs/DECISIONS.md](docs/DECISIONS.md) and [docs/APPROACH.md](docs/APPROACH.md).

## Limits

- Stylized label fonts and heavy glare are sent to review instead of guessed.
- Bold type on the warning header is not measured reliably from a scan, so a correct all-caps header is not failed for weight. Casing and wording are.
- There is no COLA login and no record kept after the tab closes.
- A batch of 300 runs one label at a time in the browser so the machine stays responsive. Each label still aims for under 5 seconds; the clock is on the screen.
- The first visit downloads the scanner from this site. Later checks do not.
