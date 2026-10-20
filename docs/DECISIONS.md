# Decisions

## The check runs in the browser

The public prototype is hosted on Vercel from this GitHub repository. Vercel cannot install the Tesseract binary, and a serverless function would also put label photos on a server. Reading the label in the browser does three jobs at once:

- The agency firewall never has to allow an outside model endpoint.
- The photo is not uploaded.
- The same page is the deployed URL and the local demo.

The English scanner data is part of the site. It is fetched from this origin when the scanner first loads. It is not fetched from an OCR vendor while a label is checked.

A Python service in `backend/` is the version to run later on an internal machine. It uses the same verdicts. Redis is not used; a browser batch of a few hundred labels does not need a queue service.

## No model API in the request

A vision API was rejected. It would be blocked by the network, it would be slower and less predictable than a local read, and an auditor could not see why a field passed. The rules print the reason on the checklist.

The scanner is behind one function (`loadScanner`). A different reader could replace it later without changing the checklist.

## Three answers, not two

Each field is a match, a review, or a mismatch.

- Match: exact, or at least 95% the same after normalizing case, punctuation, units, and proof.
- Review: 80–95% similar, capitalization that changes the look of a brand (`STONE'S THROW` vs `Stone's Throw`), a scan the reader is not confident about, or a photo that cannot be read.
- Mismatch: clearly different values, or a government warning that is missing, rewritten, or not headed `GOVERNMENT WARNING:` in all caps.

One mismatch suggests reject. Any review, with no mismatch, asks the agent to decide. The agent can approve a review as a match or reject it. Those choices are in the results spreadsheet.

## The warning is exact

The header must be the letters `GOVERNMENT WARNING` in all caps. The two statutory sentences must match word for word, ignoring line breaks. A change of a few characters is a review, in case the scanner dropped a letter. A real rewrite is a mismatch. Title case (`Government Warning`) is a mismatch on its own.

Bold weight and tiny type are specified in the rules, but a scan does not report font weight reliably. The live check flags tiny warning type when the word boxes show it. It does not fail a correct header just because bold could not be measured. The Python module can take an explicit bold measurement when a future reader provides one.

## What this prototype does not do

- No COLA integration and no login.
- No retention of images. There is nothing to retain on the server.
- No attempt to approve a label the scanner cannot read.
- Batch size stops at 300, with a plain message to split the rest.
