---
id: "68e9cc"
title: Add the view_image tool
status: todo
priority: none
labels:
  - agents
  - m2
created_at: 2026-09-27T05:32:51.584Z
updated_at: 2026-09-27T05:32:51.632Z
blocked_by:
  - "737b8c"
  - "980988"
---

`bash` returns text only, so the model needs a way to look at images on its computer: screenshots (M8), photos the user sent, downloaded images (docs/design.md §5).

`view_image(path)` reads the file through gateway's file API and returns it to the model as an image content block. Details:
- Accept common formats. Convert anything unusual (HEIC from iPhones, large PNGs) to JPEG or PNG. Doing the conversion on the VM with ImageMagick through exec keeps the backend simple.
- Downscale images above a sensible size to control tokens. Research the image sizes and token costs Claude models handle best, and pick a max edge accordingly.
- Clear errors for missing files and non-images.

Check how images flow through the AI SDK's message types and the OpenRouter provider, and make sure they're persisted in `run_messages` without bloating Postgres. Large binaries belong in S3 per §12, but locally a filesystem or MinIO stand-in may be needed. Decide the approach, keeping the "binaries go to blob storage, referenced by key" rule, and note it in §12.

Tests: format conversion and downscaling decisions, error cases, and the stored message referencing a blob rather than inlining megabytes.
