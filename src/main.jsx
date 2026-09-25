import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './styles.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round4 = (value) => Math.round(value * 10000) / 10000;
const START = 'question-start';
const END = 'question-end';
const PART = 'part';

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
}

function posKey(pos) {
  return pos.page * 100000 + pos.y * 10000;
}

function comparePos(a, b) {
  return posKey(a) - posKey(b);
}

function within(pos, start, end) {
  return comparePos(pos, start) > 0 && comparePos(pos, end) < 0;
}

function textItemPosition(item, viewport) {
  const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const x = transform[4];
  const yFromTop = viewport.height - transform[5];
  return { xNorm: x / viewport.width, yNorm: yFromTop / viewport.height };
}

function App() {
  const [file, setFile] = useState(null);
  const [pdf, setPdf] = useState(null);
  const [pages, setPages] = useState([]);
  const [headerPct, setHeaderPct] = useState(6);
  const [footerPct, setFooterPct] = useState(6);
  const [lines, setLines] = useState([]);
  const [lineMode, setLineMode] = useState(START);
  const [heldLineMode, setHeldLineMode] = useState(null);
  const [status, setStatus] = useState('Choose a PDF to begin.');
  const [loading, setLoading] = useState(false);
  const [showGuides, setShowGuides] = useState(true);
  const [selectedQuestionId, setSelectedQuestionId] = useState(null);
  const [lastSuggestionIds, setLastSuggestionIds] = useState([]);
  const fileInputRef = useRef(null);

  useEffect(() => {
    return () => {
      if (pdf) pdf.destroy();
    };
  }, [pdf]);

  useEffect(() => {
    function keyToMode(key) {
      const lower = key.toLowerCase();
      if (lower === 's') return START;
      if (lower === 'e') return END;
      if (lower === 'p') return PART;
      return null;
    }

    function isTypingTarget(target) {
      const tag = target?.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
    }

    function handleShortcutDown(event) {
      if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
      const mode = keyToMode(event.key);
      if (!mode) return;

      setHeldLineMode(mode);
      setLineMode(mode);
      const label = mode === START ? 'START' : mode === END ? 'END' : 'PART';
      setStatus(`${label} mode selected. Click the rolling paper to place the line.`);
      event.preventDefault();
    }

    function handleShortcutUp(event) {
      const mode = keyToMode(event.key);
      if (mode) setHeldLineMode(null);
    }

    function clearHeldMode() {
      setHeldLineMode(null);
    }

    window.addEventListener('keydown', handleShortcutDown);
    window.addEventListener('keyup', handleShortcutUp);
    window.addEventListener('blur', clearHeldMode);
    return () => {
      window.removeEventListener('keydown', handleShortcutDown);
      window.removeEventListener('keyup', handleShortcutUp);
      window.removeEventListener('blur', clearHeldMode);
    };
  }, []);

  async function openPdf(selected) {
    if (!selected) return;
    setLoading(true);
    setStatus('Loading PDF…');
    setFile(selected);
    setLines([]);
    setLastSuggestionIds([]);
    setSelectedQuestionId(null);

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
      setStatus(`${loadedPdf.numPages} pages loaded. Suggest regions, then scan the red start/end lines and blue part lines.`);
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

  function safeY(yNorm) {
    const top = headerPct / 100;
    const bottom = 1 - footerPct / 100;
    return round4(clamp(yNorm, top + 0.004, bottom - 0.004));
  }

  function addLine(page, y, kind = lineMode) {
    const newLine = { id: makeId(kind), page, y: safeY(y), kind, label: '', manualLabel: false, source: 'manual' };
    setLines((current) => [...current, newLine].sort(comparePos));
  }

  function moveLine(id, page, y) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, page, y: safeY(y), source: 'manual' } : line).sort(comparePos));
    setLastSuggestionIds((ids) => ids.filter((item) => item !== id));
  }

  function removeLine(id) {
    setLines((current) => current.filter((line) => line.id !== id));
    setLastSuggestionIds((ids) => ids.filter((item) => item !== id));
  }

  function updateLineLabel(id, label) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, label, manualLabel: true, source: 'manual' } : line));
    setLastSuggestionIds((ids) => ids.filter((item) => item !== id));
  }

  function clearLines() {
    setLines([]);
    setLastSuggestionIds([]);
    setSelectedQuestionId(null);
  }

  function undoLastSuggestions() {
    if (!lastSuggestionIds.length) return;
    const ids = new Set(lastSuggestionIds);
    setLines((current) => current.filter((line) => !ids.has(line.id)));
    setLastSuggestionIds([]);
    setStatus('Removed the latest automatic suggestions. Your manual lines were kept.');
  }

  function lineIsNearExisting(candidate, currentLines) {
    // Small visual tolerance for ordinary duplicate checks.
    const tolerance = 260;
    return currentLines.some((line) => line.kind === candidate.kind && Math.abs(posKey(line) - posKey(candidate)) <= tolerance);
  }

  function existingLineCoversCandidate(candidate, currentLines, detectedStarts) {
    const sameKind = currentLines.filter((line) => line.kind === candidate.kind);
    if (!sameKind.length) return false;

    if (candidate.kind === START && Number.isInteger(candidate.questionIndex)) {
      const index = candidate.questionIndex;
      const here = posKey(detectedStarts[index]);
      const prev = index > 0 ? posKey(detectedStarts[index - 1]) : -Infinity;
      const next = index < detectedStarts.length - 1 ? posKey(detectedStarts[index + 1]) : Infinity;
      const lower = Number.isFinite(prev) ? (prev + here) / 2 : -Infinity;
      const upper = Number.isFinite(next) ? (here + next) / 2 : Infinity;
      return sameKind.some((line) => {
        const key = posKey(line);
        return key > lower && key < upper;
      });
    }

    if (candidate.kind === END && Number.isInteger(candidate.questionIndex)) {
      const index = candidate.questionIndex;
      const startKey = posKey(detectedStarts[index]);
      const nextKey = index < detectedStarts.length - 1 ? posKey(detectedStarts[index + 1]) : Infinity;
      return sameKind.some((line) => {
        const key = posKey(line);
        return key > startKey && key < nextKey;
      });
    }

    return lineIsNearExisting(candidate, currentLines);
  }

  function detectMajorStarts() {
    const starts = [];
    for (const pageData of pages) {
      const { pageNumber, viewport, textContent } = pageData;
      const top = headerPct / 100;
      const bottom = 1 - footerPct / 100;
      for (const item of textContent.items || []) {
        const text = String(item.str || '').trim();
        if (!text) continue;
        const match = text.match(/^(?:Q\s*)?(\d{1,2})(?:[.)])?$/i);
        if (!match) continue;
        const { xNorm, yNorm } = textItemPosition(item, viewport);
        if (xNorm < 0.18 && yNorm > top && yNorm < bottom) {
          starts.push({ page: pageNumber, y: round4(Math.max(top + 0.004, yNorm - 0.012)), label: `Q${match[1]}` });
        }
      }
    }
    return starts.sort(comparePos).filter((candidate, idx, arr) => idx === 0 || Math.abs(posKey(candidate) - posKey(arr[idx - 1])) > 250);
  }

  function detectPartStarts() {
    const parts = [];
    for (const pageData of pages) {
      const { pageNumber, viewport, textContent } = pageData;
      const top = headerPct / 100;
      const bottom = 1 - footerPct / 100;
      for (const item of textContent.items || []) {
        const text = String(item.str || '').trim();
        const match = text.match(/^\(([a-z])\)$/i);
        if (!match) continue;
        const { xNorm, yNorm } = textItemPosition(item, viewport);
        if (xNorm < 0.28 && yNorm > top && yNorm < bottom) {
          parts.push({ page: pageNumber, y: round4(Math.max(top + 0.004, yNorm - 0.008)), raw: `(${match[1].toLowerCase()})` });
        }
      }
    }
    return parts.sort(comparePos).filter((candidate, idx, arr) => idx === 0 || Math.abs(posKey(candidate) - posKey(arr[idx - 1])) > 160);
  }

  function detectTotalMarks() {
    const totals = [];
    for (const pageData of pages) {
      const { pageNumber, viewport, textContent } = pageData;
      const top = headerPct / 100;
      const bottom = 1 - footerPct / 100;
      for (const item of textContent.items || []) {
        const text = String(item.str || '').trim();
        if (!/Total\s*:\s*\d+\s*marks?/i.test(text)) continue;
        const { yNorm } = textItemPosition(item, viewport);
        if (yNorm > top && yNorm < bottom) {
          totals.push({ page: pageNumber, y: round4(Math.min(bottom - 0.004, yNorm + 0.028)) });
        }
      }
    }
    return totals.sort(comparePos);
  }

  function suggestRegions() {
    const starts = detectMajorStarts();
    if (!starts.length) {
      setStatus('No reliable whole-question starts were found. Your existing lines were left untouched. Add red START/END lines manually; blue part lines can still be added anywhere inside a question.');
      return;
    }

    const totals = detectTotalMarks();
    const rawParts = detectPartStarts();
    const candidates = [];

    starts.forEach((start, index) => {
      const nextStart = starts[index + 1] || null;
      const total = totals.find((candidate) => comparePos(candidate, start) > 0 && (!nextStart || comparePos(candidate, nextStart) < 0));
      let end;

      if (total) {
        end = total;
      } else if (nextStart) {
        if (nextStart.page === start.page) {
          end = { page: start.page, y: round4(Math.max(start.y + 0.03, nextStart.y - 0.018)) };
        } else {
          end = { page: nextStart.page - 1, y: round4(1 - footerPct / 100 - 0.008) };
        }
      } else {
        end = { page: pages.length, y: round4(1 - footerPct / 100 - 0.008) };
      }

      candidates.push({ id: makeId(START), page: start.page, y: start.y, kind: START, label: start.label, manualLabel: false, source: 'suggested', questionIndex: index });
      candidates.push({ id: makeId(END), page: end.page, y: safeY(end.y), kind: END, label: '', manualLabel: false, source: 'suggested', questionIndex: index });

      rawParts
        .filter((part) => within(part, start, end) && comparePos(part, start) > 100)
        .forEach((part) => {
          candidates.push({
            id: makeId(PART),
            page: part.page,
            y: part.y,
            kind: PART,
            label: `${start.label}${part.raw}`,
            manualLabel: false,
            source: 'suggested',
            questionIndex: index,
          });
        });
    });

    setLines((current) => {
      const additions = candidates.filter((candidate) => !existingLineCoversCandidate(candidate, current, starts));
      setLastSuggestionIds(additions.map((line) => line.id));
      if (!additions.length) {
        setStatus('No new suggestions were added. Your existing lines already cover the detected boundaries.');
        return current;
      }
      setStatus(`Added ${additions.length} automatic suggestions without changing any existing lines. Existing manual Start/End lines take priority for their question, so duplicate question boundaries are skipped.`);
      const merged = [...current, ...additions].sort(comparePos);
      const firstSuggestedStart = additions.find((line) => line.kind === START);
      if (firstSuggestedStart && !selectedQuestionId) setSelectedQuestionId(firstSuggestedStart.id);
      return merged;
    });
  }

  const regions = useMemo(() => {
    const ordered = [...lines].sort(comparePos);
    const starts = ordered.filter((line) => line.kind === START);
    return starts.map((start, index) => {
      const nextStart = starts[index + 1] || null;
      const end = ordered.find((line) => line.kind === END && comparePos(line, start) > 0 && (!nextStart || comparePos(line, nextStart) < 0));
      const fallbackEnd = nextStart
        ? (nextStart.page === start.page
          ? { page: nextStart.page, y: Math.max(start.y + 0.02, nextStart.y - 0.006) }
          : { page: nextStart.page - 1, y: 1 - footerPct / 100 - 0.004 })
        : { page: pages.length || start.page, y: 1 - footerPct / 100 - 0.004 };
      const finalEnd = end || { ...fallbackEnd, id: null, kind: END, virtual: true };
      const fallbackLabel = start.label || `Q${index + 1}`;
      const parts = ordered.filter((line) => line.kind === PART && within(line, start, finalEnd));
      return { id: start.id, start, end: finalEnd, endExplicit: Boolean(end), label: fallbackLabel, parts };
    });
  }, [lines, footerPct, pages.length]);

  useEffect(() => {
    if (!regions.length) {
      setSelectedQuestionId(null);
      return;
    }
    if (!regions.some((region) => region.id === selectedQuestionId)) setSelectedQuestionId(regions[0].id);
  }, [regions, selectedQuestionId]);

  function exportSegmentation() {
    if (!file || !pages.length) return;
    const payload = {
      schemaVersion: 3,
      sourceFile: file.name,
      createdAt: new Date().toISOString(),
      headerFraction: round4(headerPct / 100),
      footerFraction: round4(footerPct / 100),
      pageCount: pages.length,
      questions: regions.map((region) => ({
        label: region.label,
        start: { page: region.start.page, yFractionFromTop: round4(region.start.y) },
        end: { page: region.end.page, yFractionFromTop: round4(region.end.y), explicit: region.endExplicit },
        parts: region.parts.map((part, idx) => ({
          label: part.label || `${region.label}(${String.fromCharCode(97 + idx)})`,
          start: { page: part.page, yFractionFromTop: round4(part.y) },
        })),
      })),
      lines: [...lines].sort(comparePos).map((line) => ({
        page: line.page,
        yFractionFromTop: round4(line.y),
        type: line.kind,
        label: line.label || null,
        labelEditedByUser: Boolean(line.manualLabel),
        source: line.source || 'manual',
      })),
      notes: 'question-start/question-end define explicit crop regions. part lines are nested segment starts. Positions are fractions of original PDF page height from the top edge.',
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${file.name.replace(/\.pdf$/i, '')}.segmentation.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('Segmentation saved with explicit question start/end regions, part boundaries and labels.');
  }

  const selectedRegion = regions.find((region) => region.id === selectedQuestionId) || null;
  const counts = useMemo(() => ({
    start: lines.filter((l) => l.kind === START).length,
    end: lines.filter((l) => l.kind === END).length,
    part: lines.filter((l) => l.kind === PART).length,
  }), [lines]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local browser tool</p>
          <h1>Prelim Cropper</h1>
          <p className="subtitle">Confirm question regions visually, then save clean segmentation data.</p>
        </div>
        <button className="primary" onClick={() => fileInputRef.current?.click()} disabled={loading}>
          {file ? 'Choose another PDF' : 'Choose PDF'}
        </button>
        <input ref={fileInputRef} className="hidden-input" type="file" accept="application/pdf,.pdf" onChange={(e) => openPdf(e.target.files?.[0])} />
      </header>

      <main className="workspace">
        <aside className="controls-card">
          <section>
            <h2>1. Page cleanup</h2>
            <label>Header removed <strong>{headerPct}%</strong><input type="range" min="0" max="15" step="0.5" value={headerPct} onChange={(e) => setHeaderPct(Number(e.target.value))} /></label>
            <label>Footer removed <strong>{footerPct}%</strong><input type="range" min="0" max="15" step="0.5" value={footerPct} onChange={(e) => setFooterPct(Number(e.target.value))} /></label>
            <label className="check-row"><input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />Show removed regions</label>
          </section>

          <section>
            <h2>2. Region lines</h2>
            <div className="line-mode-picker" role="group" aria-label="Line type">
              <button className={`line-mode start-mode ${(heldLineMode || lineMode) === START ? 'active' : ''}`} onClick={() => setLineMode(START)}><span className="mode-swatch start-swatch" />Question start <kbd>S</kbd></button>
              <button className={`line-mode end-mode ${(heldLineMode || lineMode) === END ? 'active' : ''}`} onClick={() => setLineMode(END)}><span className="mode-swatch end-swatch" />Question end <kbd>E</kbd></button>
              <button className={`line-mode part-mode ${(heldLineMode || lineMode) === PART ? 'active' : ''}`} onClick={() => setLineMode(PART)}><span className="mode-swatch part-swatch" />Part <kbd>P</kbd></button>
            </div>
            <div className="shortcut-strip"><span><kbd>S</kbd> Start</span><span><kbd>E</kbd> End</span><span><kbd>P</kbd> Part</span></div>
            <p className="small">Press <strong>S</strong>, <strong>E</strong> or <strong>P</strong> at any time, then click the rolling paper. You can also hold the key while clicking. Drag to move; double-click to remove. Suggestions only add missing lines and never replace your manual work.</p>
            <div className="button-stack">
              <button className="secondary" onClick={suggestRegions} disabled={!pages.length || loading}>Suggest regions</button>
              <button className="ghost" onClick={undoLastSuggestions} disabled={!lastSuggestionIds.length}>Undo suggestions</button>
              <button className="ghost clear-button" onClick={clearLines} disabled={!lines.length}>Clear all</button>
            </div>
            <div className="metric-stack">
              <div className="metric"><span><i className="metric-dot start-dot" />Starts</span><strong>{counts.start}</strong></div>
              <div className="metric"><span><i className="metric-dot end-dot" />Ends</span><strong>{counts.end}</strong></div>
              <div className="metric"><span><i className="metric-dot part-dot" />Parts</span><strong>{counts.part}</strong></div>
            </div>
          </section>

          <section>
            <h2>3. Labels</h2>
            {!regions.length && <p className="small">Question labels will appear here after start lines are added.</p>}
            <div className="region-list">
              {regions.map((region) => (
                <button key={region.id} className={`region-row ${selectedQuestionId === region.id ? 'selected' : ''}`} onClick={() => setSelectedQuestionId(region.id)}>
                  <span className="region-name">{region.label}</span>
                  <span className={`region-status ${region.endExplicit ? 'ok' : 'warn'}`}>{region.endExplicit ? 'start + end' : 'end inferred'}</span>
                </button>
              ))}
            </div>
            {selectedRegion && (
              <div className="label-editor">
                <label>Question label<input value={selectedRegion.start.label || selectedRegion.label} onChange={(e) => updateLineLabel(selectedRegion.start.id, e.target.value)} /></label>
                {selectedRegion.parts.map((part, idx) => (
                  <label key={part.id}>Part {idx + 1}<input value={part.label || `${selectedRegion.label}(${String.fromCharCode(97 + idx)})`} onChange={(e) => updateLineLabel(part.id, e.target.value)} /></label>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2>4. Confirm</h2>
            <button className="primary full" onClick={exportSegmentation} disabled={!file || !regions.length}>Save segmentation</button>
            <p className="small">The JSON stores explicit question starts/ends, nested part starts and any label edits.</p>
          </section>
          <div className="status-box">{status}</div>
        </aside>

        <section className="document-area">
          {!file && (
            <div className="empty-state" onClick={() => fileInputRef.current?.click()}>
              <div className="empty-icon">PDF</div><h2>Choose a prelim paper</h2>
              <p>The paper stays in this browser session. Nothing is uploaded to a server.</p><button className="primary">Choose PDF</button>
            </div>
          )}
          {loading && <div className="loading-card">Preparing pages…</div>}
          {!!pages.length && !loading && (
            <div className="split-workspace">
              <div className="rolling-column">
                <div className="panel-heading"><div><p className="eyebrow">Source</p><h2>Rolling paper</h2></div><span className="panel-note">Adjust lines here</span></div>
                <div className="rolling-paper">
                  {pages.map((pageData) => (
                    <PdfPage key={pageData.pageNumber} pageData={pageData} headerPct={headerPct} footerPct={footerPct}
                      lines={lines.filter((line) => line.page === pageData.pageNumber)} lineMode={heldLineMode || lineMode} onAddLine={addLine}
                      onMoveLine={moveLine} onRemoveLine={removeLine} showGuides={showGuides} regions={regions} />
                  ))}
                </div>
              </div>
              <div className="preview-column">
                <div className="preview-sticky">
                  <div className="panel-heading"><div><p className="eyebrow">Output preview</p><h2>{selectedRegion?.label || 'Select a question'}</h2></div><span className="panel-note">A4 repaginated</span></div>
                  {selectedRegion ? <QuestionPreview pages={pages} region={selectedRegion} headerPct={headerPct} footerPct={footerPct} /> : <div className="preview-empty">Add or suggest a question region to see the final crop.</div>}
                </div>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function PdfPage({ pageData, headerPct, footerPct, lines, lineMode, onAddLine, onMoveLine, onRemoveLine, showGuides, regions }) {
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
      renderTask = pageData.page.render({ canvasContext: context, transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null, viewport });
      try { await renderTask.promise; } catch (error) { if (!cancelled && error?.name !== 'RenderingCancelledException') console.error(error); }
    }
    render();
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [pageData]);

  const visibleTop = headerPct / 100;
  const visibleBottom = 1 - footerPct / 100;
  const visibleHeight = visibleBottom - visibleTop;
  const frameHeight = renderSize.height * visibleHeight;
  const canvasTop = -renderSize.height * visibleTop;

  function eventToYNorm(event) {
    const rect = frameRef.current.getBoundingClientRect();
    const yWithinVisible = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    return visibleTop + yWithinVisible * visibleHeight;
  }

  function beginDrag(event, lineId) {
    event.preventDefault(); event.stopPropagation();
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    target.setPointerCapture(pointerId);
    const onMove = (moveEvent) => onMoveLine(lineId, pageData.pageNumber, eventToYNorm(moveEvent));
    const onUp = () => {
      try { target.releasePointerCapture(pointerId); } catch (_) {}
      target.removeEventListener('pointermove', onMove); target.removeEventListener('pointerup', onUp); target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onMove); target.addEventListener('pointerup', onUp); target.addEventListener('pointercancel', onUp);
  }

  function displayText(line) {
    if (line.kind === PART) return line.label || 'PART';
    if (line.kind === START) {
      const region = regions.find((r) => r.start.id === line.id);
      return `START ${region?.label || line.label || 'Q'}`;
    }
    const region = regions.find((r) => r.end?.id === line.id);
    return `END ${region?.label || 'Q'}`;
  }

  return (
    <div className="page-wrap">
      <div className="page-label">Page {pageData.pageNumber}</div>
      <div ref={frameRef} className="page-frame" style={{ width: renderSize.width, height: frameHeight }} onClick={(e) => { if (!e.target.closest('.crop-line')) onAddLine(pageData.pageNumber, eventToYNorm(e), lineMode); }}>
        <canvas ref={canvasRef} style={{ top: canvasTop }} />
        {showGuides && <><div className="crop-guide top-guide"><span>header removed</span></div><div className="crop-guide bottom-guide"><span>footer removed</span></div></>}
        {lines.map((line) => {
          const yVisible = ((line.y - visibleTop) / visibleHeight) * 100;
          return (
            <div key={line.id} className={`crop-line ${line.kind} ${line.source === 'suggested' ? 'suggested-line' : 'confirmed-line'}`} style={{ top: `${yVisible}%` }} onPointerDown={(e) => beginDrag(e, line.id)} onDoubleClick={(e) => { e.stopPropagation(); onRemoveLine(line.id); }} title="Drag to move. Double-click to remove.">
              <span className="line-tag">{displayText(line)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QuestionPreview({ pages, region, headerPct, footerPct }) {
  const [previewPages, setPreviewPages] = useState([]);
  const [previewStatus, setPreviewStatus] = useState('Rendering preview…');

  useEffect(() => {
    let cancelled = false;
    const urls = [];

    async function build() {
      setPreviewStatus('Rendering preview…');
      const relevant = pages.filter((p) => p.pageNumber >= region.start.page && p.pageNumber <= region.end.page);
      const fragments = [];
      const renderScale = 1.15;

      for (const pageData of relevant) {
        const viewport = pageData.page.getViewport({ scale: renderScale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        await pageData.page.render({ canvasContext: ctx, viewport }).promise;
        if (cancelled) return;

        let top = headerPct / 100;
        let bottom = 1 - footerPct / 100;
        if (pageData.pageNumber === region.start.page) top = Math.max(top, region.start.y);
        if (pageData.pageNumber === region.end.page) bottom = Math.min(bottom, region.end.y);
        if (bottom <= top) continue;

        const sy = Math.round(canvas.height * top);
        const sh = Math.max(1, Math.round(canvas.height * (bottom - top)));
        const frag = document.createElement('canvas');
        frag.width = canvas.width;
        frag.height = sh;
        frag.getContext('2d').drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
        fragments.push(frag);
      }

      if (!fragments.length) {
        if (!cancelled) { setPreviewPages([]); setPreviewStatus('No visible content in this region.'); }
        return;
      }

      const a4Width = 794;
      const a4Height = 1123;
      const margin = 44;
      const contentWidth = a4Width - margin * 2;
      const contentHeight = a4Height - margin * 2;
      const output = [];
      let pageCanvas = document.createElement('canvas');
      pageCanvas.width = a4Width; pageCanvas.height = a4Height;
      let pageCtx = pageCanvas.getContext('2d');
      pageCtx.fillStyle = '#fff'; pageCtx.fillRect(0, 0, a4Width, a4Height);
      let cursorY = margin;

      function finishPage() {
        const url = pageCanvas.toDataURL('image/jpeg', 0.92);
        urls.push(url); output.push(url);
        pageCanvas = document.createElement('canvas'); pageCanvas.width = a4Width; pageCanvas.height = a4Height;
        pageCtx = pageCanvas.getContext('2d'); pageCtx.fillStyle = '#fff'; pageCtx.fillRect(0, 0, a4Width, a4Height);
        cursorY = margin;
      }

      for (const frag of fragments) {
        const scale = contentWidth / frag.width;
        let remainingSourceY = 0;
        let remainingHeight = frag.height;

        while (remainingHeight > 0) {
          let room = contentHeight - (cursorY - margin);
          if (room < 110 && cursorY > margin) { finishPage(); room = contentHeight; }
          const sourceRoom = Math.floor(room / scale);
          const sourceSlice = Math.min(remainingHeight, Math.max(1, sourceRoom));
          const destHeight = sourceSlice * scale;
          pageCtx.drawImage(frag, 0, remainingSourceY, frag.width, sourceSlice, margin, cursorY, contentWidth, destHeight);
          cursorY += destHeight;
          remainingSourceY += sourceSlice;
          remainingHeight -= sourceSlice;
          if (remainingHeight > 0) finishPage();
          else if (cursorY > margin + contentHeight - 90) finishPage();
        }
      }

      if (cursorY > margin || !output.length) finishPage();
      if (!cancelled) {
        setPreviewPages(output);
        setPreviewStatus(`${output.length} A4 page${output.length === 1 ? '' : 's'} in final crop preview.`);
      }
    }

    build().catch((error) => {
      console.error(error);
      if (!cancelled) setPreviewStatus('Could not render this preview.');
    });

    return () => { cancelled = true; urls.forEach((url) => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); }); };
  }, [pages, region.start.page, region.start.y, region.end.page, region.end.y, headerPct, footerPct]);

  return (
    <div className="question-preview">
      <div className="preview-meta"><strong>{region.label}</strong><span>{previewStatus}</span></div>
      <div className="preview-pages">
        {previewPages.map((src, idx) => <div className="preview-page-card" key={`${region.id}-${idx}`}><span>Page {idx + 1}</span><img src={src} alt={`${region.label} final crop preview page ${idx + 1}`} /></div>)}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
