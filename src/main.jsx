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

  // viewport.transform already converts PDF bottom-left coordinates into the
  // browser's top-left coordinate system (its Y scale is negative).
  // transform[5] is therefore already a distance from the TOP of the rendered
  // page. Subtracting it from viewport.height flips the text vertically a
  // second time and makes printed markers appear on the wrong side of the page.
  const yFromTop = transform[5];

  return {
    xNorm: clamp(x / viewport.width, 0, 1),
    yNorm: clamp(yFromTop / viewport.height, 0, 1),
  };
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


function normalizePrintedMarkerText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseLeadingPartMarker(text) {
  const cleaned = normalizePrintedMarkerText(text);
  if (!cleaned) return null;

  // A PDF may split a printed marker into separate text items, producing forms
  // such as "( ii )", "ii)" or "1 (a) (i)" after row reconstruction.
  // Strip only a leading whole-question number, then inspect the beginning.
  const candidate = cleaned.replace(/^(?:Q\s*)?\d{1,2}\s*[.)]?\s*/i, '');

  const both = candidate.match(/^(?:\(([a-h])\)|([a-h])\))\s*(?:\(([ivxlcdm]+)\)|([ivxlcdm]+)\))(?=\s|[.,;:]|$)/i);
  if (both) {
    const alpha = (both[1] || both[2]).toLowerCase();
    const roman = (both[3] || both[4]).toLowerCase();
    return { alpha, roman, raw: `(${alpha})(${roman})`, printedText: cleaned };
  }

  const alpha = candidate.match(/^(?:\(([a-h])\)|([a-h])\))(?=\s|[.,;:]|$)/i);
  if (alpha) {
    const value = (alpha[1] || alpha[2]).toLowerCase();
    return { alpha: value, roman: null, raw: `(${value})`, printedText: cleaned };
  }

  const roman = candidate.match(/^(?:\(([ivxlcdm]+)\)|([ivxlcdm]+)\))(?=\s|[.,;:]|$)/i);
  if (roman) {
    const value = (roman[1] || roman[2]).toLowerCase();
    return { alpha: null, roman: value, raw: `(${value})`, printedText: cleaned };
  }

  return null;
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
  const [selectedSegmentId, setSelectedSegmentId] = useState(null);
  const [segmentLabelOverrides, setSegmentLabelOverrides] = useState({});
  const [segmentPartFlags, setSegmentPartFlags] = useState({});
  const [lastSuggestionIds, setLastSuggestionIds] = useState([]);
  const [viewMode, setViewMode] = useState('segment');
  const [outputBreaks, setOutputBreaks] = useState({});
  const [exclusions, setExclusions] = useState({});
  const [trimOverrides, setTrimOverrides] = useState({});
  const [globalReviewTrim, setGlobalReviewTrim] = useState({ topExtra: 0, bottomExtra: 0 });
  const [segmentationApproved, setSegmentationApproved] = useState(false);
  const [segmentationApprovedAt, setSegmentationApprovedAt] = useState(null);
  const [approvalIssues, setApprovalIssues] = useState([]);
  const [scrollToSegmentEditorId, setScrollToSegmentEditorId] = useState(null);
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
    setExclusions({});
    setTrimOverrides({});
    setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]);
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
    setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]);
    setSelectedLineId(newLine.id);
  }

  function moveLine(id, page, y) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, page, y: safeY(y), source: 'manual' } : line).sort(comparePos));
    setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]);
    setLastSuggestionIds((ids) => ids.filter((item) => item !== id));
  }

  function removeLine(id) {
    setLines((current) => current.filter((line) => line.id !== id));
    setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]);
    setLastSuggestionIds((ids) => ids.filter((item) => item !== id));
    setSelectedLineId((current) => current === id ? null : current);
  }

  function updateLineLabel(id, label) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, label, manualLabel: true, source: 'manual' } : line));
    setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]);
    setLastSuggestionIds((ids) => ids.filter((item) => item !== id));
  }

  function clearLines() {
    setLines([]); setLastSuggestionIds([]); setSelectedQuestionId(null); setSelectedLineId(null); setOutputBreaks({}); setExclusions({}); setTrimOverrides({}); setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]);
  }

  function undoLastSuggestions() {
    if (!lastSuggestionIds.length) return;
    const ids = new Set(lastSuggestionIds);
    setLines((current) => current.filter((line) => !ids.has(line.id)));
    setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]);
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
        const marker = parseLeadingPartMarker(row.text);
        if (!marker) continue;
        parts.push({
          page: pageData.pageNumber,
          y: round4(Math.max(top + 0.004, row.yNorm - 0.009)),
          raw: marker.raw,
          printedText: marker.printedText,
        });
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

      const questionPartStarts = rawParts.filter((part) => within(part, start, end) && Math.abs(posKey(part) - posKey(start)) > 180);
      questionPartStarts.slice(1).forEach((part) => {
        candidates.push({
          id: makeId(PART), page: part.page, y: part.y, kind: PART,
          label: '', manualLabel: false, source: 'suggested', questionIndex: index,
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
      setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]);
      const firstSuggestedStart = additions.find((line) => line.kind === START);
      if (firstSuggestedStart && !selectedQuestionId) setSelectedQuestionId(firstSuggestedStart.id);
      return merged;
    });
  }

  const regions = useMemo(() => {
    const ordered = [...lines].sort(comparePos);
    const starts = ordered.filter((line) => line.kind === START);

    function rowsInside(start, end) {
      const found = [];
      for (const pageData of pages) {
        if (pageData.pageNumber < start.page || pageData.pageNumber > end.page) continue;
        for (const row of pageData.rows || []) {
          const pos = { page: pageData.pageNumber, y: row.yNorm };
          if (comparePos(pos, start) >= 0 && comparePos(pos, end) < 0) found.push({ ...row, page: pageData.pageNumber });
        }
      }
      return found.sort((a, b) => comparePos({ page: a.page, y: a.yNorm }, { page: b.page, y: b.yNorm }));
    }

    const detectedPartStarts = detectPartStarts();

    function parsePartRaw(raw) {
      if (!raw) return { alpha: null, roman: null };
      const both = raw.match(/^\(([a-h])\)\(([ivxlcdm]+)\)$/i);
      if (both) return { alpha: both[1].toLowerCase(), roman: both[2].toLowerCase() };
      const alpha = raw.match(/^\(([a-h])\)$/i);
      if (alpha) return { alpha: alpha[1].toLowerCase(), roman: null };
      const roman = raw.match(/^\(([ivxlcdm]+)\)$/i);
      if (roman) return { alpha: null, roman: roman[1].toLowerCase() };
      return { alpha: null, roman: null };
    }

    function parseMarkerFromText(text) {
      return parseLeadingPartMarker(text);
    }

    function markerForSegment(start, end) {
      // 1) Read the actual PDF text inside this segment. Printed part markers
      // should normally occur in the first few rows.
      const rows = rowsInside(start, end);
      for (const row of rows.slice(0, 18)) {
        const marker = parseMarkerFromText(row.text);
        if (marker) return { ...marker, source: 'printed' };
      }

      // 2) Blue boundaries are placed visually, while PDF text coordinates use
      // baselines. The printed marker may therefore sit a little above or below
      // the exact boundary. Search a narrow top-left neighbourhood around the
      // segment start and choose the nearest valid printed marker.
      const pageData = pages.find((item) => item.pageNumber === start.page);
      if (pageData) {
        const nearbyRows = (pageData.rows || [])
          .filter((row) => row.xNorm <= 0.36)
          .map((row) => ({ row, delta: row.yNorm - start.y }))
          .filter(({ delta }) => delta >= -0.03 && delta <= 0.075)
          .sort((a, b) => {
            const aPenalty = a.delta < 0 ? Math.abs(a.delta) * 1.4 : Math.abs(a.delta);
            const bPenalty = b.delta < 0 ? Math.abs(b.delta) * 1.4 : Math.abs(b.delta);
            return aPenalty - bPenalty;
          });
        for (const { row } of nearbyRows) {
          const marker = parseMarkerFromText(row.text);
          if (marker) return { ...marker, source: 'near-boundary' };
        }
      }

      // 3) Fall back to the part-start detector, which now uses the same robust
      // parser and tolerates PDF.js inserting spaces inside parentheses.
      const nearby = detectedPartStarts
        .filter((part) => part.page === start.page && comparePos(part, end) < 0)
        .map((part) => ({ part, delta: posKey(part) - posKey(start) }))
        .filter(({ delta }) => delta >= -320 && delta <= 760)
        .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
      if (nearby) {
        const parsed = parsePartRaw(nearby.part.raw);
        return {
          ...parsed,
          raw: nearby.part.raw,
          printedText: nearby.part.printedText || nearby.part.raw,
          source: 'near-boundary',
        };
      }

      // 4) A first segment can contain the whole-question number before its first
      // (a)/(i). Search the rest of the segment only as a final printed-text
      // fallback.
      for (const row of rows.slice(18)) {
        const marker = parseMarkerFromText(row.text);
        if (marker) return { ...marker, source: 'printed-later' };
      }

      return { alpha: null, roman: null, raw: null, printedText: null, source: 'none' };
    }

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
      const boundaries = [start, ...parts];

      // Read all printed markers first so one segment can use the next segment as
      // context. This matters for layouts such as "(d) ... (i)" followed by a
      // blue boundary at "(ii)": the first segment is naturally Qn(d)(i), even
      // when PDF text extraction only exposes the leading "(d)" clearly.
      const segmentMarkers = boundaries.map((boundary, segmentIndex) => {
        const segmentEnd = segmentIndex < parts.length ? parts[segmentIndex] : finalEnd;
        return markerForSegment(boundary, segmentEnd);
      });

      let currentAlpha = null;
      let currentRoman = null;
      const segments = boundaries.map((boundary, segmentIndex) => {
        const segmentEnd = segmentIndex < parts.length ? parts[segmentIndex] : finalEnd;
        const marker = segmentMarkers[segmentIndex];
        const nextMarker = segmentMarkers[segmentIndex + 1] || null;
        let evidence = 'No printed part marker found';
        let inferred = null;

        if (marker.alpha) {
          currentAlpha = marker.alpha;

          // If this segment is detected only as (d), but the next segment is
          // explicitly (ii) or (d)(ii), infer that this segment is (d)(i).
          // This mirrors how structured exam questions are conventionally laid
          // out: the alphabetic stem and subpart (i) often begin together.
          const nextImpliesFirstRoman = !marker.roman
            && nextMarker?.roman === 'ii'
            && (!nextMarker.alpha || nextMarker.alpha === marker.alpha);

          currentRoman = marker.roman || (nextImpliesFirstRoman ? 'i' : null);
          inferred = `${fallbackLabel}(${currentAlpha})${currentRoman ? `(${currentRoman})` : ''}`;
          evidence = nextImpliesFirstRoman
            ? `Detected ${marker.raw}; inferred (i) because the next segment is ${nextMarker.raw}`
            : (marker.source === 'near-boundary'
              ? `Detected ${marker.raw} at the segment boundary`
              : `Detected ${marker.raw} from printed text`);
        } else if (marker.roman) {
          currentRoman = marker.roman;
          inferred = `${fallbackLabel}${currentAlpha ? `(${currentAlpha})` : ''}(${currentRoman})`;
          evidence = currentAlpha
            ? `Detected ${marker.raw}; inherited (${currentAlpha}) from the previous part`
            : `Detected ${marker.raw} from printed text`;
        } else if (!parts.length) {
          // A question with no blue part boundaries is legitimately just Qn.
          inferred = fallbackLabel;
          evidence = 'Whole question; no part boundaries';
        } else {
          // Do not silently repeat the previous part label when extraction fails.
          // Make uncertainty visible so the teacher only needs to fix true misses.
          inferred = `${fallbackLabel} part ${segmentIndex + 1}`;
        }

        const override = segmentLabelOverrides[boundary.id];
        const isPart = segmentPartFlags[boundary.id] !== false;
        return {
          id: boundary.id,
          start: boundary,
          end: segmentEnd,
          label: override || inferred,
          autoLabel: inferred,
          labelEvidence: evidence,
          detectedMarker: marker.raw,
          labelEditedByUser: Boolean(override),
          isPart,
        };
      });
      return { id: start.id, start, end: finalEnd, endExplicit: Boolean(end), label: fallbackLabel, parts, segments };
    });
  }, [lines, footerPct, pages, segmentLabelOverrides, segmentPartFlags]);

  useEffect(() => {
    if (!regions.length) { setSelectedQuestionId(null); return; }
    if (!regions.some((region) => region.id === selectedQuestionId)) setSelectedQuestionId(regions[0].id);
  }, [regions, selectedQuestionId]);

  useEffect(() => {
    if (!segmentationApproved) return;
    setSegmentationApproved(false);
    setSegmentationApprovedAt(null);
    setApprovalIssues([]);
  }, [lines, headerPct, footerPct, segmentLabelOverrides, segmentPartFlags]);

  function exportSegmentation() {
    if (!file || !pages.length) return;
    const issues = validateSegmentation();
    if (!segmentationApproved || issues.length) {
      setApprovalIssues(issues);
      setStatus(issues.length ? 'Cannot save yet. Fix the flagged segmentation issues, then approve questions & parts.' : 'Approve questions & parts before saving.');
      return;
    }
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
        parts: region.parts.map((part) => ({
          start: { page: part.page, yFractionFromTop: round4(part.y) },
        })),
        segments: region.segments.map((segment) => ({
          label: segment.label,
          labelEditedByUser: Boolean(segment.labelEditedByUser),
          labelEvidence: segment.labelEvidence || null,
          detectedMarker: segment.detectedMarker || null,
          isPart: segment.isPart !== false,
          start: { page: segment.start.page, yFractionFromTop: round4(segment.start.y) },
          end: { page: segment.end.page, yFractionFromTop: round4(segment.end.y) },
        })),
        outputPageBreakFractions: (outputBreaks[region.id] || []).map(round4),
        excludedOutputRanges: (exclusions[region.id] || []).map((range) => ({ startFraction: round4(range.start), endFraction: round4(range.end) })),
        pageTrimOverrides: Object.entries(trimOverrides[region.id] || {}).map(([page, trim]) => ({ page: Number(page), extraTopFraction: round4(trim.topExtra || 0), extraBottomFraction: round4(trim.bottomExtra || 0) })),
      })),
      segmentationApproval: {
        approved: segmentationApproved,
        approvedAt: segmentationApprovedAt,
        structuralIssueCount: validateSegmentation().length,
      },
      lines: [...lines].sort(comparePos).map((line) => ({
        page: line.page,
        yFractionFromTop: round4(line.y),
        type: line.kind,
        label: line.label || null,
        labelEditedByUser: Boolean(line.manualLabel),
        source: line.source || 'manual',
      })),
      globalReviewTrim: { extraTopFraction: round4(globalReviewTrim.topExtra || 0), extraBottomFraction: round4(globalReviewTrim.bottomExtra || 0) },
      notes: 'Question starts/ends define source ownership. Review-only global/local trim overrides, excluded output ranges and publication page breaks alter layout only; they do not change source question ownership.',
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${file.name.replace(/\.pdf$/i, '')}.segmentation.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('Approved segmentation saved, including reviewed publication page breaks.');
  }

  const selectedRegion = regions.find((region) => region.id === selectedQuestionId) || null;
  const selectedRegionIndex = regions.findIndex((region) => region.id === selectedQuestionId);

  function validateSegmentation() {
    const issues = [];
    const ordered = [...lines].sort(comparePos);
    const starts = ordered.filter((line) => line.kind === START);
    const ends = ordered.filter((line) => line.kind === END);
    const parts = ordered.filter((line) => line.kind === PART);

    if (!starts.length) issues.push({ type: 'paper', message: 'No question starts found.' });
    if (starts.length !== ends.length) {
      issues.push({ type: 'paper', message: `${starts.length} question starts but ${ends.length} question ends. Check for an extra or missing START/END line.` });
    }

    const parsedNumbers = starts.map((line) => {
      const match = String(line.label || '').match(/Q?\s*(\d{1,2})/i);
      return match ? Number(match[1]) : null;
    });
    if (parsedNumbers.some((number) => number == null)) {
      issues.push({ type: 'paper', message: 'One or more question starts has no usable question number. Check the question labels.' });
    } else if (parsedNumbers.length) {
      const expected = parsedNumbers.map((_, index) => index + 1);
      const same = parsedNumbers.length === expected.length && parsedNumbers.every((number, index) => number === expected[index]);
      if (!same) {
        issues.push({ type: 'paper', message: `Question starts are not a clean Q1–Q${starts.length} sequence (${parsedNumbers.map((n) => n ?? '?').join(', ')}). This often indicates an extra detected START line.` });
      }
    }

    starts.forEach((start, index) => {
      const nextStart = starts[index + 1] || null;
      const matchingEnds = ends.filter((line) => comparePos(line, start) > 0 && (!nextStart || comparePos(line, nextStart) < 0));
      if (matchingEnds.length === 0) {
        issues.push({ type: 'question', regionId: start.id, message: `${start.label || `Q${index + 1}`} has no explicit END line.` });
      } else if (matchingEnds.length > 1) {
        issues.push({ type: 'question', regionId: start.id, message: `${start.label || `Q${index + 1}`} has ${matchingEnds.length} END lines before the next question. Remove the extra END line.` });
      }
    });

    ends.forEach((end) => {
      const ownerIndex = starts.findIndex((start, index) => {
        const nextStart = starts[index + 1] || null;
        return comparePos(end, start) > 0 && (!nextStart || comparePos(end, nextStart) < 0);
      });
      if (ownerIndex < 0) issues.push({ type: 'paper', message: `An END line on page ${end.page} is not attached to any question.` });
    });

    parts.forEach((part) => {
      const owners = regions.filter((region) => within(part, region.start, region.end));
      if (owners.length === 0) issues.push({ type: 'paper', message: `A PART line on page ${part.page} sits outside all question boundaries.` });
      if (owners.length > 1) issues.push({ type: 'paper', message: `A PART line on page ${part.page} appears to belong to more than one question.` });
    });

    regions.forEach((region) => {
      if (!region.endExplicit) {
        issues.push({ type: 'question', regionId: region.id, message: `${region.label} is using an inferred END. Add or confirm the end line.` });
      }
      const uncertainSegments = region.segments.filter((segment) => segment.isPart !== false && !segment.detectedMarker && !segment.labelEditedByUser && region.parts.length > 0);
      if (uncertainSegments.length) {
        issues.push({ type: 'question', regionId: region.id, message: `${region.label} has ${uncertainSegments.length} part boundary${uncertainSegments.length === 1 ? '' : 'ies'} without a recognised printed part label. Check for an extra PART line or label it manually.` });
      }
    });

    return issues;
  }

  const liveApprovalIssues = validateSegmentation();
  const issueRegionIds = new Set(liveApprovalIssues.filter((issue) => issue.regionId).map((issue) => issue.regionId));

  function jumpToQuestion(regionId, smooth = true) {
    if (!regionId) return;
    setSelectedQuestionId(regionId);
    requestAnimationFrame(() => {
      const target = Array.from(document.querySelectorAll('.segment-overlay[data-region-id]')).find((node) => node.dataset.regionId === regionId);
      target?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    });
  }

  function approveSegmentation() {
    const issues = validateSegmentation();
    setApprovalIssues(issues);
    if (issues.length) {
      setSegmentationApproved(false);
      setSegmentationApprovedAt(null);
      const first = issues.find((issue) => issue.regionId);
      if (first?.regionId) jumpToQuestion(first.regionId);
      setStatus(`Cannot approve yet: ${issues.length} structural issue${issues.length === 1 ? '' : 's'} found. Fix the flagged START / END / PART lines first.`);
      return;
    }
    const now = new Date().toISOString();
    setSegmentationApproved(true);
    setSegmentationApprovedAt(now);
    setApprovalIssues([]);
    setStatus('Questions and parts approved. You can now review page layout and save the segmentation JSON.');
  }

  function updateSegmentLabel(segmentId, value) {
    setSegmentLabelOverrides((current) => ({ ...current, [segmentId]: value }));
    setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]);
  }

  function updateSegmentPartFlag(segmentId, value) {
    setSegmentPartFlags((current) => ({ ...current, [segmentId]: value }));
    setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]);
  }

  useEffect(() => {
    if (!selectedRegion?.segments?.length) { setSelectedSegmentId(null); return; }
    if (!selectedRegion.segments.some((segment) => segment.id === selectedSegmentId)) setSelectedSegmentId(selectedRegion.segments[0].id);
  }, [selectedRegion, selectedSegmentId]);

  useEffect(() => {
    if (!scrollToSegmentEditorId || selectedSegmentId !== scrollToSegmentEditorId) return;
    const timer = window.setTimeout(() => {
      const target = Array.from(document.querySelectorAll('[data-segment-editor-id]'))
        .find((node) => node.dataset.segmentEditorId === scrollToSegmentEditorId);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.querySelector('input:not([type="checkbox"])')?.focus({ preventScroll: true });
      setScrollToSegmentEditorId(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [scrollToSegmentEditorId, selectedSegmentId]);

  function selectSegmentForEditing(regionId, segmentId) {
    setSelectedQuestionId(regionId);
    setSelectedSegmentId(segmentId);
    setScrollToSegmentEditorId(segmentId);
  }

  const counts = useMemo(() => ({
    start: lines.filter((l) => l.kind === START).length,
    end: lines.filter((l) => l.kind === END).length,
    part: lines.filter((l) => l.kind === PART).length,
  }), [lines]);
  const explicitEndCount = regions.filter((region) => region.endExplicit).length;

  function enterPreview() {
    if (!regions.length) return;
    const issues = validateSegmentation();
    if (!segmentationApproved || issues.length) {
      setApprovalIssues(issues);
      setStatus(issues.length ? 'Fix the flagged segmentation issues and approve questions & parts before reviewing layout.' : 'Approve questions & parts before reviewing layout.');
      return;
    }
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
          <p className="subtitle">Prepare the paper, check questions and parts, then review worksheet pages.</p>
        </div>
        {file && <button className="primary" onClick={() => fileInputRef.current?.click()} disabled={loading}>Change PDF</button>}
        <input ref={fileInputRef} className="hidden-input" type="file" accept="application/pdf,.pdf" onChange={(e) => openPdf(e.target.files?.[0])} />
      </header>

      <main className={`workspace ${viewMode === 'preview' ? 'preview-mode-shell' : ''}`}>
        <aside className="controls-card">
          <nav className="workflow-stepper" aria-label="Workflow">
            <div className={`workflow-step ${file ? 'done' : 'active'}`}><span>{file ? '✓' : '1'}</span><small>Clean</small></div>
            <div className={`workflow-step ${file && !regions.length && viewMode === 'segment' ? 'active' : regions.length ? 'done' : ''}`}><span>{regions.length ? '✓' : '2'}</span><small>Questions</small></div>
            <div className={`workflow-step ${regions.length && viewMode === 'segment' && !segmentationApproved ? 'active' : segmentationApproved ? 'done' : ''}`}><span>{segmentationApproved ? '✓' : '3'}</span><small>Parts</small></div>
            <div className={`workflow-step ${viewMode === 'preview' ? 'active' : ''}`}><span>4</span><small>Layout</small></div>
            <div className="workflow-step"><span>5</span><small>Save</small></div>
          </nav>

          {viewMode === 'segment' ? (
            <>
              <section className="compact-section">
                <div className="section-kicker">Page preparation</div>
                <details className="compact-details">
                  <summary>
                    <span><strong>Clean pages</strong><small>Header {headerPct}% · Footer {footerPct}% · guides {showGuides ? 'on' : 'off'}</small></span>
                    <span className="summary-action">Edit</span>
                  </summary>
                  <div className="details-body">
                    <label>Header removed <strong>{headerPct}%</strong><input type="range" min="0" max="15" step="0.5" value={headerPct} onChange={(e) => setHeaderPct(Number(e.target.value))} /></label>
                    <label>Footer removed <strong>{footerPct}%</strong><input type="range" min="0" max="15" step="0.5" value={footerPct} onChange={(e) => setFooterPct(Number(e.target.value))} /></label>
                    <label className="check-row"><input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />Show removed regions</label>
                  </div>
                </details>
              </section>

              <section className="compact-section">
                <div className="section-kicker">Automatic first pass</div>
                <h2>Questions & parts</h2>
                <button className="detect-card" onClick={suggestRegions} disabled={!pages.length || loading}>
                  <span className="detect-icon">✦</span>
                  <span><strong>Detect questions & parts</strong><small>Find starts, ends and printed subparts automatically</small></span>
                </button>
                <div className="summary-metrics">
                  <div><strong>{regions.length}</strong><span>questions</span></div>
                  <div><strong>{counts.part}</strong><span>parts</span></div>
                  <div className={`review-metric ${liveApprovalIssues.length ? 'has-issues' : 'clear'}`}><strong>{liveApprovalIssues.length}</strong><span>{liveApprovalIssues.length === 1 ? 'issue' : 'issues'}</span></div>
                </div>
                <details className="compact-details manual-details">
                  <summary>
                    <span><strong>Add or adjust a boundary</strong><small>Manual controls and keyboard shortcuts</small></span>
                    <span className="summary-action">Manual</span>
                  </summary>
                  <div className="details-body">
                    <div className="line-mode-picker" role="group" aria-label="Line type">
                      <button className={`line-mode start-mode ${(heldLineMode || lineMode) === START ? 'active' : ''}`} onClick={() => setLineMode(START)}><span className="mode-swatch start-swatch" />Question start <kbd>S</kbd></button>
                      <button className={`line-mode end-mode ${(heldLineMode || lineMode) === END ? 'active' : ''}`} onClick={() => setLineMode(END)}><span className="mode-swatch end-swatch" />Question end <kbd>E</kbd></button>
                      <button className={`line-mode part-mode ${(heldLineMode || lineMode) === PART ? 'active' : ''}`} onClick={() => setLineMode(PART)}><span className="mode-swatch part-swatch" />Part <kbd>P</kbd></button>
                    </div>
                    <p className="small">Click a line, then use <strong>↑ / ↓</strong> for fine adjustment. Hold <strong>Shift</strong> for a larger nudge. Drag to move; double-click to remove.</p>
                    <div className="button-stack compact-buttons">
                      <button className="ghost" onClick={undoLastSuggestions} disabled={!lastSuggestionIds.length}>Undo detection</button>
                      <button className="ghost clear-button" onClick={clearLines} disabled={!lines.length}>Clear all</button>
                    </div>
                  </div>
                </details>
              </section>

              <section className="compact-section question-section">
                <div className="section-heading-row"><div><div className="section-kicker">Check the paper</div><h2>Questions</h2></div><span className={`question-count ${segmentationApproved ? 'complete' : liveApprovalIssues.length ? 'warn' : ''}`}>{regions.length}</span></div>
                {!regions.length && <p className="small">Questions will appear here after detection.</p>}
                {!!regions.length && liveApprovalIssues.length === 0 && !segmentationApproved && <p className="review-progress-copy">Edit as you go. When everything looks right, approve the whole paper once.</p>}
                {!!regions.length && segmentationApproved && <p className="review-progress-copy approval-ok">✓ Questions and parts approved</p>}
                <div className="region-list question-list">
                  {regions.map((region) => {
                    const partCount = region.segments.filter((segment) => segment.isPart !== false).length;
                    const hasIssue = issueRegionIds.has(region.id);
                    return (
                      <button key={region.id} className={`region-row ${selectedQuestionId === region.id ? 'selected' : ''}`} onClick={() => jumpToQuestion(region.id)}>
                        <span className="region-main"><span className={`qa-dot ${hasIssue ? 'warn' : 'ok'}`}>{hasIssue ? '!' : '✓'}</span><span className="region-name">{region.label}</span></span>
                        <span className={`region-status ${hasIssue ? 'warn' : 'ok'}`}>{hasIssue ? 'check' : `${partCount} part${partCount === 1 ? '' : 's'}`}</span>
                      </button>
                    );
                  })}
                </div>
                {selectedRegion && (
                  <div className="label-editor">
                    <label>Question label<input value={selectedRegion.start.label || selectedRegion.label} onChange={(e) => updateLineLabel(selectedRegion.start.id, e.target.value)} /></label>
                    <div className="segment-label-list">
                      {selectedRegion.segments.map((segment) => (
                        <button key={segment.id} type="button" className={`segment-label-row ${selectedSegmentId === segment.id ? 'selected' : ''} ${segment.isPart === false ? 'not-part' : ''}`} onClick={() => setSelectedSegmentId(segment.id)}>
                          <span>{segment.isPart === false ? 'Not a part' : segment.label}</span><small>{segment.isPart === false ? 'excluded' : (segment.labelEditedByUser ? 'edited' : (segment.detectedMarker ? 'detected' : 'check'))}</small>
                        </button>
                      ))}
                    </div>
                    {selectedRegion.segments.map((segment) => selectedSegmentId === segment.id && (
                      <div key={`edit-${segment.id}`} className="selected-segment-editor" data-segment-editor-id={segment.id}>
                        <label>Selected segment
                          <input value={segment.label} disabled={segment.isPart === false} onChange={(e) => updateSegmentLabel(segment.id, e.target.value)} />
                        </label>
                        {segment.isPart !== false && <p className={`label-evidence ${segment.detectedMarker ? 'detected' : 'uncertain'}`}>{segment.labelEditedByUser ? 'Manual label' : segment.labelEvidence}</p>}
                        <label className="check-row segment-part-toggle"><input type="checkbox" checked={segment.isPart !== false} onChange={(e) => updateSegmentPartFlag(segment.id, e.target.checked)} />Treat this region as a question part</label>
                        {segment.isPart === false && <p className="small">The content remains inside the whole-question crop, but this final region will not be tagged or exported as a question part.</p>}
                      </div>
                    ))}
                    {selectedSegmentId && segmentLabelOverrides[selectedSegmentId] && <button type="button" className="ghost full" onClick={() => { setSegmentLabelOverrides((current) => { const next = { ...current }; delete next[selectedSegmentId]; return next; }); setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]); }}>Use automatic label</button>}
                  </div>
                )}
              </section>

              <section className="compact-section review-cta-section">
                {!!regions.length && !segmentationApproved && <button className="primary full" onClick={approveSegmentation}>✓ Approve questions & parts</button>}
                {!!regions.length && segmentationApproved && <button className="approval-confirmed full" type="button" disabled>✓ Questions & parts approved</button>}
                {!!regions.length && liveApprovalIssues.length > 0 && (
                  <div className="approval-issues" role="alert">
                    <strong>{liveApprovalIssues.length} issue{liveApprovalIssues.length === 1 ? '' : 's'} to fix before approval</strong>
                    <ul>{liveApprovalIssues.slice(0, 5).map((issue, index) => <li key={`${issue.message}-${index}`}>{issue.message}</li>)}</ul>
                    {liveApprovalIssues.length > 5 && <small>+ {liveApprovalIssues.length - 5} more</small>}
                  </div>
                )}
                <button className={`${segmentationApproved ? 'primary' : 'ghost'} full`} onClick={enterPreview} disabled={!regions.length || !segmentationApproved}>Review page layout →</button>
              </section>
            </>
          ) : (
            <>
              <section className="compact-section"><button className="ghost full" onClick={() => setViewMode('segment')}>← Back to questions</button></section>
              <section className="compact-section"><h2>Questions</h2><div className="region-list preview-region-list">{regions.map((region) => <button key={region.id} className={`region-row ${selectedQuestionId === region.id ? 'selected' : ''}`} onClick={() => setSelectedQuestionId(region.id)}><span className="region-name">{region.label}</span><span className="region-status ok">approved</span></button>)}</div></section>
              <section className="compact-section"><button className="primary full" onClick={exportSegmentation} disabled={!segmentationApproved}>Save segmentation JSON</button><p className="small">Saves the approved source boundaries and reviewed page layout.</p></section>
            </>
          )}
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
                    onMoveLine={moveLine} onRemoveLine={removeLine} showGuides={showGuides} regions={regions} selectedLineId={selectedLineId} onSelectLine={setSelectedLineId}
                    selectedQuestionId={selectedQuestionId} selectedSegmentId={selectedSegmentId} onSelectSegment={selectSegmentForEditing} />
                ))}
              </div>
            </div>
          )}
          {!!pages.length && !loading && viewMode === 'preview' && (
            <PreviewWorkspace pages={pages} region={selectedRegion} headerPct={headerPct} footerPct={footerPct}
              savedBreaks={selectedRegion ? outputBreaks[selectedRegion.id] : []}
              savedExclusions={selectedRegion ? exclusions[selectedRegion.id] || [] : []}
              globalReviewTrim={globalReviewTrim}
              onGlobalReviewTrimChange={setGlobalReviewTrim}
              trimOverrides={selectedRegion ? trimOverrides[selectedRegion.id] || {} : {}}
              onBreaksChange={(breaks) => selectedRegion && setOutputBreaks((current) => ({ ...current, [selectedRegion.id]: breaks }))}
              onExclusionsChange={(ranges) => selectedRegion && setExclusions((current) => ({ ...current, [selectedRegion.id]: ranges }))}
              onTrimOverridesChange={(next) => selectedRegion && setTrimOverrides((current) => ({ ...current, [selectedRegion.id]: next }))} />
          )}
        </section>
      </main>
    </div>
  );
}

function PdfPage({ pageData, headerPct, footerPct, lines, lineMode, onAddLine, onMoveLine, onRemoveLine, showGuides, regions, selectedLineId, onSelectLine, selectedQuestionId, selectedSegmentId, onSelectSegment }) {
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
    if (line.kind === PART) return 'PART';
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
        {showGuides && <><div className="crop-guide top-guide" style={{ height: `${headerPct}%` }}><span>header removed</span></div><div className="crop-guide bottom-guide" style={{ height: `${footerPct}%` }}><span>footer removed</span></div></>}
        {regions.flatMap((region) => (region.segments || []).map((segment) => ({ region, segment }))).filter(({ segment }) => segment.start.page <= pageData.pageNumber && segment.end.page >= pageData.pageNumber).map(({ region, segment }) => {
          const topNorm = segment.start.page === pageData.pageNumber ? Math.max(segment.start.y, visibleTop) : visibleTop;
          const bottomNorm = segment.end.page === pageData.pageNumber ? Math.min(segment.end.y, visibleBottom) : visibleBottom;
          if (bottomNorm <= topNorm) return null;
          const topPct = ((topNorm - visibleTop) / visibleHeight) * 100;
          const heightPct = ((bottomNorm - topNorm) / visibleHeight) * 100;
          const selected = selectedQuestionId === region.id && selectedSegmentId === segment.id;
          return (
            <div key={`${region.id}-${segment.id}-${pageData.pageNumber}`} data-region-id={region.id} className={`segment-overlay ${selected ? 'selected' : ''} ${segment.isPart === false ? 'not-part' : ''}`} style={{ top: `${topPct}%`, height: `${heightPct}%` }}>
              <button type="button" className="segment-watermark" onClick={(e) => { e.stopPropagation(); onSelectSegment(region.id, segment.id); }} title="Click to edit this segment label">{segment.isPart === false ? 'NOT A PART' : segment.label}</button>
            </div>
          );
        })}
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

async function buildQuestionStrip(pages, region, headerPct, footerPct, globalReviewTrim = {}, trimOverrides = {}) {
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

    const trim = trimOverrides[pageData.pageNumber] || {};
    const topExtra = trim.topExtra ?? globalReviewTrim.topExtra ?? 0;
    const bottomExtra = trim.bottomExtra ?? globalReviewTrim.bottomExtra ?? 0;

    // Apply the same base header/footer cleanup used in the rolling-paper editor
    // before any question-specific or review-only trimming. Keeping this as a
    // distinct first crop prevents raw page furniture from reappearing in the
    // layout preview on continuation pages.
    const cleanTop = clamp((Number(headerPct) || 0) / 100 + topExtra, 0, 0.48);
    const cleanBottom = clamp(1 - (Number(footerPct) || 0) / 100 - bottomExtra, 0.52, 1);
    if (cleanBottom <= cleanTop) continue;

    const cleanSy = Math.floor(canvas.height * cleanTop);
    const cleanEy = Math.ceil(canvas.height * cleanBottom);
    const cleanHeight = Math.max(1, cleanEy - cleanSy);
    const cleanedPage = document.createElement('canvas');
    cleanedPage.width = canvas.width;
    cleanedPage.height = cleanHeight;
    cleanedPage.getContext('2d').drawImage(canvas, 0, cleanSy, canvas.width, cleanHeight, 0, 0, canvas.width, cleanHeight);

    let top = cleanTop;
    let bottom = cleanBottom;
    if (pageData.pageNumber === region.start.page) top = Math.max(top, region.start.y);
    if (pageData.pageNumber === region.end.page) bottom = Math.min(bottom, region.end.y);
    if (bottom <= top) continue;

    const cleanSpan = cleanBottom - cleanTop;
    const localTop = clamp((top - cleanTop) / cleanSpan, 0, 1);
    const localBottom = clamp((bottom - cleanTop) / cleanSpan, 0, 1);
    const sy = Math.floor(cleanedPage.height * localTop);
    const ey = Math.ceil(cleanedPage.height * localBottom);
    const sh = Math.max(1, ey - sy);
    const frag = document.createElement('canvas');
    frag.width = cleanedPage.width; frag.height = sh;
    frag.getContext('2d').drawImage(cleanedPage, 0, sy, cleanedPage.width, sh, 0, 0, cleanedPage.width, sh);
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
    const segment = region.segments?.find((candidate) => candidate.start.id === part.id);
    return { id: part.id, label: segment?.label || 'Part', fraction: round4((map.startY + local * map.height) / strip.height) };
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
    const widthScale = PAGE_CONTENT_WIDTH / strip.width;
    const heightScale = PAGE_CONTENT_HEIGHT / sourceHeight;
    const scale = Math.min(widthScale, heightScale);
    const drawWidth = strip.width * scale;
    const drawHeight = sourceHeight * scale;
    const x = Math.round((a4.width - drawWidth) / 2);
    ctx.drawImage(strip, 0, startY, strip.width, sourceHeight, x, 44, drawWidth, drawHeight);
    pages.push(a4.toDataURL('image/jpeg', 0.92));
  }
  return pages;
}


function normalizeExclusions(ranges) {
  const sorted = (ranges || []).map((range) => ({
    id: range.id || makeId('exclude'),
    start: clamp(Math.min(range.start, range.end), 0, 1),
    end: clamp(Math.max(range.start, range.end), 0, 1),
  })).filter((range) => range.end - range.start > 0.002).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 0.002) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function buildCompactedStrip(strip, exclusions) {
  const normalized = normalizeExclusions(exclusions);
  const totalRemoved = normalized.reduce((sum, range) => sum + (range.end - range.start), 0);
  const keptFraction = Math.max(0.001, 1 - totalRemoved);
  const out = document.createElement('canvas');
  out.width = strip.width;
  out.height = Math.max(1, Math.round(strip.height * keptFraction));
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);

  let sourceCursor = 0;
  let destY = 0;
  for (const range of normalized) {
    const startY = Math.round(range.start * strip.height);
    if (startY > sourceCursor) {
      const h = startY - sourceCursor;
      ctx.drawImage(strip, 0, sourceCursor, strip.width, h, 0, destY, strip.width, h);
      destY += h;
    }
    sourceCursor = Math.max(sourceCursor, Math.round(range.end * strip.height));
  }
  if (sourceCursor < strip.height) {
    const h = strip.height - sourceCursor;
    ctx.drawImage(strip, 0, sourceCursor, strip.width, h, 0, destY, strip.width, h);
  }

  function originalToCompacted(fraction) {
    let removedBefore = 0;
    for (const range of normalized) {
      if (fraction >= range.end) removedBefore += range.end - range.start;
      else if (fraction > range.start) removedBefore += fraction - range.start;
    }
    return clamp((fraction - removedBefore) / keptFraction, 0, 1);
  }

  function compactedToOriginal(fraction) {
    const targetKept = clamp(fraction, 0, 1) * keptFraction;
    let keptSeen = 0;
    let cursor = 0;
    for (const range of normalized) {
      const keptSpan = range.start - cursor;
      if (targetKept <= keptSeen + keptSpan) return clamp(cursor + (targetKept - keptSeen), 0, 1);
      keptSeen += keptSpan;
      cursor = range.end;
    }
    return clamp(cursor + (targetKept - keptSeen), 0, 1);
  }

  return { canvas: out, exclusions: normalized, originalToCompacted, compactedToOriginal };
}

function PreviewWorkspace({ pages, region, headerPct, footerPct, savedBreaks, onBreaksChange, savedExclusions, onExclusionsChange, globalReviewTrim, onGlobalReviewTrimChange, trimOverrides, onTrimOverridesChange }) {
  const [strip, setStrip] = useState(null);
  const [loading, setLoading] = useState(false);
  const [autoBreaks, setAutoBreaks] = useState([]);
  const [excludeMode, setExcludeMode] = useState(false);
  const [individualTrimMode, setIndividualTrimMode] = useState(false);

  useEffect(() => {
    function onKeyDown(event) {
      const tag = event.target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable) return;
      if (event.key.toLowerCase() === 'x') {
        setExcludeMode((value) => !value);
        event.preventDefault();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!region) { setStrip(null); return undefined; }
    setLoading(true);
    buildQuestionStrip(pages, region, headerPct, footerPct, globalReviewTrim, trimOverrides).then((result) => {
      if (cancelled) return;
      setStrip(result);
      if (!result) { setLoading(false); return; }
      const compacted = buildCompactedStrip(result.canvas, savedExclusions);
      const compactedParts = result.partFractions
        .filter((part) => !compacted.exclusions.some((range) => part.fraction > range.start && part.fraction < range.end))
        .map((part) => ({ ...part, fraction: compacted.originalToCompacted(part.fraction) }));
      const compactedAuto = automaticBreaks(compacted.canvas.width, compacted.canvas.height, compactedParts);
      const nextAuto = compactedAuto.map(compacted.compactedToOriginal);
      setAutoBreaks(nextAuto);
      if ((!savedBreaks || !savedBreaks.length)) onBreaksChange(nextAuto);
      setLoading(false);
    }).catch((error) => { console.error(error); if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [pages, region?.id, region?.start.page, region?.start.y, region?.end.page, region?.end.y, headerPct, footerPct, globalReviewTrim.topExtra, globalReviewTrim.bottomExtra, JSON.stringify(trimOverrides)]);

  if (!region) return <div className="preview-empty large">Select a question to review.</div>;
  if (loading || !strip) return <div className="loading-card">Building cleaned question preview…</div>;

  const compacted = buildCompactedStrip(strip.canvas, savedExclusions);
  const compactedBreaks = (savedBreaks || [])
    .filter((fraction) => !compacted.exclusions.some((range) => fraction > range.start && fraction < range.end))
    .map(compacted.originalToCompacted);
  const finalPages = makeFinalPages(compacted.canvas, compactedBreaks);
  const sourcePages = [];
  for (let page = region.start.page; page <= region.end.page; page += 1) sourcePages.push(page);

  function updateGlobalTrim(field, valuePct) {
    const value = clamp(Number(valuePct) / 100, 0, 0.12);
    onGlobalReviewTrimChange({ ...globalReviewTrim, [field]: value });
  }

  function updateTrim(page, field, valuePct) {
    const value = clamp(Number(valuePct) / 100, 0, 0.12);
    const inherited = {
      topExtra: trimOverrides[page]?.topExtra ?? globalReviewTrim.topExtra ?? 0,
      bottomExtra: trimOverrides[page]?.bottomExtra ?? globalReviewTrim.bottomExtra ?? 0,
    };
    onTrimOverridesChange({ ...trimOverrides, [page]: { ...inherited, [field]: value } });
  }

  function resetPageTrim(page) {
    const next = { ...trimOverrides };
    delete next[page];
    onTrimOverridesChange(next);
  }

  return (
    <div className="preview-review-workspace">
      <div className="preview-toolbar compact-preview-toolbar">
        <div className="preview-title-row">
          <div><p className="eyebrow">Layout</p><h2>{region.label}</h2></div>
          <p>Drag purple page breaks. Use <strong>X</strong> to remove unwanted blank space.</p>
        </div>
        <div className="preview-actions">
          <button className={`ghost compact ${excludeMode ? 'active-tool' : ''}`} onClick={() => setExcludeMode((value) => !value)}>Remove blank space <kbd>X</kbd></button>
          <button className="ghost compact" onClick={() => onBreaksChange(autoBreaks)}>Reset breaks</button>
        </div>
      </div>

      <details className="review-trim-card compact-trim-card">
        <summary>
          <span><strong>Page cleanup</strong><small>Header {headerPct}% · Footer {footerPct}% applied · extra top +{((globalReviewTrim.topExtra || 0) * 100).toFixed(1)}% · bottom +{((globalReviewTrim.bottomExtra || 0) * 100).toFixed(1)}%{individualTrimMode ? ' · individual pages' : ' · all pages'}</small></span>
          <span className="summary-action">Edit</span>
        </summary>
        <div className="compact-trim-body">
          <div className="trim-card-heading">
            <div><strong>{individualTrimMode ? 'Individual source-page trim' : 'Extra trim for all pages'}</strong><span>{individualTrimMode ? 'Use only when one source page needs a different crop.' : 'One adjustment is applied throughout the paper.'}</span></div>
            <button className="ghost compact" onClick={() => setIndividualTrimMode((value) => !value)}>{individualTrimMode ? 'Use same trim for all' : 'Adjust pages individually'}</button>
          </div>
          {!individualTrimMode ? (
            <div className="trim-page-grid">
              <div className="trim-page-row global-trim-row">
                <strong>All pages</strong>
                <label>extra top <input type="range" min="0" max="12" step="0.5" value={(globalReviewTrim.topExtra || 0) * 100} onChange={(e) => updateGlobalTrim('topExtra', e.target.value)} /><span>{((globalReviewTrim.topExtra || 0) * 100).toFixed(1)}%</span></label>
                <label>extra bottom <input type="range" min="0" max="12" step="0.5" value={(globalReviewTrim.bottomExtra || 0) * 100} onChange={(e) => updateGlobalTrim('bottomExtra', e.target.value)} /><span>{((globalReviewTrim.bottomExtra || 0) * 100).toFixed(1)}%</span></label>
              </div>
            </div>
          ) : (
            <div className="trim-page-grid">
              {sourcePages.map((page) => {
                const trim = trimOverrides[page] || {};
                const topValue = trim.topExtra ?? globalReviewTrim.topExtra ?? 0;
                const bottomValue = trim.bottomExtra ?? globalReviewTrim.bottomExtra ?? 0;
                const hasOverride = Boolean(trimOverrides[page]);
                return <div className="trim-page-row" key={page}>
                  <strong>Page {page}{hasOverride ? ' · custom' : ' · inherited'}</strong>
                  <label>extra top <input type="range" min="0" max="12" step="0.5" value={topValue * 100} onChange={(e) => updateTrim(page, 'topExtra', e.target.value)} /><span>{(topValue * 100).toFixed(1)}%</span></label>
                  <label>extra bottom <input type="range" min="0" max="12" step="0.5" value={bottomValue * 100} onChange={(e) => updateTrim(page, 'bottomExtra', e.target.value)} /><span>{(bottomValue * 100).toFixed(1)}%</span></label>
                  {hasOverride && <button className="ghost compact" onClick={() => resetPageTrim(page)}>Use all-pages trim</button>}
                </div>;
              })}
            </div>
          )}
        </div>
      </details>

      <div className="preview-grid">
        <div className="layout-editor-panel">
          <div className="panel-heading compact-panel-heading"><div><h3>Full question</h3><p>{excludeMode ? 'Drag across blank space; double-click a removed band to restore it.' : 'Purple = page breaks · Blue = part starts'}</p></div><span className="panel-note">{savedExclusions.length} removed</span></div>
          <StripBreakEditor strip={strip} breaks={savedBreaks || []} onBreaksChange={onBreaksChange} exclusions={savedExclusions} onExclusionsChange={onExclusionsChange} excludeMode={excludeMode} />
        </div>
        <div className="final-pages-panel">
          <div className="panel-heading compact-panel-heading"><div><h3>Worksheet pages</h3><p>{finalPages.length} A4 page{finalPages.length === 1 ? '' : 's'}</p></div></div>
          <div className="final-page-list">
            {finalPages.map((src, index) => <div className="preview-page-card" key={`${region.id}-${index}`}><span>Page {index + 1}</span><img src={src} alt={`${region.label} final page ${index + 1}`} /></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

function StripBreakEditor({ strip, breaks, onBreaksChange, exclusions, onExclusionsChange, excludeMode }) {
  const containerRef = useRef(null);
  const [draftExclude, setDraftExclude] = useState(null);

  function fractionFromEvent(event) {
    const rect = containerRef.current.getBoundingClientRect();
    return clamp((event.clientY - rect.top) / rect.height, 0, 1);
  }

  function updateBreak(index, event) {
    let fraction = clamp(fractionFromEvent(event), 0.02, 0.98);
    const normalizedExclusions = normalizeExclusions(exclusions);
    const inside = normalizedExclusions.find((range) => fraction > range.start && fraction < range.end);
    if (inside) fraction = Math.abs(fraction - inside.start) < Math.abs(inside.end - fraction) ? inside.start : inside.end;
    const nearestPart = strip.partFractions.reduce((best, part) => {
      const distance = Math.abs(part.fraction - fraction);
      return !best || distance < best.distance ? { distance, fraction: part.fraction } : best;
    }, null);
    if (nearestPart && nearestPart.distance < 0.018) fraction = nearestPart.fraction;
    const previous = index > 0 ? breaks[index - 1] : 0;
    const isLastBreak = index === breaks.length - 1;
    const next = isLastBreak ? 1 : breaks[index + 1];
    if (isLastBreak && fraction >= 0.985) {
      onBreaksChange(breaks.slice(0, -1));
      return;
    }
    fraction = clamp(fraction, previous + 0.025, isLastBreak ? 0.984 : next - 0.025);
    const nextBreaks = [...breaks];
    nextBreaks[index] = round4(fraction);
    onBreaksChange(nextBreaks.sort((a, b) => a - b));
  }

  function beginBreakDrag(event, index) {
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

  function beginExclude(event) {
    if (!excludeMode || event.target.closest('.page-break-line') || event.target.closest('.excluded-band')) return;
    event.preventDefault();
    const start = fractionFromEvent(event);
    setDraftExclude({ start, end: start });
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    target.setPointerCapture(pointerId);
    const move = (moveEvent) => setDraftExclude({ start, end: fractionFromEvent(moveEvent) });
    const up = (upEvent) => {
      const end = fractionFromEvent(upEvent);
      const low = Math.min(start, end); const high = Math.max(start, end);
      if (high - low > 0.006) onExclusionsChange(normalizeExclusions([...(exclusions || []), { id: makeId('exclude'), start: round4(low), end: round4(high) }]));
      setDraftExclude(null);
      try { target.releasePointerCapture(pointerId); } catch (_) {}
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
  }

  const draftTop = draftExclude ? Math.min(draftExclude.start, draftExclude.end) : 0;
  const draftHeight = draftExclude ? Math.abs(draftExclude.end - draftExclude.start) : 0;

  return (
    <div ref={containerRef} className={`strip-editor ${excludeMode ? 'exclude-mode' : ''}`} onPointerDown={beginExclude}>
      <img src={strip.dataUrl} alt="Continuous cleaned question" />
      {strip.partFractions.map((part) => <div key={part.id} className="preview-part-guide" style={{ top: `${part.fraction * 100}%` }}><span>{part.label}</span></div>)}
      {normalizeExclusions(exclusions).map((range, index) => (
        <div key={range.id || `exclude-${index}`} className="excluded-band" style={{ top: `${range.start * 100}%`, height: `${(range.end - range.start) * 100}%` }} onDoubleClick={(event) => { event.stopPropagation(); onExclusionsChange((exclusions || []).filter((item) => item.id !== range.id)); }} title="Excluded from final output. Double-click to restore.">
          <span>EXCLUDED · double-click to restore</span>
        </div>
      ))}
      {draftExclude && <div className="excluded-band draft" style={{ top: `${draftTop * 100}%`, height: `${draftHeight * 100}%` }}><span>Exclude this gap</span></div>}
      {breaks.map((fraction, index) => (
        <div key={`break-${index}`} className="page-break-line" style={{ top: `${fraction * 100}%` }} onPointerDown={(event) => beginBreakDrag(event, index)}>
          <span>PAGE {index + 1} END ↕</span>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
