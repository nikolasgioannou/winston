---
id: "68ae89"
title: Winston can't save a page or an email as a real PDF
status: done
priority: medium
labels:
  - browser
  - mail
parent: "07ba81"
created_at: 2026-10-24T16:49:56.760Z
updated_at: 2026-10-24T19:09:52.970Z
---

There's no way to render a web page or an email as a PDF, so Winston fakes it or builds tools by hand.

**From the trace audit (07ba81):**

- **Oct 4:** the expense task wrapped email text in `<pre>` and printed it, reporting "Email saved as PDF". The front called these receipts. Nik uploaded them for a reimbursement claim and asked "why are the pdfs in google text files like this - whys it not the actual pdf?". It took three more delegations, close to the deadline, to fix.
- **Oct 4, 17:33:** the front ran `pip install --break-system-packages websocket-client`, wrote `~/bin/print_to_pdf.py` against raw CDP and used up its turn. Later runs reused that script, bypassing `winston browser` and its site locks (Oct 9).
- **Oct 5:** the front ran `pip install fpdf2 --break-system-packages` to turn receipts into PDFs. Nik: "bro theres still some txts in there. i need pdfs".

**What to build**

- `winston browser pdf [--window <win>] <path>` prints the current page (CDP `Page.printToPDF`) through winstond, respecting windows and locks.
- `winston mail pdf <msg_id> <path>` renders an email as it looks (the HTML part, with headers), for receipts and records.
- Prompts: use these for documents someone else will receive, and say so plainly when a "receipt" is only a text transcript.

**Done when**

- [ ] `browser pdf` writes a PDF of a fixture page (test)
- [ ] `mail pdf` renders an HTML email with its images to PDF (test)
- [ ] docs/design.md updated

## As built (2026-10-24)

- **`winston browser pdf <path> [--window]`:**
  - the CLI resolves `~/`;
  - winstond's `pdf` (`actions.ts`, RPC route `pdf`) runs CDP `Page.printToPDF` with backgrounds and the page's own size;
  - it writes the file through the same path as screenshots, only under `/home/winston` and only to `.pdf`;
  - any window can be printed, since printing changes nothing;
  - the result prints the path, the size and the page it came from.
  - Test with the fake Chrome: the params, the saved bytes and path, and refusals outside home or without `.pdf`.
- **Prompts:**
  - `background.md`: use `pdf` for receipts and confirmations someone will receive or file, and for an email open it in the user's webmail and print that. A text file isn't a receipt; say so if that's all there is.
  - `front-of-house.md`: names the command.
- **docs/design.md:** the browser commands.

**Changed from the plan:** `winston mail pdf` isn't built. The mail layer keeps only text (HTML is converted on read), so it would need HTML kept through the connectors, a route to fetch it, and a render step. Winston's browser is already signed in to the user's webmail, so opening the email there and running `browser pdf` gives the real rendering today. Rendering mail directly can be a ticket of its own if this proves clunky.

- [ ] `browser pdf` writes a PDF of a fixture page: tested against the fake Chrome, not a real one (no Chrome test here)
- [ ] `mail pdf` renders an HTML email with its images to PDF: not built, see above
- [x] docs/design.md updated
