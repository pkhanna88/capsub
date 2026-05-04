// =============================================================
// CapSub demo — interactive transcript with synchronized playback
// =============================================================

const video = document.getElementById('video');
const transcriptEl = document.getElementById('transcript');
const transcriptScroll = document.getElementById('transcript-scroll');
const qaListEl = document.getElementById('qa-list');
const qaToggleBtn = document.getElementById('qa-toggle');
const qaToggleLabel = document.getElementById('qa-toggle-label');
const captionEl = document.getElementById('caption-overlay');
const searchInput = document.getElementById('search-input');
const searchCountEl = document.getElementById('search-count');
const searchClearBtn = document.getElementById('search-clear');

// State
let transcriptData = null;
let allWords = [];
let segmentEls = [];
let qaItemEls = [];
let activeSegIdx = -1;
let activeQaIdx = -1;
let userIsScrolling = false;
let userScrollTimeout = null;
let pendingSeek = null;
let pendingSeekShouldPlay = false;
let seekPlayTimeout = null;
let currentSearchTerm = '';
let qaShowAll = false;       // false = high-confidence only, true = all

const SEEK_TOLERANCE = 0.35;

// =============================================================
// Helpers
// =============================================================
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function parseDurationTarget(value) {
  const parts = value.split(':').map(Number);
  if (parts.some(part => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => (total * 60) + part, 0);
}

// =============================================================
// Stat counter animation on load
// =============================================================
function animateStats() {
  document.querySelectorAll('.stat-num').forEach(el => {
    const rawTarget = el.dataset.target || '0';
    const isDuration = rawTarget.includes(':');
    const target = isDuration ? parseDurationTarget(rawTarget) : parseInt(rawTarget, 10);
    if (!Number.isFinite(target)) {
      el.textContent = rawTarget;
      return;
    }
    const duration = 900;
    const startTime = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = Math.round(target * eased);
      el.textContent = isDuration ? formatTime(current) : current;
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

// =============================================================
// Render transcript
// Spaces are separate spans so single-word search matches do not absorb
// trailing whitespace, while phrase matches can still fill the gaps.
// =============================================================
function renderTranscript(segments) {
  transcriptEl.innerHTML = '';
  segmentEls = [];
  allWords = [];

  segments.forEach((seg, segIdx) => {
    const speaker = seg.speaker || 'professor';
    const isStudent = speaker === 'student';
    const corrections = seg.corrections || [];
    const correctedOriginals = new Set(
      corrections.map(c => (c.original || '').toLowerCase().replace(/[^\w']/g, ''))
    );

    const segDiv = document.createElement('div');
    segDiv.className = `segment segment-${speaker}`;
    segDiv.dataset.segIdx = segIdx;
    segDiv.dataset.start = seg.start;
    segDiv.dataset.end = seg.end;
    segDiv.dataset.speaker = speaker;
    segDiv.dataset.text = seg.text || '';
    segDiv.dataset.searchText = (seg.text || '').toLowerCase();

    const timeDiv = document.createElement('div');
    timeDiv.className = 'segment-time';
    timeDiv.textContent = formatTime(seg.start);
    timeDiv.title = 'Click to jump to this moment';
    timeDiv.addEventListener('click', () => seekTo(seg.start));

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'segment-body';

    const spkSpan = document.createElement('span');
    spkSpan.className = 'segment-speaker';
    spkSpan.textContent = isStudent ? 'Student' : 'Professor';
    bodyDiv.appendChild(spkSpan);
    // Single space after the speaker label (text node is fine here, no search match)
    bodyDiv.appendChild(document.createTextNode(' '));

    if (Array.isArray(seg.words) && seg.words.length > 0) {
      seg.words.forEach((w, idx) => {
        const wordSpan = document.createElement('span');
        wordSpan.className = 'word unspoken';
        const cleanWord = (w.word || '').trim();
        const isLast = idx === seg.words.length - 1;
        wordSpan.textContent = cleanWord;
        // Keep a clean version for search matching
        wordSpan.dataset.text = cleanWord.toLowerCase();
        const cleanKey = cleanWord.toLowerCase().replace(/[^\w']/g, '');
        if (correctedOriginals.has(cleanKey)) {
          wordSpan.classList.add('corrected');
          wordSpan.title = 'Corrected by post-processor';
        }
        wordSpan.addEventListener('click', () => {
          if (Number.isFinite(w.start)) seekTo(w.start);
        });
        bodyDiv.appendChild(wordSpan);
        if (!isLast) {
          const gapSpan = document.createElement('span');
          gapSpan.className = 'word-gap';
          gapSpan.textContent = ' ';
          bodyDiv.appendChild(gapSpan);
        }

        if (Number.isFinite(w.start) && Number.isFinite(w.end)) {
          allWords.push({
            wordEl: wordSpan,
            start: w.start,
            end: w.end,
            segIdx: segIdx,
          });
        }
      });
    } else {
      const textSpan = document.createElement('span');
      textSpan.textContent = seg.text || '';
      bodyDiv.appendChild(textSpan);
    }

    segDiv.appendChild(timeDiv);
    segDiv.appendChild(bodyDiv);
    transcriptEl.appendChild(segDiv);
    segmentEls.push(segDiv);
  });
}

// =============================================================
// Render Q&A points
// =============================================================
function renderQa(qaPoints) {
  qaListEl.innerHTML = '';
  qaItemEls = [];

  if (!qaPoints || qaPoints.length === 0) {
    const empty = document.createElement('p');
    empty.style.fontFamily = 'var(--sans)';
    empty.style.fontSize = '0.85rem';
    empty.style.color = 'var(--ink-faint)';
    empty.textContent = 'No Q&A points detected.';
    qaListEl.appendChild(empty);
    qaToggleBtn.hidden = true;
    return;
  }

  const sorted = [...qaPoints].sort((a, b) => a.student_start - b.student_start);

  sorted.forEach((qa) => {
    const item = document.createElement('div');
    item.className = 'qa-item';
    item.dataset.start = qa.student_start;
    item.dataset.end = qa.student_end;
    item.dataset.confidence = qa.confidence || 'low';

    const start = formatTime(qa.student_start);
    const end = formatTime(qa.student_end);
    const conf = qa.confidence || 'low';

    const cueText = (qa.cue_types && qa.cue_types.length > 0)
      ? qa.cue_types.map(c => c.replace(/_/g, ' ')).join(', ')
      : null;

    const signals = (qa.signals || []).map(s => s.replace('_', ' ')).join(' + ');

    let detailHtml = '';
    if (cueText) {
      detailHtml = `<div class="qa-detail">Cue: <span class="qa-cue">${escapeHtml(cueText)}</span></div>`;
    } else {
      detailHtml = `<div class="qa-detail">Detected from acoustic gap.</div>`;
    }

    item.innerHTML = `
      <div class="qa-row">
        <span class="qa-time">${start} – ${end}</span>
        <span class="qa-conf conf-${conf}">${conf}</span>
      </div>
      ${detailHtml}
      <div class="qa-signals">${escapeHtml(signals)}</div>
    `;

    item.addEventListener('click', () => seekTo(qa.student_start));

    qaListEl.appendChild(item);
    qaItemEls.push({
      el: item,
      start: qa.student_start,
      end: qa.student_end,
      confidence: qa.confidence || 'low',
    });
  });

  applyQaFilter();
}

// =============================================================
// Q&A filter (high-confidence only by default; toggle to show all)
// =============================================================
function applyQaFilter() {
  const total = qaItemEls.length;
  const highCount = qaItemEls.filter(q => q.confidence === 'high').length;
  const hiddenCount = total - highCount;

  qaItemEls.forEach(q => {
    if (qaShowAll || q.confidence === 'high') {
      q.el.classList.remove('qa-hidden');
    } else {
      q.el.classList.add('qa-hidden');
    }
  });

  // Hide the toggle if there are no lower-confidence items to reveal
  if (hiddenCount === 0) {
    qaToggleBtn.hidden = true;
  } else {
    qaToggleBtn.hidden = false;
    if (qaShowAll) {
      qaToggleLabel.textContent = `Show high-confidence only`;
    } else {
      qaToggleLabel.textContent = `Show all (${hiddenCount} hidden)`;
    }
  }
}

if (qaToggleBtn) {
  qaToggleBtn.addEventListener('click', () => {
    qaShowAll = !qaShowAll;
    applyQaFilter();
  });
}

// =============================================================
// Centralized seek with readiness handling
// =============================================================
function isVideoReadyToSeek() {
  return video.readyState >= 1;
}

function playVideo() {
  if (video.paused) {
    video.play().catch(() => {});
  }
}

function setVideoTime(targetTime) {
  try {
    video.currentTime = targetTime;
  } catch (err) {
    return false;
  }
  return video.seeking || Math.abs(video.currentTime - targetTime) <= SEEK_TOLERANCE;
}

function playAfterSeekSettles(targetTime) {
  clearTimeout(seekPlayTimeout);

  const finish = () => {
    clearTimeout(seekPlayTimeout);
    video.removeEventListener('seeked', finish);
    updateHighlight();

    if (Math.abs(video.currentTime - targetTime) <= SEEK_TOLERANCE) {
      playVideo();
      return;
    }

    pendingSeek = targetTime;
    pendingSeekShouldPlay = true;
    video.pause();
    video.preload = 'auto';
    video.load();
  };

  if (video.seeking) {
    video.addEventListener('seeked', finish, { once: true });
    seekPlayTimeout = setTimeout(finish, 700);
  } else {
    finish();
  }
}

function performSeek(targetTime, shouldPlay) {
  if (!setVideoTime(targetTime)) return false;
  updateHighlight();
  if (shouldPlay) {
    playAfterSeekSettles(targetTime);
  }
  return true;
}

function applyPendingSeek() {
  if (!isVideoReadyToSeek()) return;
  if (pendingSeek !== null) {
    const t = pendingSeek;
    const shouldPlay = pendingSeekShouldPlay;
    if (performSeek(t, shouldPlay)) {
      pendingSeek = null;
      pendingSeekShouldPlay = false;
    }
  }
}

function seekTo(targetTime) {
  if (!Number.isFinite(targetTime)) return;
  pendingSeek = targetTime;
  pendingSeekShouldPlay = true;

  if (!isVideoReadyToSeek()) {
    video.pause();
    video.preload = 'auto';
    video.load();
    setVideoTime(targetTime);
    return;
  }

  if (performSeek(targetTime, true)) {
    pendingSeek = null;
    pendingSeekShouldPlay = false;
    return;
  }

  video.pause();
  video.preload = 'auto';
  video.load();
}

video.addEventListener('loadedmetadata', applyPendingSeek);
video.addEventListener('durationchange', applyPendingSeek);
video.addEventListener('loadeddata', applyPendingSeek);
video.addEventListener('canplay', applyPendingSeek);
video.addEventListener('canplaythrough', applyPendingSeek);
video.addEventListener('progress', applyPendingSeek);
video.addEventListener('suspend', applyPendingSeek);

// =============================================================
// Synchronize highlighting with video playback
// =============================================================
function updateHighlight() {
  const t = video.currentTime;

  // ----- Word spoken/unspoken state -----
  for (let i = 0; i < allWords.length; i++) {
    const w = allWords[i];
    if (t >= w.end) {
      if (!w.wordEl.classList.contains('spoken')) {
        w.wordEl.classList.remove('unspoken');
        w.wordEl.classList.add('spoken');
      }
    } else if (t < w.start) {
      if (!w.wordEl.classList.contains('unspoken')) {
        w.wordEl.classList.remove('spoken');
        w.wordEl.classList.add('unspoken');
      }
    }
  }

  // ----- Segment highlight + caption update -----
  let newSegIdx = -1;
  for (let i = 0; i < segmentEls.length; i++) {
    const segEl = segmentEls[i];
    const start = parseFloat(segEl.dataset.start);
    const end = parseFloat(segEl.dataset.end);
    if (t >= start && t < end) {
      newSegIdx = i;
      break;
    }
  }

  if (newSegIdx !== activeSegIdx) {
    if (activeSegIdx >= 0 && segmentEls[activeSegIdx]) {
      segmentEls[activeSegIdx].classList.remove('is-current');
    }

    if (newSegIdx >= 0) {
      const newSegEl = segmentEls[newSegIdx];
      newSegEl.classList.add('is-current');

      if (captionEl) {
        const text = newSegEl.dataset.text || '';
        const isStud = newSegEl.classList.contains('segment-student');
        captionEl.textContent = text;
        captionEl.classList.toggle('caption-student', isStud);
        captionEl.classList.toggle('is-visible', text.length > 0);
      }

      if (!userIsScrolling && !currentSearchTerm) {
        const scrollRect = transcriptScroll.getBoundingClientRect();
        const segRect = newSegEl.getBoundingClientRect();
        const offset = segRect.top - scrollRect.top - scrollRect.height / 2 + segRect.height / 2;
        if (Math.abs(offset) > 40) {
          transcriptScroll.scrollBy({ top: offset, behavior: 'smooth' });
        }
      }
    } else {
      if (captionEl) {
        captionEl.classList.remove('is-visible');
      }
    }

    activeSegIdx = newSegIdx;
  }

  // ----- Q&A item highlight -----
  let newQaIdx = -1;
  for (let i = 0; i < qaItemEls.length; i++) {
    const q = qaItemEls[i];
    if (t >= q.start && t <= q.end) {
      newQaIdx = i;
      break;
    }
  }
  if (newQaIdx !== activeQaIdx) {
    if (activeQaIdx >= 0 && qaItemEls[activeQaIdx]) {
      qaItemEls[activeQaIdx].el.classList.remove('is-current');
    }
    if (newQaIdx >= 0) {
      qaItemEls[newQaIdx].el.classList.add('is-current');
    }
    activeQaIdx = newQaIdx;
  }
}

// =============================================================
// Search functionality (phrase-aware highlighting)
// =============================================================

// Tokenize a search phrase into individual words for matching against
// the per-word spans. We strip non-word characters except apostrophes
// to match how the transcript words are stored.
function tokenizeSearch(term) {
  return term
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^\w']/g, ''))
    .filter(w => w.length > 0);
}

function getWordTextClean(wordSpan) {
  // wordSpan.dataset.text is the original lowercased word (no trailing space)
  // strip non-word/non-apostrophe chars for comparison
  return (wordSpan.dataset.text || '').replace(/[^\w']/g, '');
}

const searchMatchClasses = [
  'search-match',
  'search-match-start',
  'search-match-middle',
  'search-match-end',
];

function clearSearchHighlights() {
  document
    .querySelectorAll('.search-match, .search-match-start, .search-match-middle, .search-match-end')
    .forEach(el => el.classList.remove(...searchMatchClasses));
}

function markSearchRun(wordSpans, startIdx, length) {
  for (let j = 0; j < length; j++) {
    const wordSpan = wordSpans[startIdx + j];
    wordSpan.classList.add('search-match');

    if (length > 1) {
      if (j === 0) {
        wordSpan.classList.add('search-match-start');
      } else if (j === length - 1) {
        wordSpan.classList.add('search-match-end');
      } else {
        wordSpan.classList.add('search-match-middle');
      }

      if (j < length - 1) {
        const gapSpan = wordSpan.nextElementSibling;
        if (gapSpan && gapSpan.classList.contains('word-gap')) {
          gapSpan.classList.add('search-match', 'search-match-middle');
        }
      }
    }
  }
}

function applySearch(rawTerm) {
  const term = rawTerm.trim();
  currentSearchTerm = term.toLowerCase();

  // Clear previous match highlights
  clearSearchHighlights();
  // Remove any previous "no results" message
  const existingEmpty = transcriptScroll.querySelector('.search-empty');
  if (existingEmpty) existingEmpty.remove();

  if (!term) {
    segmentEls.forEach(seg => seg.classList.remove('search-hidden'));
    searchCountEl.textContent = '';
    searchClearBtn.hidden = true;
    return;
  }

  searchClearBtn.hidden = false;

  const tokens = tokenizeSearch(term);
  if (tokens.length === 0) {
    segmentEls.forEach(seg => seg.classList.remove('search-hidden'));
    searchCountEl.textContent = '';
    return;
  }

  let segmentsWithMatches = 0;

  segmentEls.forEach(seg => {
    // Phrase-aware match: find consecutive runs of words that match the
    // tokenized search phrase, then highlight that whole run as one phrase.
    const wordSpans = Array.from(seg.querySelectorAll('.word'));
    const wordTexts = wordSpans.map(getWordTextClean);
    let segmentHasMatch = false;

    if (wordSpans.length === 0) {
      segmentHasMatch = (seg.dataset.searchText || '').includes(currentSearchTerm);
    }

    // Sliding window: try to find tokens[] starting at each word index
    for (let i = 0; i <= wordTexts.length - tokens.length; i++) {
      let allMatch = true;
      for (let j = 0; j < tokens.length; j++) {
        const wt = wordTexts[i + j];
        const tk = tokens[j];
        // Allow partial match for the *first and last* token (so searching
        // "entrop" matches "entropy"). Middle tokens require exact match.
        if (j === 0 || j === tokens.length - 1) {
          if (!wt.includes(tk)) { allMatch = false; break; }
        } else {
          if (wt !== tk) { allMatch = false; break; }
        }
      }
      if (allMatch) {
        markSearchRun(wordSpans, i, tokens.length);
        segmentHasMatch = true;
      }
    }

    // Single-token search: also catch matches we may have missed
    // (substring matches inside a single word) — already handled above
    // for length-1 tokens since both first and last conditions apply.
    if (segmentHasMatch) {
      seg.classList.remove('search-hidden');
      segmentsWithMatches++;
    } else {
      seg.classList.add('search-hidden');
    }
  });

  if (segmentsWithMatches === 0) {
    searchCountEl.textContent = '0 results';
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = `No matches for "${term}"`;
    transcriptScroll.appendChild(empty);
  } else {
    const segWord = segmentsWithMatches === 1 ? 'segment' : 'segments';
    searchCountEl.textContent = `${segmentsWithMatches} ${segWord}`;
  }

  transcriptScroll.scrollTop = 0;
}

let searchDebounce = null;
searchInput.addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const value = e.target.value;
  searchDebounce = setTimeout(() => applySearch(value), 120);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    applySearch('');
    searchInput.blur();
  }
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  applySearch('');
  searchInput.focus();
});

// =============================================================
// User scroll detection
// =============================================================
transcriptScroll.addEventListener('wheel', () => {
  userIsScrolling = true;
  clearTimeout(userScrollTimeout);
  userScrollTimeout = setTimeout(() => { userIsScrolling = false; }, 2000);
}, { passive: true });

transcriptScroll.addEventListener('touchmove', () => {
  userIsScrolling = true;
  clearTimeout(userScrollTimeout);
  userScrollTimeout = setTimeout(() => { userIsScrolling = false; }, 2000);
}, { passive: true });

// =============================================================
// Boot
// =============================================================
async function init() {
  animateStats();

  try {
    const res = await fetch('transcript.json');
    if (!res.ok) throw new Error(`Failed to load transcript.json: ${res.status}`);
    transcriptData = await res.json();
  } catch (err) {
    console.error(err);
    transcriptEl.innerHTML = `
      <div style="padding: 2rem; font-family: var(--sans); color: var(--ink-faint);">
        Could not load transcript.json. Make sure it's in the same folder as index.html.
      </div>`;
    return;
  }

  renderTranscript(transcriptData.segments || []);
  renderQa(transcriptData.qa_points || []);

  video.addEventListener('timeupdate', updateHighlight);
  video.addEventListener('seeked', updateHighlight);

  updateHighlight();
}

init();
