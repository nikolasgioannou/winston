---
id: "68ae89"
title: Winston can't save a page or an email as a real PDF
status: todo
priority: medium
labels:
  - browser
  - mail
parent: "07ba81"
created_at: 2026-10-24T16:49:56.760Z
updated_at: 2026-10-24T16:50:33.348Z
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
