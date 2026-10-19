# V2 source and regression audit

Audit baseline: commit `9d2a4c329dd4342a84447a70d492a3190dc7cc00`, branch `main`.
All tracked application, report, dependency metadata and test files were inspected before changes. The deployable application is one HTML file with separate inline core, image, PDF, archive, text/data, media, metadata and UI modules. Node and Playwright are development-only dependencies.

The existing application contains **27 real tool runners**. The baseline suite ran against the production HTML with live pinned CDN libraries: **44 passed, 0 failed**, Chromium `154.0.8037.57`, headless Linux, measured readiness **321 ms**. This is browser emulation, not a physical Samsung or Android test. The old report's 372 ms is a previous measurement, not the V2 baseline.

## Inventory at audit time

“Tested; improve” means the baseline operation produced and reopened a valid output, but the shared dialog, mobile interactions or feature depth needed work. Formats listed are actual implementation families, not promises of universal codec support.

| Existing ID | Inputs → outputs | Audit classification and evidence | Dependencies / limits |
|---|---|---|---|
| `image-transform` | Browser-decodable PNG/JPEG/WebP/AVIF/BMP/GIF/sanitized SVG → supported Canvas encoders | Tested; improve. JPEG/WebP signatures, decoded dimensions, pixel flips/background, crop/rotation, EXIF orientation and quality verified. Animated input deliberately becomes a still image. A bad batch member currently rejects the whole batch. | Native; encoder support probed independently. 16–24 MP surface guard; explicit image and batch budgets. |
| `images-pdf` | Images → PDF | Tested; improve. Result parsed as a two-page PDF. Current order follows workspace. Needs in-dialog image ordering, rotation and page-layout feedback. | `pdf-lib`; source and embedded-image budgets. |
| `pdf-merge` | PDF → PDF | Tested; improve. Page count and distinct source page widths prove merge order. | `pdf-lib`; 1500-page and combined-size guards. |
| `pdf-split` | PDF → multiple PDF files | Tested; improve. Each output parsed; individual and grouped page counts verified. | `pdf-lib`; bounded number of outputs. |
| `pdf-extract` | PDF → PDF | Tested; improve. Requested pages `3,1` reopen in the requested order. Corrupt/empty input rejected in Arabic. | `pdf-lib`. |
| `pdf-delete` | PDF → PDF | Tested; improve. Remaining page widths prove deletion preserves order. | `pdf-lib`. |
| `pdf-reorder` | PDF → PDF | Tested; improve. Reversed/explicit page selection validated by page structures. Numeric list only; no visual organizer. | `pdf-lib`. |
| `pdf-rotate` | PDF → PDF | Tested; improve. Only selected page rotation changes. | `pdf-lib`. |
| `pdf-text` | PDF → TXT | Tested; improve. Embedded Latin and Arabic words preserved in tests. Scans are explicitly not OCR; Arabic ordering depends on source encoding. | PDF.js; bounded characters/pages. |
| `zip-create` | Files → ZIP | Tested; improve. Arabic directory names, binary bytes and empty entries reopen correctly. Duplicate/conflicting paths rejected. Current archive creation stores data without compression. | Native ZIP writer; configurable size/entry guards. |
| `zip-inspect` | ZIP → TXT contents report | Tested; improve. Report preserves Arabic entry names; structural limits verified. Contents shown as text rather than an interactive hierarchy. | Native central-directory parser. Ordinary/Deflate ZIP only. |
| `zip-extract` | ZIP → files or ZIP | Tested; improve. Selected entry extraction/repack and CRC corruption rejection verified. Numeric entry selection only. | `fflate` for Deflate; traversal, size, count, ratio and CRC checks. No encrypted ZIP/ZIP64. |
| `csv-json` | CSV/text → JSON | Fully implemented and tested for existing scope. BOM, detected delimiters, quotes, embedded newlines, escaped quotes and safe numeric coercion verified. | Native strict parser; 12 MiB text / 50000-row / 300000-cell guards. |
| `json-csv` | Array-of-object JSON → CSV | Fully implemented and tested for existing scope. Reparse/round trip and formula injection protection verified. Nested/general JSON is not advertised as a table. | Native; text/table guards. |
| `json-format` | JSON/text → JSON | Fully implemented and tested for existing scope. Actual JSON parsed; corrupt structures rejected. UI upload-to-browser-download verified. | Native JSON parser. |
| `xml-format` | XML/text → XML | Fully implemented and tested for existing scope. Reparses result; mixed text retained and DTD rejected. | Native inert DOM parser. |
| `text-stats` | Text → TXT report | Fully implemented and tested for existing scope. Arabic words, code-point counts, lines and literal search checked. | Native; bounded text size. |
| `text-merge` | Text files → TXT | Fully implemented and tested for existing scope. Arabic contents, order and separator verified. | Native; combined text budget. |
| `text-split` | Text → TXT parts | Fully implemented and tested for existing scope. Joining outputs reproduces mixed CR/LF/CRLF input exactly. | Native; at most 100 parts. |
| `text-encoding` | Supported text encodings → UTF-8 TXT | Fully implemented and tested for existing scope. Windows-1256 and UTF-16 LE/BE detection and Arabic text restoration checked; dialog uses detected encoding. | Native `TextDecoder`; explicit selectable encodings. |
| `html-text` | Untrusted HTML → TXT | Fully implemented and tested for existing scope. Text extracted without executing source scripts or requesting source resources. | Native inert parsing and sanitization. |
| `sha256` | Any files → TXT report | Fully implemented and tested for existing scope. Empty/`abc`/1 MiB boundary vectors match Node crypto; streaming cancellation checked. | Incremental native JavaScript, worker where supported; no secure-context dependency. |
| `duplicates` | Files → TXT hash groups | Fully implemented and tested for existing scope. Different names with matching bytes group together; equal names with different bytes do not. | Same SHA-256 engine; size pre-grouping avoids needless hashes. |
| `base64-encode` | File → Base64 TXT | Fully implemented and tested for existing scope. Arbitrary binary bytes round-trip exactly. | Native; 8 MiB per file guard. |
| `base64-decode` | Base64 text → binary file | Fully implemented and tested for existing scope. Bytes and chosen Arabic filename preserved; noncanonical/malformed Base64 rejected. | Native; 12 MiB text guard. |
| `audio-edit` | Browser-decodable audio → 16-bit PCM WAV | Tested; improve. Generated PCM redecoded; trim duration/gain checked. Numeric-only selection, no waveform/fades/normalization. | Web Audio; 20 MiB / 180 seconds / 2 channels. Decode cancellation is cooperative. |
| `video-frame` | Browser-playable video → PNG/JPEG still | Tested; improve. Real WebM fixture inspects and frame reopens with expected 160×90 dimensions. No universal video conversion claimed. | Native media/Canvas; codec-dependent, bounded frame pixels and file size. |

## Shared findings and safeguards

- **P0 confirmed UX defect:** tool dialogs cannot choose or replace files. With an incompatible selection, the user must close the dialog and return to the workspace. Single-file tools also require manual workspace deselection when several compatible files are selected. V2 must recover inside every dialog while preserving unrelated files.
- **P0 batch reliability gap:** image processing is sequential and memory-conscious, but one corrupt image discards all preceding results. V2 needs per-file error isolation and honest partial completion.
- **Discovery limitation:** existing search matches names/descriptions/extensions but lacks an explicit synonym index and recent-tool filtering. Favorites already persist as identifiers; private source contents are not persisted.
- **Interface debt:** tall cards and repeated copy increase phone scrolling. Numeric page lists, archive selection and audio range fields lack visual alternatives. Existing keyboard controls and responsive breakpoints are a useful base to preserve.
- **Memory policy:** source intake applies a 100 MiB general default in addition to per-operation budgets. Existing `createImageBitmap` closures, canvas disposal, media cleanup and object-URL revocation are present. Most dependency parsing cannot interrupt synchronously; cancellation must continue to be described honestly.
- **Security base:** uploaded HTML/SVG is sanitized/inert; names are rendered with text nodes/bidirectional isolation; ZIP paths and CRC are checked; no private file storage, analytics, secret keys or upload endpoint exists. Regressions in these guarantees need tests, not UI inspection.
- **Dependency reliability:** pinned `pdf-lib@1.17.1`, `pdfjs-dist@5.7.284`, `fflate@0.8.2` load on demand and rejected loads can retry. Cached bytes remain usable during the same page session. Browser cache is not a guaranteed offline distribution; there is no service worker.
- **Unsupported at baseline:** DOCX creation/extraction, Markdown rendering, Arabic text-to-PDF generation, interactive Data Lab, SHA-512, QR, smart chained workflows, visual page organizer, archive encryption, advanced image effects, audio waveform editing and heavy video conversion. These were not existing working features and cannot be counted as preserved functionality.
- **Future integration:** three AI capabilities and a provider interface are declarations with an explicit unavailable error. No inference/API calls run; OCR, translation and transcription are not implemented.

## Verification boundaries

All 27 runners have functional baseline coverage, but this is not exhaustive format fuzzing. The baseline suite verifies five viewport sizes, Arabic filenames, long filenames, malformed/empty files, output-name editing, repeated queue usage, cancellation, preference persistence, lazy dependency loading/failure and actual browser downloads. It does not establish full WCAG certification, arbitrary PDF compatibility, maximum-memory behavior, AVIF encoding on every browser, animation preservation, hardware Android performance or support for unsupported media codecs.

V2 results belong in `TEST_RESULTS.json` and the engineering report after final HTML reassembly. No feature in development should be marked tested solely because this baseline audit passed.

## Final V2 verification

The final deployable `index.html` passed **92/92 integration cases**: all **44 preserved baseline cases** and **48 V2 cases**, using live pinned CDN dependencies. The tested file is **463718 bytes**, SHA-256 `56a8e0db35ab8a6d400e8c9c88f684c187ffec344af309930c17ae5cd435b42c`. Tool registry: **54 entries**, including the original 27; 53 are available in this Chromium environment, with native QR scanning correctly unavailable.

V2 verification reopens encoded BMP/JPEG/WebP/PNG, parses generated PDFs and OOXML ZIP structures, extracts archive contents and validates byte equality/CRC, checks edited image pixels and opacity, reopens PCM WAVs and checks their samples, and independently decodes generated Arabic QR PNGs with development-only `jsQR`. It executes the visual PDF organizer, editable Data Lab, searchable archive selection, audio waveform, image comparison and direct tool file controls through the actual interface and processing queue.

Additional regression cases verify per-file success/failure states, exact retry source indices despite identical filenames, pending cancellation reference cleanup, corrupt persisted activity recovery, a bracketed CSV header, actual JSON under a misleading CSV extension, incompatible replacement recovery, strict JSON precision/depth/output budgets, and prototype-like column names remaining data. Every available tool has a tested in-dialog file picker. Privacy tests confirm no private source files or outputs persist, and no file upload requests occur.

The final measured navigation-to-registry duration was **322 ms**, compared with **321 ms** in the fresh pre-upgrade run; these are individual headless Linux measurements, not evidence of a startup speed improvement. Workload safeguards, sequential decoding, bounded previews and stable file/result DOM nodes are verified architectural improvements; peak memory was not measured. The V2 suite uses touch API emulation and checks 8 sections at each of 5 viewport sizes plus populated dialogs; physical Android devices remain untested. Manual visual inspection of the generated Arabic PDF preview confirmed joined Arabic glyphs, right alignment and readable mixed Arabic/English text in this environment.
