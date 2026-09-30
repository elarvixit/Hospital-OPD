'use strict';

/* ================= Utilities ================= */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const app = $('#app');

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`opd.${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`opd.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const toDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return toDateStr(d); };
const fmtDate = (s) => { const d = parseDate(s); return `${DOW[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
const initials = (name) => name.replace(/^Dr\.?\s*/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const AVATAR_COLORS = ['#0e8f8b', '#6366f1', '#e11d48', '#f59e0b', '#0284c7', '#7c3aed', '#059669', '#db2777'];
const avatar = (doc, lg = false) => `<div class="avatar ${lg ? 'avatar-lg' : ''}" style="background:linear-gradient(135deg, ${AVATAR_COLORS[doc.id % AVATAR_COLORS.length]}, ${AVATAR_COLORS[(doc.id + 3) % AVATAR_COLORS.length]})">${esc(initials(doc.name))}</div>`;
const pill = (status, label) => `<span class="pill pill-${status}">${esc(label || status.replace('_', ' '))}</span>`;
const isOnLeave = (doc, date) => doc.leaves.some((l) => date >= l.start_date && date <= l.end_date);
const worksOn = (doc, date) => doc.schedules.some((s) => s.weekday === parseDate(date).getDay());
/** First date from `from` (inclusive) within 60 days when the doctor consults and isn't on leave. */
const nextWorkingDay = (doc, from) => {
  for (let i = 0; i < 60; i++) {
    const d = addDays(from, i);
    if (worksOn(doc, d) && !isOnLeave(doc, d)) return d;
  }
  return from;
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const ICON = {
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.13a4 4 0 0 1 0 7.75M21 21v-2a4 4 0 0 0-3-3.85"/></svg>',
  doctor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 12 0V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3"/><path d="M8 15v1a6 6 0 0 0 12 0v-4"/><circle cx="20" cy="10" r="2"/></svg>',
  report: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16v-7"/></svg>',
  sms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  skip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 4 10 8-10 8V4zM19 5v14"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  walk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="13" cy="4" r="2"/><path d="m7 21 3-7 3 2v5M10 14l-1-4 4-2 3 3 3 1M9 10 6 12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
};

/* ================= Toasts, ripple, modal ================= */
function toast(message, type = 'success', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="ic">${type === 'error' ? '!' : type === 'info' ? 'i' : '✓'}</span><div>${esc(message)}</div><span class="progress" style="animation-duration:${ms}ms"></span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); el.addEventListener('animationend', () => el.remove(), { once: true }); }, ms);
}

document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('.btn, .slot, .offer, .day-chip, .doc-option');
  if (!btn || btn.disabled) return;
  const r = btn.getBoundingClientRect();
  const size = Math.max(r.width, r.height);
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
  btn.style.overflow = 'hidden';
  btn.appendChild(span);
  span.addEventListener('animationend', () => span.remove());
});

/** Run an async action with a spinner on the button; shows errors as toasts. */
async function withLoading(btn, fn) {
  btn?.classList.add('loading');
  try { return await fn(); }
  catch (err) { toast(err.message, 'error'); }
  finally { btn?.classList.remove('loading'); }
}

function openModal(html, onMount) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(back);
  const modal = $('.modal', back);
  const close = () => {
    modal.classList.add('closing');
    back.style.transition = 'opacity .2s'; back.style.opacity = '0';
    setTimeout(() => back.remove(), 200);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  $$('[data-close]', modal).forEach((b) => b.addEventListener('click', close));
  onMount?.(modal, close);
  return close;
}

function confirmDialog(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    let answered = false;
    openModal(
      `<div class="modal-head"><h3>${esc(title)}</h3><button class="btn btn-ghost btn-sm" data-close>${ICON.x}</button></div>
       <p class="muted" style="margin:0 0 20px">${esc(message)}</p>
       <div class="toolbar" style="justify-content:flex-end"><button class="btn" data-close>Keep it</button><button class="btn btn-primary" id="ok">${esc(confirmLabel)}</button></div>`,
      (m, closeFn) => {
        $('#ok', m).addEventListener('click', () => { answered = true; resolve(true); closeFn(); });
        $$('[data-close]', m).forEach((b) => b.addEventListener('click', () => { if (!answered) resolve(false); }));
      }
    );
  });
}

/* ================= State & navigation ================= */
const state = {
  role: store.get('role', 'desk'),
  doctorId: store.get('doctorId', null),
  view: store.get('view', 'book'),
  doctors: [],
  today: toDateStr(new Date()),
  book: { doctorId: null, date: null, slot: null },
  appts: { date: null, doctorId: '', search: '' },
  reportDate: null,
  lastServing: {},
};

const TABS = {
  desk: [
    { id: 'book', label: 'Book', icon: ICON.book },
    { id: 'appointments', label: 'Appointments', icon: ICON.list },
    { id: 'queue', label: 'Live queue', icon: ICON.queue },
    { id: 'doctors', label: 'Doctors', icon: ICON.doctor },
    { id: 'report', label: 'Daily report', icon: ICON.report },
    { id: 'notifications', label: 'SMS log', icon: ICON.sms },
  ],
  doctor: [
    { id: 'myqueue', label: 'My queue', icon: ICON.queue },
    { id: 'appointments', label: 'My appointments', icon: ICON.list },
    { id: 'report', label: 'Daily report', icon: ICON.report },
  ],
};

function renderTabs() {
  const tabs = TABS[state.role];
  if (!tabs.some((t) => t.id === state.view)) state.view = tabs[0].id;
  $('#tabs').innerHTML = tabs.map((t) => `<button class="tab ${t.id === state.view ? 'active' : ''}" data-view="${t.id}">${t.icon}${t.label}</button>`).join('') + '<span class="tab-indicator"></span>';
  requestAnimationFrame(moveIndicator);
}
function moveIndicator() {
  const active = $('.tab.active');
  const ind = $('.tab-indicator');
  if (active && ind) { ind.style.left = `${active.offsetLeft}px`; ind.style.width = `${active.offsetWidth}px`; }
}
window.addEventListener('resize', moveIndicator);

$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-view]');
  if (!t || t.dataset.view === state.view) return;
  state.view = t.dataset.view;
  store.set('view', state.view);
  $$('.tab').forEach((b) => b.classList.toggle('active', b === t));
  moveIndicator();
  renderView();
});

function renderRoleControls() {
  $('#role').value = state.role;
  const sel = $('#doctorSelect');
  sel.hidden = state.role !== 'doctor';
  sel.innerHTML = state.doctors.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  if (!state.doctors.some((d) => d.id === state.doctorId)) state.doctorId = state.doctors[0]?.id ?? null;
  sel.value = state.doctorId;
}
$('#role').addEventListener('change', (e) => {
  state.role = e.target.value;
  store.set('role', state.role);
  renderRoleControls();
  renderTabs();
  renderView();
  toast(`Switched to ${state.role === 'desk' ? 'Front desk' : 'Doctor'} view`, 'info', 2200);
});
$('#doctorSelect').addEventListener('change', (e) => {
  state.doctorId = Number(e.target.value);
  store.set('doctorId', state.doctorId);
  renderView();
});

async function loadDoctors() {
  state.doctors = await api('/doctors');
}
const doctorById = (id) => state.doctors.find((d) => d.id === Number(id));

function renderView() {
  const fn = VIEWS[state.view];
  app.innerHTML = '';
  fn();
}

/* ================= Empty state ================= */
function noDoctorsView(what) {
  const isDesk = state.role === 'desk';
  app.innerHTML = `
  <section class="view">
    <div class="empty" style="padding:60px 20px">
      <span class="big">🩺</span>
      <h2 style="margin:6px 0 8px">No doctors yet</h2>
      <p style="margin:0 0 18px">${esc(what)} needs at least one doctor with a weekly schedule.</p>
      ${isDesk
        ? '<button class="btn btn-primary" id="goDoctors">' + ICON.plus + 'Add your first doctor</button>'
        : '<p class="small">Switch to <strong>Front desk</strong> (top right) and add doctors in the Doctors tab.</p>'}
    </div>
  </section>`;
  $('#goDoctors')?.addEventListener('click', () => {
    state.view = 'doctors';
    store.set('view', state.view);
    renderTabs();
    renderView();
    openDoctorForm();
  });
}

/* ================= Book ================= */
function viewBook() {
  if (!state.doctors.length) return noDoctorsView('Booking');
  const b = state.book;
  if (!doctorById(b.doctorId)) b.doctorId = state.doctors[0]?.id ?? null;
  if (!b.date || b.date < state.today) b.date = nextWorkingDay(doctorById(b.doctorId), state.today);
  b.slot = null;

  app.innerHTML = `
  <section class="view">
    <div class="page-head"><div><h2>Book an appointment</h2><p>Pick a doctor, a day and a free slot — or add a walk-in straight to today's queue.</p></div></div>
    <div class="grid grid-book">
      <div class="card">
        <div class="card-title"><h3><span class="step">1</span>Doctor</h3></div>
        <div class="doc-picker stagger" id="docPicker"></div>
        <div class="card-title" style="margin-top:22px"><h3><span class="step">2</span>Date</h3>
          <input type="date" class="input" id="dateInput" style="width:auto" min="${state.today}" />
        </div>
        <div class="date-strip" id="dateStrip"></div>
        <div class="card-title" style="margin-top:14px"><h3><span class="step">3</span>Slot</h3><span class="muted small" id="slotCount"></span></div>
        <div id="slotsBox"></div>
        <div class="legend">
          <span><i></i>Available</span>
          <span><i style="background:var(--primary);border-color:var(--primary)"></i>Selected</span>
          <span><i style="background:repeating-linear-gradient(-45deg,#f4f6f7,#f4f6f7 3px,#e3e8ea 3px,#e3e8ea 6px)"></i>Booked</span>
          <span><i style="border-style:dashed"></i>Past</span>
        </div>
      </div>
      <div class="card sticky">
        <div class="card-title"><h3><span class="step">4</span>Patient</h3></div>
        <form id="patientForm" autocomplete="off">
          <div class="field suggest">
            <label for="pPhone">Mobile number</label>
            <input class="input mono" id="pPhone" inputmode="numeric" maxlength="10" placeholder="98765 43210" required />
            <span class="input-hint">Type to find a returning patient</span>
          </div>
          <div class="field"><label for="pName">Full name</label><input class="input" id="pName" placeholder="e.g. Rahul Sharma" required /></div>
          <div class="field"><label for="pAge">Age</label><input class="input" id="pAge" type="number" min="0" max="120" placeholder="Years" required /></div>
          <div class="summary" id="summary"></div>
          <button class="btn btn-primary btn-lg btn-block" id="bookBtn" type="submit">${ICON.check}Book appointment</button>
          <div class="divider">or</div>
          <button class="btn btn-block" id="walkinBtn" type="button">${ICON.walk}Add as walk-in to today's queue</button>
        </form>
      </div>
    </div>
  </section>`;

  renderDocPicker();
  renderDateStrip();
  loadSlots();
  updateSummary();

  $('#dateInput').value = b.date;
  $('#dateInput').addEventListener('change', (e) => { if (e.target.value) { b.date = e.target.value; b.slot = null; renderDateStrip(); loadSlots(); updateSummary(); } });

  // Returning-patient lookup
  const phone = $('#pPhone');
  const lookup = debounce(async () => {
    $('.suggest-list')?.remove();
    const digits = phone.value.replace(/\D/g, '');
    if (digits.length < 3 || digits.length === 10 && $('#pName').value) return;
    const found = await api(`/patients?phone=${digits}`).catch(() => []);
    if (!found.length || document.activeElement !== phone) return;
    const list = document.createElement('div');
    list.className = 'suggest-list';
    list.innerHTML = found.map((p) => `<button type="button" data-p='${esc(JSON.stringify(p))}'><strong>${esc(p.name)}</strong><span class="muted mono">${esc(p.phone)} · ${p.age}y</span></button>`).join('');
    phone.parentElement.appendChild(list);
    list.addEventListener('mousedown', (e) => {
      const btn = e.target.closest('[data-p]');
      if (!btn) return;
      const p = JSON.parse(btn.dataset.p);
      phone.value = p.phone; $('#pName').value = p.name; $('#pAge').value = p.age;
      list.remove(); updateSummary();
    });
  }, 250);
  phone.addEventListener('input', () => { phone.value = phone.value.replace(/\D/g, ''); lookup(); });
  phone.addEventListener('blur', () => setTimeout(() => $('.suggest-list')?.remove(), 150));
  $('#patientForm').addEventListener('input', updateSummary);

  $('#patientForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!b.slot) return toast('Please choose a slot first', 'error');
    withLoading($('#bookBtn'), async () => {
      const a = await api('/appointments', { method: 'POST', body: { doctorId: b.doctorId, date: b.date, slot: b.slot, patient: readPatient() } });
      toast(`Booked ${a.patient_name} with ${a.doctor_name} · ${fmtDate(a.date)} at ${a.slot_start}`);
      resetPatient();
      b.slot = null;
      loadSlots();
      updateSummary();
    });
  });

  $('#walkinBtn').addEventListener('click', () => {
    const f = $('#patientForm');
    if (!f.reportValidity()) return;
    withLoading($('#walkinBtn'), async () => {
      const a = await api('/walkins', { method: 'POST', body: { doctorId: b.doctorId, patient: readPatient() } });
      toast(`Walk-in added — ${a.patient_name} is token #${a.token} for ${a.doctor_name}`);
      resetPatient();
      updateSummary();
    });
  });
}

const readPatient = () => ({ name: $('#pName').value.trim(), phone: $('#pPhone').value.trim(), age: Number($('#pAge').value) });
const resetPatient = () => { $('#patientForm').reset(); };

function renderDocPicker() {
  $('#docPicker').innerHTML = state.doctors.map((d, i) => `
    <button type="button" class="doc-option ${d.id === state.book.doctorId ? 'selected' : ''}" data-id="${d.id}" style="--i:${i}">
      ${avatar(d)}<span><strong>${esc(d.name)}</strong><span class="muted small">${esc(d.department)} · ${d.duration_min} min</span></span>
    </button>`).join('');
  $('#docPicker').onclick = (e) => {
    const opt = e.target.closest('.doc-option');
    if (!opt) return;
    state.book.doctorId = Number(opt.dataset.id);
    // Jump to this doctor's next working day so there are slots to pick.
    const doc = doctorById(state.book.doctorId);
    if (!worksOn(doc, state.book.date) || isOnLeave(doc, state.book.date)) {
      state.book.date = nextWorkingDay(doc, state.today);
      $('#dateInput').value = state.book.date;
    }
    state.book.slot = null;
    $$('.doc-option').forEach((o) => o.classList.toggle('selected', o === opt));
    renderDateStrip();
    loadSlots();
    updateSummary();
  };
}

function renderDateStrip() {
  const doc = doctorById(state.book.doctorId);
  if (!doc) return;
  const days = Array.from({ length: 14 }, (_, i) => addDays(state.today, i));
  if (!days.includes(state.book.date)) days.push(state.book.date);
  $('#dateStrip').innerHTML = days.map((d) => {
    const dt = parseDate(d);
    const leave = isOnLeave(doc, d);
    const cls = [d === state.book.date && 'selected', !worksOn(doc, d) && 'off', leave && 'leave'].filter(Boolean).join(' ');
    const title = leave ? 'On leave' : worksOn(doc, d) ? 'Working' : 'Not working';
    return `<button type="button" class="day-chip ${cls}" data-date="${d}" title="${title}">
      <div class="dow">${d === state.today ? 'Today' : DOW[dt.getDay()]}</div><div class="dnum">${dt.getDate()}</div><span class="dot"></span></button>`;
  }).join('');
  $('#dateStrip').onclick = (e) => {
    const chip = e.target.closest('.day-chip');
    if (!chip) return;
    state.book.date = chip.dataset.date;
    state.book.slot = null;
    $('#dateInput').value = state.book.date;
    $$('.day-chip').forEach((c) => c.classList.toggle('selected', c === chip));
    loadSlots();
    updateSummary();
  };
  $('.day-chip.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

let slotReq = 0;
async function loadSlots() {
  const { doctorId, date } = state.book;
  const box = $('#slotsBox');
  if (!box || !doctorId) return;
  const reqId = ++slotReq;
  box.innerHTML = `<div class="slots">${'<div class="skeleton" style="height:38px"></div>'.repeat(12)}</div>`;
  box.onclick = (e) => {
    const jump = e.target.closest('[data-jump]');
    if (!jump) return;
    state.book.date = jump.dataset.jump;
    state.book.slot = null;
    $('#dateInput').value = state.book.date;
    renderDateStrip();
    loadSlots();
    updateSummary();
  };
  try {
    const data = await api(`/doctors/${doctorId}/slots?date=${date}`);
    if (reqId !== slotReq) return; // a newer request superseded this one
    const doc = doctorById(doctorId);
    const free = data.slots.filter((s) => s.status === 'available').length;
    $('#slotCount').textContent = data.slots.length ? `${free} of ${data.slots.length} free` : '';
    if (data.onLeave) {
      const leave = doc.leaves.find((l) => date >= l.start_date && date <= l.end_date);
      box.innerHTML = `<div class="empty"><span class="big">🌴</span><strong>${esc(doc.name)} is on leave</strong><div class="small">${leave?.reason ? esc(leave.reason) + ' · ' : ''}Pick another day</div></div>`;
      return;
    }
    if (!data.working) {
      box.innerHTML = `<div class="empty"><span class="big">📅</span><strong>No OPD on ${fmtDate(date)}</strong><div class="small">${esc(doc.name)} doesn't consult on ${DOW_FULL[parseDate(date).getDay()]}s.</div>${workingDaysLine(doc, date)}</div>`;
      return;
    }
    const soldOut = free === 0 ? `<div class="banner">${ICON.alert}<div>No free slots left on this day. Try the next working day, or add the patient as a walk-in.</div></div>` : '';
    box.innerHTML = soldOut + `<div class="slots">${data.slots.map((s, i) =>
      `<button type="button" class="slot ${s.status}" data-start="${s.start}" style="--i:${i}" ${s.status !== 'available' ? 'disabled' : ''} title="${s.start}–${s.end} · ${s.status}">${s.start}</button>`
    ).join('')}</div>`;
    box.onclick = (e) => {
      const slot = e.target.closest('.slot:not(:disabled)');
      if (!slot) return;
      state.book.slot = slot.dataset.start;
      $$('.slot', box).forEach((s) => s.classList.toggle('selected', s === slot));
      updateSummary();
    };
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function workingDaysLine(doc, date) {
  const days = [...new Set(doc.schedules.map((s) => s.weekday))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (!days.length) return '<div class="small" style="margin-top:6px">No weekly schedule yet — add one in the Doctors tab.</div>';
  const next = nextWorkingDay(doc, date);
  return `<div class="small" style="margin-top:6px">Consults on: <strong>${days.map((d) => DOW_FULL[d]).join(', ')}</strong></div>
    ${next !== date ? `<button type="button" class="btn btn-sm btn-primary" style="margin-top:12px" data-jump="${next}">Go to ${fmtDate(next)}</button>` : ''}`;
}

function updateSummary() {
  const el = $('#summary');
  if (!el) return;
  const doc = doctorById(state.book.doctorId);
  const name = $('#pName')?.value.trim();
  const ready = doc && state.book.slot && name;
  el.classList.toggle('ready', Boolean(ready));
  el.innerHTML = `
    <div class="summary-row"><span>Doctor</span><strong>${doc ? esc(doc.name) : '—'}</strong></div>
    <div class="summary-row"><span>Date</span><strong>${state.book.date ? fmtDate(state.book.date) : '—'}</strong></div>
    <div class="summary-row"><span>Slot</span><strong class="mono">${state.book.slot ? `${state.book.slot} (${doc.duration_min} min)` : '—'}</strong></div>
    <div class="summary-row"><span>Patient</span><strong>${name ? esc(name) : '—'}</strong></div>`;
}

/* ================= Appointments ================= */
function viewAppointments() {
  const s = state.appts;
  if (!s.date) s.date = state.today;
  const isDoctor = state.role === 'doctor';
  const docFilter = isDoctor ? state.doctorId : s.doctorId;

  app.innerHTML = `
  <section class="view">
    <div class="page-head">
      <div><h2>${isDoctor ? 'My appointments' : 'Appointments'}</h2><p>${isDoctor ? 'Everyone booked with you for the day.' : 'Check patients in when they arrive, cancel or reschedule bookings.'}</p></div>
      <div class="toolbar">
        <button class="btn btn-sm" id="prevDay">‹</button>
        <input type="date" class="input" id="apDate" style="width:auto" value="${s.date}" />
        <button class="btn btn-sm" id="nextDay">›</button>
        <button class="btn btn-sm" id="todayBtn">Today</button>
        ${isDoctor ? '' : `<select class="select" id="apDoctor"><option value="">All doctors</option>${state.doctors.map((d) => `<option value="${d.id}" ${String(d.id) === String(s.doctorId) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`}
        <input class="input" id="apSearch" placeholder="Search name or phone" style="width:190px" value="${esc(s.search)}" />
      </div>
    </div>
    <div class="card" style="padding:8px 8px 4px"><div class="table-wrap" id="apTable"></div></div>
  </section>`;

  const reload = () => loadAppointments(docFilter);
  $('#apDate').addEventListener('change', (e) => { s.date = e.target.value || state.today; reload(); });
  $('#prevDay').addEventListener('click', () => { s.date = addDays(s.date, -1); $('#apDate').value = s.date; reload(); });
  $('#nextDay').addEventListener('click', () => { s.date = addDays(s.date, 1); $('#apDate').value = s.date; reload(); });
  $('#todayBtn').addEventListener('click', () => { s.date = state.today; $('#apDate').value = s.date; reload(); });
  $('#apDoctor')?.addEventListener('change', (e) => { s.doctorId = e.target.value; viewAppointments(); });
  $('#apSearch').addEventListener('input', debounce((e) => { s.search = e.target.value; reload(); }, 200));
  reload();
}

async function loadAppointments(doctorId) {
  const s = state.appts;
  const box = $('#apTable');
  box.innerHTML = `<div style="padding:12px">${'<div class="skeleton" style="height:42px;margin-bottom:8px"></div>'.repeat(5)}</div>`;
  let rows;
  try {
    rows = await api(`/appointments?date=${s.date}${doctorId ? `&doctorId=${doctorId}` : ''}`);
  } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  const q = s.search.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.patient_name.toLowerCase().includes(q) || r.patient_phone.includes(q));
  const isDesk = state.role === 'desk';

  if (!rows.length) {
    box.innerHTML = `<div class="empty" style="margin:12px"><span class="big">🗓️</span><strong>No appointments on ${fmtDate(s.date)}</strong>${isDesk ? '<div class="small">Use the Book tab to add one.</div>' : ''}</div>`;
    return;
  }
  const statusLabel = (r) => {
    if (r.status === 'checked_in' && r.queue_state === 'serving') return pill('serving', 'with doctor');
    if (r.status === 'checked_in') return pill('checked_in', r.skips ? `waiting · skipped ${r.skips}×` : 'waiting');
    return pill(r.status);
  };
  box.innerHTML = `<table>
    <thead><tr><th>Token</th><th>Time</th><th>Patient</th>${state.role === 'desk' && !s.doctorId ? '<th>Doctor</th>' : ''}<th>Type</th><th>Status</th>${isDesk ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows.map((r, i) => `
      <tr style="--i:${i}">
        <td>${r.token ? `<span class="token-badge">${r.token}</span>` : '<span class="muted">—</span>'}</td>
        <td class="mono"><strong>${r.slot_start || '—'}</strong></td>
        <td><strong>${esc(r.patient_name)}</strong><div class="muted small mono">${esc(r.patient_phone)} · ${r.patient_age}y</div></td>
        ${state.role === 'desk' && !s.doctorId ? `<td>${esc(r.doctor_name)}<div class="muted small">${esc(r.department)}</div></td>` : ''}
        <td>${r.kind === 'walkin' ? pill('walkin', 'walk-in') : '<span class="muted small">Scheduled</span>'}</td>
        <td>${statusLabel(r)}</td>
        ${isDesk ? `<td><div class="actions">${rowActions(r)}</div></td>` : ''}
      </tr>`).join('')}</tbody></table>`;

  box.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const row = rows.find((r) => r.id === id);
    if (btn.dataset.act === 'checkin') {
      await withLoading(btn, async () => {
        const a = await api(`/appointments/${id}/checkin`, { method: 'POST' });
        toast(`${a.patient_name} checked in — token #${a.token}`);
        loadAppointments(doctorId);
      });
    } else if (btn.dataset.act === 'cancel') {
      if (!(await confirmDialog('Cancel appointment?', `${row.patient_name} · ${fmtDate(row.date)} at ${row.slot_start} with ${row.doctor_name}. The slot will be freed immediately.`, 'Cancel appointment'))) return;
      await withLoading(btn, async () => {
        await api(`/appointments/${id}/cancel`, { method: 'POST' });
        toast('Appointment cancelled — slot is free again');
        loadAppointments(doctorId);
      });
    } else if (btn.dataset.act === 'reschedule') {
      openReschedule(row, () => loadAppointments(doctorId));
    }
  };
}

function rowActions(r) {
  const out = [];
  if (r.status === 'booked' && r.date === state.today) out.push(`<button class="btn btn-sm btn-primary" data-act="checkin" data-id="${r.id}">${ICON.check}Check in</button>`);
  if (r.status === 'booked' && r.date >= state.today) {
    out.push(`<button class="btn btn-sm" data-act="reschedule" data-id="${r.id}">Reschedule</button>`);
    out.push(`<button class="btn btn-sm btn-danger-ghost" data-act="cancel" data-id="${r.id}">Cancel</button>`);
  }
  return out.join('');
}

function openReschedule(appt, onDone) {
  const doc = doctorById(appt.doctor_id);
  let choice = null;
  openModal(`
    <div class="modal-head"><h3>Reschedule appointment</h3><button class="btn btn-ghost btn-sm" data-close>${ICON.x}</button></div>
    <p class="muted" style="margin-top:0">${esc(appt.patient_name)} with ${esc(doc.name)} — currently <strong>${fmtDate(appt.date)} at ${appt.slot_start}</strong></p>
    <h4 style="margin:18px 0 10px">Next three free slots</h4>
    <div class="offer-slots" id="offers"><div class="skeleton" style="height:76px"></div><div class="skeleton" style="height:76px"></div><div class="skeleton" style="height:76px"></div></div>
    <div class="divider">or pick another day</div>
    <input type="date" class="input" id="rsDate" min="${state.today}" style="margin-bottom:12px" />
    <div id="rsSlots"></div>
    <div class="toolbar" style="justify-content:flex-end;margin-top:20px">
      <button class="btn" data-close>Close</button>
      <button class="btn btn-primary" id="rsConfirm" disabled>Move appointment</button>
    </div>`, async (m, close) => {
    const setChoice = (c, el) => {
      choice = c;
      $$('.offer, .slot', m).forEach((x) => x.classList.toggle('selected', x === el));
      $('#rsConfirm', m).disabled = !c;
      $('#rsConfirm', m).textContent = c ? `Move to ${fmtDate(c.date)} ${c.start}` : 'Move appointment';
    };
    try {
      const offers = await api(`/doctors/${doc.id}/next-free?count=3`);
      $('#offers', m).innerHTML = offers.length
        ? offers.map((o, i) => `<button class="offer" style="--i:${i}" data-date="${o.date}" data-start="${o.start}"><div class="t mono">${o.start}</div><div class="small muted">${o.date === state.today ? 'Today' : fmtDate(o.date)}</div></button>`).join('')
        : '<div class="empty" style="grid-column:1/-1">No free slots in the next 60 days</div>';
    } catch (err) { $('#offers', m).innerHTML = `<div class="empty" style="grid-column:1/-1">${esc(err.message)}</div>`; }
    $('#offers', m).addEventListener('click', (e) => {
      const o = e.target.closest('.offer');
      if (o) setChoice({ date: o.dataset.date, start: o.dataset.start }, o);
    });
    $('#rsDate', m).addEventListener('change', async (e) => {
      const date = e.target.value;
      const box = $('#rsSlots', m);
      setChoice(null);
      if (!date) { box.innerHTML = ''; return; }
      const data = await api(`/doctors/${doc.id}/slots?date=${date}`).catch((err) => { toast(err.message, 'error'); return null; });
      if (!data) return;
      if (data.onLeave) { box.innerHTML = '<div class="empty">Doctor is on leave that day</div>'; return; }
      if (!data.slots.length) { box.innerHTML = '<div class="empty">No OPD that day</div>'; return; }
      box.innerHTML = `<div class="slots">${data.slots.map((s, i) => `<button class="slot ${s.status}" style="--i:${i}" data-start="${s.start}" ${s.status !== 'available' ? 'disabled' : ''}>${s.start}</button>`).join('')}</div>`;
      box.onclick = (ev) => {
        const s = ev.target.closest('.slot:not(:disabled)');
        if (s) setChoice({ date, start: s.dataset.start }, s);
      };
    });
    $('#rsConfirm', m).addEventListener('click', (e) => withLoading(e.currentTarget, async () => {
      await api(`/appointments/${appt.id}/reschedule`, { method: 'POST', body: { date: choice.date, slot: choice.start } });
      toast(`Moved to ${fmtDate(choice.date)} at ${choice.start}`);
      close();
      onDone();
    }));
  });
}

/* ================= Live queue (desk) ================= */
function queueCard(q, i) {
  const d = q.doctor;
  const s = q.serving;
  const changed = s && state.lastServing[d.id] !== undefined && state.lastServing[d.id] !== s.token;
  state.lastServing[d.id] = s ? s.token : null;
  const onLeave = isOnLeave(doctorById(d.id) || { leaves: [] }, q.date);
  return `
  <div class="card hoverable q-card" style="--i:${i}" data-doctor="${d.id}">
    <div class="q-head">${avatar(d)}<div style="flex:1"><h3>${esc(d.name)}</h3><div class="muted small">${esc(d.department)}${d.room ? ` · Room ${esc(d.room)}` : ''}</div></div>${onLeave ? pill('cancelled', 'on leave') : ''}</div>
    <div class="now-serving ${s ? '' : 'idle'}">
      ${s ? '<span class="pulse-ring"></span>' : ''}
      <div class="label">Now serving</div>
      <div class="token mono ${changed ? 'token-flip' : ''}">${s ? `#${s.token}` : '—'}</div>
      <div class="who">${s ? esc(s.patient_name) : q.next ? 'Ready to call next patient' : 'No one waiting'}</div>
    </div>
    <div class="q-next"><span class="label">Next</span><strong>${q.next ? `#${q.next.token} · ${esc(q.next.patient_name)}` : '<span class="muted">—</span>'}</strong></div>
    <div>
      <div class="muted small" style="margin-bottom:6px;font-weight:600">Waiting (${q.waiting.length})</div>
      <div class="chips">${q.waiting.length ? q.waiting.map((e, j) => `<span class="chip ${e.skips ? 'skipped' : ''}" style="--i:${j}" title="${esc(e.patient_name)}${e.skips ? ' · skipped once' : ''}">#${e.token}</span>`).join('') : '<span class="muted small">Nobody else in line</span>'}</div>
    </div>
    <div class="q-stats"><span>Seen <b>${q.done.length}</b></span><span>No-show <b>${q.noShow.length}</b></span></div>
    ${queueButtons(q)}
  </div>`;
}

function queueButtons(q) {
  if (q.serving) {
    return `<div class="q-actions">
      <button class="btn btn-success" data-q="done">${ICON.check}Done</button>
      <button class="btn btn-warn" data-q="skip" title="Patient didn't come in — 1st skip moves them to the end, 2nd marks no-show">${ICON.skip}Skip</button>
    </div>`;
  }
  return `<div class="q-actions"><button class="btn btn-primary" data-q="next" ${q.next ? '' : 'disabled'}>${ICON.play}Call next</button></div>`;
}

async function doQueueAction(doctorId, action, btn) {
  const prevToken = state.lastServing[doctorId];
  return withLoading(btn, async () => {
    const q = await api(`/doctors/${doctorId}/queue/${action}`, { method: 'POST' });
    if (action === 'skip') {
      const noShow = q.noShow.some((e) => e.token === prevToken);
      toast(noShow ? `Token #${prevToken} skipped twice — marked no-show` : `Token #${prevToken} skipped — moved to the end of the queue`, noShow ? 'error' : 'info');
    } else if (q.serving) {
      toast(`Now serving token #${q.serving.token} · ${q.serving.patient_name}`);
    } else {
      toast('Queue is clear', 'info');
    }
    return q;
  });
}

function viewQueue() {
  if (!state.doctors.length) return noDoctorsView('The live queue');
  app.innerHTML = `
  <section class="view">
    <div class="page-head">
      <div><h2>Live queue</h2><p>All doctors, today. Auto-refreshes every 10 seconds.</p></div>
      <div class="toolbar"><span class="refresh-note" id="refreshNote">${ICON.refresh}<span>Live</span></span><a class="btn btn-sm" href="display.html" target="_blank">Open waiting-area screen ↗</a></div>
    </div>
    <div class="grid grid-cards stagger" id="queueGrid">${'<div class="card"><div class="skeleton" style="height:320px"></div></div>'.repeat(3)}</div>
  </section>`;
  $('#queueGrid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-q]');
    if (!btn) return;
    const id = Number(btn.closest('[data-doctor]').dataset.doctor);
    await doQueueAction(id, btn.dataset.q, btn);
    refreshQueue(false);
  });
  refreshQueue(true);
}

async function refreshQueue(first) {
  const grid = $('#queueGrid');
  if (!grid) return;
  $('#refreshNote svg')?.classList.add('spinning');
  try {
    const queues = await api('/queue');
    grid.classList.toggle('stagger', first);
    grid.innerHTML = queues.map(queueCard).join('');
  } catch (err) { toast(err.message, 'error'); }
  setTimeout(() => $('#refreshNote svg')?.classList.remove('spinning'), 600);
}

/* ================= Doctor: my queue ================= */
function viewMyQueue() {
  if (!state.doctors.length) return noDoctorsView('My queue');
  app.innerHTML = `<section class="view"><div id="myQueue"><div class="card"><div class="skeleton" style="height:420px"></div></div></div></section>`;
  refreshMyQueue(true);
}

async function refreshMyQueue(first) {
  const box = $('#myQueue');
  if (!box || !state.doctorId) return;
  let q;
  try { q = await api(`/doctors/${state.doctorId}/queue`); } catch (err) { toast(err.message, 'error'); return; }
  const d = q.doctor;
  const s = q.serving;
  const changed = s && state.lastServing[d.id] !== undefined && state.lastServing[d.id] !== s.token;
  state.lastServing[d.id] = s ? s.token : null;
  const line = [q.next, ...q.waiting].filter(Boolean);

  box.innerHTML = `
    <div class="page-head">
      <div style="display:flex;gap:14px;align-items:center">${avatar(d, true)}<div><h2>${esc(d.name)}</h2><p>${esc(d.department)}${d.room ? ` · Room ${esc(d.room)}` : ''} · ${fmtDate(q.date)}</p></div></div>
      <div class="toolbar"><span class="refresh-note">${ICON.refresh}Auto-refreshing</span></div>
    </div>
    <div class="dq-grid ${first ? 'stagger' : ''}">
      <div class="card hero" style="--i:0">
        <div class="now-serving ${s ? '' : 'idle'}">
          ${s ? '<span class="pulse-ring"></span>' : ''}
          <div class="label">Now serving</div>
          <div class="token mono ${changed ? 'token-flip' : ''}">${s ? `#${s.token}` : '—'}</div>
          <div class="who">${s ? `${esc(s.patient_name)} · ${s.patient_age}y` : line.length ? 'Press “Call next” when you’re ready' : 'No patients waiting'}</div>
          ${s ? `<div class="small" style="opacity:.85;margin-top:6px">${s.kind === 'walkin' ? 'Walk-in' : `Slot ${s.slot_start}`} · checked in ${fmtTime(s.checked_in_at)}${s.skips ? ` · skipped ${s.skips}× before` : ''}</div>` : ''}
        </div>
        <div style="margin-top:18px">${queueButtons(q).replace('>' + ICON.check + 'Done<', '>' + ICON.check + 'Done — next patient<')}</div>
        <div class="q-stats" style="margin-top:16px;justify-content:center"><span>Waiting <b>${line.length}</b></span><span>Seen <b>${q.done.length}</b></span><span>No-show <b>${q.noShow.length}</b></span></div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card" style="--i:1">
          <div class="card-title"><h3>${ICON.users} Up next</h3><span class="muted small">${line.length} in line</span></div>
          <div class="list">${line.length ? line.map((e, i) => `
            <div class="list-item" style="--i:${i}"><span class="token-badge">${e.token}</span>
              <div class="grow"><strong>${esc(e.patient_name)}</strong><div class="muted small">${e.patient_age}y · ${e.kind === 'walkin' ? 'walk-in' : `slot ${e.slot_start}`} · in at ${fmtTime(e.checked_in_at)}</div></div>
              ${e.skips ? pill('walkin', 'skipped once') : i === 0 ? pill('serving', 'next') : ''}</div>`).join('') : '<div class="empty"><span class="big">☕</span>Nobody waiting</div>'}</div>
        </div>
        <div class="card" style="--i:2">
          <div class="card-title"><h3>${ICON.check} Completed today</h3><span class="muted small">${q.done.length}</span></div>
          <div class="list">${q.done.length ? q.done.slice().reverse().map((e, i) => `
            <div class="list-item" style="--i:${i}"><span class="token-badge" style="background:var(--success)">${e.token}</span>
              <div class="grow"><strong>${esc(e.patient_name)}</strong><div class="muted small">${fmtTime(e.called_at)} – ${fmtTime(e.served_at)}</div></div></div>`).join('') : '<div class="muted small">No one yet</div>'}
            ${q.noShow.map((e) => `<div class="list-item"><span class="token-badge" style="background:var(--danger)">${e.token}</span><div class="grow"><strong>${esc(e.patient_name)}</strong></div>${pill('no_show', 'no-show')}</div>`).join('')}
          </div>
        </div>
      </div>
    </div>`;
  $('.hero', box).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-q]');
    if (!btn) return;
    await doQueueAction(state.doctorId, btn.dataset.q, btn);
    refreshMyQueue(false);
  });
}

/* ================= Doctors ================= */
function viewDoctors() {
  app.innerHTML = `
  <section class="view">
    <div class="page-head">
      <div><h2>Doctors</h2><p>Weekly schedules, consultation length and leave days.</p></div>
      <button class="btn btn-primary" id="addDoc">${ICON.plus}Add doctor</button>
    </div>
    <div class="grid grid-cards stagger" id="docGrid"></div>
  </section>`;
  $('#addDoc').addEventListener('click', () => openDoctorForm());
  renderDoctorCards();
}

function renderDoctorCards() {
  const grid = $('#docGrid');
  if (!state.doctors.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><span class="big">🩺</span><strong>No doctors yet</strong><div class="small">Click <b>Add doctor</b> to create one with a weekly schedule.</div></div>';
    return;
  }
  grid.innerHTML = state.doctors.map((d, i) => {
    const upcoming = d.leaves.filter((l) => l.end_date >= state.today);
    return `
    <div class="card hoverable" style="--i:${i}" data-id="${d.id}">
      <div class="q-head">${avatar(d, true)}<div style="flex:1"><h3>${esc(d.name)}</h3><div class="muted small">${esc(d.department)}${d.room ? ` · Room ${esc(d.room)}` : ''}</div></div>
        <button class="btn btn-ghost btn-sm" data-act="edit" title="Edit">${ICON.edit}</button></div>
      <div style="margin-top:10px">${pill('booked', `${d.duration_min} min consult`)}</div>
      <div class="week">${[1, 2, 3, 4, 5, 6, 0].map((wd) => {
        const blocks = d.schedules.filter((s) => s.weekday === wd);
        return `<div class="week-day"><div class="d">${DOW[wd][0]}${DOW[wd][1]}</div>${blocks.length ? blocks.map((b) => `<div class="b" title="${b.start_time}–${b.end_time}">${b.start_time.replace(':00', '')}–${b.end_time.replace(':00', '')}</div>`).join('') : '<div class="none"></div>'}</div>`;
      }).join('')}</div>
      <div class="muted small" style="font-weight:600;margin-bottom:6px">Upcoming leave</div>
      ${upcoming.length ? upcoming.map((l) => `<div class="leave-item"><span>🌴 ${fmtDate(l.start_date)}${l.end_date !== l.start_date ? ` → ${fmtDate(l.end_date)}` : ''}${l.reason ? ` · <span class="muted">${esc(l.reason)}</span>` : ''}</span><button class="btn btn-ghost btn-sm" data-act="rmleave" data-leave="${l.id}" title="Remove">${ICON.x}</button></div>`).join('') : '<div class="muted small" style="margin-bottom:8px">None scheduled</div>'}
      <form class="row" data-act="leaveform" style="margin-top:10px;gap:6px;flex-wrap:wrap">
        <input type="date" class="input" name="start" min="${state.today}" required title="From" style="min-width:130px" />
        <input type="date" class="input" name="end" min="${state.today}" title="To (optional)" style="min-width:130px" />
        <input class="input" name="reason" placeholder="Reason (optional)" style="min-width:130px" />
        <button class="btn btn-sm" type="submit" style="flex:0">${ICON.plus}Add leave</button>
      </form>
    </div>`;
  }).join('');

  grid.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.tagName === 'FORM') return;
    const id = Number(btn.closest('[data-id]').dataset.id);
    if (btn.dataset.act === 'edit') openDoctorForm(doctorById(id));
    if (btn.dataset.act === 'rmleave') {
      await withLoading(btn, async () => {
        await api(`/leaves/${btn.dataset.leave}`, { method: 'DELETE' });
        toast('Leave removed');
        await loadDoctors();
        renderDoctorCards();
      });
    }
  };
  $$('form[data-act="leaveform"]', grid).forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = Number(f.closest('[data-id]').dataset.id);
    withLoading($('button', f), async () => {
      const r = await api(`/doctors/${id}/leaves`, { method: 'POST', body: { start_date: f.start.value, end_date: f.end.value || f.start.value, reason: f.reason.value } });
      toast('Leave added');
      if (r.affected.length) toast(`${r.affected.length} booked appointment(s) fall on this leave — reschedule them from Appointments`, 'error', 6500);
      await loadDoctors();
      renderDoctorCards();
    });
  }));
}

function openDoctorForm(doc) {
  const blocks = doc ? doc.schedules.map((s) => ({ ...s })) : [{ weekday: 1, start_time: '10:00', end_time: '13:00' }];
  const blockRow = (b, i) => `
    <div class="sched-row" data-i="${i}">
      <select class="select" name="weekday">${DOW.map((n, wd) => `<option value="${wd}" ${wd === b.weekday ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <input type="time" class="input" name="start" value="${b.start_time}" required />
      <input type="time" class="input" name="end" value="${b.end_time}" required />
      <button type="button" class="btn btn-ghost btn-sm" data-rm title="Remove">${ICON.x}</button>
    </div>`;
  openModal(`
    <div class="modal-head"><h3>${doc ? 'Edit doctor' : 'Add doctor'}</h3><button class="btn btn-ghost btn-sm" data-close>${ICON.x}</button></div>
    <form id="docForm">
      <div class="field"><label>Name</label><input class="input" name="name" value="${esc(doc?.name || 'Dr. ')}" required /></div>
      <div class="row">
        <div class="field"><label>Department</label><input class="input" name="department" value="${esc(doc?.department || '')}" required /></div>
        <div class="field"><label>Consultation (min)</label><input class="input" type="number" name="duration" min="5" max="120" step="5" value="${doc?.duration_min || 15}" required /></div>
        <div class="field"><label>Room</label><input class="input" name="room" value="${esc(doc?.room || '')}" /></div>
      </div>
      <div class="card-title" style="margin:6px 0 10px"><h3>Weekly schedule</h3><button type="button" class="btn btn-sm" id="addBlock">${ICON.plus}Add block</button></div>
      <div class="sched-row muted small" style="animation:none"><span>Day</span><span>From</span><span>To</span><span style="width:32px"></span></div>
      <div id="blocks">${blocks.map(blockRow).join('')}</div>
      <div class="toolbar" style="justify-content:flex-end;margin-top:20px">
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn btn-primary" type="submit" id="saveDoc">${doc ? 'Save changes' : 'Add doctor'}</button>
      </div>
    </form>`, (m, close) => {
    const readBlocks = () => $$('.sched-row[data-i]', m).map((r) => ({ weekday: Number($('[name=weekday]', r).value), start_time: $('[name=start]', r).value, end_time: $('[name=end]', r).value }));
    $('#addBlock', m).addEventListener('click', () => {
      const cur = readBlocks();
      const last = cur.at(-1) || { weekday: 0, start_time: '10:00', end_time: '13:00' };
      $('#blocks', m).insertAdjacentHTML('beforeend', blockRow({ ...last, weekday: (last.weekday + 1) % 7 }, cur.length));
    });
    $('#blocks', m).addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) e.target.closest('.sched-row').remove(); });
    $('#docForm', m).addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { name: f.name.value, department: f.department.value, duration_min: Number(f.duration.value), room: f.room.value, schedules: readBlocks() };
      withLoading($('#saveDoc', m), async () => {
        await api(doc ? `/doctors/${doc.id}` : '/doctors', { method: doc ? 'PUT' : 'POST', body });
        toast(doc ? 'Doctor updated' : 'Doctor added');
        close();
        await loadDoctors();
        renderRoleControls();
        if (state.view === 'doctors') renderDoctorCards();
      });
    });
  });
}

/* ================= Report ================= */
function viewReport() {
  if (!state.reportDate) state.reportDate = state.today;
  app.innerHTML = `
  <section class="view">
    <div class="page-head">
      <div><h2>Daily report</h2><p>Per doctor: booked, seen, no-shows and average wait (check-in → called).</p></div>
      <div class="toolbar">
        <button class="btn btn-sm" id="rPrev">‹</button>
        <input type="date" class="input" id="rDate" style="width:auto" value="${state.reportDate}" />
        <button class="btn btn-sm" id="rNext">›</button>
      </div>
    </div>
    <div id="reportBox"></div>
  </section>`;
  const go = (d) => { state.reportDate = d; $('#rDate').value = d; loadReport(); };
  $('#rDate').addEventListener('change', (e) => go(e.target.value || state.today));
  $('#rPrev').addEventListener('click', () => go(addDays(state.reportDate, -1)));
  $('#rNext').addEventListener('click', () => go(addDays(state.reportDate, 1)));
  loadReport();
}

function countUp(el) {
  const target = Number(el.dataset.to);
  const decimals = String(el.dataset.to).includes('.') ? 1 : 0;
  const start = performance.now();
  const dur = 900;
  const tick = (t) => {
    const p = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = (target * eased).toFixed(decimals) + (el.dataset.suffix || '');
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function loadReport() {
  const box = $('#reportBox');
  box.innerHTML = `<div class="kpis">${'<div class="card"><div class="skeleton" style="height:64px"></div></div>'.repeat(4)}</div>`;
  let rows;
  try { rows = await api(`/reports/daily?date=${state.reportDate}`); } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  if (state.role === 'doctor') rows = rows.filter((r) => r.doctor_id === state.doctorId);
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const waits = rows.filter((r) => r.avg_wait_min !== null);
  const seenTotal = rows.reduce((s, r) => s + (r.avg_wait_min !== null ? r.seen : 0), 0);
  const avgWait = seenTotal ? Math.round((waits.reduce((s, r) => s + r.avg_wait_min * r.seen, 0) / seenTotal) * 10) / 10 : null;
  const kpi = (label, value, icon, bg, fg, suffix = '', i = 0) => `
    <div class="card hoverable kpi" style="--i:${i}"><div class="k-icon" style="background:${bg};color:${fg}">${icon}</div>
      <div class="k-label">${label}</div><div class="k-value" ${value !== null ? `data-to="${value}" data-suffix="${suffix}"` : ''}>${value === null ? '—' : '0'}</div></div>`;

  box.innerHTML = `
    <div class="kpis stagger">
      ${kpi('Booked', sum('booked') + sum('walk_ins'), ICON.book, '#eaf2ff', '#2563eb', '', 0)}
      ${kpi('Seen', sum('seen'), ICON.check, 'var(--success-50)', 'var(--success)', '', 1)}
      ${kpi('No-shows', sum('no_shows'), ICON.alert, 'var(--danger-50)', 'var(--danger)', '', 2)}
      ${kpi('Avg wait', avgWait, ICON.clock, 'var(--warn-50)', 'var(--warn)', ' min', 3)}
    </div>
    <div class="card" style="padding:8px 8px 4px"><div class="table-wrap"><table>
      <thead><tr><th>Doctor</th><th>Booked</th><th>Walk-ins</th><th>Cancelled</th><th>Checked in</th><th>Seen</th><th>No-shows</th><th>Not arrived</th><th>Avg wait</th><th>Avg consult</th><th>Seen / expected</th></tr></thead>
      <tbody>${rows.map((r, i) => {
        const expected = r.booked + r.walk_ins;
        const pct = expected ? Math.round((r.seen / expected) * 100) : 0;
        return `<tr style="--i:${i}">
          <td><strong>${esc(r.doctor_name)}</strong><div class="muted small">${esc(r.department)}</div></td>
          <td class="mono">${r.booked}</td><td class="mono">${r.walk_ins}</td><td class="mono">${r.cancelled}</td><td class="mono">${r.checked_in}</td>
          <td class="mono"><strong>${r.seen}</strong></td>
          <td>${r.no_shows ? pill('no_show', String(r.no_shows)) : '<span class="mono">0</span>'}</td>
          <td class="mono">${r.not_arrived}</td>
          <td class="mono">${r.avg_wait_min === null ? '—' : `${r.avg_wait_min} min`}</td>
          <td class="mono">${r.avg_consult_min === null ? '—' : `${r.avg_consult_min} min`}</td>
          <td><div style="display:flex;align-items:center;gap:8px"><div class="bar" style="flex:1"><span data-w="${pct}"></span></div><span class="small mono">${pct}%</span></div></td>
        </tr>`;
      }).join('')}</tbody></table></div></div>`;
  $$('[data-to]', box).forEach(countUp);
  requestAnimationFrame(() => requestAnimationFrame(() => $$('.bar > span', box).forEach((b) => { b.style.width = `${b.dataset.w}%`; })));
}

/* ================= Notifications ================= */
function viewNotifications() {
  app.innerHTML = `
  <section class="view">
    <div class="page-head"><div><h2>SMS log</h2><p>Simulated notifications sent to patients (latest first).</p></div>
      <button class="btn btn-sm" id="nRefresh">${ICON.refresh}Refresh</button></div>
    <div class="list" id="smsList"></div>
  </section>`;
  $('#nRefresh').addEventListener('click', (e) => withLoading(e.currentTarget, loadNotifications));
  loadNotifications();
}
async function loadNotifications() {
  const list = $('#smsList');
  if (!list) return;
  const items = await api('/notifications');
  list.innerHTML = items.length ? items.map((n, i) => {
    const [head, ...rest] = n.message.split(': ');
    return `<div class="sms" style="--i:${Math.min(i, 20)}"><div class="sms-icon">${ICON.sms}</div><div class="grow" style="flex:1"><div class="muted small">${esc(head)} · ${new Date(n.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div><div>${esc(rest.join(': '))}</div></div></div>`;
  }).join('') : '<div class="empty"><span class="big">📭</span>No messages yet</div>';
}

/* ================= Boot ================= */
const VIEWS = {
  book: viewBook,
  appointments: viewAppointments,
  queue: viewQueue,
  myqueue: viewMyQueue,
  doctors: viewDoctors,
  report: viewReport,
  notifications: viewNotifications,
};

let lastBrowserDate = toDateStr(new Date());
function tickClock() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // "Today" comes from the server (hospital timezone). Re-ask it when the local date rolls over.
  const browserDate = toDateStr(now);
  if (browserDate !== lastBrowserDate) {
    lastBrowserDate = browserDate;
    api('/meta').then((m) => { state.today = m.today; }).catch(() => {});
  }
}

async function boot() {
  tickClock();
  setInterval(tickClock, 1000);
  try {
    const meta = await api('/meta');
    state.today = meta.today;
    await loadDoctors();
  } catch (err) {
    app.innerHTML = `<div class="empty"><span class="big">⚠️</span><strong>Can't reach the server</strong><div class="small">${esc(err.message)}</div></div>`;
    return;
  }
  renderRoleControls();
  renderTabs();
  renderView();

  // Poll live views every 10 s
  setInterval(() => {
    if (document.hidden) return;
    if (state.view === 'queue') refreshQueue(false);
    if (state.view === 'myqueue') refreshMyQueue(false);
  }, 10000);
}
boot();
