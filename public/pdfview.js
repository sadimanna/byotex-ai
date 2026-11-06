/* BYOTeX.AI PDF viewer built on PDF.js (served locally from /vendor/pdfjs).
 * - continuous vertical scroll, lazy page rendering, HiDPI canvases
 * - reloads keep the reader's position (page + offset within the page) and swap without flicker
 * - fit-width / fit-page / fixed zoom
 * - double-click → inverse search callback (page, x, y in PDF points, top-left origin)
 * - showBox() → forward-search highlight
 */
'use strict';

const PdfView = (() => {
  const BASE = '/vendor/pdfjs';
  const GAP = 10;
  const PAD = 10;
  const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
  let libPromise = null;

  function loadLib() {
    if (!libPromise) {
      libPromise = import(`${BASE}/build/pdf.min.mjs`).then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = `${BASE}/build/pdf.worker.min.mjs`;
        return lib;
      });
    }
    return libPromise;
  }

  class Viewer {
    constructor(container, { onInverse, onPage, onZoom } = {}) {
      this.el = container;
      this.onInverse = onInverse || (() => {});
      this.onPage = onPage || (() => {});
      this.onZoom = onZoom || (() => {});
      this.doc = null;
      this.sizes = []; // [{w, h}] at scale 1 (PDF points)
      this.pages = []; // [{div, canvas, rendered: scale|null, task}]
      this.mode = 'width'; // 'width' | 'page' | 'fixed'
      this.scale = 1;
      this.current = 1;
      this.gen = 0;
      this.wrap = null;
      this.raf = 0;
      container.addEventListener('scroll', () => this.schedule());
      new ResizeObserver(() => {
        if (!this.doc || this.mode === 'fixed') return;
        clearTimeout(this.resizeT);
        this.resizeT = setTimeout(() => this.relayout(), 120);
      }).observe(container);
    }

    get pageCount() { return this.sizes.length; }

    fitScale(mode) {
      const maxW = Math.max(...this.sizes.map((s) => s.w));
      const availW = this.el.clientWidth - PAD * 2;
      const wScale = availW / maxW;
      if (mode === 'page') {
        const maxH = Math.max(...this.sizes.map((s) => s.h));
        return Math.max(0.1, Math.min(wScale, (this.el.clientHeight - PAD * 2) / maxH));
      }
      return Math.max(0.1, wScale);
    }

    pageTop(i, scale = this.scale) {
      let y = PAD;
      for (let k = 0; k < i; k++) y += this.sizes[k].h * scale + GAP;
      return y;
    }

    /** Position anchor that survives zoom/reload: page index + fractional offset. */
    anchor() {
      if (!this.sizes.length) return null;
      const st = this.el.scrollTop;
      let i = 0;
      while (i < this.sizes.length - 1 && this.pageTop(i + 1) <= st) i++;
      const h = this.sizes[i].h * this.scale + GAP;
      return { i, frac: (st - this.pageTop(i)) / h, left: this.el.scrollLeft };
    }

    async open(url) {
      const lib = await loadLib();
      const gen = ++this.gen;
      const keep = this.doc ? this.anchor() : null;
      const doc = await lib.getDocument({
        url,
        isEvalSupported: false,
        cMapUrl: `${BASE}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${BASE}/standard_fonts/`,
      }).promise;
      if (gen !== this.gen) { doc.destroy(); return; }
      const pageObjs = [];
      const sizes = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const pg = await doc.getPage(n);
        const vp = pg.getViewport({ scale: 1 });
        pageObjs.push(pg);
        sizes.push({ w: vp.width, h: vp.height });
      }
      if (gen !== this.gen) { doc.destroy(); return; }
      const old = this.doc;
      this.doc = doc;
      this.pageObjs = pageObjs;
      this.sizes = sizes;
      if (keep) keep.i = Math.min(keep.i, sizes.length - 1);
      await this.build(keep);
      if (old) old.destroy();
    }

    /** Build a fresh page stack, pre-render the pages that will be visible, then swap it in. */
    async build(anchor) {
      const gen = ++this.gen;
      if (this.mode !== 'fixed') this.scale = this.fitScale(this.mode);
      const scale = this.scale;
      const wrap = document.createElement('div');
      wrap.className = 'pdf-stack';
      const maxW = Math.max(...this.sizes.map((s) => s.w)) * scale;
      wrap.style.width = `${maxW + PAD * 2}px`;
      wrap.style.minWidth = '100%';
      wrap.style.height = `${this.pageTop(this.sizes.length, scale) - GAP + PAD}px`;
      const pages = this.sizes.map((s, i) => {
        const div = document.createElement('div');
        div.className = 'pdf-page';
        div.style.cssText = `top:${this.pageTop(i, scale)}px;width:${s.w * scale}px;height:${s.h * scale}px;margin-left:${-s.w * scale / 2}px`;
        div.dataset.page = i + 1;
        const canvas = document.createElement('canvas');
        div.append(canvas);
        div.addEventListener('dblclick', (e) => {
          const r = div.getBoundingClientRect();
          this.onInverse(i + 1, (e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale);
        });
        wrap.append(div);
        return { div, canvas, rendered: null, task: null };
      });
      const top = anchor ? this.pageTop(anchor.i, scale) + anchor.frac * (this.sizes[anchor.i].h * scale + GAP) : 0;
      // Render what will be on screen before swapping, so a recompile doesn't flash blank pages.
      const vis = this.visibleRange(top, scale);
      await Promise.all(range(vis[0], vis[1]).map((i) => this.renderPage(pages, i, scale, gen)));
      if (gen !== this.gen) return;
      for (const p of this.pages) p.task?.cancel();
      this.pages = pages;
      if (this.wrap) this.wrap.replaceWith(wrap); else this.el.append(wrap);
      this.wrap = wrap;
      this.el.scrollTop = top;
      if (anchor) this.el.scrollLeft = anchor.left;
      this.onZoom(this.scale, this.mode);
      this.update();
    }

    relayout() { if (this.doc) this.build(this.anchor()); }

    visibleRange(top, scale) {
      const bottom = top + this.el.clientHeight;
      let a = 0;
      while (a < this.sizes.length - 1 && this.pageTop(a + 1, scale) < top) a++;
      let b = a;
      while (b < this.sizes.length - 1 && this.pageTop(b + 1, scale) < bottom) b++;
      return [Math.max(0, a - 1), Math.min(this.sizes.length - 1, b + 1)];
    }

    async renderPage(pages, i, scale, gen) {
      const p = pages[i];
      if (p.rendered === scale) return;
      p.task?.cancel();
      const dpr = window.devicePixelRatio || 1;
      const vp = this.pageObjs[i].getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      p.task = this.pageObjs[i].render({ canvasContext: canvas.getContext('2d'), viewport: vp });
      try {
        await p.task.promise;
      } catch (e) {
        if (e?.name !== 'RenderingCancelledException') console.warn(e);
        return;
      }
      if (gen !== this.gen && pages !== this.pages) return;
      p.canvas.replaceWith(canvas);
      p.canvas = canvas;
      p.rendered = scale;
    }

    schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.update(); }); }

    update() {
      if (!this.doc) return;
      const [a, b] = this.visibleRange(this.el.scrollTop, this.scale);
      for (let i = a; i <= b; i++) this.renderPage(this.pages, i, this.scale, this.gen);
      // free canvases far away on long documents
      if (this.pages.length > 30) {
        this.pages.forEach((p, i) => {
          if (p.rendered && (i < a - 10 || i > b + 10)) { const c = document.createElement('canvas'); p.canvas.replaceWith(c); p.canvas = c; p.rendered = null; }
        });
      }
      const mid = this.el.scrollTop + this.el.clientHeight / 3;
      let cur = 0;
      while (cur < this.sizes.length - 1 && this.pageTop(cur + 1) <= mid) cur++;
      if (cur + 1 !== this.current) { this.current = cur + 1; this.onPage(this.current, this.sizes.length); }
      else this.onPage(this.current, this.sizes.length);
    }

    setZoom(mode, scale) {
      if (!this.doc) return;
      const keep = this.anchor();
      this.mode = mode;
      if (mode === 'fixed') this.scale = scale;
      this.build(keep);
    }
    zoomStep(dir) {
      const cur = this.scale;
      const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.001) : [...ZOOMS].reverse().find((z) => z < cur - 0.001);
      if (next) this.setZoom('fixed', next);
    }
    goto(n) {
      if (!this.doc) return;
      const i = Math.max(1, Math.min(this.sizes.length, n)) - 1;
      this.el.scrollTop = this.pageTop(i) - PAD / 2;
    }

    /** Forward-search highlight: box in PDF points, (h, v) = left/baseline. */
    showBox(b) {
      const p = this.pages[b.page - 1];
      if (!p) return;
      this.el.querySelectorAll('.pdf-hl').forEach((x) => x.remove());
      const s = this.scale;
      const H = Math.max(b.H || 10, 8);
      const hl = document.createElement('div');
      hl.className = 'pdf-hl';
      hl.style.cssText = `left:${(b.h ?? b.x) * s - 3}px;top:${((b.v ?? b.y) - H) * s - 3}px;width:${Math.max((b.W || 40) * s, 20) + 6}px;height:${H * s + 6}px`;
      p.div.append(hl);
      const y = this.pageTop(b.page - 1) + ((b.v ?? b.y) - H) * s;
      this.el.scrollTop = y - this.el.clientHeight / 3;
      clearTimeout(this.hlT);
      this.hlT = setTimeout(() => hl.remove(), 3000);
    }

    clear() {
      this.gen++;
      this.doc?.destroy();
      this.doc = null;
      this.sizes = [];
      this.pages = [];
      this.wrap?.remove();
      this.wrap = null;
    }
  }

  const range = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; };
  return { Viewer, ZOOMS };
})();
