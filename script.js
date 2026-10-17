/* ==========================================================================
   CYBERFORGE: HACK & SECURE — Certificate lookup + PDF download
   KAIRVOX TECHNOLOGIES

   Static, database-free prototype:
     participants.csv  --fetch + Papa Parse-->  in-memory records
     name + ID typed by the participant        --> matched against ONE record
     matched record                            --> <canvas> certificate preview
     same canvas drawing at higher resolution  --> jsPDF single-page PDF

   SECURITY NOTE: the CSV is a public static file and all checks run in the
   browser, so anyone can read the participant list or bypass the form.
   This is NOT secure against unauthorized certificate retrieval.
   To harden it later, replace CertificateService.load() / .verify() below with
   a server call (e.g. POST /api/verify) that returns only the matched record —
   the UI, preview and PDF code do not need to change.
   ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------------
     1. CONFIGURATION
     ------------------------------------------------------------------------ */
  const CONFIG = {
    csvPath: 'participants.csv',
    templatePath: 'certificate-template.png',

    // Resolution multiplier for the preview canvas and the PDF render.
    previewScale: 2,
    pdfScale: 2,
    pdfJpegQuality: 0.97,

    // Minimum time the loading indicator is shown (ms), so the state is visible.
    minSearchMs: 450,

    // How the name is written on the certificate:
    //   'auto'     (default) keeps names as stored, but converts names typed ENTIRELY IN CAPITALS
    //              ("SHARMILA DEVI N" -> "Sharmila Devi N"), because capitals are hard to read in a script font.
    //   'preserve' always draws the name exactly as stored in the CSV.
    //   'title'    converts every name to Title Case.
    nameCase: 'auto',

    // Accepted CSV header spellings, compared after trim + UPPERCASE.
    // The workshop CSV really uses the misspelled "CERFICATE ID".
    columns: {
      name: ['FULL NAME'],
      id: ['CERFICATE ID', 'CERTIFICATE ID'],
      title: ['WORKSHOP TITLE'],
      date: ['COMPLETION DATE'],
    },
  };

  /* ------------------------------------------------------------------------
     2. CERTIFICATE LAYOUT
     All numbers below are in the template's reference space:
     1491 x 1055 px (the size of certificate-template.png).
     If you swap in a template with the same layout at a different resolution,
     nothing changes: drawing is scaled by (template width / REF.width).
     If the layout differs, re-measure the values below (see README).
     ------------------------------------------------------------------------ */
  const REF = { width: 1491, height: 1055 };

  const NAME_LAYOUT = {
    // The template has "[ Participant Name ]" printed at x 461-1026, y 422-491,
    // above a blue underline at y ~497 (x 302-1180). Only this rectangle is
    // repainted. It stops at y = 493 so the underline is never touched.
    cover: { x: 448, y: 414, w: 598, h: 79 },
    // The tail of the "p" in the printed placeholder dips onto the underline
    // (x 676-690, y 493-496). That small strip is replaced with a clean piece of
    // the same underline copied from further left (x 648-670).
    patch: { x: 672, y: 493, w: 22, h: 7, donorX: 648 },
    centerX: 741,        // horizontal centre of the underline (302..1180)
    baselineY: 468,      // text baseline: sits just above the underline
    maxWidth: 840,       // keep inside the underline (878 px wide) with margin
    maxSize: 84,         // starting font size (px, reference space)
    minSize: 34,         // below this the text is squeezed horizontally instead
    family: '"Mr Dafoe", "Segoe Script", "Brush Script MT", cursive',
    color: '#101c4a',
  };

  const ID_LAYOUT = {
    // The template has "KTX-CF-2026-0001" printed at x 978-1166, y 832-848
    // inside the Certificate ID box (box: x 955-1190, y 785-870).
    // Only the printed ID text is repainted, not the box or its label.
    cover: { x: 970, y: 824, w: 204, h: 32 },
    centerX: 1072,       // centre of the ID box
    centerY: 840.5,      // vertical centre of the original ID text
    maxWidth: 196,       // fits inside the box with padding
    maxSize: 24,
    minSize: 13,
    family: '"Inter", "Segoe UI", Arial, sans-serif',
    weight: 700,
    color: '#0c1a40',
  };

  /* ------------------------------------------------------------------------
     3. MESSAGES
     ------------------------------------------------------------------------ */
  const MSG = {
    missing: 'Please enter your registered name and certificate ID.',
    loading: 'Please wait while participant records are loaded.',
    loadFailed: 'Certificate records could not be loaded. Please try again later.',
    notFound: 'No matching certificate was found. Please check your registered name and certificate ID.',
    verified: 'Certificate verified successfully!',
    pdfReady: 'Your certificate is ready to download.',
    pdfFailed: 'Unable to generate the certificate PDF. Please try again.',
    previewFailed: 'Unable to display the certificate preview. Please try again.',
  };

  /* ------------------------------------------------------------------------
     4. DOM REFERENCES
     ------------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('verifyForm'),
    name: $('participantName'),
    id: $('certificateId'),
    submit: $('verifyButton'),
    formAlert: $('formAlert'),
    recordsStatus: $('recordsStatus'),
    retryLoad: $('retryLoadBtn'),
    previewSection: $('previewSection'),
    previewAlert: $('previewAlert'),
    previewHeading: $('previewHeading'),
    canvas: $('certificateCanvas'),
    download: $('downloadButton'),
    downloadAlert: $('downloadAlert'),
    findBtn: $('findCertificateBtn'),
    navToggle: document.querySelector('.nav-toggle'),
    nav: $('primaryNav'),
  };

  const state = {
    status: 'idle',      // 'idle' | 'loading' | 'ready' | 'error'
    records: [],
    isSearching: false,
    isGenerating: false,
    current: null,       // the verified record currently previewed
  };

  /* ------------------------------------------------------------------------
     5. SMALL HELPERS
     ------------------------------------------------------------------------ */
  const ZERO_WIDTH = /[​-‍﻿]/g;

  /** Trim, drop invisible characters, collapse runs of spaces/NBSP into one space. */
  const cleanSpaces = (value) =>
    String(value ?? '').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();

  /** Comparison key for names: cleaned spaces, case-insensitive. */
  const nameKey = (value) => cleanSpaces(value).normalize('NFC').toLocaleLowerCase('en');

  /** Comparison key for certificate IDs: no whitespace at all, case-insensitive. */
  const idKey = (value) => String(value ?? '').replace(ZERO_WIDTH, '').replace(/\s+/g, '').toUpperCase();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** "SHARMILA DEVI N" -> "Sharmila Devi N". Tokens of 1-2 letters (initials such as "N", "GG") stay as typed. */
  function toTitleCase(text) {
    return text
      .split(' ')
      .map((token) => {
        const letters = (token.match(/\p{L}/gu) || []).length;
        if (letters <= 2) return token;
        return token
          .toLocaleLowerCase('en')
          .replace(/(^|[.'\u2019-])(\p{L})/gu, (_, sep, ch) => sep + ch.toLocaleUpperCase('en'));
      })
      .join(' ');
  }

  const isAllCaps = (text) => text === text.toLocaleUpperCase('en') && text !== text.toLocaleLowerCase('en');

  /** The name exactly as it will be drawn on the certificate (see CONFIG.nameCase). */
  function displayName(record) {
    const mode = CONFIG.nameCase;
    if (mode === 'title' || (mode === 'auto' && isAllCaps(record.name))) return toTitleCase(record.name);
    return record.name;
  }

  /** Safe filename: CYBERFORGE_Certificate_PARTICIPANT_NAME.pdf (spaces/symbols become "_") */
  function pdfFileName(record) {
    const safe = record.name
      .normalize('NFC')
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '');
    return `CYBERFORGE_Certificate_${safe || idKey(record.id) || 'Participant'}.pdf`;
  }

  /* ---- Inline alert component (no browser alert() pop-ups) ---- */
  const ICONS = {
    success: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 12.3l2.6 2.6L16 9.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5v5.6M12 16.4v.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5.4M12 7.7v.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };

  function showAlert(el, type, message) {
    el.className = `alert alert--${type}`;
    el.innerHTML = ICONS[type] || ICONS.info;       // static, trusted markup
    const span = document.createElement('span');
    span.textContent = message;                      // message is always plain text
    el.appendChild(span);
    el.hidden = false;
  }

  function hideAlert(el) {
    el.hidden = true;
    el.textContent = '';
  }

  function setBusy(button, busy, busyLabel) {
    const label = button.querySelector('.btn-label');
    const spinner = button.querySelector('.spinner');
    const icon = button.querySelector('.btn-icon');
    if (!button.dataset.label) button.dataset.label = label.textContent;
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
    if (spinner) spinner.hidden = !busy;
    if (icon) icon.hidden = busy;
    label.textContent = busy ? busyLabel : button.dataset.label;
  }

  function setFieldInvalid(input, invalid) {
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  /* ------------------------------------------------------------------------
     6. CERTIFICATE SERVICE (data layer)
     The only code that knows records come from a CSV. Swap this object for a
     server-backed version later; keep the same two methods.
     ------------------------------------------------------------------------ */
  const CertificateService = {
    /** Load and validate participants.csv. Returns { records, report }. */
    async load() {
      if (typeof window.Papa === 'undefined') {
        throw new Error('Papa Parse did not load (check your internet connection or the CDN script tag).');
      }

      const response = await fetch(CONFIG.csvPath, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Could not fetch ${CONFIG.csvPath}: HTTP ${response.status} ${response.statusText}`);
      }
      const text = await response.text();

      const parsed = window.Papa.parse(text, {
        header: true,
        skipEmptyLines: 'greedy',                       // ignores completely empty rows (e.g. ",,,")
        transformHeader: (h) => String(h).replace(/^﻿/, '').trim().toUpperCase(),
      });

      const report = { totalRows: parsed.data.length, valid: 0, skipped: [], duplicates: [], parseWarnings: parsed.errors };

      const headers = parsed.meta.fields || [];
      const pick = (aliases) => aliases.find((a) => headers.includes(a));
      const col = {
        name: pick(CONFIG.columns.name),
        id: pick(CONFIG.columns.id),
        title: pick(CONFIG.columns.title),
        date: pick(CONFIG.columns.date),
      };
      if (!col.name || !col.id) {
        throw new Error(
          `${CONFIG.csvPath} is missing a required column. Found: [${headers.join(', ')}]. ` +
          `Expected "${CONFIG.columns.name[0]}" and "${CONFIG.columns.id[0]}".`
        );
      }

      const records = [];
      const seen = new Map();                           // idKey -> first line number
      parsed.data.forEach((row, index) => {
        const line = index + 2;                         // +1 header, +1 for 1-based lines
        const name = cleanSpaces(row[col.name]);        // original text kept, only spacing tidied
        const id = String(row[col.id] ?? '').trim();    // ID kept exactly as stored (minus edge spaces)

        if (!name && !id) return;                       // blank after trimming
        if (!name || !id) {
          report.skipped.push({ line, reason: !name ? 'missing name' : 'missing certificate ID', name, id });
          return;
        }

        const key = idKey(id);
        if (seen.has(key)) {
          report.duplicates.push({ line, id, firstLine: seen.get(key) });
        } else {
          seen.set(key, line);
        }

        records.push({
          name,
          id,
          title: col.title ? cleanSpaces(row[col.title]) : '',
          date: col.date ? cleanSpaces(row[col.date]) : '',
          nameKey: nameKey(name),
          idKey: key,
          line,
        });
      });

      report.valid = records.length;
      if (records.length === 0) throw new Error(`${CONFIG.csvPath} contains no valid participant records.`);
      return { records, report };
    },

    /**
     * Find a record where BOTH the name and the ID match the same row.
     * Returns the record, or null. It deliberately never says which part failed.
     */
    async verify(fullName, certificateId) {
      const nk = nameKey(fullName);
      const ik = idKey(certificateId);
      return state.records.find((r) => r.idKey === ik && r.nameKey === nk) || null;
    },
  };

  /** Development report in the browser console (not shown to participants). */
  function logLoadReport(report) {
    console.groupCollapsed(`[CYBERFORGE] ${report.valid} participant records loaded from ${CONFIG.csvPath}`);
    console.info('Rows read:', report.totalRows, '| valid records:', report.valid);
    if (report.skipped.length) console.error('Skipped rows (missing data):', report.skipped);
    if (report.duplicates.length) console.warn('DUPLICATE certificate IDs:', report.duplicates);
    else console.info('No duplicate certificate IDs.');
    if (report.parseWarnings.length) console.warn('CSV parse warnings:', report.parseWarnings);
    console.groupEnd();
    if (report.skipped.length || report.duplicates.length) {
      console.warn(
        `[CYBERFORGE] Data problems found: ${report.skipped.length} skipped row(s), ` +
        `${report.duplicates.length} duplicate ID(s). Expand the log group above for details.`
      );
    }
  }

  /* ------------------------------------------------------------------------
     7. CSV LOADING STATE
     ------------------------------------------------------------------------ */
  function renderRecordsStatus() {
    const text = els.recordsStatus.querySelector('.records-status-text');
    els.recordsStatus.dataset.state = state.status === 'idle' ? 'loading' : state.status;
    els.retryLoad.hidden = state.status !== 'error';
    if (state.status === 'ready') text.textContent = 'Participant records loaded.';
    else if (state.status === 'error') text.textContent = MSG.loadFailed;
    else text.textContent = 'Loading participant records…';
  }

  let loadPromise = null;
  function loadRecords() {
    if (state.status === 'loading' && loadPromise) return loadPromise;
    state.status = 'loading';
    renderRecordsStatus();
    loadPromise = CertificateService.load()
      .then(({ records, report }) => {
        state.records = records;
        state.status = 'ready';
        logLoadReport(report);
      })
      .catch((error) => {
        state.records = [];
        state.status = 'error';
        console.error('[CYBERFORGE] Could not load participant records:', error);
        if (location.protocol === 'file:') {
          console.error('[CYBERFORGE] This page is open via file://. Serve the folder with a local web server (e.g. VS Code Live Server) so fetch() can read participants.csv.');
        }
      })
      .finally(renderRecordsStatus);
    return loadPromise;
  }

  /* ------------------------------------------------------------------------
     8. CERTIFICATE RENDERING (preview + PDF share this exact code)
     ------------------------------------------------------------------------ */
  let templatePromise = null;
  let fontsPromise = null;

  /** Load the template once and measure the surrounding colour of each repaint area. */
  function loadTemplate() {
    if (templatePromise) return templatePromise;
    templatePromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = async () => {
        try { await img.decode(); } catch (_) { /* already loaded; decode() is optional */ }
        const k = img.naturalWidth / REF.width;
        if (Math.abs(img.naturalHeight / img.naturalWidth - REF.height / REF.width) > 0.01) {
          console.warn(`[CYBERFORGE] Template is ${img.naturalWidth}x${img.naturalHeight}; layout values assume the ${REF.width}x${REF.height} proportions. Re-measure NAME_LAYOUT / ID_LAYOUT.`);
        }
        resolve({ img, fills: measureFills(img, k) });
      };
      img.onerror = () => {
        templatePromise = null;                         // allow a retry
        reject(new Error(`Certificate template image failed to load: ${CONFIG.templatePath}`));
      };
      img.src = CONFIG.templatePath;
    });
    return templatePromise;
  }

  /**
   * Median colour of the pixels just outside a rectangle (top, left and right
   * edges; the bottom is skipped because the name underline sits below it).
   * Used so the repainted area blends with the template's near-white background.
   */
  function measureFills(img, k) {
    const fallback = '#fbfefe';
    const result = { name: fallback, id: fallback };
    try {
      const probe = document.createElement('canvas');
      probe.width = img.naturalWidth;
      probe.height = img.naturalHeight;
      const pctx = probe.getContext('2d', { willReadFrequently: true });
      pctx.drawImage(img, 0, 0);

      const sample = (rect) => {
        const strips = [
          [rect.x, rect.y - 6, rect.w, 4],              // above
          [rect.x - 10, rect.y, 6, rect.h],             // left
          [rect.x + rect.w + 4, rect.y, 6, rect.h],     // right
        ];
        const r = [], g = [], b = [];
        for (const [sx, sy, sw, sh] of strips) {
          const d = pctx.getImageData(Math.round(sx * k), Math.round(sy * k), Math.max(1, Math.round(sw * k)), Math.max(1, Math.round(sh * k))).data;
          for (let i = 0; i < d.length; i += 4) { r.push(d[i]); g.push(d[i + 1]); b.push(d[i + 2]); }
        }
        const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
        return `rgb(${med(r)}, ${med(g)}, ${med(b)})`;
      };

      result.name = sample(NAME_LAYOUT.cover);
      result.id = sample(ID_LAYOUT.cover);
    } catch (error) {
      // Typically a SecurityError when opened via file:// (tainted canvas).
      console.warn('[CYBERFORGE] Could not sample template colours; using a default near-white fill.', error);
    }
    return result;
  }

  /** Wait until the certificate fonts are really available before drawing. */
  function loadFonts() {
    if (fontsPromise) return fontsPromise;
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    fontsPromise = Promise.all([
      document.fonts.load(`${NAME_LAYOUT.maxSize}px "Mr Dafoe"`, 'Participant Name'),
      document.fonts.load(`${ID_LAYOUT.weight} ${ID_LAYOUT.maxSize}px "Inter"`, 'KTX-CF-2026-0001'),
    ])
      .then(() => document.fonts.ready)
      .then(() => {
        if (!document.fonts.check('40px "Mr Dafoe"')) {
          console.warn('[CYBERFORGE] "Mr Dafoe" font is unavailable (offline?). A fallback cursive font is used for the name.');
        }
      })
      .catch((error) => {
        console.warn('[CYBERFORGE] Font loading problem; fallback fonts will be used.', error);
      });
    return fontsPromise;
  }

  /**
   * Draw text centred on (centerX, y) and shrink it to fit maxWidth.
   * Words are placed one by one with an explicit gap, because script fonts
   * have very narrow word spaces ("KebinPeterT" otherwise).
   *   1) Reduce the font size in 1 px steps down to minSize.
   *   2) If it STILL does not fit (extremely long name), squeeze horizontally.
   */
  function drawFittedText(ctx, text, { centerX, y, maxWidth, maxSize, minSize, family, weight = 400, color, baseline, wordGap = 0.3 }) {
    const words = text.split(' ');
    let size = maxSize;
    let widths = [];
    let total = 0;

    const measure = () => {
      ctx.font = `${weight} ${size}px ${family}`;
      widths = words.map((word) => ctx.measureText(word).width);
      total = widths.reduce((sum, w) => sum + w, 0) + wordGap * size * (words.length - 1);
    };

    measure();
    while (total > maxWidth && size > minSize) {
      size -= 1;
      measure();
    }

    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = baseline;

    ctx.save();
    ctx.translate(centerX, y);
    if (total > maxWidth) ctx.scale(maxWidth / total, 1);   // last resort: squeeze, never overflow
    let cursor = -total / 2;                                // centred (also correct after the squeeze above)
    words.forEach((word, i) => {
      ctx.fillText(word, cursor, 0);
      cursor += widths[i] + wordGap * size;
    });
    ctx.restore();
  }

  /**
   * Render the full certificate onto `canvas`.
   * scale = output pixels per template pixel (2 => 2x the template's resolution).
   */
  async function renderCertificate(canvas, record, scale) {
    const [{ img, fills }] = await Promise.all([loadTemplate(), loadFonts()]);

    // Canvas size = template size x scale, so the aspect ratio is never changed.
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Work in reference coordinates (1491 x 1055): one transform maps them to canvas pixels.
    //   canvasPx = referencePx * (img.naturalWidth / REF.width) * scale
    const k = (img.naturalWidth / REF.width) * scale;
    ctx.setTransform(k, 0, 0, k, 0, 0);

    // 1) Original template, full bleed, unchanged.
    ctx.drawImage(img, 0, 0, REF.width, REF.height);

    // 2) Repaint ONLY the two placeholder areas with the sampled background colour.
    ctx.fillStyle = fills.name;
    const n = NAME_LAYOUT.cover;
    ctx.fillRect(n.x, n.y, n.w, n.h);

    const pt = NAME_LAYOUT.patch;                       // restore the underline under the old "p" tail
    const ik = img.naturalWidth / REF.width;            // reference px -> template px (source coordinates)
    ctx.drawImage(img, pt.donorX * ik, pt.y * ik, pt.w * ik, pt.h * ik, pt.x, pt.y, pt.w, pt.h);

    ctx.fillStyle = fills.id;
    const c = ID_LAYOUT.cover;
    ctx.fillRect(c.x, c.y, c.w, c.h);

    // 3) Participant name: cursive, centred on the underline, shrunk to fit.
    drawFittedText(ctx, displayName(record), {
      centerX: NAME_LAYOUT.centerX,
      y: NAME_LAYOUT.baselineY,
      maxWidth: NAME_LAYOUT.maxWidth,
      maxSize: NAME_LAYOUT.maxSize,
      minSize: NAME_LAYOUT.minSize,
      family: NAME_LAYOUT.family,
      color: NAME_LAYOUT.color,
      baseline: 'alphabetic',
      wordGap: 0.42,
    });

    // 4) Certificate ID: bold, centred in the ID box, exactly as stored in the CSV.
    drawFittedText(ctx, record.id, {
      centerX: ID_LAYOUT.centerX,
      y: ID_LAYOUT.centerY,
      maxWidth: ID_LAYOUT.maxWidth,
      maxSize: ID_LAYOUT.maxSize,
      minSize: ID_LAYOUT.minSize,
      family: ID_LAYOUT.family,
      weight: ID_LAYOUT.weight,
      color: ID_LAYOUT.color,
      baseline: 'middle',
    });

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  /* ------------------------------------------------------------------------
     9. PDF GENERATION
     ------------------------------------------------------------------------ */
  async function createPdf(record) {
    const jsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDF) throw new Error('jsPDF did not load (check your internet connection or the CDN script tag).');

    // Fresh off-screen render: nothing from the website UI can end up in the PDF.
    const canvas = document.createElement('canvas');
    await renderCertificate(canvas, record, CONFIG.pdfScale);
    const imageData = canvas.toDataURL('image/jpeg', CONFIG.pdfJpegQuality);   // throws if the canvas is tainted

    // Page = the template's own proportions (landscape, A4-wide 297 mm): no margins, no stretching, no cropping.
    const pageW = 297;
    const pageH = (pageW * canvas.height) / canvas.width;
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [pageW, pageH], compress: true });
    pdf.setProperties({
      title: `CYBERFORGE Certificate - ${record.name}`,
      subject: 'Certificate of Participation - CYBERFORGE: HACK & SECURE',
      author: 'KAIRVOX TECHNOLOGIES',
    });
    pdf.addImage(imageData, 'JPEG', 0, 0, pageW, pageH, undefined, 'FAST');
    return pdf;
  }

  async function handleDownload() {
    if (state.isGenerating || !state.current) return;
    state.isGenerating = true;
    hideAlert(els.downloadAlert);
    setBusy(els.download, true, 'Generating PDF…');
    try {
      const pdf = await createPdf(state.current);
      pdf.save(pdfFileName(state.current));
      showAlert(els.downloadAlert, 'success', MSG.pdfReady);
    } catch (error) {
      console.error('[CYBERFORGE] PDF generation failed:', error);
      showAlert(els.downloadAlert, 'error', MSG.pdfFailed);     // button is re-enabled below: user can retry
    } finally {
      state.isGenerating = false;
      setBusy(els.download, false);
    }
  }

  /* ------------------------------------------------------------------------
     10. SEARCH FORM
     ------------------------------------------------------------------------ */
  function resetPreview() {
    els.previewSection.hidden = true;
    hideAlert(els.previewAlert);
    hideAlert(els.downloadAlert);
    state.current = null;
  }

  async function handleSubmit(event) {
    event.preventDefault();                              // no page reload
    if (state.isSearching) return;                       // block repeated submissions

    hideAlert(els.formAlert);
    resetPreview();

    const nameValue = cleanSpaces(els.name.value);
    const idValue = els.id.value.trim();

    // Reflect trimmed / tidied values back into the fields.
    els.name.value = nameValue;
    els.id.value = idValue;

    // --- Validation ---
    setFieldInvalid(els.name, !nameValue);
    setFieldInvalid(els.id, !idValue);
    if (!nameValue || !idValue) {
      showAlert(els.formAlert, 'error', MSG.missing);
      (!nameValue ? els.name : els.id).focus();
      return;
    }

    state.isSearching = true;
    setBusy(els.submit, true, 'Searching…');
    try {
      // --- Make sure the records are available before claiming anything ---
      if (state.status === 'loading') {
        showAlert(els.formAlert, 'info', MSG.loading);
        return;
      }
      if (state.status !== 'ready') {                    // earlier load failed: try once more
        await loadRecords();
        if (state.status !== 'ready') {
          showAlert(els.formAlert, 'error', MSG.loadFailed);
          return;
        }
      }

      const [record] = await Promise.all([
        CertificateService.verify(nameValue, idValue),
        sleep(CONFIG.minSearchMs),
      ]);

      if (!record) {
        // One generic message: never reveal whether the name or the ID exists.
        showAlert(els.formAlert, 'error', MSG.notFound);
        return;
      }

      // --- Verified: draw the preview ---
      try {
        await renderCertificate(els.canvas, record, CONFIG.previewScale);
      } catch (error) {
        console.error('[CYBERFORGE] Certificate preview failed:', error);
        showAlert(els.formAlert, 'error', MSG.previewFailed);
        return;
      }

      state.current = record;
      els.canvas.setAttribute('aria-label', `Certificate of Participation for ${displayName(record)}, certificate ID ${record.id}`);
      showAlert(els.previewAlert, 'success', MSG.verified);
      els.previewSection.hidden = false;
      els.previewSection.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
      els.previewHeading.focus({ preventScroll: true });
    } finally {
      state.isSearching = false;
      setBusy(els.submit, false);
    }
  }

  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------------
     11. NAVIGATION (mobile menu, hero button focus, active link)
     ------------------------------------------------------------------------ */
  function initNavigation() {
    const closeMenu = () => {
      els.nav.classList.remove('is-open');
      els.navToggle.setAttribute('aria-expanded', 'false');
    };

    els.navToggle.addEventListener('click', () => {
      const open = els.nav.classList.toggle('is-open');
      els.navToggle.setAttribute('aria-expanded', String(open));
    });
    els.nav.addEventListener('click', (event) => { if (event.target.closest('a')) closeMenu(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });

    // "Find My Certificate": smooth scroll comes from CSS; move keyboard focus to the first field afterwards.
    els.findBtn.addEventListener('click', () => {
      setTimeout(() => els.name.focus({ preventScroll: true }), prefersReducedMotion() ? 0 : 600);
    });

    // Highlight the nav link of the section currently in view.
    if ('IntersectionObserver' in window) {
      const links = new Map([...els.nav.querySelectorAll('a[data-spy]')].map((a) => [a.dataset.spy, a]));
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          links.forEach((a) => a.removeAttribute('aria-current'));
          const active = links.get(entry.target.id);
          if (active) active.setAttribute('aria-current', 'true');
        });
      }, { rootMargin: '-45% 0px -50% 0px' });
      ['home', 'verify', 'about'].forEach((id) => { const s = $(id); if (s) observer.observe(s); });
    }
  }

  /* ------------------------------------------------------------------------
     12. START
     ------------------------------------------------------------------------ */
  function init() {
    // Clear the "invalid" marker as soon as the user types.
    els.name.addEventListener('input', () => setFieldInvalid(els.name, false));
    els.id.addEventListener('input', () => setFieldInvalid(els.id, false));

    els.form.addEventListener('submit', handleSubmit);      // also fires on Enter in either field
    els.download.addEventListener('click', handleDownload);
    els.retryLoad.addEventListener('click', () => { loadRecords(); });

    initNavigation();
    loadRecords();
    loadTemplate().catch((error) => console.error('[CYBERFORGE]', error));   // warm the cache early
    loadFonts();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
