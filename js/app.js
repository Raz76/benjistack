/* ============================================================
   URBANVOICE — APP.JS
   Central state manager and navigation controller.
   All screen transitions and step progression flow through here.
   ============================================================ */

'use strict';

const FREE_VALIDATION_CONSUMED_KEY = 'benjistack_free_validation_consumed';

// ----------------------------------------------------------------
// GLOBAL STATE
// ----------------------------------------------------------------
const STATE = {
  currentStep: 0,
  rawIdea: '',
  selectedAngle: null,
  selectedProblem: null,
  selectedSolution: null,
  selectedBrand: null,
  angles: [],
  problems: [],
  solutions: [],
  validations: [],   // pre-computed array of 5 validation objects (one per solution)
  validation: null,  // the selected solution's validation (set on card click)
  brandOptions: [],
  anglesSkipped: false,
  nearMissNote: '',
  // Gate / rate limiting
  ownerMode: false,
  confirmed: false,
  dailyCount: 0,
  dailyLimit: 1,
  gateSubmitted: false,
  freeValidationConsumed: false,
};

const STEPS = [
  null,          // 0: landing
  'angles',      // 1: search + evaluate (or niche picker if too broad)
  'problems',    // 2: problem picker
  'solutions',   // 3: solution picker (validation pre-computed here)
  'validation',  // 4: validation detail — instant, data already cached
  'summary',     // 5: final summary
];

function hasConsumedFreeValidation() {
  return STATE.freeValidationConsumed || localStorage.getItem(FREE_VALIDATION_CONSUMED_KEY) === 'true';
}

function markFreeValidationConsumed() {
  STATE.freeValidationConsumed = true;
  localStorage.setItem(FREE_VALIDATION_CONSUMED_KEY, 'true');
}

function clearFreeValidationConsumed() {
  STATE.freeValidationConsumed = false;
  localStorage.removeItem(FREE_VALIDATION_CONSUMED_KEY);
}

// ----------------------------------------------------------------
// RATE LIMITING — Worker-based (IP tracked server-side)
// ----------------------------------------------------------------
async function checkRateStatus() {
  if (STATE.ownerMode) return;
  try {
    const headers = { 'x-api-key': UV_SECRET };
    if (STATE.ownerMode) headers['X-Owner-Token'] = OWNER_TOKEN;
    const res  = await fetch(`${WORKER_URL}/rate-check`, { headers });
    if (!res.ok) return;
    const data = await res.json();
    STATE.confirmed  = data.confirmed  || false;
    STATE.dailyCount = data.count      || 0;
    STATE.dailyLimit = data.limit      || 1;
  } catch {
    // fail open — don't block users if Worker has a hiccup
  }
}

// Returns true if the journey was gated (caller should abort), false if clear to proceed.
async function checkJourneyStart() {
  if (STATE.ownerMode) return false;
  try {
    const headers = { 'x-api-key': UV_SECRET, 'Content-Type': 'application/json' };
    const res = await fetch(`${WORKER_URL}/journey-start`, { method: 'POST', headers });
    if (res.ok) {
      const data = await res.json();
      STATE.dailyCount++;
      STATE.dailyLimit = data.remaining !== undefined
        ? STATE.dailyCount + data.remaining
        : STATE.dailyLimit;
      return false; // clear to proceed
    }
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      if (data.reason === 'unconfirmed') {
        STATE.gateSubmitted ? showPendingConfirmation() : showEmailGate();
      } else {
        showDailyLimitWall();
      }
      return true; // gated
    }
  } catch {
    return false; // fail open
  }
  return false;
}

// ----------------------------------------------------------------
// EMAIL GATE MODAL — GHL iframe form
// ----------------------------------------------------------------
function showEmailGate() {
  const existing = document.getElementById('gate-modal');
  window.removeEventListener('message', handleGHLMessage);
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'gate-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal gate-modal">
      <h2 class="modal-title">Join BenjiStack for free</h2>
      <p class="modal-desc">
        You've used your free idea validation. Join BenjiStack for free and confirm your email to unlock up to 3 idea validations per day.
      </p>
      <div class="gate-iframe-wrap">
        <iframe
          style="width:100%;height:412px;border:none;border-radius:3px"
          id="inline-lDgjUTQXJ4CuJBhzanD4"
          data-layout="{'id':'INLINE'}"
          data-trigger-type="alwaysShow"
          data-activation-type="alwaysActivated"
          data-deactivation-type="neverDeactivate"
          data-form-name="Urban Voice Discover Gate"
          data-height="412"
          data-layout-iframe-id="inline-lDgjUTQXJ4CuJBhzanD4"
          data-form-id="lDgjUTQXJ4CuJBhzanD4"
          title="Urban Voice Discover Gate">
        </iframe>
      </div>
      <p class="modal-note" style="margin-top:14px;">
        Already subscribed? Use the same email here. You'll need to confirm your free subscription before continuing.
      </p>
    </div>
  `;
  document.body.appendChild(overlay);
  window.addEventListener('message', handleGHLMessage);
}

function handleGHLMessage(event) {
  if (!event.data) return;
  const d = event.data;
  const isSubmit =
    (typeof d === 'string' && d.includes('form_submitted')) ||
    (typeof d === 'object' && (
      d.type === 'form_submitted' ||
      d.event === 'formSubmit' ||
      d.page?.url?.includes('submitted')
    ));
  if (!isSubmit) return;

  window.removeEventListener('message', handleGHLMessage);
  STATE.gateSubmitted = true;
  localStorage.setItem('uv_gate_submitted', 'true');

  const modal = document.getElementById('gate-modal')?.querySelector('.modal');
  if (modal) {
    modal.innerHTML = `
      <h2 class="modal-title">Almost there!</h2>
      <p class="modal-desc">
        Check your email and click the confirmation link to finish joining BenjiStack for free and unlock up to 3 idea validations per day.
      </p>
      <p class="modal-note" style="margin-top:16px;">
        You can also read the newsletter now.
      </p>
      <a href="${BOOKING_LINK}" target="_blank" class="btn-primary"
         style="display:block;text-align:center;margin-top:12px;text-decoration:none;">
        Open the BenjiStack Newsletter →
      </a>
      <button class="btn-secondary" id="btn-gate-close"
              style="width:100%;margin-top:10px;">
        Close
      </button>
    `;
    document.getElementById('btn-gate-close')?.addEventListener('click', () => {
      document.getElementById('gate-modal')?.remove();
    });
  }
}

function showPendingConfirmation() {
  const existing = document.getElementById('gate-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'gate-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2 class="modal-title">Check Your Email</h2>
      <p class="modal-desc">
        Click the confirmation link we sent you to finish joining BenjiStack for free and unlock up to 3 idea validations per day.
      </p>
      <a href="${BOOKING_LINK}" target="_blank" class="btn-primary"
         style="display:block;text-align:center;margin-top:20px;text-decoration:none;">
        Open the BenjiStack Newsletter →
      </a>
      <button class="btn-secondary" id="btn-gate-close"
              style="width:100%;margin-top:10px;">
        Close
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('btn-gate-close').addEventListener('click', () => overlay.remove());
}

function showDailyLimitWall() {
  const existing = document.getElementById('gate-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'gate-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2 class="modal-title">You're on a roll.</h2>
      <p class="modal-desc">
        You've used all 3 idea validations for today. Your limit resets at midnight UTC.
        In the meantime, you can read the BenjiStack newsletter for more validated ideas.
      </p>
      <a href="${BOOKING_LINK}" target="_blank" class="btn-primary"
         style="display:block;text-align:center;margin-top:20px;text-decoration:none;">
        Open the BenjiStack Newsletter →
      </a>
      <button class="btn-secondary" id="btn-gate-close"
              style="width:100%;margin-top:10px;">
        Come Back Tomorrow
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('btn-gate-close').addEventListener('click', () => overlay.remove());
}

function showConfirmationSuccess() {
  const existing = document.getElementById('gate-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'gate-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2 class="modal-title">You're confirmed</h2>
      <p class="modal-desc">
        Your free subscription is confirmed. You can now validate up to 3 ideas per day.
      </p>
      <button class="btn-primary" id="btn-gate-close"
              style="width:100%;margin-top:16px;">
        Continue
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('btn-gate-close').addEventListener('click', () => overlay.remove());
}

// ----------------------------------------------------------------
// NAVIGATION
// ----------------------------------------------------------------
function goTo(stepName) {
  const stepIndex = STEPS.indexOf(stepName);
  STATE.currentStep = stepIndex;
  updateProgressDots(stepIndex);
  renderScreen(stepName);
}

function goBack() {
  if (!STATE.confirmed && hasConsumedFreeValidation() && STATE.currentStep === STEPS.indexOf('summary')) {
    showEmailGate();
    return;
  }

  // If going back from problems and angles was skipped, return to landing
  if (STATE.currentStep === STEPS.indexOf('problems') && STATE.anglesSkipped) {
    STATE.currentStep = 0;
    updateProgressDots(0);
    renderScreen('landing');
    return;
  }

  const prev = STATE.currentStep - 1;
  if (prev <= 0) {
    STATE.currentStep = 0;
    updateProgressDots(0);
    renderScreen('landing');
    return;
  }
  const prevStep = STEPS[prev];
  goTo(prevStep);
}

// ----------------------------------------------------------------
// PROGRESS DOTS
// ----------------------------------------------------------------
function updateProgressDots(activeIndex) {
  const bar       = document.getElementById('progress-bar');
  const container = document.getElementById('progress-dots');

  if (activeIndex <= 0) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  container.innerHTML = '';

  for (let i = 1; i < STEPS.length; i++) {
    const dot = document.createElement('div');
    dot.className = 'progress-dot';
    if (i < activeIndex) dot.classList.add('done');
    if (i === activeIndex) dot.classList.add('active');
    container.appendChild(dot);
  }
}

// ----------------------------------------------------------------
// SCREEN ROUTER
// ----------------------------------------------------------------
function renderScreen(stepName) {
  const container = document.getElementById('screen-container');
  container.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));

  switch (stepName) {
    case null:
    case 'landing':    showLandingScreen();              break;
    case 'angles':     renderAnglesScreen(container);    break;
    case 'problems':   renderProblemsScreen(container);  break;
    case 'solutions':  renderSolutionsScreen(container); break;
    case 'validation': renderValidationScreen(container);break;
    case 'summary':    renderSummaryScreen(container);   break;
    default: console.warn('Unknown step:', stepName);
  }
}

// ----------------------------------------------------------------
// LANDING SCREEN
// ----------------------------------------------------------------
function showLandingScreen() {
  const screen    = document.getElementById('screen-landing');
  screen.classList.add('active');

  const input     = document.getElementById('idea-input');
  const btn       = document.getElementById('btn-discover');
  const charCount = document.getElementById('char-count');

  if (STATE.rawIdea) {
    input.value = STATE.rawIdea;
    charCount.textContent = STATE.rawIdea.length;
    btn.disabled = STATE.rawIdea.trim().length < 3;
  }

  input.addEventListener('input', () => {
    charCount.textContent = input.value.length;
    btn.disabled = input.value.trim().length < 3;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !btn.disabled) handleDiscover();
  });

  btn.addEventListener('click', handleDiscover);
}

async function handleDiscover() {
  const input = document.getElementById('idea-input');
  const idea  = input.value.trim();
  if (!idea || idea.length < 3) return;

  if (!STATE.confirmed && hasConsumedFreeValidation()) {
    showEmailGate();
    return;
  }

  const gated = await checkJourneyStart();
  if (gated) return;

  STATE.rawIdea = idea;
  goTo('angles');
}

// ----------------------------------------------------------------
// CONFIRMATION HANDLER — called on ?confirmed=true in URL
// ----------------------------------------------------------------
async function handleEmailConfirmation() {
  try {
    const headers = { 'x-api-key': UV_SECRET, 'Content-Type': 'application/json' };
    await fetch(`${WORKER_URL}/confirm`, { method: 'POST', headers });
    STATE.confirmed  = true;
    STATE.dailyLimit = 3;
    STATE.gateSubmitted = false;
    localStorage.removeItem('uv_gate_submitted');
    clearFreeValidationConsumed();
  } catch {
    // fail silently — they'll just hit the gate again if needed
  }
}

function loadDebugSample() {
  Object.assign(STATE, {
    rawIdea: 'content business for wedding cake guides',
    selectedAngle: 'content + affiliate for wedding cake planning',
    selectedProblem: {
      title: 'Planning wedding cake details is confusing',
      description: 'People struggle to compare cake styles, servings, design choices, and what different decoration levels actually cost before talking to suppliers.',
      quotes: [
        'I have no idea how much cake I actually need for 85 guests.',
        'Every bakery shows pretty photos, but not enough practical guidance.'
      ]
    },
    selectedSolution: {
      title: 'Wedding Cake Planner + Vendor Guide',
      description: 'A content-led business that helps couples choose cake styles, estimate servings, compare options, and discover trusted tools or vendors.',
      score: 7
    },
    selectedBrand: {
      name: 'Cake Path',
      tagline: 'Choose your wedding cake with less stress',
      targetAudience: 'Engaged couples planning weddings',
      positioning: 'A calm, practical planning companion for couples comparing wedding cake options.'
    },
    validation: {
      opportunityScore: 7,
      monetizable: true,
      willingnessToPay: 'Medium',
      estimatedPriceRange: '€19–€79 for digital products, higher for services',
      currentAlternatives: ['Pinterest boards', 'Bakery blogs', 'Wedding planning forums'],
      verdict: 'There is clear planning friction here. This looks more promising as a content + affiliate or digital planning business than as a broad generic wedding blog.'
    }
  });
}

// ----------------------------------------------------------------
// INIT
// ----------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);

  // Owner mode activation
  if (params.get('owner') === OWNER_TOKEN) {
    localStorage.setItem('uv_owner', 'true');
    params.delete('owner');
    const clean = params.toString();
    history.replaceState({}, '', clean ? `?${clean}` : window.location.pathname);
  }

  // Owner mode deactivation
  if (params.has('reset_owner')) {
    localStorage.removeItem('uv_owner');
    params.delete('reset_owner');
    const clean = params.toString();
    history.replaceState({}, '', clean ? `?${clean}` : window.location.pathname);
  }

  // Email confirmation from GHL link
  let justConfirmed = false;
  if (params.has('confirmed')) {
    await handleEmailConfirmation();
    justConfirmed = true;
    params.delete('confirmed');
    const clean = params.toString();
    history.replaceState({}, '', clean ? `?${clean}` : window.location.pathname);
  }

  // Restore owner mode from localStorage
  if (localStorage.getItem('uv_owner') === 'true') {
    STATE.ownerMode = true;
  }

  // Restore gate-submitted flag
  if (localStorage.getItem('uv_gate_submitted') === 'true') {
    STATE.gateSubmitted = true;
  }

  if (localStorage.getItem(FREE_VALIDATION_CONSUMED_KEY) === 'true') {
    STATE.freeValidationConsumed = true;
  }

  if (params.has('sample_report') || params.has('sample_pdf')) {
    loadDebugSample();
    localStorage.setItem(PDF_ACCESS_KEY, 'granted');
    goTo('summary');
    if (params.has('print_report') || params.has('download_pdf')) {
      setTimeout(() => generatePDF(), 250);
    }
    return;
  }

  // Fetch current rate status from Worker
  await checkRateStatus();

  showLandingScreen();
  if (justConfirmed) showConfirmationSuccess();
});
