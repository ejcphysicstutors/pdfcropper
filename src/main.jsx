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
const PAGE_CONTENT_WIDTH = 706;
const PAGE_CONTENT_HEIGHT = 1035;

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

function extractTextRows(pageData) {
  const rows = [];
  for (const item of pageData.textContent.items || []) {
    const text = String(item.str || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const pos = textItemPosition(item, pageData.viewport);
    let row = rows.find((candidate) => Math.abs(candidate.yNorm - pos.yNorm) < 0.0065);
    if (!row) {
      row = { yNorm: pos.yNorm, items: [] };
      rows.push(row);
    }
    row.items.push({ text, xNorm: pos.xNorm });
  }
  return rows
    .map((row) => {
      const ordered = row.items.sort((a, b) => a.xNorm - b.xNorm);
      return {
        yNorm: row.yNorm,
        xNorm: ordered[0]?.xNorm ?? 1,
        text: ordered.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim(),
      };
    })
    .sort((a, b) => a.yNorm - b.yNorm);
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
  const [selectedLineId, setSelectedLineId] = useState(null);
  const [lastSuggestionIds, setLastSuggestionIds] = useState([]);
  const [viewMode, setViewMode] = useState('segment');
  const [outputBreaks, setOutputBreaks] = useState({});
  const fileInputRef = useRef(null);

  useEffect(() => () => { if (pdf) pdf.destroy(); }, [pdf]);

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
      if (viewMode !== 'segment') return;

      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && selectedLineId) {
        const direction = event.key === 'ArrowUp' ? -1 : 1;
        const step = event.shiftKey ? 0.005 : 0.001;
        const top = headerPct / 100 + 0.004;
        const bottom = 1 - footerPct / 100 - 0.004;
        setLines((current) => current.map((line) => line.id === selectedLineId
          ? { ...line, y: round4(clamp(line.y + direction * step, top, bottom)), source: 'manual' }
          : line).sort(comparePos));
        setLastSuggestionIds((ids) => ids.filter((item) => item !== selectedLineId));
        setStatus(`Selected line moved ${event.key === 'ArrowUp' ? 'up' : 'down'} ${event.shiftKey ? '5' : '1'} fine step${event.shiftKey ? 's' : ''}.`);
        event.preventDefault();
        return;
      }

      const mode = keyToMode(event.key);
      if (!mode) return;
      setHeldLineMode(mode);
      setLineMode(mode);
      setStatus(`${mode === START ? 'START' : mode === END ? 'END' : 'PART'} mode selected. Click the rolling paper to place the line.`);
      event.preventDefault();
    }
    function handleShortcutUp(event) {
      if (keyToMode(event.key)) setHeldLineMode(null);
    }
    const clearHeldMode = () => setHeldLineMode(null);
    window.addEventListener('keydown', handleShortcutDown);
    window.addEventListener('keyup', handleShortcutUp);
    window.addEventListener('blur', clearHeldMode);
    return () => {
      window.removeEventListener('keydown', handleShortcutDown);
      window.removeEventListener('keyup', handleShortcutUp);
      window.removeEventListener('blur', clearHeldMode);
    };
  }, [selectedLineId, headerPct, footerPct, viewMode]);

  async function openPdf(selected) {
    if (!selected) return;
    setLoading(true);
    setStatus('Loading PDF…');
    setFile(selected);
    setLines([]);
    setLastSuggestionIds([]);
    setSelectedQuestionId(null);
    setSelectedLineId(null);
    setOutputBreaks({});
    setViewMode('segment');

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
        nextPages.push({ pageNumber, page, viewport, textContent, rows: null });
      }
      nextPages.forEach((pageData) => { pageData.rows = extractTextRows(pageData); });
      setPages(nextPages);
      setStatus(`${loadedPdf.numPages} pages loaded. Use Suggest regions, then scan the proposed starts, ends and part lines.`);
    } catch (error) {
      console.error(error);
      setStatus('Could not open this PDF. Please try another file.');
      setFile(null); setPdf(null); setPages([]);
    } finally {
      setLoading(false);
    }
  }

  function safeY(yNorm) {
    return round4(clamp(yNorm, headerPct / 100 + 0.004, 1 - footerPct / 100 - 0.004));
  }

  function addLine(page, y, kind = lineMode) {
    const newLine = { id: makeId(kind), page, y: safeY(y), kind, label: '', manualLabel: false, source: 'manual' };
    setLines((current) => [...current, newLine].sort(comparePos));
    setSelectedLineId(newLine.id);
  }

  function moveLine(id, page, y) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, page, y: safeY(y), source: 'manual' } : line).sort(comparePos));
    setLastSuggestionIds((ids) => ids.filter((item) => item !== id));
  }

  function removeLine(id) {
    setLines((current) => current.filter((line) => line.id !== id));
    setLastSuggestionIds((ids) => ids.filter((item) => item !== id));
    setSelectedLineId((current) => current === id ? null : current);
  }

  function updateLineLabel(id, label) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, label, manualLabel: true, source: 'manual' } : line));
    setLastSuggestionIds((ids) => ids.filter((item) => item !== id));
  }

  function clearLines() {
    setLines([]); setLastSuggestionIds([]); setSelectedQuestionId(null); setSelectedLineId(null); setOutputBreaks({});
  }

  function undoLastSuggestions() {
    if (!lastSuggestionIds.length) return;
    const ids = new Set(lastSuggestionIds);
    setLines((current) => current.filter((line) => !ids.has(line.id)));
    setLastSuggestionIds([]);
    setStatus('Removed the latest automatic suggestions. Your manual lines were kept.');
  }

  function lineIsNearExisting(candidate, currentLines) {
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
      return sameKind.some((line) => posKey(line) > lower && posKey(line) < upper);
    }
    if (candidate.kind === END && Number.isInteger(candidate.questionIndex)) {
      const index = candidate.questionIndex;
      const startKey = posKey(detectedStarts[index]);
      const nextKey = index < detectedStarts.length - 1 ? posKey(detectedStarts[index + 1]) : Infinity;
      return sameKind.some((line) => posKey(line) > startKey && posKey(line) < nextKey);
    }
    return lineIsNearExisting(candidate, currentLines);
  }

  function detectMajorStarts() {
    const starts = [];
    for (const pageData of pages) {
      const top = headerPct / 100;
      const bottom = 1 - footerPct / 100;
      for (const row of pageData.rows || []) {
        if (row.yNorm <= top || row.yNorm >= bottom || row.xNorm > 0.19) continue;
        const match = row.text.match(/^(?:Q\s*)?(\d{1,2})(?=\s|\(|[.)])/i);
        if (!match) continue;
        starts.push({
          page: pageData.pageNumber,
          y: round4(Math.max(top + 0.004, row.yNorm - 0.014)),
          label: `Q${match[1]}`,
          number: Number(match[1]),
        });
      }
    }
    return starts.sort(comparePos).filter((candidate, idx, arr) => {
      if (idx === 0) return true;
      const previous = arr[idx - 1];
      if (candidate.number === previous.number && Math.abs(posKey(candidate) - posKey(previous)) < 1000) return false;
      return Math.abs(posKey(candidate) - posKey(previous)) > 250;
    });
  }

  function detectPartStarts() {
    const parts = [];
    for (const pageData of pages) {
      const top = headerPct / 100;
      const bottom = 1 - footerPct / 100;
      for (const row of pageData.rows || []) {
        if (row.yNorm <= top || row.yNorm >= bottom || row.xNorm > 0.30) continue;
        const match = row.text.match(/^(?:\d{1,2}\s+)?\(([a-z])\)(?=\s|$)/i);
        if (!match) continue;
        parts.push({ page: pageData.pageNumber, y: round4(Math.max(top + 0.004, row.yNorm - 0.009)), raw: `(${match[1].toLowerCase()})` });
      }
    }
    return parts.sort(comparePos).filter((candidate, idx, arr) => idx === 0 || Math.abs(posKey(candidate) - posKey(arr[idx - 1])) > 150);
  }

  function detectTotalMarks() {
    const totals = [];
    for (const pageData of pages) {
      const top = headerPct / 100;
      const bottom = 1 - footerPct / 100;
      for (const row of pageData.rows || []) {
        if (row.yNorm <= top || row.yNorm >= bottom) continue;
        if (!/\[?\s*Total\s*[:=]\s*\d+\s*marks?\s*\]?/i.test(row.text)) continue;
        totals.push({ page: pageData.pageNumber, y: round4(Math.min(bottom - 0.004, row.yNorm + 0.026)) });
      }
    }
    return totals.sort(comparePos);
  }

  function suggestRegions() {
    const starts = detectMajorStarts();
    if (!starts.length) {
      setStatus('No reliable whole-question numbers were found. Existing lines were left untouched. Add START/END lines manually.');
      return;
    }

    const totals = detectTotalMarks();
    const rawParts = detectPartStarts();
    const candidates = [];
    let usedTotalCount = 0;

    starts.forEach((start, index) => {
      const nextStart = starts[index + 1] || null;
      const total = totals.find((candidate) => comparePos(candidate, start) > 0 && (!nextStart || comparePos(candidate, nextStart) < 0));
      let end;
      if (total) {
        end = total;
        usedTotalCount += 1;
      } else if (nextStart) {
        end = nextStart.page === start.page
          ? { page: start.page, y: round4(Math.max(start.y + 0.03, nextStart.y - 0.018)) }
          : { page: nextStart.page - 1, y: round4(1 - footerPct / 100 - 0.008) };
      } else {
        end = { page: pages.length, y: round4(1 - footerPct / 100 - 0.008) };
      }

      candidates.push({ id: makeId(START), page: start.page, y: start.y, kind: START, label: start.label, manualLabel: false, source: 'suggested', questionIndex: index });
      candidates.push({ id: makeId(END), page: end.page, y: safeY(end.y), kind: END, label: '', manualLabel: false, source: 'suggested', questionIndex: index });

      rawParts.filter((part) => within(part, start, end) && Math.abs(posKey(part) - posKey(start)) > 180).forEach((part) => {
        candidates.push({
          id: makeId(PART), page: part.page, y: part.y, kind: PART,
          label: `${start.label}${part.raw}`, manualLabel: false, source: 'suggested', questionIndex: index,
        });
      });
    });

    setLines((current) => {
      const additions = candidates.filter((candidate) => !existingLineCoversCandidate(candidate, current, starts));
      setLastSuggestionIds(additions.map((line) => line.id));
      if (!additions.length) {
        setStatus('No new suggestions were added. Existing boundaries already cover the detected questions.');
        return current;
      }
      const modeNote = usedTotalCount ? `${usedTotalCount} end${usedTotalCount === 1 ? '' : 's'} anchored to [Total: … marks].` : 'No [Total: … marks] lines were found, so ends were inferred from the next question number (MCQ-style fallback).';
      setStatus(`Added ${additions.length} non-destructive suggestions. ${modeNote}`);
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
    if (!regions.length) { setSelectedQuestionId(null); return; }
    if (!regions.some((region) => region.id === selectedQuestionId)) setSelectedQuestionId(regions[0].id);
  }, [regions, selectedQuestionId]);

  function exportSegmentation() {
    if (!file || !pages.length) return;
    const payload = {
      schemaVersion: 4,
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
        outputPageBreakFractions: (outputBreaks[region.id] || []).map(round4),
      })),
      lines: [...lines].sort(comparePos).map((line) => ({
        page: line.page,
        yFractionFromTop: round4(line.y),
        type: line.kind,
        label: line.label || null,
        labelEditedByUser: Boolean(line.manualLabel),
        source: line.source || 'manual',
      })),
      notes: 'Question starts/ends define source ownership. Header/footer removal is applied before question assembly. outputPageBreakFractions describe publication-only page breaks within each cleaned question strip and do not alter source boundaries.',
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${file.name.replace(/\.pdf$/i, '')}.segmentation.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('Segmentation saved, including reviewed publication page breaks.');
  }

  const selectedRegion = regions.find((region) => region.id === selectedQuestionId) || null;
  const counts = useMemo(() => ({
    start: lines.filter((l) => l.kind === START).length,
    end: lines.filter((l) => l.kind === END).length,
    part: lines.filter((l) => l.kind === PART).length,
  }), [lines]);
  const explicitEndCount = regions.filter((region) => region.endExplicit).length;

  function enterPreview() {
    if (!regions.length) return;
    setViewMode('preview');
    setSelectedLineId(null);
    setStatus('Review the final layout. Purple page-break lines affect output only; source question boundaries stay unchanged.');
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local browser tool</p>
          <h1>Prelim Cropper</h1>
          <p className="subtitle">{viewMode === 'segment' ? 'Confirm question ownership first. Review page layout only when segmentation is finished.' : 'Review and adjust publication page breaks before saving the segmentation JSON.'}</p>
        </div>
        <button className="primary" onClick={() => fileInputRef.current?.click()} disabled={loading}>{file ? 'Choose another PDF' : 'Choose PDF'}</button>
        <input ref={fileInputRef} className="hidden-input" type="file" accept="application/pdf,.pdf" onChange={(e) => openPdf(e.target.files?.[0])} />
      </header>

      <main className={`workspace ${viewMode === 'preview' ? 'preview-mode-shell' : ''}`}>
        <aside className="controls-card">
          {viewMode === 'segment' ? (
            <>
              <section>
                <h2>1. Page cleanup</h2>
                <label>Header removed <strong>{headerPct}%</strong><input type="range" min="0" max="15" step="0.5" value={headerPct} onChange={(e) => setHeaderPct(Number(e.target.value))} /></label>
                <label>Footer removed <strong>{footerPct}%</strong><input type="range" min="0" max="15" step="0.5" value={footerPct} onChange={(e) => setFooterPct(Number(e.target.value))} /></label>
                <label className="check-row"><input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />Show removed regions</label>
              </section>

              <section>
                <h2>2. Question boundaries</h2>
                <div className="line-mode-picker" role="group" aria-label="Line type">
                  <button className={`line-mode start-mode ${(heldLineMode || lineMode) === START ? 'active' : ''}`} onClick={() => setLineMode(START)}><span className="mode-swatch start-swatch" />Question start <kbd>S</kbd></button>
                  <button className={`line-mode end-mode ${(heldLineMode || lineMode) === END ? 'active' : ''}`} onClick={() => setLineMode(END)}><span className="mode-swatch end-swatch" />Question end <kbd>E</kbd></button>
                  <button className={`line-mode part-mode ${(heldLineMode || lineMode) === PART ? 'active' : ''}`} onClick={() => setLineMode(PART)}><span className="mode-swatch part-swatch" />Part <kbd>P</kbd></button>
                </div>
                <div className="shortcut-strip"><span><kbd>S</kbd> Start</span><span><kbd>E</kbd> End</span><span><kbd>P</kbd> Part</span></div>
                <p className="small">Suggested START lines sit just above whole-question numbers. For structured papers, END lines prefer <strong>[Total: … marks]</strong>. If totals are absent, the next whole-question number is used as a fallback. Suggestions never overwrite your manual work.</p>
                <p className="small">Click a line, then use <strong>↑ / ↓</strong> for fine adjustment. Hold <strong>Shift</strong> for a larger nudge. Drag to move; double-click to remove.</p>
                <div className="button-stack">
                  <button className="secondary" onClick={suggestRegions} disabled={!pages.length || loading}>Suggest regions</button>
                  <button className="ghost" onClick={undoLastSuggestions} disabled={!lastSuggestionIds.length}>Undo suggestions</button>
                  <button className="ghost clear-button" onClick={clearLines} disabled={!lines.length}>Clear all</button>
                </div>
                <div className="metric-stack">
                  <div className="metric"><span><i className="metric-dot start-dot" />Starts</span><strong>{counts.start}</strong></div>
                  <div className="metric"><span><i className="metric-dot end-dot" />Explicit ends</span><strong>{explicitEndCount}/{regions.length || 0}</strong></div>
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
                <h2>4. Review output</h2>
                <button className="primary full" onClick={enterPreview} disabled={!regions.length}>Review final crops →</button>
                <p className="small">Finish source boundaries first. Publication page breaks are adjusted separately in the next screen.</p>
              </section>
            </>
          ) : (
            <>
              <section>
                <button className="ghost full" onClick={() => setViewMode('segment')}>← Back to segmentation</button>
              </section>
              <section>
                <h2>Review questions</h2>
                <div className="region-list preview-region-list">
                  {regions.map((region) => (
                    <button key={region.id} className={`region-row ${selectedQuestionId === region.id ? 'selected' : ''}`} onClick={() => setSelectedQuestionId(region.id)}>
                      <span className="region-name">{region.label}</span>
                      <span className="region-status ok">{(outputBreaks[region.id]?.length || 0) + 1} page{(outputBreaks[region.id]?.length || 0) === 0 ? '' : 's'}</span>
                    </button>
                  ))}
                </div>
              </section>
              <section>
                <h2>Finalise</h2>
                <button className="primary full" onClick={exportSegmentation} disabled={!file || !regions.length}>Download segmentation JSON</button>
                <p className="small">The JSON keeps source boundaries and publication page breaks separate, so later compilation can re-create the reviewed layout.</p>
              </section>
            </>
          )}
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
          {!!pages.length && !loading && viewMode === 'segment' && (
            <div className="segmentation-workspace">
              <div className="panel-heading"><div><p className="eyebrow">Segmentation</p><h2>Rolling paper</h2></div><span className="panel-note">Focus only on question ownership</span></div>
              <div className="rolling-paper">
                {pages.map((pageData) => (
                  <PdfPage key={pageData.pageNumber} pageData={pageData} headerPct={headerPct} footerPct={footerPct}
                    lines={lines.filter((line) => line.page === pageData.pageNumber)} lineMode={heldLineMode || lineMode} onAddLine={addLine}
                    onMoveLine={moveLine} onRemoveLine={removeLine} showGuides={showGuides} regions={regions} selectedLineId={selectedLineId} onSelectLine={setSelectedLineId} />
                ))}
              </div>
            </div>
          )}
          {!!pages.length && !loading && viewMode === 'preview' && (
            <PreviewWorkspace pages={pages} region={selectedRegion} headerPct={headerPct} footerPct={footerPct}
              savedBreaks={selectedRegion ? outputBreaks[selectedRegion.id] : []}
              onBreaksChange={(breaks) => selectedRegion && setOutputBreaks((current) => ({ ...current, [selectedRegion.id]: breaks }))} />
          )}
        </section>
      </main>
    </div>
  );
}

function PdfPage({ pageData, headerPct, footerPct, lines, lineMode, onAddLine, onMoveLine, onRemoveLine, showGuides, regions, selectedLineId, onSelectLine }) {
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
            <div key={line.id} className={`crop-line ${line.kind} ${line.source === 'suggested' ? 'suggested-line' : 'confirmed-line'} ${selectedLineId === line.id ? 'selected-line' : ''}`} style={{ top: `${yVisible}%` }}
              onClick={(e) => { e.stopPropagation(); onSelectLine(line.id); }} onPointerDown={(e) => { onSelectLine(line.id); beginDrag(e, line.id); }}
              onDoubleClick={(e) => { e.stopPropagation(); onRemoveLine(line.id); }} title="Click to select. Use Up/Down arrows for fine adjustment. Drag to move. Double-click to remove.">
              <span className="line-tag">{displayText(line)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

async function buildQuestionStrip(pages, region, headerPct, footerPct) {
  const relevant = pages.filter((p) => p.pageNumber >= region.start.page && p.pageNumber <= region.end.page);
  const fragments = [];
  const pageMaps = [];
  const renderScale = 1.4;
  let cumulativeHeight = 0;

  for (const pageData of relevant) {
    const viewport = pageData.page.getViewport({ scale: renderScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await pageData.page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    let top = headerPct / 100;
    let bottom = 1 - footerPct / 100;
    if (pageData.pageNumber === region.start.page) top = Math.max(top, region.start.y);
    if (pageData.pageNumber === region.end.page) bottom = Math.min(bottom, region.end.y);
    if (bottom <= top) continue;

    const sy = Math.round(canvas.height * top);
    const sh = Math.max(1, Math.round(canvas.height * (bottom - top)));
    const frag = document.createElement('canvas');
    frag.width = canvas.width; frag.height = sh;
    frag.getContext('2d').drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
    fragments.push(frag);
    pageMaps.push({ page: pageData.pageNumber, top, bottom, startY: cumulativeHeight, height: sh, fullHeight: canvas.height });
    cumulativeHeight += sh;
  }

  if (!fragments.length) return null;
  const width = Math.max(...fragments.map((fragment) => fragment.width));
  const strip = document.createElement('canvas');
  strip.width = width; strip.height = cumulativeHeight;
  const ctx = strip.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, strip.width, strip.height);
  let y = 0;
  for (const frag of fragments) {
    ctx.drawImage(frag, 0, y);
    y += frag.height;
  }

  const partFractions = region.parts.map((part) => {
    const map = pageMaps.find((candidate) => candidate.page === part.page);
    if (!map) return null;
    const local = clamp((part.y - map.top) / Math.max(0.0001, map.bottom - map.top), 0, 1);
    return { id: part.id, label: part.label || 'Part', fraction: round4((map.startY + local * map.height) / strip.height) };
  }).filter(Boolean);

  return { dataUrl: strip.toDataURL('image/jpeg', 0.94), canvas: strip, width: strip.width, height: strip.height, partFractions };
}

function automaticBreaks(stripWidth, stripHeight, partFractions) {
  const sourcePageHeight = PAGE_CONTENT_HEIGHT * (stripWidth / PAGE_CONTENT_WIDTH);
  if (stripHeight <= sourcePageHeight) return [];
  const breaks = [];
  let current = 0;
  const partYs = partFractions.map((part) => part.fraction * stripHeight).filter((value) => value > 0 && value < stripHeight);
  while (current + sourcePageHeight < stripHeight - 1) {
    const target = current + sourcePageHeight;
    const minimumUseful = current + sourcePageHeight * 0.56;
    const candidates = partYs.filter((y) => y > minimumUseful && y <= target);
    let breakY = candidates.length ? candidates[candidates.length - 1] : target;
    if (breakY <= current + 10) breakY = target;
    breaks.push(round4(breakY / stripHeight));
    current = breakY;
  }
  return breaks;
}

function makeFinalPages(strip, breaks) {
  const boundaries = [0, ...breaks.map((value) => clamp(value, 0.001, 0.999)), 1].sort((a, b) => a - b);
  const pages = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const startY = Math.round(boundaries[i] * strip.height);
    const endY = Math.round(boundaries[i + 1] * strip.height);
    const sourceHeight = Math.max(1, endY - startY);
    const a4 = document.createElement('canvas');
    a4.width = 794; a4.height = 1123;
    const ctx = a4.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, a4.width, a4.height);
    const scale = PAGE_CONTENT_WIDTH / strip.width;
    const destHeight = sourceHeight * scale;
    const safeHeight = Math.min(destHeight, PAGE_CONTENT_HEIGHT);
    const sourceHeightToDraw = Math.min(sourceHeight, safeHeight / scale);
    ctx.drawImage(strip, 0, startY, strip.width, sourceHeightToDraw, 44, 44, PAGE_CONTENT_WIDTH, sourceHeightToDraw * scale);
    pages.push(a4.toDataURL('image/jpeg', 0.92));
  }
  return pages;
}

function PreviewWorkspace({ pages, region, headerPct, footerPct, savedBreaks, onBreaksChange }) {
  const [strip, setStrip] = useState(null);
  const [loading, setLoading] = useState(false);
  const [autoBreaks, setAutoBreaks] = useState([]);

  useEffect(() => {
    let cancelled = false;
    if (!region) { setStrip(null); return undefined; }
    setLoading(true);
    buildQuestionStrip(pages, region, headerPct, footerPct).then((result) => {
      if (cancelled) return;
      setStrip(result);
      const nextAuto = result ? automaticBreaks(result.width, result.height, result.partFractions) : [];
      setAutoBreaks(nextAuto);
      if ((!savedBreaks || !savedBreaks.length) && nextAuto.length) onBreaksChange(nextAuto);
      if ((!savedBreaks || !savedBreaks.length) && !nextAuto.length) onBreaksChange([]);
      setLoading(false);
    }).catch((error) => { console.error(error); if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pages, region?.id, region?.start.page, region?.start.y, region?.end.page, region?.end.y, headerPct, footerPct]);

  if (!region) return <div className="preview-empty large">Select a question to review.</div>;
  if (loading || !strip) return <div className="loading-card">Building cleaned question preview…</div>;

  const breaks = savedBreaks || [];
  const finalPages = makeFinalPages(strip.canvas, breaks);

  return (
    <div className="preview-review-workspace">
      <div className="preview-toolbar">
        <div><p className="eyebrow">Review output</p><h2>{region.label}</h2><p>Headers and footers are removed before these fragments are joined. Purple lines are publication-only page breaks.</p></div>
        <button className="ghost" onClick={() => onBreaksChange(autoBreaks)}>Reset page breaks</button>
      </div>
      <div className="preview-grid">
        <div className="layout-editor-panel">
          <div className="panel-heading"><div><h3>Continuous cleaned question</h3><p>Drag purple page-break lines. They snap near blue part boundaries.</p></div><span className="panel-note">Source crop unchanged</span></div>
          <StripBreakEditor strip={strip} breaks={breaks} onBreaksChange={onBreaksChange} />
        </div>
        <div className="final-pages-panel">
          <div className="panel-heading"><div><h3>Final pages</h3><p>{finalPages.length} A4 page{finalPages.length === 1 ? '' : 's'}</p></div><span className="panel-note">What compilation will use</span></div>
          <div className="final-page-list">
            {finalPages.map((src, index) => <div className="preview-page-card" key={`${region.id}-${index}`}><span>Page {index + 1}</span><img src={src} alt={`${region.label} final page ${index + 1}`} /></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

function StripBreakEditor({ strip, breaks, onBreaksChange }) {
  const containerRef = useRef(null);
  function updateBreak(index, event) {
    const rect = containerRef.current.getBoundingClientRect();
    let fraction = clamp((event.clientY - rect.top) / rect.height, 0.02, 0.98);
    const nearestPart = strip.partFractions.reduce((best, part) => {
      const distance = Math.abs(part.fraction - fraction);
      return !best || distance < best.distance ? { distance, fraction: part.fraction } : best;
    }, null);
    if (nearestPart && nearestPart.distance < 0.018) fraction = nearestPart.fraction;
    const previous = index > 0 ? breaks[index - 1] : 0;
    const next = index < breaks.length - 1 ? breaks[index + 1] : 1;
    fraction = clamp(fraction, previous + 0.025, next - 0.025);
    const nextBreaks = [...breaks];
    nextBreaks[index] = round4(fraction);
    onBreaksChange(nextBreaks.sort((a, b) => a - b));
  }
  function beginDrag(event, index) {
    event.preventDefault(); event.stopPropagation();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    target.setPointerCapture(pointerId);
    const move = (moveEvent) => updateBreak(index, moveEvent);
    const up = () => {
      try { target.releasePointerCapture(pointerId); } catch (_) {}
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
  }
  return (
    <div ref={containerRef} className="strip-editor">
      <img src={strip.dataUrl} alt="Continuous cleaned question" />
      {strip.partFractions.map((part) => <div key={part.id} className="preview-part-guide" style={{ top: `${part.fraction * 100}%` }}><span>{part.label}</span></div>)}
      {breaks.map((fraction, index) => (
        <div key={`break-${index}`} className="page-break-line" style={{ top: `${fraction * 100}%` }} onPointerDown={(event) => beginDrag(event, index)}>
          <span>PAGE {index + 1} END ↕</span>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
