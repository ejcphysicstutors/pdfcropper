import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './styles.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round4 = (value) => Math.round(value * 10000) / 10000;
const QUESTION_CUT = 'question';
const PART_CUT = 'part';

function App() {
  const [file, setFile] = useState(null);
  const [pdf, setPdf] = useState(null);
  const [pages, setPages] = useState([]);
  const [headerPct, setHeaderPct] = useState(6);
  const [footerPct, setFooterPct] = useState(6);
  const [cuts, setCuts] = useState({});
  const [cutMode, setCutMode] = useState(QUESTION_CUT);
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
      setStatus(`${loadedPdf.numPages} pages loaded. Review the header/footer masks, then scan the proposed question and part boundaries.`);
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

  function addCut(pageNumber, yNorm, type = cutMode) {
    const top = headerPct / 100;
    const bottom = 1 - footerPct / 100;
    const safeY = round4(clamp(yNorm, top + 0.005, bottom - 0.005));
    setCuts((current) => {
      const existing = current[pageNumber] || [];
      if (existing.some((cut) => Math.abs(cut.y - safeY) < 0.01)) return current;
      return {
        ...current,
        [pageNumber]: [...existing, makeCut(safeY, type)].sort((a, b) => a.y - b.y),
      };
    });
  }

  function moveCut(pageNumber, cutId, yNorm) {
    const top = headerPct / 100;
    const bottom = 1 - footerPct / 100;
    const safeY = round4(clamp(yNorm, top + 0.005, bottom - 0.005));
    setCuts((current) => {
      const next = (current[pageNumber] || []).map((cut) =>
        cut.id === cutId ? { ...cut, y: safeY } : cut
      );
      next.sort((a, b) => a.y - b.y);
      return { ...current, [pageNumber]: next };
    });
  }

  function removeCut(pageNumber, cutId) {
    setCuts((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] || []).filter((cut) => cut.id !== cutId),
    }));
  }

  function changeCutType(pageNumber, cutId) {
    setCuts((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] || []).map((cut) =>
        cut.id === cutId
          ? { ...cut, type: cut.type === QUESTION_CUT ? PART_CUT : QUESTION_CUT }
          : cut
      ),
    }));
  }

  function clearCuts() {
    setCuts({});
  }

  function makeCut(y, type) {
    return {
      id: `${type}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`,
      y: round4(y),
      type,
    };
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

        // Conservative heuristic: a standalone whole-question number near the left margin.
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

      if (unique.length) suggested[pageNumber] = unique.map((y) => makeCut(y, QUESTION_CUT));
    }

    setCuts(suggested);
    const count = Object.values(suggested).reduce((sum, list) => sum + list.length, 0);
    setStatus(
      count
        ? `${count} possible whole-question starts found. Red lines are whole questions; add blue part cuts where useful.`
        : 'No reliable whole-question starts were found. Add red question cuts or blue part cuts by clicking the pages.'
    );
  }

  function exportSegmentation() {
    if (!file || !pages.length) return;

    const payload = {
      schemaVersion: 2,
      sourceFile: file.name,
      createdAt: new Date().toISOString(),
      headerFraction: round4(headerPct / 100),
      footerFraction: round4(footerPct / 100),
      pageCount: pages.length,
      cuts: pages.map(({ pageNumber }) => {
        const pageCuts = cuts[pageNumber] || [];
        return {
          page: pageNumber,
          // Kept for backwards compatibility with the first version.
          yFractionsFromTop: pageCuts.map((cut) => round4(cut.y)),
          cutLines: pageCuts.map((cut) => ({
            yFractionFromTop: round4(cut.y),
            type: cut.type,
          })),
        };
      }),
      notes: 'Cut positions are fractions of the original PDF page height measured from the top edge. question = whole-question boundary; part = part-question boundary.',
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${file.name.replace(/\.pdf$/i, '')}.segmentation.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('Segmentation file saved with whole-question and part-question boundaries.');
  }

  const counts = useMemo(() => {
    let question = 0;
    let part = 0;
    Object.values(cuts).forEach((pageCuts) => {
      pageCuts.forEach((cut) => {
        if (cut.type === PART_CUT) part += 1;
        else question += 1;
      });
    });
    return { question, part, total: question + part };
  }, [cuts]);

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
            <h2>2. Question & part cuts</h2>
            <div className="cut-mode-picker" role="group" aria-label="Cut type">
              <button
                className={`cut-mode question-mode ${cutMode === QUESTION_CUT ? 'active' : ''}`}
                onClick={() => setCutMode(QUESTION_CUT)}
                type="button"
              >
                <span className="mode-swatch question-swatch" />
                Whole question
              </button>
              <button
                className={`cut-mode part-mode ${cutMode === PART_CUT ? 'active' : ''}`}
                onClick={() => setCutMode(PART_CUT)}
                type="button"
              >
                <span className="mode-swatch part-swatch" />
                Part
              </button>
            </div>
            <p className="small">
              Click a page to add the selected cut. Hold <strong>Shift</strong> while clicking for a blue part cut. Drag to move; double-click to remove; click the handle to switch red ↔ blue.
            </p>
            <div className="button-stack">
              <button className="secondary" onClick={suggestCuts} disabled={!pages.length || loading}>Suggest question cuts</button>
              <button className="ghost" onClick={clearCuts} disabled={!counts.total}>Clear cuts</button>
            </div>
            <div className="metric-stack">
              <div className="metric"><span><i className="metric-dot question-dot" />Question cuts</span><strong>{counts.question}</strong></div>
              <div className="metric"><span><i className="metric-dot part-dot" />Part cuts</span><strong>{counts.part}</strong></div>
            </div>
          </section>

          <section>
            <h2>3. Confirm</h2>
            <button className="primary full" onClick={exportSegmentation} disabled={!file || !pages.length}>Save segmentation</button>
            <p className="small">The JSON keeps both whole-question and part-question boundaries beside the original PDF.</p>
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
                  cutMode={cutMode}
                  onAddCut={addCut}
                  onMoveCut={moveCut}
                  onRemoveCut={removeCut}
                  onChangeCutType={changeCutType}
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

function PdfPage({ pageData, headerPct, footerPct, cuts, cutMode, onAddCut, onMoveCut, onRemoveCut, onChangeCutType, showGuides }) {
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
    const requestedType = event.shiftKey ? PART_CUT : cutMode;
    onAddCut(pageData.pageNumber, eventToYNorm(event), requestedType);
  }

  function beginDrag(event, cutId) {
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    target.setPointerCapture(pointerId);

    const onMove = (moveEvent) => {
      onMoveCut(pageData.pageNumber, cutId, eventToYNorm(moveEvent));
    };

    const onUp = () => {
      try { target.releasePointerCapture(pointerId); } catch (_) {}
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
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

        {cuts.map((cut) => {
          const yVisible = ((cut.y - visibleTop) / visibleHeight) * 100;
          const isPart = cut.type === PART_CUT;
          return (
            <div
              key={cut.id}
              className={`cut-line ${isPart ? 'part-cut' : 'question-cut'}`}
              style={{ top: `${yVisible}%` }}
              onPointerDown={(event) => beginDrag(event, cut.id)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                onRemoveCut(pageData.pageNumber, cut.id);
              }}
              title={`${isPart ? 'Part cut' : 'Whole-question cut'}. Drag to move. Double-click to remove.`}
            >
              <button
                className="cut-handle"
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onChangeCutType(pageData.pageNumber, cut.id);
                }}
                title="Click to switch between whole-question and part cut"
              >
                {isPart ? 'P' : 'Q'}
              </button>
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
