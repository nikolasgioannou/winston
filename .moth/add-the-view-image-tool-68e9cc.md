---
id: "68e9cc"
title: Add the view_image tool
status: done
priority: none
labels:
  - agents
  - m2
created_at: 2026-09-27T05:32:51.584Z
updated_at: 2026-09-28T02:23:28.170Z
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

## Outcome

Built as described in docs/design.md §5 ("`view_image` as built") and §12 (Large binaries, "As built").
- **Checked live first:** an image in a tool result reaches Sonnet through OpenRouter. It read "BLUE 1742" off a test PNG for about 194 tokens.
- **Conversion on the VM:** the VM does the work with ImageMagick (HEIC, HEIF and AVIF readable in the image). The limits are 1568 px on the long edge, about 1.15 MP and 4.5 MB.
- **Storage:** images are stored as blobs, never inline. `BlobStore` is keyed by SHA-256 and local-directory backed (S3 in M4), and `storableMessage` swaps image bytes for a stub before `run_messages`. That also implements the older-images-become-stubs rule for the window.
- **Tests:** the conversion and downscale decisions, error cases, path-injection safety, the blob transform, and a turn that views an image and stores only the stub.
