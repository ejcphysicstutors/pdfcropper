import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './styles.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round4 = (value) => Math.round(value * 10000) / 10000;

function App() {
  const [file, setFile] = useState(null);
  const [pdf, setPdf] = useState(null);
  const [pages, setPages] = useState([]);
  const [headerPct, setHeaderPct] = useState(6);
  const [footerPct, setFooterPct] = useState(6);
  const [cuts, setCuts] = useState({});
  const [status, setStatus] = useState('Choose a PDF to begin.');
  const [loading, setLoading] = useState(false);
  const [showGuides, setShowGuides] = useState(true);

  const fileInputRef = useRef(null);

  useEffect(() => {
    return () => {
      if (pdf) pdf.destroy();
    };
  }, [pdf]);

  async function openPdf(selected) {
    if (!selected) return;
    setLoading(true);
    setStatus('Loading PDF…');
    setFile(selected);
    setCuts({});

    try {
      const bytes = new Uint8Array(await selected.arrayBuffer());
      const loadingTask = pdfjsLib.getDocument({ data: bytes });
      const loadedPdf = await loadingTask.promise;
      setPdf(loadedPdf);

      const nextPages = [];
      for (let pageNumber = 1; pageNumber <= loadedPdf.numPages; pageNumber += 1) {
        const page = await loadedPdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.4 });
        const textContent = await page.getTextContent();
        nextPages.push({ pageNumber, page, viewport, textContent });
      }
      setPages(nextPages);
      setStatus(`${loadedPdf.numPages} pages loaded. Review the header/footer masks, then add or adjust cut lines.`);
    } catch (error) {
      console.error(error);
      setStatus('Could not open this PDF. Please try another file.');
      setFile(null);
      setPdf(null);
      setPages([]);
    } finally {
      setLoading(false);
    }
  }

  function addCut(pageNumber, yNorm) {
    const top = headerPct / 100;
    const bottom = 1 - footerPct / 100;
    const safeY = round4(clamp(yNorm, top + 0.005, bottom - 0.005));
    setCuts((current) => {
      const existing = current[pageNumber] || [];
      if (existing.some((value) => Math.abs(value - safeY) < 0.01)) return current;
      return {
        ...current,
        [pageNumber]: [...existing, safeY].sort((a, b) => a - b),
      };
    });
  }

  function moveCut(pageNumber, index, yNorm) {
    const top = headerPct / 100;
    const bottom = 1 - footerPct / 100;
    const safeY = round4(clamp(yNorm, top + 0.005, bottom - 0.005));
    setCuts((current) => {
      const next = [...(current[pageNumber] || [])];
      next[index] = safeY;
      next.sort((a, b) => a - b);
      return { ...current, [pageNumber]: next };
    });
  }

  function removeCut(pageNumber, index) {
    setCuts((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] || []).filter((_, i) => i !== index),
    }));
  }

  function clearCuts() {
    setCuts({});
  }

  function suggestCuts() {
    const suggested = {};

    for (const pageData of pages) {
      const { pageNumber, viewport, textContent } = pageData;
      const top = headerPct / 100;
      const bottom = 1 - footerPct / 100;
      const candidates = [];

      for (const item of textContent.items || []) {
        const text = String(item.str || '').trim();
        if (!text) continue;

        // Conservative heuristic: a standalone question number near the left margin.
        const looksLikeQuestion = /^(?:Q\s*)?\d{1,2}[.)]?$/i.test(text);
        if (!looksLikeQuestion) continue;

        const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const x = transform[4];
        const yFromTop = viewport.height - transform[5];
        const xNorm = x / viewport.width;
        const yNorm = yFromTop / viewport.height;

        if (xNorm < 0.18 && yNorm > top && yNorm < bottom) {
          candidates.push(yNorm);
        }
      }

      const unique = [];
      for (const candidate of candidates.sort((a, b) => a - b)) {
        if (!unique.some((existing) => Math.abs(existing - candidate) < 0.025)) {
          unique.push(round4(candidate));
        }
      }

      // The first visible question on a page does not always need a cut, but keeping
      // suggestions conservative is safer than inventing many boundaries.
      if (unique.length) suggested[pageNumber] = unique;
    }

    setCuts(suggested);
    const count = Object.values(suggested).reduce((sum, list) => sum + list.length, 0);
    setStatus(
      count
        ? `${count} possible question starts found. Please scan and adjust them before confirming.`
        : 'No reliable question-number starts were found. Add cut lines by clicking the pages.'
    );
  }

  function exportSegmentation() {
    if (!file || !pages.length) return;

    const payload = {
      schemaVersion: 1,
      sourceFile: file.name,
      createdAt: new Date().toISOString(),
      headerFraction: round4(headerPct / 100),
      footerFraction: round4(footerPct / 100),
      pageCount: pages.length,
      cuts: pages.map(({ pageNumber }) => ({
        page: pageNumber,
        yFractionsFromTop: (cuts[pageNumber] || []).map(round4),
      })),
      notes: 'Cut positions are fractions of the original PDF page height measured from the top edge.',
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${file.name.replace(/\.pdf$/i, '')}.segmentation.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('Segmentation file saved. Keep it together with the original PDF.');
  }

  const cutCount = useMemo(
    () => Object.values(cuts).reduce((sum, pageCuts) => sum + pageCuts.length, 0),
    [cuts]
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local browser tool</p>
          <h1>Prelim Cropper</h1>
          <p className="subtitle">Segment exam papers quickly. Your PDF stays in this browser session.</p>
        </div>
        <button className="primary" onClick={() => fileInputRef.current?.click()} disabled={loading}>
          {file ? 'Choose another PDF' : 'Choose PDF'}
        </button>
        <input
          ref={fileInputRef}
          className="hidden-input"
          type="file"
          accept="application/pdf,.pdf"
          onChange={(event) => openPdf(event.target.files?.[0])}
        />
      </header>

      <main className="workspace">
        <aside className="controls-card">
          <section>
            <h2>1. Page cleanup</h2>
            <label>
              Header removed <strong>{headerPct}%</strong>
              <input
                type="range"
                min="0"
                max="15"
                step="0.5"
                value={headerPct}
                onChange={(event) => setHeaderPct(Number(event.target.value))}
              />
            </label>
            <label>
              Footer removed <strong>{footerPct}%</strong>
              <input
                type="range"
                min="0"
                max="15"
                step="0.5"
                value={footerPct}
                onChange={(event) => setFooterPct(Number(event.target.value))}
              />
            </label>
            <label className="check-row">
              <input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />
              Show removed regions
            </label>
          </section>

          <section>
            <h2>2. Question cuts</h2>
            <p className="small">Click anywhere on a page to add a cut. Drag a red line to move it. Double-click a line to remove it.</p>
            <div className="button-stack">
              <button className="secondary" onClick={suggestCuts} disabled={!pages.length || loading}>Suggest cuts</button>
              <button className="ghost" onClick={clearCuts} disabled={!cutCount}>Clear cuts</button>
            </div>
            <div className="metric"><span>Cut lines</span><strong>{cutCount}</strong></div>
          </section>

          <section>
            <h2>3. Confirm</h2>
            <button className="primary full" onClick={exportSegmentation} disabled={!file || !pages.length}>Save segmentation</button>
            <p className="small">This saves a small JSON file. Keep it beside the original PDF so the paper can be reconstructed later.</p>
          </section>

          <div className="status-box">{status}</div>
        </aside>

        <section className="document-area">
          {!file && (
            <div className="empty-state" onClick={() => fileInputRef.current?.click()}>
              <div className="empty-icon">PDF</div>
              <h2>Choose a prelim paper</h2>
              <p>The paper will appear as one continuous vertical document. Nothing is uploaded to a server.</p>
              <button className="primary">Choose PDF</button>
            </div>
          )}

          {loading && <div className="loading-card">Preparing pages…</div>}

          {!!pages.length && !loading && (
            <div className="rolling-paper">
              {pages.map((pageData) => (
                <PdfPage
                  key={pageData.pageNumber}
                  pageData={pageData}
                  headerPct={headerPct}
                  footerPct={footerPct}
                  cuts={cuts[pageData.pageNumber] || []}
                  onAddCut={addCut}
                  onMoveCut={moveCut}
                  onRemoveCut={removeCut}
                  showGuides={showGuides}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function PdfPage({ pageData, headerPct, footerPct, cuts, onAddCut, onMoveCut, onRemoveCut, showGuides }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const [renderSize, setRenderSize] = useState({ width: pageData.viewport.width, height: pageData.viewport.height });

  useEffect(() => {
    let cancelled = false;
    let renderTask;

    async function render() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d');
      const outputScale = window.devicePixelRatio || 1;
      const viewport = pageData.viewport;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setRenderSize({ width: viewport.width, height: viewport.height });

      renderTask = pageData.page.render({
        canvasContext: context,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
        viewport,
      });

      try {
        await renderTask.promise;
      } catch (error) {
        if (!cancelled && error?.name !== 'RenderingCancelledException') console.error(error);
      }
    }

    render();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pageData]);

  const visibleTop = headerPct / 100;
  const visibleBottom = 1 - footerPct / 100;
  const visibleHeight = visibleBottom - visibleTop;

  function eventToYNorm(event) {
    const rect = frameRef.current.getBoundingClientRect();
    const yWithinVisible = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    return visibleTop + yWithinVisible * visibleHeight;
  }

  function handlePageClick(event) {
    if (event.target.closest('.cut-line')) return;
    onAddCut(pageData.pageNumber, eventToYNorm(event));
  }

  function beginDrag(event, cutIndex) {
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const onMove = (moveEvent) => {
      onMoveCut(pageData.pageNumber, cutIndex, eventToYNorm(moveEvent));
    };

    const onUp = (upEvent) => {
      try { event.currentTarget.releasePointerCapture(pointerId); } catch (_) {}
      event.currentTarget.removeEventListener('pointermove', onMove);
      event.currentTarget.removeEventListener('pointerup', onUp);
      event.currentTarget.removeEventListener('pointercancel', onUp);
    };

    event.currentTarget.addEventListener('pointermove', onMove);
    event.currentTarget.addEventListener('pointerup', onUp);
    event.currentTarget.addEventListener('pointercancel', onUp);
  }

  const frameHeight = renderSize.height * visibleHeight;
  const canvasTop = -renderSize.height * visibleTop;

  return (
    <div className="page-wrap">
      <div className="page-label">Page {pageData.pageNumber}</div>
      <div
        ref={frameRef}
        className="page-frame"
        style={{ width: renderSize.width, height: frameHeight }}
        onClick={handlePageClick}
      >
        <canvas ref={canvasRef} style={{ top: canvasTop }} />

        {showGuides && (
          <>
            <div className="crop-guide top-guide"><span>header removed</span></div>
            <div className="crop-guide bottom-guide"><span>footer removed</span></div>
          </>
        )}

        {cuts.map((yNorm, index) => {
          const yVisible = ((yNorm - visibleTop) / visibleHeight) * 100;
          return (
            <div
              key={`${yNorm}-${index}`}
              className="cut-line"
              style={{ top: `${yVisible}%` }}
              onPointerDown={(event) => beginDrag(event, index)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onRemoveCut(pageData.pageNumber, index);
              }}
              title="Drag to move. Double-click to remove."
            >
              <span className="cut-handle">↕</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
