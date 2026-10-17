# CYBERFORGE: HACK & SECURE — Certificate Website

KAIRVOX TECHNOLOGIES · static site (HTML, CSS, vanilla JavaScript, Papa Parse, jsPDF). No backend, no database, no Node.js.

> **Security limitation — please read.**
> This is a static, database-free prototype. `participants.csv` is a public file: anyone who can open the website can download it and see every name and certificate ID. All checks run in the browser, so they can be bypassed. **This version is not secure against unauthorized certificate retrieval.** The code keeps the data lookup isolated in `CertificateService` (top of `script.js`) so a server-side verification endpoint can replace it later without redesigning the page.

## Project structure

```
cyberforge/
├── index.html                 page structure (header, hero, search form, preview, about, footer)
├── style.css                  all styling
├── script.js                  CSV loading, search, certificate drawing, PDF generation
├── participants.csv           your 165 participants (FULL NAME, CERFICATE ID, WORKSHOP TITLE, COMPLETION DATE)
├── certificate-template.png   the certificate artwork (1491 x 1055 px)
└── README.md
```

External libraries load from CDNs, so the first run needs internet: Papa Parse 5.4.1 and jsPDF 2.5.1 (cdnjs), plus the Inter and Mr Dafoe fonts (Google Fonts).

## Run it locally (VS Code Live Server)

The site reads `participants.csv` with `fetch()`, which browsers block on `file://` pages. Opening `index.html` by double-click will show "Certificate records could not be loaded". Use a local web server:

1. Install the **Live Server** extension (Ritwick Dey) in VS Code.
2. In VS Code: **File → Open Folder…** and choose the `cyberforge` folder.
3. Right-click `index.html` → **Open with Live Server** (or click **Go Live** in the status bar).
4. The site opens at `http://127.0.0.1:5500/`.

Without VS Code, from inside the `cyberforge` folder: `python3 -m http.server 8000`, then open `http://localhost:8000`.

## How a participant uses it

1. Enter the registered name and certificate ID (case and extra spaces don't matter), then press the button or Enter.
2. Name and ID must belong to the **same** CSV row. A wrong pair always shows the same generic message.
3. The certificate preview appears. **Download Certificate as PDF** saves `CYBERFORGE_Certificate_<NAME>.pdf` (one landscape page, A4 width, same proportions as the template).

## Replace the participant list

1. Export your new list as CSV (UTF-8) with these exact headers: `FULL NAME`, `CERFICATE ID`, `WORKSHOP TITLE`, `COMPLETION DATE`. Headers are matched after trimming and upper-casing; `CERTIFICATE ID` (correct spelling) is also accepted.
2. Save it as `participants.csv` in the project folder, replacing the old file.
3. Reload the site. Open the browser console (F12) → the **[CYBERFORGE]** group reports how many records loaded, any rows skipped for a missing name/ID, and any **duplicate certificate IDs**.

Empty rows are ignored. IDs and names are never altered in the file; they are only tidied (spaces) for comparison.

## Change the certificate template

1. Replace `certificate-template.png` (keep the same file name, or change `CONFIG.templatePath` in `script.js`).
2. Same layout at a different resolution (e.g. 2982 x 2110): nothing else to change. Positions are stored for a 1491 x 1055 reference and scaled automatically.
3. Different layout: re-measure and edit `NAME_LAYOUT` and `ID_LAYOUT` in `script.js` (coordinates in pixels of a 1491 x 1055 image):
   - `cover` — the rectangle that hides the old placeholder text (`[ Participant Name ]`, `KTX-CF-2026-0001`). It must not touch the underline, box border or label.
   - `centerX`, `baselineY` / `centerY`, `maxWidth` — where the text is centred and how wide it may be.
   - `patch` — a small strip that restores the name underline where the old "p" tail touched it; remove it for a template without that issue.
   - The old placeholder is repainted with a colour sampled from the template around it, so a plain light background works best.

## Name styling

`CONFIG.nameCase` in `script.js`:

- `'auto'` (default): names are written as stored, **except** names typed entirely in capitals (`SHARMILA DEVI N`), which become `Sharmila Devi N` — capitals are very hard to read in a script font. Initials of 1–2 letters (`N`, `GG`) stay as typed.
- `'preserve'`: always exactly as in the CSV.
- `'title'`: Title Case for everyone.

Long names shrink (down to 34 px) and are squeezed horizontally only as a last resort, so they never run past the underline.

## Notes on the PDF

The certificate (template + name + ID) is drawn on a canvas at 2x the template resolution and placed into a one-page PDF as a high-quality JPEG. Preview and PDF use the same drawing code, so the positions are identical. Because it is an image, text in the PDF cannot be selected or copied.

## Data issues noticed in the supplied CSV

- No duplicate certificate IDs and no incomplete rows (165 records; the trailing `,,,` row is ignored).
- Four names appear twice with different IDs (`Dev Anand` 0018/0056, `Dhanush` 0019/0062, `Abyvighneesh P Y` 0010/0063, `Kiruthikaa PT` 0024/0073). They work because a name must match its own ID.
- `6Kabilan. T` (ID 0064) has a stray "6", and a few names have a trailing full stop or odd casing. They are shown as stored. Fix them in the CSV if wrong.

## Testing checklist (automated headless-Chromium run, 21 checks passed)

Run against the real CSV and template, with the CDN libraries and fonts served from local copies of the same versions.

- [x] Stylesheet and script load, no console errors; CSV loads (165 records)
- [x] Empty fields → "Please enter your registered name and certificate ID."
- [x] Correct ID + wrong name, and correct name + wrong ID → generic "No matching certificate…" message, no preview
- [x] Correct pair with messy case/spacing (`   kebin    PETER   t  ` / ` ktx-cf-2026-0001 `) verifies; Enter key submits; no page reload
- [x] Participants sharing a name (`Dev Anand`) each match only their own ID
- [x] Submitting while the CSV is still loading → "Please wait while participant records are loaded."
- [x] CSV 404 → "Certificate records could not be loaded. Please try again later."
- [x] Preview canvas is 2x the template (2982 x 2110), name and ID overlays correct (visually checked for short, long and ALL-CAPS names)
- [x] PDF downloads as `CYBERFORGE_Certificate_KEBIN_PETER_T.pdf`: 1 page, landscape, 297 x 210 mm, no website UI, success message shown
- [x] jsPDF missing → "Unable to generate the certificate PDF. Please try again." and the button stays usable for a retry
- [x] Mobile width (390 px): menu works, no horizontal scrolling

Not tested: real Google Fonts/CDN delivery from your network, other browsers than Chromium, and opening PDFs in every reader (checked with poppler only).
