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
const APP_VERSION = '0.9.3-whole-question';

const LOCAL_DRAFT_DB = 'prelim-cropper-local-v1';
const LOCAL_DRAFT_STORE = 'drafts';
const LOCAL_DRAFT_KEY = 'active-work';
const LOCAL_DRAFT_SOURCE_KEY = 'active-source';

function openDraftDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DRAFT_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_DRAFT_STORE)) db.createObjectStore(LOCAL_DRAFT_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readLocalDraft() {
  const db = await openDraftDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(LOCAL_DRAFT_STORE, 'readonly');
      const store = tx.objectStore(LOCAL_DRAFT_STORE);
      const draftRequest = store.get(LOCAL_DRAFT_KEY);
      const sourceRequest = store.get(LOCAL_DRAFT_SOURCE_KEY);
      tx.oncomplete = () => {
        const draft = draftRequest.result || null;
        const source = sourceRequest.result || null;
        if (!draft) { resolve(null); return; }
        resolve({ ...draft, fileBlob: source?.fileBlob || draft.fileBlob || null });
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function writeLocalDraft(draft) {
  const db = await openDraftDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LOCAL_DRAFT_STORE, 'readwrite');
      const store = tx.objectStore(LOCAL_DRAFT_STORE);
      const { fileBlob, ...lightweightDraft } = draft;
      store.put({ ...lightweightDraft, id: LOCAL_DRAFT_KEY });

      // Keep the large source PDF in a separate record and rewrite it only when
      // the actual source file changes. Frequent autosaves then update only the
      // lightweight boundary/layout state rather than copying the PDF blob.
      if (fileBlob) {
        const sourceSignature = `${draft.fileName || ''}|${fileBlob.size || 0}|${draft.fileLastModified || 0}`;
        const currentSource = store.get(LOCAL_DRAFT_SOURCE_KEY);
        currentSource.onsuccess = () => {
          if (currentSource.result?.sourceSignature !== sourceSignature) {
            store.put({
              id: LOCAL_DRAFT_SOURCE_KEY,
              sourceSignature,
              fileBlob,
              fileName: draft.fileName,
              fileType: draft.fileType,
              fileLastModified: draft.fileLastModified || 0,
            });
          }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function clearLocalDraft() {
  const db = await openDraftDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LOCAL_DRAFT_STORE, 'readwrite');
      const store = tx.objectStore(LOCAL_DRAFT_STORE);
      store.delete(LOCAL_DRAFT_KEY);
      store.delete(LOCAL_DRAFT_SOURCE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

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



function parseCompactSolutionMarker(text) {
  const cleaned = normalizePrintedMarkerText(text);
  if (!cleaned) return null;

  // Many mark schemes print compact codes such as 1ai, 1aii, 6biii or
  // slightly spaced variants such as "1 a ii". Treat these as authoritative
  // solution-part markers rather than trying to read them as question prose.
  const compact = cleaned.match(/^(?:Q\s*)?(\d{1,2})\s*([a-h])\s*([ivxlcdm]+)?(?=\s|[.)\]:;,\-]|$)/i);
  if (!compact) return null;

  const questionNumber = Number(compact[1]);
  const alpha = compact[2].toLowerCase();
  const roman = compact[3] ? compact[3].toLowerCase() : null;
  return {
    questionNumber,
    alpha,
    roman,
    raw: roman ? `Q${questionNumber}(${alpha})(${roman})` : `Q${questionNumber}(${alpha})`,
    printedText: cleaned,
    source: 'compact-solution-code',
  };
}

function isMcqAnswerKeyRow(text) {
  const cleaned = normalizePrintedMarkerText(text);
  if (!cleaned) return false;

  // Paper 1 schemes commonly begin with a dense answer-key table such as:
  // "1 D 6 A 11 A 16 C 21 D 26 C". Those cells are answers, not solution
  // starts or subparts. Ignore any row containing several number + option pairs.
  const pairs = [...cleaned.matchAll(/(?:^|\s)(\d{1,2})\s*([A-D])(?=\s|$)/gi)];
  if (pairs.length >= 3) return true;

  // PDF extraction can sometimes omit spacing around table cell boundaries.
  // A row with several question numbers and several standalone A-D options is
  // still overwhelmingly likely to be the collated MCQ answer table.
  const numbers = cleaned.match(/(?:^|\s)\d{1,2}(?=\s|$)/g) || [];
  const options = cleaned.match(/(?:^|\s)[A-D](?=\s|$)/gi) || [];
  return numbers.length >= 3 && options.length >= 3;
}

function authoritativeQuestionSegments(question) {
  const segments = (question?.segments || []).filter((segment) => segment.isPart !== false);
  return segments.filter((segment) => {
    const label = String(segment.label || '').trim();
    // A label such as "Q1 part 4" means the question cropper never found a
    // printed marker and the teacher did not correct it. Do not let that
    // unresolved placeholder become an authoritative expected solution part.
    const unresolvedPlaceholder = /^Q\d+\s+part\s+\d+$/i.test(label)
      && !segment.detectedMarker
      && !segment.labelEditedByUser;
    return !unresolvedPlaceholder;
  });
}


class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Prelim Cropper render error', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error?.message || String(this.state.error);
    return (
      <div className="fatal-error-screen">
        <div className="fatal-error-card">
          <p className="eyebrow">Prelim Cropper · recovery</p>
          <h1>The cropper hit an unexpected error</h1>
          <p>Your local autosave should still be available. Reload the page and choose <strong>Continue</strong> to recover the last saved state.</p>
          <details>
            <summary>Technical details</summary>
            <code>{message}</code>
          </details>
          <div className="fatal-error-actions">
            <button className="primary" type="button" onClick={() => window.location.reload()}>Reload cropper</button>
          </div>
        </div>
      </div>
    );
  }
}

function App() {
  const [file, setFile] = useState(null);
  const [pdf, setPdf] = useState(null);
  const [pages, setPages] = useState([]);
  const [headerPct, setHeaderPct] = useState(3);
  const [footerPct, setFooterPct] = useState(3);
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
  // Whole-question crops are the default; subpart boundaries remain available on demand.
  const [detailedQuestionIds, setDetailedQuestionIds] = useState([]);
  const [outputBreaks, setOutputBreaks] = useState({});
  const [exclusions, setExclusions] = useState({});
  const [trimOverrides, setTrimOverrides] = useState({});
  const [globalReviewTrim, setGlobalReviewTrim] = useState({ topExtra: 0, bottomExtra: 0 });
  const [segmentationApproved, setSegmentationApproved] = useState(false);
  const [segmentationApprovedAt, setSegmentationApprovedAt] = useState(null);
  const [approvalIssues, setApprovalIssues] = useState([]);
  const [scrollToSegmentEditorId, setScrollToSegmentEditorId] = useState(null);
  const [workflowKind, setWorkflowKind] = useState('questions');
  const [questionPayload, setQuestionPayload] = useState(null);
  const [solutionPayload, setSolutionPayload] = useState(null);
  const [solutionJsonSaved, setSolutionJsonSaved] = useState(false);
  const fileInputRef = useRef(null);
  const restoringDraftRef = useRef(false);
  const [resumeDraft, setResumeDraft] = useState(null);
  const [resumePromptOpen, setResumePromptOpen] = useState(false);
  const [lastLocalSaveAt, setLastLocalSaveAt] = useState(null);
  const [statusVisible, setStatusVisible] = useState(false);
  const [reviewedRegionIds, setReviewedRegionIds] = useState([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pendingMismatch, setPendingMismatch] = useState(null);
  const [awaitingSolutionPdf, setAwaitingSolutionPdf] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [downloadBaselineFingerprint, setDownloadBaselineFingerprint] = useState(null);
  const historyRef = useRef([]);
  const redoRef = useRef([]);
  const lastHistoryFingerprintRef = useRef(null);
  const applyingHistoryRef = useRef(false);
  const baselinePendingRef = useRef(false);
  const questionAuthorityRef = useRef(null);

  const editableSnapshot = useMemo(() => ({
    headerPct, footerPct, lines, segmentLabelOverrides, segmentPartFlags, outputBreaks,
    exclusions, trimOverrides, globalReviewTrim, segmentationApproved, segmentationApprovedAt,
  }), [headerPct, footerPct, lines, segmentLabelOverrides, segmentPartFlags, outputBreaks, exclusions, trimOverrides, globalReviewTrim, segmentationApproved, segmentationApprovedAt]);
  const currentEditFingerprint = useMemo(() => JSON.stringify(editableSnapshot), [editableSnapshot]);
  const jsonState = !file ? null : downloadBaselineFingerprint == null
    ? 'not-downloaded'
    : (downloadBaselineFingerprint === currentEditFingerprint ? 'up-to-date' : 'changed');

  useEffect(() => {
    if (questionPayload?.questions?.length) questionAuthorityRef.current = questionPayload;
  }, [questionPayload]);

  useEffect(() => () => {
    // Some restored/hot-reloaded states can temporarily hold a non-PDF value.
    // Never let cleanup crash the whole app just because destroy() is absent.
    if (pdf && typeof pdf.destroy === 'function') {
      Promise.resolve(pdf.destroy()).catch((error) => {
        console.warn('Could not destroy previous PDF document cleanly.', error);
      });
    }
  }, [pdf]);

  useEffect(() => {
    if (!status) return undefined;
    setStatusVisible(true);
    const isAlert = /cannot|could not|fix|missing|different|expected|failed|please/i.test(status);
    const timer = window.setTimeout(() => setStatusVisible(false), isAlert ? 7000 : 3800);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    readLocalDraft()
      .then((draft) => {
        if (cancelled || !draft?.fileBlob) return;
        setResumeDraft(draft);
        setResumePromptOpen(true);
      })
      .catch((error) => console.warn('Could not read local cropper draft.', error));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!file || !pages.length || loading || restoringDraftRef.current) return undefined;
    const timer = window.setTimeout(() => {
      saveWorkLocally().catch((error) => console.warn('Could not autosave local cropper draft.', error));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    file, pages.length, loading, workflowKind, headerPct, footerPct, lines, lineMode,
    showGuides, selectedQuestionId, selectedLineId, selectedSegmentId,
    segmentLabelOverrides, segmentPartFlags, lastSuggestionIds, viewMode, outputBreaks,
    exclusions, trimOverrides, globalReviewTrim, segmentationApproved,
    segmentationApprovedAt, approvalIssues, questionPayload, solutionPayload, solutionJsonSaved, reviewedRegionIds,
  ]);

  useEffect(() => {
    if (!file || !pages.length || loading || restoringDraftRef.current) return;
    const previous = lastHistoryFingerprintRef.current;
    if (applyingHistoryRef.current) {
      applyingHistoryRef.current = false;
      lastHistoryFingerprintRef.current = currentEditFingerprint;
      setHistoryVersion((value) => value + 1);
      return;
    }
    if (previous && previous !== currentEditFingerprint) {
      historyRef.current.push(JSON.parse(previous));
      if (historyRef.current.length > 50) historyRef.current.shift();
      redoRef.current = [];
      setHistoryVersion((value) => value + 1);
    }
    lastHistoryFingerprintRef.current = currentEditFingerprint;
  }, [currentEditFingerprint, file, pages.length, loading]);

  useEffect(() => {
    if (!baselinePendingRef.current || !file || !pages.length || loading) return;
    baselinePendingRef.current = false;
    setDownloadBaselineFingerprint(currentEditFingerprint);
  }, [currentEditFingerprint, file, pages.length, loading]);

  function applyEditableSnapshot(snapshot) {
    if (!snapshot) return;
    setHeaderPct(snapshot.headerPct ?? 3);
    setFooterPct(snapshot.footerPct ?? 3);
    setLines(Array.isArray(snapshot.lines) ? snapshot.lines : []);
    setSegmentLabelOverrides(snapshot.segmentLabelOverrides || {});
    setSegmentPartFlags(snapshot.segmentPartFlags || {});
    setOutputBreaks(snapshot.outputBreaks || {});
    setExclusions(snapshot.exclusions || {});
    setTrimOverrides(snapshot.trimOverrides || {});
    setGlobalReviewTrim(snapshot.globalReviewTrim || { topExtra: 0, bottomExtra: 0 });
    setSegmentationApproved(Boolean(snapshot.segmentationApproved));
    setSegmentationApprovedAt(snapshot.segmentationApprovedAt || null);
    setApprovalIssues([]);
  }

  function undoEdit() {
    if (!historyRef.current.length) return;
    const previous = historyRef.current.pop();
    redoRef.current.push(JSON.parse(currentEditFingerprint));
    applyingHistoryRef.current = true;
    applyEditableSnapshot(previous);
    setHistoryVersion((value) => value + 1);
    setStatus('Undid the last edit.');
  }

  function redoEdit() {
    if (!redoRef.current.length) return;
    const next = redoRef.current.pop();
    historyRef.current.push(JSON.parse(currentEditFingerprint));
    applyingHistoryRef.current = true;
    applyEditableSnapshot(next);
    setHistoryVersion((value) => value + 1);
    setStatus('Redid the edit.');
  }

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
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && !event.altKey && !isTypingTarget(event.target)) {
        const lower = event.key.toLowerCase();
        if (lower === 'z' && !event.shiftKey) { undoEdit(); event.preventDefault(); return; }
        if (lower === 'y' || (lower === 'z' && event.shiftKey)) { redoEdit(); event.preventDefault(); return; }
      }
      if (event.altKey || isTypingTarget(event.target)) return;
      if (event.key === 'Escape') {
        setSelectedLineId(null);
        setSelectedSegmentId(null);
        event.preventDefault();
        return;
      }
      if (viewMode !== 'segment') return;

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedLineId) {
        removeLine(selectedLineId);
        event.preventDefault();
        return;
      }

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

  async function openPdf(selected, kindOverride = workflowKind, restoreSnapshot = null, authorityOverride = null) {
    if (!selected) return;

    // Keep the currently mounted document intact while the replacement PDF is
    // being parsed. This avoids a half-switched React state where solution mode
    // is active but the new pages/authority do not exist yet.
    setLoading(true);
    setStatus(kindOverride === 'solutions' ? 'Loading solution PDF…' : 'Loading PDF…');

    try {
      const bytes = new Uint8Array(await selected.arrayBuffer());
      const loadingTask = pdfjsLib.getDocument({ data: bytes });
      const loadedPdf = await loadingTask.promise;
      const nextPages = [];
      for (let pageNumber = 1; pageNumber <= loadedPdf.numPages; pageNumber += 1) {
        const page = await loadedPdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.4 });
        const textContent = await page.getTextContent();
        nextPages.push({ pageNumber, page, viewport, textContent, rows: null });
      }
      nextPages.forEach((pageData) => { pageData.rows = extractTextRows(pageData); });

      // Only commit the new document after it has loaded successfully.
      historyRef.current = [];
      redoRef.current = [];
      lastHistoryFingerprintRef.current = null;
      setHistoryVersion((value) => value + 1);
      baselinePendingRef.current = Boolean(restoreSnapshot?._fromSegmentationJson);
      setDownloadBaselineFingerprint(restoreSnapshot?.downloadBaselineFingerprint || null);

      const nextKind = restoreSnapshot?.workflowKind || kindOverride || 'questions';
      const authority = authorityOverride || restoreSnapshot?.questionPayload || questionAuthorityRef.current || questionPayload || null;
      if (nextKind === 'solutions' && authority?.questions?.length) {
        questionAuthorityRef.current = authority;
        setQuestionPayload(authority);
      }

      setWorkflowKind(nextKind);
      setFile(selected);
      setPdf(loadedPdf);
      setPages(nextPages);
      setLines([]);
      setLastSuggestionIds([]);
      setSelectedQuestionId(null);
      setSelectedLineId(null);
      setSelectedSegmentId(null);
      setOutputBreaks({});
      setExclusions({});
      setTrimOverrides({});
      setSegmentationApproved(false);
      setSegmentationApprovedAt(null);
      setApprovalIssues([]);
      if (!restoreSnapshot) setSolutionJsonSaved(false);
      setViewMode('segment');
      setReviewedRegionIds([]);

      if (restoreSnapshot) {
        setWorkflowKind(restoreSnapshot.workflowKind || kindOverride || 'questions');
        setHeaderPct(Number.isFinite(restoreSnapshot.headerPct) ? restoreSnapshot.headerPct : 3);
        setFooterPct(Number.isFinite(restoreSnapshot.footerPct) ? restoreSnapshot.footerPct : 3);
        setLines(Array.isArray(restoreSnapshot.lines) ? restoreSnapshot.lines : []);
        setLineMode(restoreSnapshot.lineMode || START);
        setShowGuides(restoreSnapshot.showGuides !== false);
        setSelectedQuestionId(restoreSnapshot.selectedQuestionId || null);
        setSelectedLineId(restoreSnapshot.selectedLineId || null);
        setSelectedSegmentId(restoreSnapshot.selectedSegmentId || null);
        setSegmentLabelOverrides(restoreSnapshot.segmentLabelOverrides || {});
        setSegmentPartFlags(restoreSnapshot.segmentPartFlags || {});
        setLastSuggestionIds(Array.isArray(restoreSnapshot.lastSuggestionIds) ? restoreSnapshot.lastSuggestionIds : []);
        setViewMode(restoreSnapshot.viewMode === 'preview' ? 'preview' : 'segment');
        setOutputBreaks(restoreSnapshot.outputBreaks || {});
        setExclusions(restoreSnapshot.exclusions || {});
        setTrimOverrides(restoreSnapshot.trimOverrides || {});
        setGlobalReviewTrim(restoreSnapshot.globalReviewTrim || { topExtra: 0, bottomExtra: 0 });
        setSegmentationApproved(Boolean(restoreSnapshot.segmentationApproved));
        setSegmentationApprovedAt(restoreSnapshot.segmentationApprovedAt || null);
        setApprovalIssues(Array.isArray(restoreSnapshot.approvalIssues) ? restoreSnapshot.approvalIssues : []);
        if (restoreSnapshot.questionPayload?.questions?.length) {
          questionAuthorityRef.current = restoreSnapshot.questionPayload;
          setQuestionPayload(restoreSnapshot.questionPayload);
        } else if (nextKind !== 'solutions') {
          setQuestionPayload(null);
        }
        setSolutionPayload(restoreSnapshot.solutionPayload || null);
        setSolutionJsonSaved(Boolean(restoreSnapshot.solutionJsonSaved));
        setReviewedRegionIds(Array.isArray(restoreSnapshot.reviewedRegionIds) ? restoreSnapshot.reviewedRegionIds : []);
        setLastLocalSaveAt(restoreSnapshot.savedAt || null);
        setStatus(`Restored local work from ${new Date(restoreSnapshot.savedAt || Date.now()).toLocaleString()}. Continue from where you left off.`);
      } else {
        // Fresh solution documents must retain their question authority. Fresh
        // question documents intentionally start with no previous payload.
        if (nextKind !== 'solutions') {
          questionAuthorityRef.current = null;
          setQuestionPayload(null);
        }
        setSolutionPayload(null);
        setStatus(nextKind === 'solutions'
          ? `${loadedPdf.numPages} solution pages loaded. Detect solution blocks, then reconcile them against the approved question list.`
          : `${loadedPdf.numPages} pages loaded. Detect questions & parts, then scan the proposed starts, ends and part lines.`);
      }
    } catch (error) {
      console.error('Could not open PDF', error);
      setStatus(`Could not open this ${kindOverride === 'solutions' ? 'solution ' : ''}PDF. The current work has been kept. Please try another file.`);
    } finally {
      setLoading(false);
    }
  }


  function buildLocalDraftSnapshot() {
    if (!file || !pages.length) return null;
    return {
      savedAt: new Date().toISOString(),
      fileBlob: file,
      fileName: file.name,
      fileType: file.type || 'application/pdf',
      fileLastModified: file.lastModified || 0,
      workflowKind,
      headerPct,
      footerPct,
      lines,
      lineMode,
      showGuides,
      selectedQuestionId,
      selectedLineId,
      selectedSegmentId,
      segmentLabelOverrides,
      segmentPartFlags,
      lastSuggestionIds,
      viewMode,
      outputBreaks,
      exclusions,
      trimOverrides,
      globalReviewTrim,
      segmentationApproved,
      segmentationApprovedAt,
      approvalIssues,
      questionPayload,
      solutionPayload,
      solutionJsonSaved,
      reviewedRegionIds,
      downloadBaselineFingerprint,
    };
  }

  async function saveWorkLocally() {
    const snapshot = buildLocalDraftSnapshot();
    if (!snapshot) return;
    await writeLocalDraft(snapshot);
    setLastLocalSaveAt(snapshot.savedAt);
    setResumeDraft(snapshot);
  }

  async function resumeSavedWork() {
    if (!resumeDraft?.fileBlob) return;
    setResumePromptOpen(false);
    restoringDraftRef.current = true;
    try {
      const sourceBlob = resumeDraft.fileBlob;
      const restoredFile = sourceBlob instanceof File
        ? sourceBlob
        : new File([sourceBlob], resumeDraft.fileName || 'restored-paper.pdf', { type: resumeDraft.fileType || 'application/pdf' });
      await openPdf(restoredFile, resumeDraft.workflowKind || 'questions', resumeDraft);
    } catch (error) {
      console.error(error);
      setStatus('The locally saved session could not be restored. You can discard it and start again.');
      setResumePromptOpen(true);
    } finally {
      restoringDraftRef.current = false;
    }
  }

  async function discardSavedWork() {
    try {
      await clearLocalDraft();
    } catch (error) {
      console.warn('Could not clear local cropper draft.', error);
    }
    setResumeDraft(null);
    setResumePromptOpen(false);
    setLastLocalSaveAt(null);
    setStatus('Choose a PDF to begin.');
  }

  async function parseSegmentationJson(selected) {
    const text = await selected.text();
    const payload = JSON.parse(text);
    const questions = Array.isArray(payload?.questions) ? payload.questions : [];
    const documentType = payload?.documentType;
    const isQuestionJson = documentType === 'question-segmentation' || (payload?.schemaVersion === 4 && documentType !== 'solution-segmentation');
    const isSolutionJson = documentType === 'solution-segmentation';
    if ((!isQuestionJson && !isSolutionJson) || !questions.length) throw new Error('not-segmentation-json');
    return { payload, kind: isSolutionJson ? 'solutions' : 'questions' };
  }

  function normaliseSourceName(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/\\/g, '/')
      .split('/').pop()
      .replace(/\s+/g, ' ');
  }

  function pdfMatchesSegmentationSource(pdfFile, payload) {
    const pdfName = normaliseSourceName(pdfFile?.name);
    const sourceName = normaliseSourceName(payload?.sourceFile);
    return Boolean(pdfName && sourceName && pdfName === sourceName);
  }

  function snapshotFromSegmentationPayload(payload, kind) {
    const importedLines = (payload?.lines || []).map((line) => ({
      id: makeId(line.type || START),
      page: Number(line.page),
      y: Number(line.yFractionFromTop),
      kind: line.type,
      label: line.label || '',
      manualLabel: Boolean(line.labelEditedByUser),
      source: line.source || 'imported-json',
    })).filter((line) => Number.isFinite(line.page) && Number.isFinite(line.y) && [START, END, PART].includes(line.kind));

    const lineAt = (page, y, kinds) => importedLines.find((line) =>
      kinds.includes(line.kind)
      && line.page === Number(page)
      && Math.abs(line.y - Number(y)) < 0.0025
    );

    const segmentLabelOverrides = {};
    const segmentPartFlags = {};
    const outputBreaks = {};
    const exclusions = {};
    const trimOverrides = {};

    for (const question of payload?.questions || []) {
      const startLine = lineAt(question?.start?.page, question?.start?.yFractionFromTop, [START]);
      if (!startLine) continue;
      const regionId = startLine.id;
      outputBreaks[regionId] = Array.isArray(question.outputPageBreakFractions) ? question.outputPageBreakFractions : [];
      exclusions[regionId] = Array.isArray(question.excludedOutputRanges || question.outputCrop?.excludedRanges)
        ? (question.excludedOutputRanges || question.outputCrop.excludedRanges).map((range) => ({
            id: range.id || makeId('exclude'),
            start: Number.isFinite(Number(range.start)) ? Number(range.start) : Number(range.startFraction),
            end: Number.isFinite(Number(range.end)) ? Number(range.end) : Number(range.endFraction),
          })).filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
        : [];
      const perPageTrim = {};
      for (const trim of question.pageTrimOverrides || []) {
        perPageTrim[Number(trim.page)] = {
          topExtra: Number(trim.extraTopFraction || 0),
          bottomExtra: Number(trim.extraBottomFraction || 0),
        };
      }
      trimOverrides[regionId] = perPageTrim;

      for (const segment of question.segments || []) {
        const boundary = lineAt(segment?.start?.page, segment?.start?.yFractionFromTop, [START, PART]);
        if (!boundary) continue;
        if (segment.label) segmentLabelOverrides[boundary.id] = segment.label;
        if (segment.isPart === false) segmentPartFlags[boundary.id] = false;
      }
    }

    let questionAuthority = null;
    let solutionPayloadForSnapshot = null;
    if (kind === 'solutions') {
      // A saved solution JSON may be reopened without its original question JSON.
      // Reconstruct the minimum parent/part authority needed for editing from the
      // saved solution itself; the existing labels remain visible and editable.
      questionAuthority = {
        schemaVersion: 4,
        documentType: 'question-segmentation',
        sourceFile: payload?.sourceQuestionFile || null,
        questions: (payload?.questions || []).map((question, index) => ({
          label: question.questionRef || question.label || payload?.expectedQuestionLabels?.[index] || `Q${index + 1}`,
          segments: (question.segments || []).filter((segment) => segment.isPart !== false).map((segment) => ({
            label: segment.label,
            detectedMarker: segment.detectedMarker || null,
            labelEditedByUser: Boolean(segment.labelEditedByUser),
            isPart: segment.isPart !== false,
          })),
        })),
      };
      solutionPayloadForSnapshot = payload;
    }

    return {
      workflowKind: kind,
      headerPct: Number.isFinite(Number(payload?.headerFraction)) ? Number(payload.headerFraction) * 100 : 3,
      footerPct: Number.isFinite(Number(payload?.footerFraction)) ? Number(payload.footerFraction) * 100 : 3,
      lines: importedLines.sort(comparePos),
      lineMode: START,
      showGuides: true,
      selectedQuestionId: importedLines.find((line) => line.kind === START)?.id || null,
      selectedLineId: null,
      selectedSegmentId: null,
      segmentLabelOverrides,
      segmentPartFlags,
      lastSuggestionIds: [],
      viewMode: 'segment',
      outputBreaks,
      exclusions,
      trimOverrides,
      globalReviewTrim: {
        topExtra: Number(payload?.globalReviewTrim?.extraTopFraction || 0),
        bottomExtra: Number(payload?.globalReviewTrim?.extraBottomFraction || 0),
      },
      // Imported JSON is deliberately reopened for review/editing. Require one
      // fresh approval before the revised JSON is saved.
      segmentationApproved: false,
      segmentationApprovedAt: null,
      approvalIssues: [],
      questionPayload: questionAuthority,
      solutionPayload: solutionPayloadForSnapshot,
      solutionJsonSaved: false,
      reviewedRegionIds: [],
      _fromSegmentationJson: true,
      savedAt: new Date().toISOString(),
    };
  }

  async function parseQuestionJson(selected) {
    const parsed = await parseSegmentationJson(selected);
    if (parsed.kind !== 'questions') throw new Error('not-question-segmentation');
    return parsed.payload;
  }

  function resetForSolutionIntake(payload) {
    setAwaitingSolutionPdf(false);
    const questions = Array.isArray(payload?.questions) ? payload.questions : [];
    questionAuthorityRef.current = payload;
    setQuestionPayload(payload);
    setSolutionPayload(null);
    setWorkflowKind('solutions');
    setFile(null);
    setPdf(null);
    setPages([]);
    setLines([]);
    setLastSuggestionIds([]);
    setSelectedQuestionId(null);
    setSelectedLineId(null);
    setSelectedSegmentId(null);
    setOutputBreaks({});
    setExclusions({});
    setTrimOverrides({});
    setGlobalReviewTrim({ topExtra: 0, bottomExtra: 0 });
    setSegmentationApproved(false);
    setSegmentationApprovedAt(null);
    setApprovalIssues([]);
    setViewMode('segment');
    setReviewedRegionIds([]);
    return questions.length;
  }

  async function handleIntakeFiles(fileList) {
    const selected = Array.from(fileList || []).filter(Boolean);
    if (!selected.length) return;

    const pdfFiles = selected.filter((item) => item.type === 'application/pdf' || /\.pdf$/i.test(item.name));
    const jsonFiles = selected.filter((item) => item.type === 'application/json' || /\.json$/i.test(item.name));

    try {
      // When the teacher has just chosen “Continue with solutions”, keep the
      // completed question paper on screen until a solution PDF is actually
      // selected. This avoids tearing down the current PDF and prevents the
      // transient blank-screen state that could occur during the hand-off.
      if (awaitingSolutionPdf && (questionPayload || questionAuthorityRef.current) && selected.length === 1 && pdfFiles.length === 1) {
        const authority = questionPayload || questionAuthorityRef.current;
        setAwaitingSolutionPdf(false);
        setSolutionPayload(null);
        setSolutionJsonSaved(false);
        await openPdf(pdfFiles[0], 'solutions', null, authority);
        return;
      }

      // Normal start: one paper PDF means a new question-paper crop.
      if (selected.length === 1 && pdfFiles.length === 1) {
        if (workflowKind === 'solutions' && solutionPayload?.documentType === 'solution-segmentation') {
          const snapshot = snapshotFromSegmentationPayload(solutionPayload, 'solutions');
          await openPdf(pdfFiles[0], 'solutions', snapshot);
          setStatus('Solution boundaries loaded from the saved JSON. Adjust them as needed, approve again, then save a revised solution JSON.');
        } else if (workflowKind === 'solutions' && questionPayload) {
          await openPdf(pdfFiles[0], 'solutions', null, questionPayload || questionAuthorityRef.current);
        } else {
          setWorkflowKind('questions');
          setQuestionPayload(null);
          setSolutionPayload(null);
          await openPdf(pdfFiles[0], 'questions');
        }
        return;
      }

      // PDF + segmentation JSON can mean either "reopen this exact document for
      // boundary edits" or "question JSON + a different PDF = continue with
      // solutions". Use document type plus source filename to decide.
      if (selected.length === 2 && pdfFiles.length === 1 && jsonFiles.length === 1) {
        setAwaitingSolutionPdf(false);
        const parsed = await parseSegmentationJson(jsonFiles[0]);
        const payload = parsed.payload;
        const sourceMatches = pdfMatchesSegmentationSource(pdfFiles[0], payload);

        if (parsed.kind === 'solutions') {
          if (!sourceMatches) {
            setPendingMismatch({ kind: 'solutions', pdfFile: pdfFiles[0], payload });
            setStatus('The solution PDF filename does not match the source recorded in this JSON. Confirm the pairing before continuing.');
            return;
          }
          const snapshot = snapshotFromSegmentationPayload(payload, 'solutions');
          setStatus('Solution JSON recognised. Reopening its saved boundaries for adjustment…');
          await openPdf(pdfFiles[0], 'solutions', snapshot);
          setStatus('Solution boundaries and excluded crop regions restored from JSON. Check Layout > Output preview, approve again, then save the revised solution JSON.');
          return;
        }

        if (sourceMatches) {
          const snapshot = snapshotFromSegmentationPayload(payload, 'questions');
          setQuestionPayload(null);
          setSolutionPayload(null);
          setStatus('Question JSON matches this question paper. Reopening its saved boundaries for adjustment…');
          await openPdf(pdfFiles[0], 'questions', snapshot);
          setStatus('Question boundaries and excluded crop regions restored from JSON. Check Layout > Output preview, approve again, then save the revised question JSON.');
          return;
        }

        // A different filename is usually the normal continuation into solutions,
        // but it can also be a renamed copy of the original question paper. Ask
        // rather than silently guessing.
        setPendingMismatch({ kind: 'question-or-solution', pdfFile: pdfFiles[0], payload });
        setStatus('The PDF filename differs from the source recorded in the question JSON. Choose whether this is the solution file or a renamed question paper.');
        return;
      }

      // JSON-only intake remains useful when the second file is not yet ready.
      // Question JSON waits for a solution PDF; solution JSON waits for its own
      // solution PDF so the saved solution boundaries can be reopened.
      if (selected.length === 1 && jsonFiles.length === 1) {
        setAwaitingSolutionPdf(false);
        const parsed = await parseSegmentationJson(jsonFiles[0]);
        if (parsed.kind === 'solutions') {
          setSolutionPayload(parsed.payload);
          setQuestionPayload(null);
          setWorkflowKind('solutions');
          setFile(null); setPdf(null); setPages([]); setLines([]);
          setStatus('Solution JSON loaded. Now choose its matching solution PDF to reopen the saved boundaries.');
        } else {
          const count = resetForSolutionIntake(parsed.payload);
          setStatus(`Question JSON loaded. Choose the matching solution PDF; ${count} parent questions will be reconciled against it.`);
        }
        return;
      }

      setStatus('Choose one PDF to start fresh, or pair a PDF with its saved segmentation JSON to reopen existing boundaries. A question JSON paired with a different PDF continues into solution cropping.');
    } catch (error) {
      console.error(error);
      setStatus('Could not recognise that intake. Use one PDF to start fresh, or upload a PDF together with its saved question/solution segmentation JSON.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function resolvePendingMismatch(action) {
    const pending = pendingMismatch;
    if (!pending) return;
    setPendingMismatch(null);
    if (action === 'cancel') { setStatus('Choose the correct file pair when ready.'); return; }
    if (pending.kind === 'solutions') {
      const snapshot = snapshotFromSegmentationPayload(pending.payload, 'solutions');
      await openPdf(pending.pdfFile, 'solutions', snapshot);
      setStatus('Opened the solution despite the filename mismatch. Verify the first and last boundaries carefully before approval.');
      return;
    }
    if (action === 'reopen-question') {
      const snapshot = snapshotFromSegmentationPayload(pending.payload, 'questions');
      await openPdf(pending.pdfFile, 'questions', snapshot);
      setStatus('Opened the PDF as a renamed question paper. Verify that the saved boundaries align before approval.');
      return;
    }
    // Keep the current document intact until the mismatched solution PDF has
    // successfully loaded. This route must be just as atomic as the normal
    // “Continue with solutions” hand-off.
    const count = Array.isArray(pending.payload?.questions) ? pending.payload.questions.length : 0;
    questionAuthorityRef.current = pending.payload;
    setQuestionPayload(pending.payload);
    setAwaitingSolutionPdf(false);
    setSolutionPayload(null);
    setSolutionJsonSaved(false);
    await openPdf(pending.pdfFile, 'solutions', null, pending.payload);
    setStatus(`Loaded the PDF as the solution and will reconcile it against ${count} parent questions.`);
  }

  function safeY(yNorm) {
    return round4(clamp(yNorm, headerPct / 100 + 0.004, 1 - footerPct / 100 - 0.004));
  }

  function addLine(page, y, kind = lineMode) {
    if (kind === PART && !detailedQuestionIds.includes(selectedQuestionId)) return;
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
    setStatus('Boundary removed.');
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
        if (workflowKind === 'solutions' && isMcqAnswerKeyRow(row.text)) continue;
        const match = workflowKind === 'solutions'
          ? row.text.match(/^(?:Q\s*)?(\d{1,2})(?=\s|\(|[.)]|[a-h](?:[ivxlcdm]+)?\b)/i)
          : row.text.match(/^(?:Q\s*)?(\d{1,2})(?=\s|\(|[.)])/i);
        if (!match) continue;
        starts.push({
          page: pageData.pageNumber,
          y: round4(Math.max(top + 0.004, row.yNorm - 0.014)),
          label: `Q${match[1]}`,
          number: Number(match[1]),
        });
      }
    }
    const ordered = starts.sort(comparePos);
    if (workflowKind === 'solutions') {
      const seen = new Set();
      return ordered.filter((candidate) => {
        if (seen.has(candidate.number)) return false;
        seen.add(candidate.number);
        return true;
      });
    }
    return ordered.filter((candidate, idx, arr) => {
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
        if (workflowKind === 'solutions' && isMcqAnswerKeyRow(row.text)) continue;
        const marker = workflowKind === 'solutions'
          ? (parseCompactSolutionMarker(row.text) || parseLeadingPartMarker(row.text))
          : parseLeadingPartMarker(row.text);
        if (!marker) continue;
        parts.push({
          page: pageData.pageNumber,
          y: round4(Math.max(top + 0.004, row.yNorm - 0.014)),
          raw: marker.raw,
          printedText: marker.printedText,
          questionNumber: marker.questionNumber ?? null,
          alpha: marker.alpha ?? null,
          roman: marker.roman ?? null,
          markerSource: marker.source || 'printed',
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
        if (!/\[?\s*Total\s*[:=]\s*\d+(?:\s*marks?)?\s*\]?/i.test(row.text)) continue;
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
    const autoNotPartIds = [];
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

      const detectedLabel = `Q${start.number}`;
      const authoritativeMatch = workflowKind === 'solutions'
        ? questionPayload?.questions?.find((question) => question.label === detectedLabel)?.label
        : null;
      const authoritativeLabel = authoritativeMatch || start.label;
      candidates.push({ id: makeId(START), page: start.page, y: start.y, kind: START, label: authoritativeLabel, manualLabel: false, source: 'suggested', questionIndex: index });
      candidates.push({ id: makeId(END), page: end.page, y: safeY(end.y), kind: END, label: '', manualLabel: false, source: 'suggested', questionIndex: index });

      const questionPartStarts = rawParts.filter((part) => {
        if (!within(part, start, end) || Math.abs(posKey(part) - posKey(start)) <= 180) return false;
        if (workflowKind === 'solutions' && Number.isInteger(part.questionNumber)) {
          return part.questionNumber === start.number;
        }
        return true;
      });

      // In solution mode compact scheme codes such as 1ai, 1aii and 1b are
      // themselves the part starts. The first one belongs at the parent START;
      // every later one therefore becomes a blue PART boundary. For ordinary
      // question papers retain the previous behaviour.
      const partBoundaryCandidates = workflowKind === 'solutions'
        // The parent START already sits on the first compact code (for example
        // 1ai), and the near-start filter above removes that same marker. Every
        // remaining compact marker is therefore a genuine next solution part.
        ? questionPartStarts
        : questionPartStarts.slice(1);

      const createdPartLines = partBoundaryCandidates.map((part) => ({
        id: makeId(PART), page: part.page, y: part.y, kind: PART,
        label: '', manualLabel: false, source: 'suggested', questionIndex: index,
      }));
      candidates.push(...createdPartLines);

      // Exam papers often print a final "[Total: n]" line below the last
      // actual part. If automatic detection has created a trailing PART region
      // whose only printable content is that total-marks line, keep the region
      // for whole-question cropping but classify it as "Not a part".
      if (createdPartLines.length) {
        const trailingStart = createdPartLines[createdPartLines.length - 1];
        const trailingRows = [];
        for (const pageData of pages) {
          if (pageData.pageNumber < trailingStart.page || pageData.pageNumber > end.page) continue;
          const top = headerPct / 100;
          const bottom = 1 - footerPct / 100;
          for (const row of pageData.rows || []) {
            if (row.yNorm <= top || row.yNorm >= bottom) continue;
            const pos = { page: pageData.pageNumber, y: row.yNorm };
            if (comparePos(pos, trailingStart) >= 0 && comparePos(pos, end) < 0) trailingRows.push(String(row.text || '').trim());
          }
        }
        const visibleRows = trailingRows.filter(Boolean);
        const hasTotal = visibleRows.some((text) => /\[?\s*Total\s*[:=]\s*\d+(?:\s*marks?)?\s*\]?/i.test(text));
        const substantiveRows = visibleRows.filter((text) => !/^\[?\s*Total\s*[:=]\s*\d+(?:\s*marks?)?\s*\]?$/i.test(text));
        if (hasTotal && substantiveRows.length === 0) autoNotPartIds.push(trailingStart.id);
      }
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
      if (autoNotPartIds.length) {
        setSegmentPartFlags((flags) => {
          const next = { ...flags };
          autoNotPartIds.forEach((id) => { if (!(id in next)) next[id] = false; });
          return next;
        });
      }
      setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]);
      const firstSuggestedStart = additions.find((line) => line.kind === START);
      if (firstSuggestedStart && !selectedQuestionId) setSelectedQuestionId(firstSuggestedStart.id);
      return merged;
    });
  }

  // Keep detected PART lines in memory, but do not use them in whole-question mode.
  // This preserves existing edits while avoiding compulsory part-by-part review.
  const activeLines = useMemo(() => {
    const starts = lines.filter((line) => line.kind === START).sort(comparePos);
    return lines.filter((line) => {
      if (line.kind !== PART) return true;
      const owner = starts.find((start, index) =>
        comparePos(line, start) > 0 && (!starts[index + 1] || comparePos(line, starts[index + 1]) < 0));
      return Boolean(owner && detailedQuestionIds.includes(owner.id));
    });
  }, [lines, detailedQuestionIds]);

  const regions = useMemo(() => {
    const ordered = [...activeLines].sort(comparePos);
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
      const expectedQuestion = workflowKind === 'solutions' ? questionPayload?.questions?.[index] : null;
      const fallbackLabel = expectedQuestion?.label || start.label || `Q${index + 1}`;
      const expectedPartLabels = workflowKind === 'solutions'
        ? authoritativeQuestionSegments(expectedQuestion).map((segment) => segment.label).filter(Boolean)
        : [];
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

        if (workflowKind === 'solutions') {
          if (expectedPartLabels[segmentIndex]) {
            inferred = expectedPartLabels[segmentIndex];
            evidence = `Matched by position to ${expectedPartLabels[segmentIndex]} from the approved question JSON`;
          } else if (!parts.length && expectedPartLabels.length === 0) {
            inferred = fallbackLabel;
            evidence = `Matched to ${fallbackLabel} from the approved question JSON`;
          } else {
            inferred = `${fallbackLabel} solution block ${segmentIndex + 1}`;
            evidence = 'No corresponding question-part label at this position; check the solution boundaries';
          }
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
  }, [activeLines, footerPct, pages, segmentLabelOverrides, segmentPartFlags, workflowKind, questionPayload]);

  useEffect(() => {
    if (!regions.length) { setSelectedQuestionId(null); return; }
    if (!regions.some((region) => region.id === selectedQuestionId)) setSelectedQuestionId(regions[0].id);
  }, [regions, selectedQuestionId]);

  useEffect(() => {
    if (workflowKind === 'solutions') setSolutionPayload(null);
    else setQuestionPayload(null);
    if (!segmentationApproved) return;
    setSegmentationApproved(false);
    setSegmentationApprovedAt(null);
    setApprovalIssues([]);
  }, [lines, headerPct, footerPct, segmentLabelOverrides, segmentPartFlags]);

  function buildSegmentationPayload(documentKind = workflowKind, approvalOverride = null) {
    if (!file || !pages.length) return null;
    const isSolution = documentKind === 'solutions';
    return {
      schemaVersion: isSolution ? 1 : 4,
      documentType: isSolution ? 'solution-segmentation' : 'question-segmentation',
      sourceFile: file.name,
      sourceQuestionFile: isSolution ? (questionPayload?.sourceFile || null) : undefined,
      createdAt: new Date().toISOString(),
      headerFraction: round4(headerPct / 100),
      footerFraction: round4(footerPct / 100),
      pageCount: pages.length,
      expectedQuestionLabels: isSolution ? (questionPayload?.questions || []).map((question) => question.label) : undefined,
      cropInstructions: {
        appliesTo: isSolution ? 'solutions' : 'questions',
        requiredForQuestionBank: true,
        coordinateSystem: 'fractions of the full cleaned question strip, before exclusions and output page breaks',
        order: ['crop source question using start/end', 'remove source-page header/footer and review trim', 'remove every excludedOutputRanges band', 'paginate using outputPageBreakFractions'],
        exclusionPolicy: 'Excluded ranges are not part of the published question or solution and MUST NOT appear in question-bank crops, previews, exports or searchable extracted content.',
      },
      questions: regions.map((region, index) => ({
        questionRef: isSolution ? (questionPayload?.questions?.[index]?.label || region.label) : undefined,
        label: isSolution ? (questionPayload?.questions?.[index]?.label || region.label) : region.label,
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
        excludedOutputRanges: normalizeExclusions(exclusions[region.id] || []).map((range) => ({ startFraction: round4(range.start), endFraction: round4(range.end) })),
        outputCrop: {
          version: 1,
          exclusionCoordinateSystem: 'normalized vertical fraction of cleaned question strip before removal',
          excludedRanges: normalizeExclusions(exclusions[region.id] || []).map((range) => ({ startFraction: round4(range.start), endFraction: round4(range.end) })),
          exclusionBehavior: 'remove-content',
          includeExcludedContentInQuestionBank: false,
          outputPageBreakFractions: (outputBreaks[region.id] || []).map(round4),
        },
        pageTrimOverrides: Object.entries(trimOverrides[region.id] || {}).map(([page, trim]) => ({ page: Number(page), extraTopFraction: round4(trim.topExtra || 0), extraBottomFraction: round4(trim.bottomExtra || 0) })),
      })),
      segmentationApproval: {
        approved: approvalOverride?.approved ?? segmentationApproved,
        approvedAt: approvalOverride?.approvedAt ?? segmentationApprovedAt,
        structuralIssueCount: validateSegmentation().length,
      },
      lines: [...activeLines].sort(comparePos).map((line) => ({
        page: line.page,
        yFractionFromTop: round4(line.y),
        type: line.kind,
        label: line.label || null,
        labelEditedByUser: Boolean(line.manualLabel),
        source: line.source || 'manual',
      })),
      globalReviewTrim: { extraTopFraction: round4(globalReviewTrim.topExtra || 0), extraBottomFraction: round4(globalReviewTrim.bottomExtra || 0) },
      reconciliation: isSolution ? {
        expectedQuestionCount: questionPayload?.questions?.length || 0,
        matchedQuestionCount: regions.length,
        exactParentMatch: Boolean(questionPayload?.questions?.length && questionPayload.questions.length === regions.length),
      } : undefined,
      notes: isSolution
        ? 'Solution boundaries are matched in order to the approved question-paper question list. Excluded output ranges MUST be removed from published solution crops and question-bank exports.'
        : 'Question starts/ends define source ownership. Excluded output ranges MUST be removed from published question crops and question-bank exports; they do not change source question ownership.',
    };
  }

  function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportSegmentation() {
    if (!file || !pages.length) return;
    const issues = validateSegmentation();
    if (issues.length) {
      setApprovalIssues(issues);
      setStatus('Cannot save yet. Fix the flagged segmentation issues first.');
      return;
    }

    // Reaching Layout review means the teacher has accepted the question/part
    // structure. Saving from Layout must never force them back to the Check step.
    let approvalOverride = null;
    if (!segmentationApproved && viewMode === 'preview') {
      const approvedAt = new Date().toISOString();
      approvalOverride = { approved: true, approvedAt };
      setSegmentationApproved(true);
      setSegmentationApprovedAt(approvedAt);
      setApprovalIssues([]);
    } else if (!segmentationApproved) {
      setStatus('Review page layout first; entering Layout approves the question/part structure.');
      return;
    }

    const payload = buildSegmentationPayload(workflowKind, approvalOverride);
    if (!payload) return;
    const base = file.name.replace(/\.pdf$/i, '');
    if (workflowKind === 'solutions') {
      setSolutionPayload(payload);
      setSolutionJsonSaved(true);
      downloadJson(payload, `${base}.solutions.json`);
      setDownloadBaselineFingerprint(currentEditFingerprint);
      setStatus('Solution JSON saved and matched to the approved question list. You can now download the combined package.');
    } else {
      setQuestionPayload(payload);
      downloadJson(payload, `${base}.segmentation.json`);
      setDownloadBaselineFingerprint(currentEditFingerprint);
      setStatus('Question JSON saved. Continue with the solution file when ready.');
    }
  }

  function continueWithSolutions() {
    if (!segmentationApproved) return;
    const payload = questionPayload || buildSegmentationPayload('questions');
    if (!payload) return;

    // Keep the completed question paper mounted while the native file picker is
    // open. We only switch documents after a solution PDF has actually been
    // chosen. Apart from being less jarring, this prevents a blank-screen race
    // caused by clearing the current PDF before the replacement existed.
    questionAuthorityRef.current = payload;
    setQuestionPayload(payload);
    setAwaitingSolutionPdf(true);
    setStatus(`Question JSON retained. Choose the solution PDF; ${payload.questions.length} parent questions will be reconciled exactly.`);
    window.setTimeout(() => fileInputRef.current?.click(), 0);
  }

  function uploadAnotherPaper() {
    setAwaitingSolutionPdf(false);
    setWorkflowKind('questions');
    questionAuthorityRef.current = null;
    setQuestionPayload(null);
    setSolutionPayload(null);
    setSolutionJsonSaved(false);
    setFile(null);
    setPdf(null);
    setPages([]);
    setLines([]);
    setLastSuggestionIds([]);
    setSelectedQuestionId(null);
    setSelectedLineId(null);
    setSelectedSegmentId(null);
    setSegmentLabelOverrides({});
    setSegmentPartFlags({});
    setOutputBreaks({});
    setExclusions({});
    setTrimOverrides({});
    setGlobalReviewTrim({ topExtra: 0, bottomExtra: 0 });
    setSegmentationApproved(false);
    setSegmentationApprovedAt(null);
    setApprovalIssues([]);
    setViewMode('segment');
    setReviewedRegionIds([]);
    setStatus('Choose the next paper to begin.');
    setTimeout(() => fileInputRef.current?.click(), 0);
  }

  function downloadCombinedPackage() {
    const currentSolution = solutionPayload || (workflowKind === 'solutions' && segmentationApproved ? buildSegmentationPayload('solutions') : null);
    if (!questionPayload || !currentSolution) return;
    const bundle = {
      schemaVersion: 1,
      packageType: 'question-and-solution-segmentation',
      createdAt: new Date().toISOString(),
      questionSegmentation: questionPayload,
      solutionSegmentation: currentSolution,
    };
    const base = (questionPayload.sourceFile || 'prelim-paper').replace(/\.pdf$/i, '');
    downloadJson(bundle, `${base}.question-solution-bundle.json`);
    setStatus('Combined question + solution segmentation package downloaded.');
  }

  function exportTroubleshootingFile() {
    const diagnostic = {
      schemaVersion: 1,
      type: 'prelim-cropper-diagnostic',
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
      browser: navigator.userAgent,
      workflowKind,
      sourceFileName: file?.name || null,
      sourceQuestionFileName: questionPayload?.sourceFile || null,
      pageCount: pages.length,
      viewMode,
      headerPct, footerPct,
      boundaryCounts: { start: lines.filter((line) => line.kind === START).length, end: lines.filter((line) => line.kind === END).length, part: lines.filter((line) => line.kind === PART).length },
      lines: lines.map(({ id, page, y, kind, label, manualLabel, source }) => ({ id, page, y, kind, label, manualLabel, source })),
      segmentLabelOverrides, segmentPartFlags, outputBreaks, exclusions, trimOverrides, globalReviewTrim,
      segmentationApproved, segmentationApprovedAt,
      validationIssues: validateSegmentation().map(({ type, regionId, message, expectedLabels }) => ({ type, regionId, message, expectedLabels })),
      reviewedRegionIds,
      jsonState,
      localSaveAt: lastLocalSaveAt,
      note: 'Diagnostic metadata only. PDF page contents and extracted text are not included.',
    };
    const base = (file?.name || 'prelim-cropper').replace(/\.pdf$/i, '');
    downloadJson(diagnostic, `${base}.cropper-diagnostic.json`);
    setStatus('Troubleshooting file downloaded. It contains cropper state and diagnostics, not the PDF contents.');
  }

  async function resetCurrentPaper() {
    if (!file) return;
    const confirmed = window.confirm('Reset this paper? This clears the current boundaries, labels, exclusions and layout edits for this PDF. Downloaded JSON files are not affected.');
    if (!confirmed) return;
    const currentFile = file;
    const kind = workflowKind;
    await openPdf(currentFile, kind);
    setStatus('This paper has been reset to a fresh crop. Run detection again when ready.');
  }

  const selectedRegion = regions.find((region) => region.id === selectedQuestionId) || null;
  const selectedRegionIndex = regions.findIndex((region) => region.id === selectedQuestionId);
  const selectedLine = activeLines.find((line) => line.id === selectedLineId) || null;
  const selectedLineOwner = selectedLine ? regions.find((region) =>
    region.start.id === selectedLine.id || region.end.id === selectedLine.id || within(selectedLine, region.start, region.end)
  ) : null;

  useEffect(() => {
    if (viewMode !== 'preview' || !selectedRegion?.id) return;
    setReviewedRegionIds((current) => current.includes(selectedRegion.id) ? current : [...current, selectedRegion.id]);
  }, [viewMode, selectedRegion?.id]);

  useEffect(() => {
    function isTypingTarget(target) {
      const tag = target?.tagName?.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
    }
    function handlePreviewKeys(event) {
      if (viewMode !== 'preview' || isTypingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'ArrowLeft' && selectedRegionIndex > 0) {
        setSelectedQuestionId(regions[selectedRegionIndex - 1].id);
        event.preventDefault();
      } else if (event.key === 'ArrowRight' && selectedRegionIndex >= 0 && selectedRegionIndex < regions.length - 1) {
        setSelectedQuestionId(regions[selectedRegionIndex + 1].id);
        event.preventDefault();
      }
    }
    window.addEventListener('keydown', handlePreviewKeys);
    return () => window.removeEventListener('keydown', handlePreviewKeys);
  }, [viewMode, selectedRegionIndex, regions]);

  function validateSegmentation() {
    const issues = [];
    const ordered = [...activeLines].sort(comparePos);
    const starts = ordered.filter((line) => line.kind === START);
    const ends = ordered.filter((line) => line.kind === END);
    const parts = ordered.filter((line) => line.kind === PART);

    if (!starts.length) issues.push({ type: 'paper', message: 'No question starts found.' });
    if (starts.length !== ends.length) {
      issues.push({ type: 'paper', message: `${starts.length} question starts but ${ends.length} question ends. Check for an extra or missing START/END line.` });
    }

    if (workflowKind !== 'solutions') {
      const parsedNumbers = starts.map((line) => {
        const match = String(line.label || '').match(/Q?\s*(\d{1,2})/i);
        return match ? Number(match[1]) : null;
      });
      if (parsedNumbers.some((number) => number == null)) {
        const badIndex = parsedNumbers.findIndex((number) => number == null);
        issues.push({ type: 'paper', lineId: starts[badIndex]?.id, page: starts[badIndex]?.page, message: 'One or more question starts has no usable question number. Check the question labels.' });
      } else if (parsedNumbers.length) {
        const expected = parsedNumbers.map((_, index) => index + 1);
        const same = parsedNumbers.length === expected.length && parsedNumbers.every((number, index) => number === expected[index]);
        if (!same) {
          const mismatchIndex = parsedNumbers.findIndex((number, index) => number !== expected[index]);
          issues.push({ type: 'paper', lineId: starts[mismatchIndex]?.id, page: starts[mismatchIndex]?.page, message: `Question starts are not a clean Q1–Q${starts.length} sequence (${parsedNumbers.map((n) => n ?? '?').join(', ')}). This often indicates an extra detected START line.` });
        }
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
      if (ownerIndex < 0) issues.push({ type: 'paper', lineId: end.id, page: end.page, message: `An END line on page ${end.page} is not attached to any question.` });
    });

    parts.forEach((part) => {
      const owners = regions.filter((region) => within(part, region.start, region.end));
      if (owners.length === 0) issues.push({ type: 'paper', lineId: part.id, page: part.page, message: `A PART line on page ${part.page} sits outside all question boundaries.` });
      if (owners.length > 1) issues.push({ type: 'paper', lineId: part.id, page: part.page, message: `A PART line on page ${part.page} appears to belong to more than one question.` });
    });

    regions.forEach((region, regionIndex) => {
      if (!region.endExplicit) {
        issues.push({ type: 'question', regionId: region.id, message: `${region.label} is using an inferred END. Add or confirm the end line.` });
      }
      if (workflowKind === 'solutions') {
        const expectedSegments = authoritativeQuestionSegments(questionPayload?.questions?.[regionIndex]);
        const actualSegments = region.segments.filter((segment) => segment.isPart !== false);
        if (detailedQuestionIds.includes(region.id) && expectedSegments.length && actualSegments.length !== expectedSegments.length) {
          const expectedLabels = expectedSegments.map((segment, segmentIndex) => {
            const label = String(segment.label || '').trim();
            return label || `${region.label} part ${segmentIndex + 1}`;
          });
          issues.push({
            type: 'question',
            regionId: region.id,
            message: `${region.label} has ${actualSegments.length} solution block${actualSegments.length === 1 ? '' : 's'}, but the approved question JSON expects ${expectedSegments.length} question part${expectedSegments.length === 1 ? '' : 's'}. Check for an extra or missing PART boundary.`,
            expectedLabels,
          });
        }
      } else {
        const uncertainSegments = region.segments.filter((segment) => segment.isPart !== false && !segment.detectedMarker && !segment.labelEditedByUser && region.parts.length > 0);
        if (uncertainSegments.length) {
          issues.push({ type: 'question', regionId: region.id, message: `${region.label} has ${uncertainSegments.length} part boundar${uncertainSegments.length === 1 ? 'y' : 'ies'} without a recognised printed part label. Check for an extra PART line or label it manually.` });
        }
      }
    });

    if (workflowKind === 'solutions' && questionPayload?.questions?.length) {
      const expected = questionPayload.questions.map((question) => question.label);
      const actual = regions.map((region) => region.label);
      if (actual.length !== expected.length) {
        issues.push({ type: 'paper', message: `Solution reconciliation expected ${expected.length} parent questions from the question JSON, but found ${actual.length}.` });
      } else {
        actual.forEach((label, index) => {
          if (label !== expected[index]) issues.push({ type: 'question', regionId: regions[index]?.id, message: `Solution block ${index + 1} must match ${expected[index]}, but is labelled ${label}.` });
        });
      }
    }

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

  function jumpToIssue(issue) {
    if (!issue) return;
    if (issue.lineId) {
      const line = lines.find((item) => item.id === issue.lineId);
      if (line) {
        setSelectedLineId(line.id);
        const owner = regions.find((region) => region.start.id === line.id || region.end.id === line.id || within(line, region.start, region.end));
        if (owner?.id) setSelectedQuestionId(owner.id);
        requestAnimationFrame(() => {
          const target = document.querySelector(`.crop-line[data-line-id="${line.id}"]`);
          target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        return;
      }
    }
    if (issue.regionId) {
      jumpToQuestion(issue.regionId);
      return;
    }
    if (issue.page) {
      requestAnimationFrame(() => {
        const page = document.querySelector(`.page-wrap[data-page-number="${issue.page}"]`);
        page?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
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
    setStatus(workflowKind === 'solutions' ? 'Solution blocks approved and reconciled to the question JSON. Review layout, then save the solution JSON.' : 'Questions and parts approved. You can now review page layout and save the segmentation JSON.');
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
    part: activeLines.filter((l) => l.kind === PART).length,
  }), [lines, activeLines]);
  const explicitEndCount = regions.filter((region) => region.endExplicit).length;

  function handleFileDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    const dropped = event.dataTransfer?.files;
    if (!dropped?.length) return;
    handleIntakeFiles(dropped);
  }

  function allowFileDrop(event) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  function enterPreview() {
    if (!regions.length) return;
    const issues = validateSegmentation();
    if (issues.length) {
      setApprovalIssues(issues);
      setStatus('Fix the flagged question/part issues before reviewing page layout.');
      return;
    }

    // Entering Layout is itself the teacher's approval of the question/part
    // structure. There is no reason to make them click Approve and then click
    // Review page layout as a second confirmation of the same decision.
    if (!segmentationApproved) {
      const approvedAt = new Date().toISOString();
      setSegmentationApproved(true);
      setSegmentationApprovedAt(approvedAt);
      setApprovalIssues([]);
    }
    setViewMode('preview');
    setSelectedLineId(null);
    setStatus(workflowKind === 'solutions' ? 'Solution matches approved. Review the final layout; purple page-break lines affect output only.' : 'Questions and parts approved. Review the final layout; purple page-break lines affect output only.');
  }

  return (
    <div className="app-shell" onDragOver={allowFileDrop} onDrop={handleFileDrop}>
      <header className="topbar">
        <div className="topbar-copy">
          <p className="eyebrow">Local browser tool · v{APP_VERSION}</p>
          <h1>{workflowKind === 'solutions' ? 'Prelim Solution Cropper' : 'Prelim Cropper'}</h1>
          <p className="subtitle">{workflowKind === 'solutions' ? `Match the solution file to the ${questionPayload?.questions?.length || 0} approved question parents, then review the solution crops.` : 'Crop full questions first; open subparts only when needed, then review worksheet pages.'}</p>
          {file && <div className="context-strip"><strong>{workflowKind === 'solutions' ? 'Solutions' : 'Question paper'}</strong><span>{file.name}</span>{workflowKind === 'solutions' && questionPayload?.sourceFile && <span className="context-authority">Matched to {questionPayload.sourceFile}</span>}</div>}
        </div>
        {file && <div className="topbar-work-state"><span className="local-save-state">{lastLocalSaveAt ? `Saved locally ${new Date(lastLocalSaveAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Autosave pending'}</span><span className={`json-save-state ${jsonState || ''}`}>{jsonState === 'changed' ? '● Changes since last JSON' : jsonState === 'up-to-date' ? '✓ JSON up to date' : '○ JSON not yet downloaded'}</span></div>}
        {file && <div className="topbar-tools"><button className="ghost compact" type="button" onClick={undoEdit} disabled={!historyRef.current.length} title="Undo (Ctrl+Z)">↶ Undo</button><button className="ghost compact" type="button" onClick={redoEdit} disabled={!redoRef.current.length} title="Redo (Ctrl+Y)">↷ Redo</button><button className="ghost compact" type="button" onClick={() => setHelpOpen(true)}>?</button></div>}
        {file && <button className="primary" onClick={workflowKind === 'solutions' && solutionJsonSaved ? uploadAnotherPaper : () => fileInputRef.current?.click()} disabled={loading}>{workflowKind === 'solutions' && solutionJsonSaved ? 'Upload another paper' : `Change ${workflowKind === 'solutions' ? 'solution' : 'files'}`}</button>}
        <input ref={fileInputRef} className="hidden-input" type="file" accept="application/pdf,.pdf,application/json,.json" multiple onChange={(e) => handleIntakeFiles(e.target.files)} />
      </header>
      {statusVisible && status && <div className={`status-toast ${/cannot|could not|fix|missing|different|expected|failed|please/i.test(status) ? 'alert' : 'ok'}`} role="status"><span>{/cannot|could not|fix|missing|different|expected|failed|please/i.test(status) ? '!' : '✓'}</span><p>{status}</p><button type="button" aria-label="Dismiss message" onClick={() => setStatusVisible(false)}>×</button></div>}
      {helpOpen && <div className="modal-backdrop" onMouseDown={() => setHelpOpen(false)}><div className="help-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><p className="eyebrow">Quick help</p><h2>Keyboard & editing</h2></div><button type="button" className="ghost compact" onClick={() => setHelpOpen(false)}>×</button></div><div className="shortcut-grid"><kbd>Click line</kbd><span>Select boundary</span><kbd>Drag line</kbd><span>Move boundary</span><kbd>Double-click</kbd><span>Delete boundary</span><kbd>Delete / Backspace</kbd><span>Delete selected boundary</span><kbd>Ctrl / Cmd + Z</kbd><span>Undo</span><kbd>Ctrl / Cmd + Y</kbd><span>Redo</span><kbd>↑ / ↓</kbd><span>Fine-move selected boundary</span><kbd>← / →</kbd><span>Previous / next question in Layout</span><kbd>S / E / P</kbd><span>Choose START / END / PART tool</span><kbd>Esc</kbd><span>Deselect</span></div><p className="small">Work is autosaved locally in this browser. Download a new JSON after making changes you want to keep outside this computer.</p></div></div>}
      {pendingMismatch && <div className="modal-backdrop"><div className="help-modal mismatch-modal"><div className="modal-heading"><div><p className="eyebrow">Check file pairing</p><h2>These filenames do not match</h2></div></div><div className="mismatch-files"><span>JSON expects</span><strong>{pendingMismatch.payload?.sourceFile || 'Unknown source PDF'}</strong><span>You selected</span><strong>{pendingMismatch.pdfFile?.name}</strong></div>{pendingMismatch.kind === 'question-or-solution' ? <><p>Is this the solution PDF, or is it a renamed copy of the original question paper?</p><div className="modal-actions stacked-actions"><button className="primary" type="button" onClick={() => resolvePendingMismatch('use-as-solution')}>Use as solution PDF</button><button className="ghost" type="button" onClick={() => resolvePendingMismatch('reopen-question')}>Reopen as renamed question paper</button><button className="ghost" type="button" onClick={() => resolvePendingMismatch('cancel')}>Choose different files</button></div></> : <><p>The saved solution boundaries may not align with this PDF. Continue only if the file was renamed but its pages are unchanged.</p><div className="modal-actions"><button className="ghost" type="button" onClick={() => resolvePendingMismatch('cancel')}>Choose different file</button><button className="primary" type="button" onClick={() => resolvePendingMismatch('continue')}>Open anyway</button></div></>}</div></div>}

      <main className={`workspace ${viewMode === 'preview' ? 'preview-mode-shell' : ''}`}>
        <aside className="controls-card">
          <nav className="workflow-stepper" aria-label="Workflow">
            <div className={`workflow-step ${file ? 'done' : 'active'}`}><span>{file ? '✓' : '1'}</span><small>Upload</small></div>
            <div className={`workflow-step ${file && !regions.length && viewMode === 'segment' ? 'active' : regions.length ? 'done' : ''}`}><span>{regions.length ? '✓' : '2'}</span><small>{workflowKind === 'solutions' ? 'Match' : 'Detect'}</small></div>
            <div className={`workflow-step ${regions.length && viewMode === 'segment' && !segmentationApproved ? 'active' : segmentationApproved ? 'done' : ''}`}><span>{segmentationApproved ? '✓' : '3'}</span><small>Check</small></div>
            <div className={`workflow-step ${viewMode === 'preview' ? 'active' : ''}`}><span>{viewMode === 'preview' && reviewedRegionIds.length >= regions.length && regions.length ? '✓' : '4'}</span><small>Layout</small></div>
            <div className={`workflow-step ${(questionPayload && workflowKind === 'questions') || solutionJsonSaved ? 'done' : viewMode === 'preview' ? 'active' : ''}`}><span>{(questionPayload && workflowKind === 'questions') || solutionJsonSaved ? '✓' : '5'}</span><small>Save</small></div>
          </nav>

          {file && <section className="compact-section trial-tools"><div className="trial-tool-row"><button className="ghost compact" type="button" onClick={() => setHelpOpen(true)}>Shortcuts</button><button className="ghost compact" type="button" onClick={exportTroubleshootingFile}>Troubleshooting file</button><button className="ghost compact danger-soft" type="button" onClick={resetCurrentPaper}>Reset paper</button></div></section>}

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
                <h2>Whole-question cropping</h2>
                <button className="detect-card" onClick={suggestRegions} disabled={!pages.length || loading}>
                  <span className="detect-icon">✦</span>
                  <span><strong>Detect whole questions</strong><small>Find the start and end of each full question; subparts are optional</small></span>
                </button>
                <div className="summary-metrics">
                  <div><strong>{regions.length}</strong><span>questions</span></div>
                  <div><strong>{counts.part}</strong><span>optional part boundaries</span></div>
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
                      {selectedRegion && detailedQuestionIds.includes(selectedRegion.id) && <button className={`line-mode part-mode ${(heldLineMode || lineMode) === PART ? 'active' : ''}`} onClick={() => setLineMode(PART)}><span className="mode-swatch part-swatch" />Part <kbd>P</kbd></button>}
                    </div>
                    <p className="small">Click a line, then use <strong>↑ / ↓</strong> for fine adjustment. Hold <strong>Shift</strong> for a larger nudge. Drag to move; double-click or press <strong>Delete</strong> / <strong>Backspace</strong> to remove.</p>
                    <div className="button-stack compact-buttons">
                      <button className="ghost" onClick={undoLastSuggestions} disabled={!lastSuggestionIds.length}>Undo detection</button>
                      <button className="ghost clear-button" onClick={clearLines} disabled={!lines.length}>Clear all</button>
                    </div>
                  </div>
                </details>
              </section>

              <section className="compact-section question-section">
                <div className="section-heading-row"><div><div className="section-kicker">{workflowKind === 'solutions' ? 'Match to question JSON' : 'Check the paper'}</div><h2>{workflowKind === 'solutions' ? 'Solution parents' : 'Questions'}</h2></div><span className={`question-count ${segmentationApproved ? 'complete' : liveApprovalIssues.length ? 'warn' : ''}`}>{regions.length}</span></div>
                {workflowKind === 'solutions' && questionPayload && <p className="review-progress-copy">Expected: {questionPayload.questions.length} parent questions. Parent identity is inherited from the approved question JSON.</p>}
                {!regions.length && <p className="small">Questions will appear here after detection.</p>}
                {!!regions.length && liveApprovalIssues.length === 0 && !segmentationApproved && <p className="review-progress-copy">Edit as you go. When everything looks right, approve the whole paper once.</p>}
                {!!regions.length && segmentationApproved && <p className="review-progress-copy approval-ok">✓ Questions and parts approved</p>}
                <div className="region-list question-list">
                  {regions.map((region) => {
                    const partSegments = region.segments.filter((segment) => segment.isPart !== false);
                    const partCount = partSegments.length;
                    const partLabels = partSegments.map((segment) => String(segment.label || '').replace(new RegExp(`^${region.label}\\s*`, 'i'), '')).filter(Boolean);
                    const hasIssue = issueRegionIds.has(region.id);
                    return (
                      <button key={region.id} className={`region-row richer-row ${selectedQuestionId === region.id ? 'selected' : ''}`} onClick={() => jumpToQuestion(region.id)}>
                        <span className="region-main"><span className={`qa-dot ${hasIssue ? 'warn' : 'ok'}`}>{hasIssue ? '!' : '✓'}</span><span className="region-row-copy"><span className="region-name">{region.label}</span><small title={partLabels.join(' · ')}>{partLabels.length ? partLabels.join(' · ') : 'No parts identified'}</small></span></span>
                        <span className={`region-status ${hasIssue ? 'warn' : 'ok'}`}>{hasIssue ? 'check' : `${partCount}`}</span>
                      </button>
                    );
                  })}
                </div>
                {selectedRegion && (
                  <div className="whole-question-choice">
                    <strong>{detailedQuestionIds.includes(selectedRegion.id) ? 'Subpart cropping enabled' : 'Full question crop'}</strong>
                    <p className="small">{detailedQuestionIds.includes(selectedRegion.id) ? 'Blue part boundaries are editable for this question only.' : 'Only the start and end of this question need checking. Header/footer cleanup, exclusions and page review still work as usual.'}</p>
                    <button type="button" className="ghost full" onClick={() => {
                      const wasDetailed = detailedQuestionIds.includes(selectedRegion.id);
                      setDetailedQuestionIds((current) => wasDetailed ? current.filter((id) => id !== selectedRegion.id) : [...current, selectedRegion.id]);
                      setSelectedSegmentId(null);
                      setLineMode(START);
                      setSegmentationApproved(false);
                      setSegmentationApprovedAt(null);
                    }}>{detailedQuestionIds.includes(selectedRegion.id) ? 'Use whole question only' : '+ Crop subparts of this question'}</button>
                  </div>
                )}
                {selectedRegion && detailedQuestionIds.includes(selectedRegion.id) && (
                  <div className="label-editor">
                    <label>Question label<input value={selectedRegion.start.label || selectedRegion.label} disabled={workflowKind === 'solutions'} onChange={(e) => updateLineLabel(selectedRegion.start.id, e.target.value)} /></label>
                    <div className="segment-label-list">
                      {selectedRegion.segments.map((segment) => (
                        <button key={segment.id} type="button" className={`segment-label-row ${selectedSegmentId === segment.id ? 'selected' : ''} ${segment.isPart === false ? 'not-part' : ''}`} onClick={() => setSelectedSegmentId(segment.id)}>
                          <span>{segment.isPart === false ? (workflowKind === 'solutions' ? 'Not a solution part' : 'Not a question part') : segment.label}</span><small>{segment.isPart === false ? 'excluded' : (segment.labelEditedByUser ? 'edited' : (segment.detectedMarker ? 'detected' : 'check'))}</small>
                        </button>
                      ))}
                    </div>
                    {selectedRegion.segments.map((segment) => selectedSegmentId === segment.id && (
                      <div key={`edit-${segment.id}`} className="selected-segment-editor" data-segment-editor-id={segment.id}>
                        <label>Selected segment
                          <input value={segment.label} disabled={segment.isPart === false} onChange={(e) => updateSegmentLabel(segment.id, e.target.value)} />
                        </label>
                        <div className="segment-role-toggle" role="group" aria-label="Segment role">
                          <button type="button" className={segment.isPart !== false ? 'primary' : 'ghost'} onClick={() => updateSegmentPartFlag(segment.id, true)}>{workflowKind === 'solutions' ? 'Solution part' : 'Question part'}</button>
                          <button type="button" className={segment.isPart === false ? 'not-part-active' : 'ghost'} onClick={() => updateSegmentPartFlag(segment.id, false)}>{workflowKind === 'solutions' ? 'Not a solution part' : 'Not a question part'}</button>
                        </div>
                        {segment.isPart !== false && <p className={`label-evidence ${segment.detectedMarker ? 'detected' : 'uncertain'}`}>{segment.labelEditedByUser ? 'Manual label' : segment.labelEvidence}</p>}
                        {segment.isPart === false && <p className="small compact-segment-note">Kept inside the parent crop, but excluded from part tagging/export.</p>}
                      </div>
                    ))}
                    {selectedSegmentId && segmentLabelOverrides[selectedSegmentId] && <button type="button" className="ghost full" onClick={() => { setSegmentLabelOverrides((current) => { const next = { ...current }; delete next[selectedSegmentId]; return next; }); setSegmentationApproved(false); setSegmentationApprovedAt(null); setApprovalIssues([]); }}>Use automatic label</button>}
                  </div>
                )}
              </section>

              <section className="compact-section review-cta-section">
                {!!regions.length && !segmentationApproved && <button className="primary full" onClick={approveSegmentation}>{workflowKind === 'solutions' ? '✓ Approve solution matches' : '✓ Approve whole questions'}</button>}
                {!!regions.length && segmentationApproved && <button className="approval-confirmed full" type="button" disabled>{workflowKind === 'solutions' ? '✓ Solution matches approved' : '✓ Whole questions approved'}</button>}
                {!!regions.length && liveApprovalIssues.length > 0 && (
                  <details className="approval-issues compact-approval-issues">
                    <summary>{liveApprovalIssues.length} issue{liveApprovalIssues.length === 1 ? '' : 's'} to fix before approval</summary>
                    <ul>{liveApprovalIssues.slice(0, 5).map((issue, index) => (
                      <li key={`${issue.message}-${index}`}>
                        <button type="button" className={`issue-jump ${issue.regionId || issue.lineId || issue.page ? 'clickable' : ''}`} onClick={() => jumpToIssue(issue)} disabled={!issue.regionId && !issue.lineId && !issue.page}>
                          <span>{issue.message}</span>
                          {!!issue.expectedLabels?.length && <small>Expected parts: {issue.expectedLabels.join(' · ')}</small>}
                          {(issue.regionId || issue.lineId || issue.page) && <em>{issue.lineId ? `Go to problem on page ${issue.page || ''}` : issue.regionId ? `Go to ${regions.find((region) => region.id === issue.regionId)?.label || 'question'}` : `Go to page ${issue.page}`} →</em>}
                        </button>
                      </li>
                    ))}</ul>
                    {liveApprovalIssues.length > 5 && <small>+ {liveApprovalIssues.length - 5} more</small>}
                  </details>
                )}
                <button className={`${segmentationApproved || liveApprovalIssues.length === 0 ? 'primary' : 'ghost'} full`} onClick={enterPreview} disabled={!regions.length}>Review page layout →</button>
              </section>
            </>
          ) : (
            <>
              <section className="compact-section"><button className="ghost full" onClick={() => setViewMode('segment')}>← Back to questions</button></section>
              <section className="compact-section"><div className="section-heading-row"><h2>{workflowKind === 'solutions' ? 'Solution parents' : 'Questions'}</h2><span className="review-count">{reviewedRegionIds.length}/{regions.length} viewed</span></div><div className="region-list preview-region-list">{regions.map((region) => { const visited = reviewedRegionIds.includes(region.id); const current = selectedQuestionId === region.id; return <button key={region.id} className={`region-row ${current ? 'selected' : ''}`} onClick={() => setSelectedQuestionId(region.id)}><span className="region-name">{region.label}</span><span className={`visit-state ${current ? 'current' : visited ? 'visited' : ''}`}>{current ? '●' : visited ? '✓' : '○'}</span></button>; })}</div></section>
              <section className="compact-section save-section">
                <button className="primary full" onClick={exportSegmentation} disabled={liveApprovalIssues.length > 0}>{workflowKind === 'solutions' ? 'Save solution JSON' : 'Save question JSON'}</button>
                <p className="small">Saves the approved source boundaries and reviewed page layout.</p>
                {workflowKind === 'questions' && questionPayload && <div className="completion-card"><strong>✓ Question JSON saved</strong><span>{questionPayload.sourceFile || file?.name}</span><button className="ghost full" type="button" onClick={continueWithSolutions}>{awaitingSolutionPdf ? 'Choose solution PDF…' : 'Continue with solutions →'}</button><button className="ghost full" type="button" onClick={uploadAnotherPaper}>Upload another paper</button></div>}
                {workflowKind === 'solutions' && solutionJsonSaved && <div className="completion-card"><strong>✓ Solution JSON saved</strong><span>{solutionPayload?.sourceFile || file?.name}</span>{questionPayload && solutionPayload && <button className="ghost full" type="button" onClick={downloadCombinedPackage}>Download both JSONs</button>}<button className="ghost full" type="button" onClick={uploadAnotherPaper}>Upload another paper</button></div>}
              </section>
            </>
          )}
        </aside>
      <section className="document-area">
          {!file && (
            <div className="empty-state drop-zone" onClick={() => fileInputRef.current?.click()}>
              {resumePromptOpen && resumeDraft && <div className="resume-card" onClick={(event) => event.stopPropagation()}><div><p className="eyebrow">Recent unfinished work</p><strong>{resumeDraft.fileName || 'Previous paper'}</strong><small>Saved {new Date(resumeDraft.savedAt || Date.now()).toLocaleString()}</small></div><div className="resume-actions"><button type="button" className="ghost" onClick={discardSavedWork}>Start fresh</button><button type="button" className="primary" onClick={resumeSavedWork}>Continue</button></div></div>}
              <div className="empty-icon">⇩</div><h2>{workflowKind === 'solutions' ? 'Drop the matching solution PDF here' : 'Drop your paper here'}</h2>
              <p>{workflowKind === 'solutions' ? `The question JSON is ready. Add the solution PDF and it will be matched to ${questionPayload?.questions?.length || 0} parent questions.` : 'The cropper works out what you are trying to do from the files you provide.'}</p>
              {workflowKind === 'questions' && <div className="intake-guide"><div><strong>PDF only</strong><span>Start a new question paper</span></div><div><strong>PDF + matching JSON</strong><span>Reopen and edit saved boundaries</span></div><div><strong>Question JSON + solution PDF</strong><span>Continue with solutions</span></div></div>}
              <button className="primary" onClick={(event) => { event.stopPropagation(); fileInputRef.current?.click(); }}>Choose {workflowKind === 'solutions' ? 'solution PDF' : 'files'}</button>
              <small className="panel-note">You can also drag files anywhere onto this window.</small>
            </div>
          )}
          {loading && <div className="loading-card">Preparing pages…</div>}
          {!!pages.length && !loading && viewMode === 'segment' && (
            <div className="segmentation-workspace">
              <div className="panel-heading"><div><p className="eyebrow">Segmentation</p><h2>Rolling paper</h2></div><span className="panel-note">Focus only on question ownership</span></div>
              {selectedLine && <div className="selected-line-bar"><strong>Selected: {selectedLine.kind === START ? 'START' : selectedLine.kind === END ? 'END' : 'PART'}{selectedLineOwner ? ` · ${selectedLineOwner.label}` : ''}</strong><span>↑ / ↓ move · Shift = larger move · Delete removes</span></div>}
              <div className="rolling-paper">
                {pages.map((pageData) => (
                  <PdfPage key={pageData.pageNumber} pageData={pageData} headerPct={headerPct} footerPct={footerPct}
                    lines={activeLines.filter((line) => line.page === pageData.pageNumber)} lineMode={heldLineMode || lineMode} onAddLine={addLine}
                    onMoveLine={moveLine} onRemoveLine={removeLine} showGuides={showGuides} regions={regions} selectedLineId={selectedLineId} onSelectLine={setSelectedLineId}
                    selectedQuestionId={selectedQuestionId} selectedSegmentId={selectedSegmentId} onSelectSegment={selectSegmentForEditing} />
                ))}
              </div>
            </div>
          )}
          {!!pages.length && !loading && viewMode === 'preview' && (
            <PreviewWorkspace pages={pages} region={selectedRegion} headerPct={headerPct} footerPct={footerPct}
              hasPrevious={selectedRegionIndex > 0}
              hasNext={selectedRegionIndex >= 0 && selectedRegionIndex < regions.length - 1}
              onPrevious={() => {
                if (selectedRegionIndex > 0) setSelectedQuestionId(regions[selectedRegionIndex - 1].id);
              }}
              onNext={() => {
                if (selectedRegionIndex >= 0 && selectedRegionIndex < regions.length - 1) setSelectedQuestionId(regions[selectedRegionIndex + 1].id);
              }}
              currentIndex={selectedRegionIndex}
              totalCount={regions.length}
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
    <div className="page-wrap" data-page-number={pageData.pageNumber}>
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
            <div key={line.id} data-line-id={line.id} className={`crop-line ${line.kind} ${line.source === 'suggested' ? 'suggested-line' : 'confirmed-line'} ${selectedLineId === line.id ? 'selected-line' : ''}`} style={{ top: `${yVisible}%` }}
              onClick={(e) => { e.stopPropagation(); onSelectLine(line.id); }} onPointerDown={(e) => { onSelectLine(line.id); beginDrag(e, line.id); }}
              onDoubleClick={(e) => { e.stopPropagation(); onRemoveLine(line.id); }} title="Click to select. Use Up/Down arrows for fine adjustment. Drag to move. Double-click or press Delete/Backspace to remove.">
              <span className="line-tag">{displayText(line)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function detectedHeaderCutoff(pageData, configuredTop) {
  // The crop-review preview must not reintroduce a printed page number that
  // was already hidden by the paper editor's nominal header crop. Some papers
  // position this number just below the default 3% trim.
  const headerNumbers = (pageData.rows || []).filter((row) => {
    const text = String(row.text || '').trim();
    const x = Number(row.xNorm);
    const y = Number(row.yNorm);
    return /^\d{1,3}$/.test(text) && Number.isFinite(x) && Number.isFinite(y)
      && x >= 0.32 && x <= 0.68 && y >= configuredTop - 0.015 && y < 0.09;
  });
  if (!headerNumbers.length) return configuredTop;
  // Only expand the crop to include printed page furniture. Do not discard
  // the first line of a part on pages where its crop starts below the number.
  return Math.min(0.12, Math.max(configuredTop, ...headerNumbers.map((row) => Number(row.yNorm) + 0.012)));
}

function detectedFooterCutoff(pageData, configuredBottom) {
  // Do not infer a footer from a bare number in the lower portion of a page.
  // In worked Physics solutions, equations routinely contain small standalone
  // numbers, and an incorrect match silently removes the FINAL answer lines.
  // Printed page numbers are handled by detectedHeaderCutoff instead.
  // Only recognise explicit footer furniture in the physical footer zone.
  const footerRows = (pageData.rows || []).filter((row) => {
    const y = Number(row.yNorm);
    if (!Number.isFinite(y) || y < 0.90 || y >= configuredBottom) return false;
    const text = String(row.text || '').replace(/\s+/g, ' ').trim();
    return /turn\s+over/i.test(text)
      || /\b\d{4}\s*\/\s*0?\d{1,2}\s*\//i.test(text)
      || (/\b(?:ASRJC|HCI|RI|RJC|VJC|NJC|SAJC|EJC|ACJC|CJC|DHS|TJC|NYJC|YIJC|JPJC)\b/i.test(text) && /\d{4}/.test(text))
      || /^(?:©|copyright)\b/i.test(text);
  });
  if (!footerRows.length) return configuredBottom;
  const firstFurnitureY = Math.min(...footerRows.map((row) => Number(row.yNorm)));
  // Do not pull a page's footer crop into substantive answer content.
  return Math.min(configuredBottom, Math.max(0.90, firstFurnitureY - 0.006));
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
    const cleanTop = detectedHeaderCutoff(pageData, clamp((Number(headerPct) || 0) / 100 + topExtra, 0, 0.48));
    const configuredBottom = clamp(1 - (Number(footerPct) || 0) / 100 - bottomExtra, 0.52, 1);
    const cleanBottom = detectedFooterCutoff(pageData, configuredBottom);
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

  // Treat every part start as both the start of the next part and the end of
  // the previous part. A normal page should therefore finish on a part
  // boundary rather than halfway through a part. If one individual part is
  // taller than an A4 content area, there is no legal boundary available and
  // that part is split only as much as necessary, with further breaks added
  // automatically until the oversized part fits across the required pages.
  const boundaryYs = [...new Set(
    partFractions
      .map((part) => part.fraction * stripHeight)
      .filter((value) => value > 8 && value < stripHeight - 8)
      .map((value) => Math.round(value))
  )].sort((a, b) => a - b);

  const breaks = [];
  let current = 0;
  let guard = 0;
  while (current + sourcePageHeight < stripHeight - 1 && guard < 200) {
    guard += 1;
    const target = current + sourcePageHeight;
    const candidates = boundaryYs.filter((y) => y > current + 8 && y <= target + 1);

    // The latest boundary before the physical page end is the start of the
    // part that would otherwise be split. Move the break there only when that
    // whole part can fit on a fresh page. If that part is itself taller than a
    // page, splitting it is unavoidable, so use the physical page limit.
    let breakY = target;
    if (candidates.length) {
      const candidate = candidates[candidates.length - 1];
      const nextBoundary = boundaryYs.find((y) => y > candidate + 1) ?? stripHeight;
      const candidatePartHeight = nextBoundary - candidate;
      if (candidatePartHeight <= sourcePageHeight + 1) breakY = candidate;
    }

    // No usable part boundary exists because the current part itself is taller
    // than a page. Split that oversized part at the physical page limit and
    // continue; the next loop adds another break if the remainder still
    // overflows.
    if (breakY <= current + 8) breakY = target;
    breakY = Math.min(breakY, stripHeight - 1);
    breaks.push(round4(breakY / stripHeight));
    current = breakY;
  }
  return breaks;
}

// For published pages, do not orphan the beginning of a short question part.
// Saved coordinates remain unchanged; this only chooses the printed page edge.
// When a manual break sits inside a part that fits on one A4 page, start that
// part on the next page instead of displaying just its heading / first lines.
function keepCompletePartsAtPageBreaks(stripWidth, stripHeight, partFractions, requestedBreaks) {
  const capacity = PAGE_CONTENT_HEIGHT * (stripWidth / PAGE_CONTENT_WIDTH);
  const starts = [0, ...(partFractions || []).map((p) => Number(p.fraction) || 0), 1]
    .filter((f) => f >= 0 && f <= 1).sort((a, b) => a - b);
  const uniqueStarts = [...new Set(starts.map((f) => Math.round(f * stripHeight)))];
  const minimumPartFragment = Math.max(10, stripWidth * 0.02);
  return (requestedBreaks || []).map((fraction) => {
    const y = clamp(Number(fraction) || 0, 0, 1) * stripHeight;
    const index = uniqueStarts.findIndex((boundary, i) =>
      i + 1 < uniqueStarts.length && y > boundary + 1 && y < uniqueStarts[i + 1] - 1);
    if (index < 0) return fraction;
    const partStart = uniqueStarts[index];
    const partEnd = uniqueStarts[index + 1];
    // A very long part cannot be kept whole. Also avoid creating a tiny page
    // merely to move a break near the top of the current part.
    if (partEnd - partStart > capacity + 1 || y - partStart < minimumPartFragment) return fraction;
    return round4(partStart / stripHeight);
  });
}

function normalizeBreaksForPageCapacity(stripWidth, stripHeight, partFractions, requestedBreaks) {
  const pageHeight = PAGE_CONTENT_HEIGHT * (stripWidth / PAGE_CONTENT_WIDTH);
  // A saved/manual page break is intentional even when the whole strip fits on A4.
  // Discarding it made the editor and exported page preview disagree.
  if (stripHeight <= pageHeight + 1 && !(requestedBreaks || []).length) return [];

  const boundaryYs = [...new Set(
    (partFractions || [])
      .map((part) => clamp(Number(part.fraction) || 0, 0, 1) * stripHeight)
      .filter((value) => value > 8 && value < stripHeight - 8)
      .map((value) => Math.round(value))
  )].sort((a, b) => a - b);

  const requestedYs = [...new Set(
    (requestedBreaks || [])
      .map((fraction) => clamp(Number(fraction) || 0, 0.001, 0.999) * stripHeight)
      .map((value) => Math.round(value))
  )].sort((a, b) => a - b);

  function safeBreakBefore(current, target) {
    const candidates = boundaryYs.filter((y) => y > current + 8 && y <= target + 1);
    if (!candidates.length) return target;

    // Prefer the latest part boundary that fits before the physical page end.
    // If the part beginning there is itself taller than a page, splitting that
    // oversized part is unavoidable, so use the physical page limit instead.
    const candidate = candidates[candidates.length - 1];
    const nextBoundary = boundaryYs.find((y) => y > candidate + 1) ?? stripHeight;
    if (nextBoundary - candidate <= pageHeight + 1) return candidate;
    return target;
  }

  const result = [];
  let current = 0;
  let requestIndex = 0;
  let guard = 0;

  while (guard < 300) {
    guard += 1;
    while (requestIndex < requestedYs.length && requestedYs[requestIndex] <= current + 8) requestIndex += 1;
    // Continue for explicit breaks even if there is room for the entire tail.
    // Otherwise stop when no further physical page split is needed.
    if (current + pageHeight >= stripHeight - 1 && requestIndex >= requestedYs.length) break;

    const target = Math.min(current + pageHeight, stripHeight - 1);
    const requested = requestIndex < requestedYs.length ? requestedYs[requestIndex] : null;
    let breakY;

    if (requested != null && requested <= target + 1) {
      // A teacher-selected break that physically fits is honoured. It should
      // already be snapped by the editor, but if it falls very near a part
      // boundary, use the exact boundary to prevent slicing through glyphs.
      const nearest = boundaryYs.reduce((best, y) => {
        const distance = Math.abs(y - requested);
        return !best || distance < best.distance ? { y, distance } : best;
      }, null);
      breakY = nearest && nearest.distance <= Math.max(8, stripHeight * 0.008) ? nearest.y : requested;
      requestIndex += 1;
    } else {
      // The next requested break is too far down to fit on the current A4
      // page (or there is no requested break). Insert a safe break now rather
      // than allowing makeFinalPages() to clip the bottom of the content.
      breakY = safeBreakBefore(current, target);
    }

    if (breakY <= current + 8) breakY = target;
    breakY = Math.min(breakY, stripHeight - 1);
    result.push(round4(breakY / stripHeight));
    current = breakY;
  }

  return [...new Set(result)].sort((a, b) => a - b);
}

function makeFinalPages(strip, breaks) {
  // The break planner works with fractions, but rasterization uses integer
  // pixels. Recheck capacity with those exact pixel coordinates so rounding,
  // user-authored breaks and imported JSON can never silently clip a solution.
  const pageHeight = Math.floor(PAGE_CONTENT_HEIGHT * (strip.width / PAGE_CONTENT_WIDTH));
  const requested = [...new Set((breaks || [])
    .map((fraction) => Math.round(clamp(Number(fraction) || 0, 0, 1) * strip.height))
    .filter((y) => y > 0 && y < strip.height))].sort((a, b) => a - b);
  const boundaries = [0];
  for (const end of [...requested, strip.height]) {
    let cursor = boundaries[boundaries.length - 1];
    while (end - cursor > pageHeight) {
      cursor = Math.min(end, cursor + pageHeight);
      boundaries.push(cursor);
    }
    if (end > boundaries[boundaries.length - 1]) boundaries.push(end);
  }
  const pages = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const startY = boundaries[i];
    const sourceHeight = boundaries[i + 1] - startY;
    if (sourceHeight <= 0) continue;
    const a4 = document.createElement('canvas');
    a4.width = 794; a4.height = 1123;
    const ctx = a4.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, a4.width, a4.height);
    const scale = PAGE_CONTENT_WIDTH / strip.width;
    const drawWidth = strip.width * scale;
    const drawHeight = sourceHeight * scale;
    const x = Math.round((a4.width - drawWidth) / 2);
    ctx.drawImage(strip, 0, startY, strip.width, sourceHeight, x, 44, drawWidth, drawHeight);
    pages.push(a4.toDataURL('image/jpeg', 0.92));
  }
  return pages;
}

function normalizeExclusions(ranges) {
  const sorted = (ranges || []).map((range) => {
    const rawStart = Number.isFinite(Number(range?.start)) ? Number(range.start) : Number(range?.startFraction);
    const rawEnd = Number.isFinite(Number(range?.end)) ? Number(range.end) : Number(range?.endFraction);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) return null;
    return {
      id: range.id || makeId('exclude'),
      start: clamp(Math.min(rawStart, rawEnd), 0, 1),
      end: clamp(Math.max(rawStart, rawEnd), 0, 1),
    };
  }).filter(Boolean).filter((range) => range.end - range.start > 0.002).sort((a, b) => a.start - b.start);
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
  // Keep a small white gutter wherever a removed band joins two pieces of
  // question content. "Remove blank space" should shorten a gap, not glue
  // neighbouring parts together visually.
  const joinGapPx = Math.max(12, Math.round(strip.width * 0.016));
  const removedPx = normalized.reduce((sum, range) => {
    const startY = Math.round(range.start * strip.height);
    const endY = Math.round(range.end * strip.height);
    return sum + Math.max(0, endY - startY);
  }, 0);
  const spacerPx = normalized.length * joinGapPx;
  const out = document.createElement('canvas');
  out.width = strip.width;
  out.height = Math.max(1, strip.height - removedPx + spacerPx);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);

  const pieces = [];
  let sourceCursor = 0;
  let destY = 0;
  for (const range of normalized) {
    const startY = Math.round(range.start * strip.height);
    const endY = Math.round(range.end * strip.height);
    if (startY > sourceCursor) {
      const h = startY - sourceCursor;
      ctx.drawImage(strip, 0, sourceCursor, strip.width, h, 0, destY, strip.width, h);
      pieces.push({ type: 'kept', sourceStart: sourceCursor, sourceEnd: startY, destStart: destY, destEnd: destY + h });
      destY += h;
    }
    pieces.push({ type: 'removed', sourceStart: startY, sourceEnd: endY, destStart: destY, destEnd: destY + joinGapPx });
    // Canvas is already white, so advancing destY leaves a clean gutter.
    destY += joinGapPx;
    sourceCursor = Math.max(sourceCursor, endY);
  }
  if (sourceCursor < strip.height) {
    const h = strip.height - sourceCursor;
    ctx.drawImage(strip, 0, sourceCursor, strip.width, h, 0, destY, strip.width, h);
    pieces.push({ type: 'kept', sourceStart: sourceCursor, sourceEnd: strip.height, destStart: destY, destEnd: destY + h });
  }

  function originalToCompacted(fraction) {
    const sourceY = clamp(fraction, 0, 1) * strip.height;
    for (const piece of pieces) {
      if (sourceY <= piece.sourceEnd) {
        if (piece.type === 'removed') {
          const span = Math.max(1, piece.sourceEnd - piece.sourceStart);
          const t = clamp((sourceY - piece.sourceStart) / span, 0, 1);
          return clamp((piece.destStart + t * (piece.destEnd - piece.destStart)) / out.height, 0, 1);
        }
        return clamp((piece.destStart + (sourceY - piece.sourceStart)) / out.height, 0, 1);
      }
    }
    return 1;
  }

  function compactedToOriginal(fraction) {
    const dest = clamp(fraction, 0, 1) * out.height;
    for (const piece of pieces) {
      if (dest <= piece.destEnd) {
        if (piece.type === 'removed') {
          const span = Math.max(1, piece.destEnd - piece.destStart);
          const t = clamp((dest - piece.destStart) / span, 0, 1);
          return clamp((piece.sourceStart + t * (piece.sourceEnd - piece.sourceStart)) / strip.height, 0, 1);
        }
        return clamp((piece.sourceStart + (dest - piece.destStart)) / strip.height, 0, 1);
      }
    }
    return 1;
  }

  return { canvas: out, exclusions: normalized, originalToCompacted, compactedToOriginal, joinGapPx };
}

// A question-part boundary may be swallowed by a teacher-selected removal,
// especially when the repeated question heading is being removed from solutions.
// Do not discard that boundary: it is still needed to keep the remaining worked
// solution together when an output page fills up.
function mapPartsToCompactedStrip(partFractions, compacted) {
  return (partFractions || []).map((part) => {
    const range = compacted.exclusions.find((entry) =>
      part.fraction > entry.start && part.fraction < entry.end
    );
    // Anchor at the end of the removed content, where the retained solution
    // resumes. This avoids a page break stranded in an excluded band.
    const sourceFraction = range ? range.end : part.fraction;
    return { ...part, fraction: compacted.originalToCompacted(sourceFraction) };
  }).filter((part) => part.fraction > 0.0005 && part.fraction < 0.9995);
}

function moveBreakToAdjacentPart(strip, breaks, exclusions, selectedIndex, direction) {
  if (!strip || selectedIndex == null || selectedIndex < 0 || selectedIndex >= (breaks || []).length) {
    return { moved: false, breaks: breaks || [], warning: '' };
  }

  const normalizedExclusions = normalizeExclusions(exclusions || []);
  const compacted = buildCompactedStrip(strip.canvas, normalizedExclusions);
  const currentBreaks = [...(breaks || [])].sort((a, b) => a - b);
  const current = currentBreaks[selectedIndex];
  const previous = selectedIndex > 0 ? currentBreaks[selectedIndex - 1] : 0;
  const next = selectedIndex < currentBreaks.length - 1 ? currentBreaks[selectedIndex + 1] : 1;

  // Work from the compacted strip so a removed band near the end of a part
  // does not make the fit calculation think the page is taller than it really
  // is. Part starts that fall inside an excluded band are not useful snap
  // targets and are ignored.
  const candidates = (strip.partFractions || [])
    .map((part) => part.fraction)
    .filter((fraction) => !normalizedExclusions.some((range) => fraction > range.start && fraction < range.end))
    .filter((fraction) => direction < 0
      ? fraction > previous + 0.002 && fraction < current - 0.002
      : fraction > current + 0.002 && fraction < next - 0.002)
    .sort((a, b) => a - b);

  const candidate = direction < 0 ? candidates[candidates.length - 1] : candidates[0];
  if (candidate == null) {
    return {
      moved: false,
      breaks: currentBreaks,
      warning: direction < 0 ? 'There is no earlier question-part boundary for this page break.' : 'There is no later question-part boundary before the next page break.',
    };
  }

  if (direction > 0) {
    const pageHeight = PAGE_CONTENT_HEIGHT * (compacted.canvas.width / PAGE_CONTENT_WIDTH);
    const previousCompacted = compacted.originalToCompacted(previous) * compacted.canvas.height;
    const candidateCompacted = compacted.originalToCompacted(candidate) * compacted.canvas.height;
    if (candidateCompacted - previousCompacted > pageHeight + 1) {
      const part = (strip.partFractions || []).find((item) => Math.abs(item.fraction - candidate) < 0.0002);
      return {
        moved: false,
        breaks: currentBreaks,
        warning: `${part?.label || 'The next part'} will not fit completely on this A4 page. The break has not moved. If you want to split that part, drag the purple line manually to a suitable point inside the part.`,
      };
    }
  }

  const nextBreaks = [...currentBreaks];
  nextBreaks[selectedIndex] = round4(candidate);
  return { moved: true, breaks: nextBreaks.sort((a, b) => a - b), warning: '' };
}

function PreviewWorkspace({ pages, region, headerPct, footerPct, hasPrevious, hasNext, onPrevious, onNext, currentIndex, totalCount, savedBreaks, onBreaksChange, savedExclusions, onExclusionsChange, globalReviewTrim, onGlobalReviewTrimChange, trimOverrides, onTrimOverridesChange }) {
  const [strip, setStrip] = useState(null);
  const [loading, setLoading] = useState(false);
  const [autoBreaks, setAutoBreaks] = useState([]);
  const [excludeMode, setExcludeMode] = useState(false);
  const [showExcludeHelp, setShowExcludeHelp] = useState(false);
  const [addBreakMode, setAddBreakMode] = useState(false);
  const [individualTrimMode, setIndividualTrimMode] = useState(false);
  const [selectedBreakIndex, setSelectedBreakIndex] = useState(null);
  const [breakWarning, setBreakWarning] = useState('');

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
    setSelectedBreakIndex(null);
    setBreakWarning('');
  }, [region?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!region) { setStrip(null); return undefined; }
    setLoading(true);
    buildQuestionStrip(pages, region, headerPct, footerPct, globalReviewTrim, trimOverrides).then((result) => {
      if (cancelled) return;
      setStrip(result);
      if (!result) { setLoading(false); return; }
      const compacted = buildCompactedStrip(result.canvas, savedExclusions);
      const compactedParts = mapPartsToCompactedStrip(result.partFractions, compacted);
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
  const compactedParts = mapPartsToCompactedStrip(strip.partFractions, compacted);
  // Saved break coordinates refer to the original strip. A break swallowed by
  // an excluded band is no longer a meaningful page boundary: omit it, while
  // preserving the other teacher-selected breaks in compacted coordinates.
  const requestedCompactedBreaks = (savedBreaks || [])
    .filter((fraction) => !compacted.exclusions.some((range) => fraction >= range.start && fraction <= range.end))
    .map((fraction) => compacted.originalToCompacted(fraction));
  const publicationBreaks = keepCompletePartsAtPageBreaks(
    compacted.canvas.width,
    compacted.canvas.height,
    compactedParts,
    requestedCompactedBreaks,
  );
  const compactedBreaks = normalizeBreaksForPageCapacity(
    compacted.canvas.width,
    compacted.canvas.height,
    compactedParts,
    publicationBreaks,
  );
  const effectiveOriginalBreaks = compactedBreaks.map(compacted.compactedToOriginal);
  const manualBreakInsidePart = (savedBreaks || []).map((fraction) => {
    const starts = [0, ...strip.partFractions.map((part) => part.fraction).sort((a, b) => a - b), 1];
    const nearest = starts.reduce((best, start) => Math.min(best, Math.abs(start - fraction)), 1);
    if (nearest <= 0.004) return null;
    const part = [...strip.partFractions].reverse().find((item) => item.fraction < fraction);
    return { fraction, label: part?.label || region.label };
  }).filter(Boolean);
  const finalPages = makeFinalPages(compacted.canvas, compactedBreaks);
  const sourcePages = [];
  for (let page = region.start.page; page <= region.end.page; page += 1) sourcePages.push(page);

  function moveSelectedBreak(direction) {
    const result = moveBreakToAdjacentPart(strip, effectiveOriginalBreaks, savedExclusions, selectedBreakIndex, direction);
    setBreakWarning(result.warning || '');
    if (result.moved) onBreaksChange(result.breaks);
  }

  function removeSelectedBreak() {
    if (selectedBreakIndex == null || selectedBreakIndex < 0 || selectedBreakIndex >= effectiveOriginalBreaks.length) return;
    const remaining = effectiveOriginalBreaks.filter((_, index) => index !== selectedBreakIndex);
    onBreaksChange(remaining);
    setSelectedBreakIndex(null);
    setBreakWarning('');
    setAddBreakMode(false);
  }

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

  function handleExclusionsChange(nextExclusions) {
    if (!strip) {
      onExclusionsChange(nextExclusions);
      return;
    }

    // Page breaks are stored in source-strip coordinates. Excluding a question
    // statement must not move a teacher's break into a different question part.
    // The preview remaps those original coordinates only after compaction.
    const newCompacted = buildCompactedStrip(strip.canvas, nextExclusions);

    // Recalculate the automatic-break suggestion against the newly compacted
    // strip without rebuilding the source strip. Rebuilding here used to replace
    // the whole review workspace with a loading card, which jumped the teacher
    // back to the top of the page after every exclusion.
    const compactedParts = mapPartsToCompactedStrip(strip.partFractions, newCompacted);
    const nextAuto = automaticBreaks(newCompacted.canvas.width, newCompacted.canvas.height, compactedParts)
      .map(newCompacted.compactedToOriginal);
    setAutoBreaks(nextAuto);

    const scrollTop = document.scrollingElement?.scrollTop ?? window.scrollY;
    const scrollLeft = document.scrollingElement?.scrollLeft ?? window.scrollX;
    onExclusionsChange(nextExclusions);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.scrollTo({ top: scrollTop, left: scrollLeft, behavior: 'auto' });
    }));
  }

  return (
    <div className="preview-review-workspace">
      <div className="layout-sticky-controls">
      <div className="preview-toolbar compact-preview-toolbar">
        <div className="preview-title-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button type="button" className="ghost compact" onClick={onPrevious} disabled={!hasPrevious} aria-label="Previous question" title="Previous question" style={{ minWidth: 38, fontSize: '1.2rem', lineHeight: 1 }}>←</button>
            <div><p className="eyebrow">Layout · {currentIndex + 1} of {totalCount}</p><h2>{region.label}</h2></div>
            <button type="button" className="ghost compact" onClick={onNext} disabled={!hasNext} aria-label="Next question" title="Next question" style={{ minWidth: 38, fontSize: '1.2rem', lineHeight: 1 }}>→</button>
          </div>
          <p>Use ← / → to review questions. Click a purple break, then use ↑ / ↓ to jump to the previous/next part boundary; drag it manually to split a part.</p>
        </div>
        <div className="preview-actions">
          <button className={`ghost compact ${excludeMode ? 'active-tool' : ''}`} onClick={() => { setExcludeMode((value) => !value); setAddBreakMode(false); }}>Remove blank space <kbd>X</kbd></button>
          <button className="ghost compact" onClick={() => setShowExcludeHelp((value) => !value)} aria-expanded={showExcludeHelp}>{showExcludeHelp ? 'Hide removal help' : 'How to remove space'}</button>
          <button className={`ghost compact ${addBreakMode ? 'active-tool' : ''}`} onClick={() => { setAddBreakMode((value) => !value); setExcludeMode(false); }}>{addBreakMode ? 'Click crop to place break' : '+ Add page break'}</button>
          {selectedBreakIndex != null && <button className="ghost compact" type="button" onClick={() => moveSelectedBreak(-1)} title="Move selected page break to the previous part boundary">↑ Previous part</button>}
          {selectedBreakIndex != null && <button className="ghost compact" type="button" onClick={() => moveSelectedBreak(1)} title="Move selected page break to the next part boundary">↓ Next part</button>}
          {selectedBreakIndex != null && selectedBreakIndex < effectiveOriginalBreaks.length && <button className="ghost compact" type="button" onClick={removeSelectedBreak} title="Delete the selected purple page break">Remove selected break</button>}
          <button className="ghost compact" onClick={() => { onBreaksChange(autoBreaks); setAddBreakMode(false); setSelectedBreakIndex(null); setBreakWarning(''); }}>Reset smart breaks</button>
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
      </div>

      {manualBreakInsidePart.length > 0 && <div role="alert" style={{ margin: '0 0 10px', padding: '10px 12px', border: '1px solid #e8b85d', borderRadius: 10, background: '#fff8e8', color: '#765116', fontSize: '.82rem', lineHeight: 1.45 }}><strong>Saved page break inside a question part:</strong> {manualBreakInsidePart.map((item) => `${item.label} (${(item.fraction * 100).toFixed(1)}%)`).join(', ')}. This intentionally divides the part across output pages. Drag the purple line to the beginning of the part to keep it together, or use Reset smart breaks.</div>}
      {savedExclusions.some((range) => strip.partFractions.some((part) => part.fraction > range.start && part.fraction < range.end)) && <div role="status" className="exclusion-boundary-warning"><strong>Check excluded question parts:</strong> One or more grey bands cross a blue part boundary. This may be intentional when removing repeated questions from solutions. Review the right-hand preview; drag the top/bottom edge of a grey band to keep more working without restoring the entire band.</div>}
      {breakWarning && <div role="alert" style={{ margin: '0 0 10px', padding: '10px 12px', border: '1px solid #e8b85d', borderRadius: 10, background: '#fff8e8', color: '#765116', fontSize: '.82rem', lineHeight: 1.45 }}><strong>Page fit warning:</strong> {breakWarning}</div>}

      {showExcludeHelp && <div style={{ margin: '0 0 10px', padding: '10px 12px', border: '1px solid #cfd8e6', borderRadius: 10, background: '#fff', color: '#43516a', fontSize: '.82rem', lineHeight: 1.45 }}>
        <strong style={{ color: '#24324a' }}>Remove content or blank space:</strong> click <strong>Remove blank space</strong> (or press <kbd>X</kbd>), then drag vertically across the unwanted band in <strong>Edit crop</strong>. The grey <strong>EXCLUDED</strong> regions are omitted from the output preview and recorded in the saved question/solution JSON. <strong>Drag the top or bottom handle</strong> of a grey region to adjust exactly what is omitted. Double-click the region to restore all of it.
      </div>}

      <div className="preview-grid independent-scroll-grid" key={region.id}>
        <div className="layout-editor-panel" aria-label="Crop editor scroll area" tabIndex={0}>
          <div className="panel-heading compact-panel-heading"><div><h3>Edit crop</h3><p>{excludeMode ? 'Drag across blank space; double-click a removed band to restore it.' : addBreakMode ? 'Click where the new page should end; it will snap to a nearby part boundary.' : 'Purple = page breaks · Blue = part starts'}</p></div><span className="panel-note">{savedExclusions.length} excluded from output</span></div>
          <StripBreakEditor strip={strip} breaks={effectiveOriginalBreaks} onBreaksChange={onBreaksChange} exclusions={savedExclusions} onExclusionsChange={handleExclusionsChange} excludeMode={excludeMode} addBreakMode={addBreakMode} onAddBreakComplete={() => setAddBreakMode(false)} selectedBreakIndex={selectedBreakIndex} onSelectBreak={setSelectedBreakIndex} onBreakWarning={setBreakWarning} />
        </div>
        <div className="final-pages-panel" aria-label="Output preview scroll area" tabIndex={0}>
          <div className="panel-heading compact-panel-heading"><div><h3>Output preview</h3><p>{finalPages.length} A4 page{finalPages.length === 1 ? '' : 's'}</p></div></div>
          <div className="final-page-list">
            {finalPages.map((src, index) => <div className="preview-page-card" key={`${region.id}-${index}`}><span>Page {index + 1}</span><img src={src} alt={`${region.label} final page ${index + 1}`} /></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

function StripBreakEditor({ strip, breaks, onBreaksChange, exclusions, onExclusionsChange, excludeMode, addBreakMode, onAddBreakComplete, selectedBreakIndex, onSelectBreak, onBreakWarning }) {
  const containerRef = useRef(null);
  const [draftExclude, setDraftExclude] = useState(null);

  useEffect(() => {
    if (selectedBreakIndex == null) return undefined;
    function onKeyDown(event) {
      const tag = event.target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const direction = event.key === 'ArrowUp' ? -1 : 1;
      const result = moveBreakToAdjacentPart(strip, breaks, exclusions, selectedBreakIndex, direction);
      onBreakWarning?.(result.warning || '');
      if (result.moved) onBreaksChange(result.breaks);
      event.preventDefault();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [strip, breaks, exclusions, selectedBreakIndex, onBreaksChange, onBreakWarning]);

  function fractionFromEvent(event) {
    const rect = containerRef.current.getBoundingClientRect();
    return clamp((event.clientY - rect.top) / rect.height, 0, 1);
  }

  function snapBreakFraction(fraction, threshold = 0.035) {
    const normalizedExclusions = normalizeExclusions(exclusions);
    const inside = normalizedExclusions.find((range) => fraction > range.start && fraction < range.end);
    if (inside) fraction = Math.abs(fraction - inside.start) < Math.abs(inside.end - fraction) ? inside.start : inside.end;

    const boundaries = [
      ...strip.partFractions.map((part) => part.fraction),
      1,
    ].filter((value) => value > 0.01 && value < 0.99);
    const nearest = boundaries.reduce((best, value) => {
      const distance = Math.abs(value - fraction);
      return !best || distance < best.distance ? { distance, fraction: value } : best;
    }, null);
    if (nearest && nearest.distance <= threshold) return nearest.fraction;
    return fraction;
  }

  function addBreakAt(event) {
    if (!addBreakMode || event.target.closest('.page-break-line') || event.target.closest('.excluded-band')) return false;
    event.preventDefault();
    event.stopPropagation();
    let fraction = clamp(fractionFromEvent(event), 0.02, 0.98);
    fraction = snapBreakFraction(fraction, 0.055);
    if ((breaks || []).some((value) => Math.abs(value - fraction) < 0.012)) return true;
    onBreaksChange([...(breaks || []), round4(fraction)].sort((a, b) => a - b));
    onAddBreakComplete?.();
    return true;
  }

  function updateBreak(index, event) {
    onBreakWarning?.('');
    let fraction = clamp(fractionFromEvent(event), 0.02, 0.98);
    fraction = snapBreakFraction(fraction, 0.03);
    const previous = index > 0 ? breaks[index - 1] : 0;
    const isLastBreak = index === breaks.length - 1;
    const next = isLastBreak ? 1 : breaks[index + 1];
    // Never delete a page break merely because it is dragged close to the
    // end of the strip. Accidental break deletion makes the final worksheet
    // page disappear and leaves no obvious recovery path. Keep a small
    // minimum tail after the last break instead.
    const maxFraction = isLastBreak ? 0.97 : next - 0.025;
    fraction = clamp(fraction, previous + 0.025, maxFraction);
    const nextBreaks = [...breaks];
    nextBreaks[index] = round4(fraction);
    onBreaksChange(nextBreaks.sort((a, b) => a - b));
  }

  function beginBreakDrag(event, index) {
    event.preventDefault(); event.stopPropagation();
    onSelectBreak?.(index);
    onBreakWarning?.('');
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

  // Fine tune an existing excluded band without losing the rest of the crop.
  // Coordinates remain relative to the ORIGINAL strip and are saved unchanged
  // through the existing JSON serialization path.
  function beginExclusionResize(event, range, edge) {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const original = normalizeExclusions(exclusions);
    const stableId = range.id;
    let latest = edge === 'start' ? range.start : range.end;
    target.setPointerCapture(pointerId);
    const move = (moveEvent) => {
      latest = clamp(fractionFromEvent(moveEvent), edge === 'start' ? 0 : range.start + 0.006,
        edge === 'start' ? range.end - 0.006 : 1);
      const next = original.map((item) => item.id !== stableId ? item : {
        ...item, [edge]: round4(latest),
      });
      onExclusionsChange(next);
    };
    const done = () => {
      try { target.releasePointerCapture(pointerId); } catch (_) {}
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', done);
      target.removeEventListener('pointercancel', done);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', done);
    target.addEventListener('pointercancel', done);
  }

  function beginExclude(event) {
    if (addBreakAt(event)) return;
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
    <div ref={containerRef} className={`strip-editor ${excludeMode ? 'exclude-mode' : ''} ${addBreakMode ? 'add-break-mode' : ''}`} onPointerDown={beginExclude}>
      <img src={strip.dataUrl} alt="Continuous cleaned question" />
      {strip.partFractions.map((part) => <div key={part.id} className="preview-part-guide" style={{ top: `${part.fraction * 100}%` }}><span>{part.label}</span></div>)}
      {normalizeExclusions(exclusions).map((range, index) => (
        <div key={range.id || `exclude-${index}`} className="excluded-band" style={{ top: `${range.start * 100}%`, height: `${(range.end - range.start) * 100}%` }} onDoubleClick={(event) => { event.stopPropagation(); onExclusionsChange((exclusions || []).filter((item) => item.id !== range.id)); }} title="Excluded from final output. Double-click to restore.">
          <button type="button" className="exclusion-resize-handle top" title="Drag to adjust where the exclusion starts" aria-label={`Adjust top of excluded band ${index + 1}`} onPointerDown={(event) => beginExclusionResize(event, range, 'start')}>↕ top</button>
          <span>EXCLUDED {index + 1} · {((range.end - range.start) * 100).toFixed(1)}% · double-click to restore</span>
          <button type="button" className="exclusion-resize-handle bottom" title="Drag to adjust where the exclusion ends" aria-label={`Adjust bottom of excluded band ${index + 1}`} onPointerDown={(event) => beginExclusionResize(event, range, 'end')}>↕ bottom</button>
        </div>
      ))}
      {draftExclude && <div className="excluded-band draft" style={{ top: `${draftTop * 100}%`, height: `${draftHeight * 100}%` }}><span>Exclude this gap</span></div>}
      {breaks.map((fraction, index) => (
        <div key={`break-${index}`} className={`page-break-line ${selectedBreakIndex === index ? 'selected' : ''}`} style={{ top: `${fraction * 100}%`, filter: selectedBreakIndex === index ? 'drop-shadow(0 0 4px rgba(87, 42, 220, .65))' : undefined }} onPointerDown={(event) => beginBreakDrag(event, index)} title="Click to select. Use ↑ / ↓ to jump to adjacent part boundaries, or drag to split a part manually.">
          <span>PAGE {index + 1} END {selectedBreakIndex === index ? '· selected' : '↕'}</span>
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<React.StrictMode><AppErrorBoundary><App /></AppErrorBoundary></React.StrictMode>);
