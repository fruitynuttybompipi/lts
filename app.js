import {
  addDays, balances, changeCommitment, correctBalance, cycleOf, cycleReport, endCommitment, localToday,
  merge, parseSen, planFor, prevCycle, savePlan, summary, BUFFER_PCT, FULL_CYCLES_NEEDED,
} from './budget.mjs';

const KEY = 'left-to-spend-data';
const SYNC_KEY = 'left-to-spend-sync';
const DATA_FILE = 'finance.json';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const uid = () => crypto.randomUUID();
const slug = s => s.toLowerCase().replace(/\W+/g, '-');

const sign = n => (n < 0 ? '−' : '');
const plain = sen => (Math.abs(sen) / 100).toLocaleString('en-MY', {
  minimumFractionDigits: sen % 100 ? 2 : 0, maximumFractionDigits: 2,
});
const money = sen => `${sign(sen)}RM ${plain(sen)}`;
const inputAmount = sen => (sen ? (sen / 100).toFixed(2).replace(/\.00$/, '') : '');

const asDate = iso => new Date(`${iso}T12:00:00`);
const shortDate = iso => asDate(iso).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' });
const longDate = iso => asDate(iso).toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short' });

function seed() {
  const cats = ['Food', 'Groceries', 'Transport', 'Shopping', 'Bills', 'Health', 'Fun', 'Other'];
  const regular = ['House loan', 'Car loan', 'House rental', 'Health insurance', 'Subscriptions', 'Instalments'];
  // Fixed ids, so two devices that start separately do not get duplicates when merged.
  return {
    meta: { payday: null, setupDate: null, salaryAccountId: null, updatedAt: 0 },
    accounts: [],
    categories: cats.map(name => ({ id: `cat-${slug(name)}`, name, updatedAt: 0 })),
    commitments: regular.map(name => ({
      id: `com-${slug(name)}`, name, amount: 0, day: 1, accountId: null, from: '', to: null, addedOn: '', updatedAt: 0,
    })),
    plans: [], tx: [], deleted: {}, dismissed: {},
  };
}

function load() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return seed();
  try {
    return merge(seed(), JSON.parse(raw));
  } catch {
    localStorage.setItem(`${KEY}-damaged-${Date.now()}`, raw);
    return seed();
  }
}

let data = load();
let cfg = {};
try { cfg = JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch { /* no saved sync settings */ }

const ui = { tab: 'today', cycleBack: 0, category: null };
let syncText = '';

const isSetup = () => data.plans.length > 0;
const hasCommitments = () => data.commitments.some(c => c.amount > 0);
// The figure means nothing until commitments are in, so setup stays on screen until then.
const isReady = () => isSetup() && openAccounts().length > 0 && hasCommitments();
const typing = () => document.activeElement?.closest('#view input, #view select');
const TYPE_ORDER = { card: 0, ewallet: 1, bank: 2 };
const openAccounts = () => data.accounts.filter(a => !a.archived)
  .sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.name.localeCompare(b.name));
// Most-used categories come first, so logging usually takes one tap.
function categoriesByUse() {
  const uses = new Map();
  for (const t of data.tx) if (t.type === 'spend') uses.set(t.categoryId, (uses.get(t.categoryId) ?? 0) + 1);
  return data.categories.filter(c => !c.archived)
    .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0) || a.name.localeCompare(b.name));
}
const categoryName = id => data.categories.find(c => c.id === id)?.name ?? 'Uncategorised';
const accountName = id => data.accounts.find(a => a.id === id)?.name ?? 'Unknown account';

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    toast('Could not save on this device');
  }
}

const saved = () => { persist(); queueSync(); };
const commit = () => { saved(); render(); };

/* Views */

const CATEGORY_ICONS = ['food', 'groceries', 'transport', 'shopping', 'bills', 'health', 'fun', 'other'];

// Seeded categories keep one hue and icon; added ones stay neutral rather than generating a colour.
function badge(categoryId, name) {
  const key = String(categoryId).replace('cat-', '');
  if (CATEGORY_ICONS.includes(key)) return `<span class="badge" data-cat="${key}"><svg class="icon" aria-hidden="true"><use href="#c-${key}"/></svg></span>`;
  return `<span class="badge" aria-hidden="true">${esc((name || '?').slice(0, 1).toUpperCase())}</span>`;
}

const moveBadge = (icon, kind) => `<span class="badge" data-cat="${kind}"><svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg></span>`;

function entryRow(t) {
  const title = t.type === 'spend' ? (t.note || categoryName(t.categoryId))
    : t.type === 'income' ? (t.note || 'Received')
    : `${accountName(t.accountId)} to ${accountName(t.toAccountId)}`;
  const where = t.type === 'spend' ? (t.note ? `${categoryName(t.categoryId)} · ${accountName(t.accountId)}` : accountName(t.accountId))
    : t.type === 'income' ? accountName(t.accountId)
    : 'Moved, not spending';
  const amount = t.type === 'income' ? `+${money(t.amount)}` : money(t.amount);
  const mark = t.type === 'spend' ? badge(t.categoryId, categoryName(t.categoryId))
    : t.type === 'income' ? moveBadge('i-add', 'in') : moveBadge('i-next', 'move');
  return `<li><button class="row" data-act="edit" data-id="${esc(t.id)}">
    ${mark}
    <span class="row-main"><span class="row-title">${esc(title)}</span><span class="row-sub">${esc(where)}</span></span>
    <span class="row-amount ${t.type === 'income' ? 'in' : ''}">${amount}</span>
  </button></li>`;
}

const byNewest = (a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt;
const entries = () => data.tx.filter(t => t.type !== 'adjust').sort(byNewest);

function accountCard(a, bal) {
  const type = { bank: 'Bank', card: 'Credit card', ewallet: 'E-wallet' }[a.type];
  return `<li><button class="acct" data-type="${a.type}" data-act="account" data-id="${esc(a.id)}">
    <span class="acct-main"><span class="acct-name">${esc(a.name)}</span><span class="acct-type">${type}</span></span>
    <span class="acct-balance">${money(bal)}</span>
  </button></li>`;
}

const figureText = left => (left < 0 ? Math.ceil(-left / 100) : Math.floor(left / 100)).toLocaleString('en-MY');
const figure = (text, id = '') => `<p class="figure" style="--len:${text.length}"><span class="cur">RM</span> <span ${id ? `id="${id}"` : ''}>${text}</span></p>`;
const PACE_WORDS = { ok: 'On track', fast: 'Spending fast', over: 'Over budget' };

function hero(s, today) {
  const over = s.left < 0;
  const payday = today === s.cycle.start;
  const dayWord = s.days === 1 ? 'day' : 'days';
  return `<section class="hero" id="hero" data-state="${over ? 'over' : 'ok'}">
    ${figure(figureText(s.left), 'figure')}
    <p class="hero-label">${over ? 'over budget' : 'left to spend'}</p>
    <div class="pace" data-pace="${s.pace.state}" role="img" aria-label="${s.pace.spentPct.toFixed(0)}% of budget spent, ${s.pace.dayPct.toFixed(0)}% of the pay cycle gone. ${PACE_WORDS[s.pace.state]}.">
      <span class="pace-fill" style="width:${s.pace.spentPct.toFixed(1)}%"></span>
      <span class="pace-now" style="left:${s.pace.dayPct.toFixed(1)}%"></span>
    </div>
    <p class="pace-row">
      <span class="pace-word" data-pace="${s.pace.state}">${PACE_WORDS[s.pace.state]}</span>
      <span>${payday ? 'Payday today' : `${s.days} ${dayWord} to payday`}</span>
    </p>
  </section>`;
}

const savingsShort = sv => (sv.lowered ? 'Lowered after last cycle' : sv.basis === 'average' ? 'Based on your spending' : `${sv.pct}% of what's left`);

function savingsNote(sv) {
  const parts = [];
  if (sv.basis === 'average') parts.push(`Based on your average spending of ${money(sv.average)}, keeping a ${BUFFER_PCT}% buffer.`);
  else if (sv.basis === 'start') parts.push(`${sv.pct}% of what's left after commitments. Updates after ${FULL_CYCLES_NEEDED} full pay cycles.`);
  else parts.push(`${sv.pct}% of what's left after commitments.`);
  if (sv.lowered) {
    parts.push(`Lowered by ${money(sv.lowered)} because last cycle went ${money(sv.over)} over.`);
    if (sv.causes.length) parts.push(`Biggest rises: ${sv.causes.map(categoryName).join(', ')}.`);
  }
  return parts.join(' ');
}

function viewToday() {
  const today = localToday();
  const warning = /rejected|not found|damaged/i.test(syncText) ? `<span class="sync-warning">${esc(syncText)}</span>` : '';
  if (!isReady()) {
    const count = openAccounts().length;
    const pay = isSetup() ? summary(data, today) : null;
    const step = (done, act, title, sub, off) => `<li><button class="acct step ${done ? '' : 'ghost'}" ${done ? 'data-type="bank"' : ''} data-act="${act}" ${off ? 'disabled' : ''}>
      <span class="acct-main"><span class="acct-name">${title}</span><span class="acct-type">${esc(sub)}</span></span>
      <svg class="icon" aria-hidden="true"><use href="#i-${done ? 'check' : 'next'}"/></svg>
      ${done ? '<span class="visually-hidden">Done</span>' : ''}
    </button></li>`;
    return `<div class="topline"><h1>Set up your wallet</h1>${warning}</div>
    <p class="hero-sub">Three steps, then your left to spend appears here.</p>
    <ol class="stack">
      ${step(isSetup(), 'salary', 'Salary and payday', pay ? `${money(pay.salary)}, payday on day ${data.meta.payday}` : 'What lands in your bank each month')}
      ${step(count > 0, 'account', 'Your accounts', count ? `${count} added. Tap to add another.` : 'Your bank, cards and e-wallets')}
      ${step(hasCommitments(), 'commitments', 'Monthly commitments', isSetup() ? 'Loans, rental, insurance and more' : 'Add your salary first', !isSetup())}
    </ol>`;
  }

  const s = summary(data, today);
  const { balances: bal } = balances(data, today);
  const leftover = s.leftover && s.left >= 0 && !data.dismissed[s.prior.start];
  const recent = entries().slice(0, 5);
  return `<div class="topline quiet"><h1 class="visually-hidden">Today</h1><p class="date">${esc(asDate(today).toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'long' }))}</p>${warning}</div>
  ${hero(s, today)}

  <ul class="stack">
    <li><button class="acct" data-type="save" data-act="savings">
      <span class="acct-main"><span class="acct-name">Suggested savings</span><span class="acct-type">${esc(savingsShort(s.savings))}</span></span>
      <span class="acct-balance">${money(s.savings.amount)}</span>
    </button></li>
    ${openAccounts().map(a => accountCard(a, bal.get(a.id))).join('')}
  </ul>

  ${leftover ? `<div class="notice">
    <p><b>${money(s.leftover)} left from last cycle.</b> Move it to savings?</p>
    <div class="notice-actions">
      <button class="btn primary" data-act="move-leftover" data-amount="${s.leftover}">Move to savings</button>
      <button class="btn" data-act="dismiss-leftover" data-id="${esc(s.prior.start)}">Not now</button>
    </div>
  </div>` : ''}

  <section class="block"><h2>Recent</h2>
    ${recent.length ? `<ul class="rows">${recent.map(entryRow).join('')}</ul>` : '<p class="empty">Nothing logged yet. Tap + after your next purchase.</p>'}
  </section>`;
}

function selectedCycle() {
  let cycle = cycleOf(localToday(), data.meta.payday);
  for (let i = 0; i < ui.cycleBack; i++) cycle = prevCycle(cycle, data.meta.payday);
  return cycle;
}

function viewSpending() {
  if (!isReady()) {
    return `<div class="topline"><h1>Where it went</h1></div>
    <p class="hero-sub">Once you start logging, this shows where each ringgit went.</p>
    <button class="btn primary wide" data-act="tab" data-tab="today">Finish setup</button>`;
  }
  const cycle = selectedCycle();
  const report = cycleReport(data, cycle);
  const first = cycleOf(data.meta.setupDate, data.meta.payday).start;
  const top = report.categories[0]?.amount ?? 0;
  const inRange = t => t.date >= cycle.start && t.date < cycle.end;
  const list = entries().filter(inRange).filter(t => !ui.category || t.categoryId === ui.category);
  const groups = new Map();
  for (const t of list) groups.set(t.date, [...(groups.get(t.date) ?? []), t]);

  return `<div class="topline"><h1>Where it went</h1></div>
  <div class="cycle-nav">
    <button data-act="cycle" data-step="1" aria-label="Previous pay cycle" ${cycle.start <= first ? 'disabled' : ''}><svg class="icon"><use href="#i-back"/></svg></button>
    <span>${shortDate(cycle.start)} to ${shortDate(addDays(cycle.end, -1))}</span>
    <button data-act="cycle" data-step="-1" aria-label="Next pay cycle" ${ui.cycleBack ? '' : 'disabled'}><svg class="icon"><use href="#i-next"/></svg></button>
  </div>
  <section class="hero" data-state="${report.spent > report.budget ? 'over' : 'ok'}">
    ${figure(plain(report.spent))}
    <p class="hero-label">spent of ${money(report.budget)} budget</p>
    ${report.categories.length ? `<div class="mix" aria-hidden="true">${report.categories.map(c => `<span data-cat="${esc(String(c.id).replace('cat-', ''))}" style="flex:${c.amount} 1 0"></span>`).join('')}</div>` : ''}
    <p class="hero-sub">Commitments of ${money(report.commitments)} are counted separately</p>
  </section>

  <section class="block"><h2>By category</h2>
    ${report.categories.length ? `<div class="cats">${report.categories.map(c => `
      <button class="cat" data-act="filter" data-id="${esc(c.id)}" aria-pressed="${ui.category === c.id}">
        ${badge(c.id, categoryName(c.id))}
        <span class="cat-main">
          <span class="cat-label"><span>${esc(categoryName(c.id))}</span><span>${money(c.amount)}</span></span>
          <span class="cat-track"><span class="cat-bar" data-cat="${esc(String(c.id).replace('cat-', ''))}" style="width:${(c.amount / top * 100).toFixed(1)}%"></span></span>
        </span>
      </button>`).join('')}</div>` : '<p class="empty">No spending logged in this cycle.</p>'}
  </section>

  <section class="block"><h2>${ui.category ? esc(categoryName(ui.category)) : 'All entries'}</h2>
    ${[...groups].map(([date, items]) => `<p class="date-head">${longDate(date)}</p><ul class="rows">${items.map(entryRow).join('')}</ul>`).join('') || '<p class="empty">No entries.</p>'}
  </section>`;
}

function viewAccounts() {
  const today = localToday();
  const b = balances(data, today);
  const open = openAccounts();
  const archived = data.accounts.filter(a => a.archived);
  return `<div class="topline"><h1>Accounts</h1></div>
  ${open.length ? `<ul class="stack">${open.map(a => accountCard(a, b.balances.get(a.id))).join('')}</ul>
  <button class="btn wide" data-act="account">Add account</button>` : `<ul class="stack">
    <li><button class="acct ghost" data-act="account" data-kind="bank"><span class="acct-name">Add your bank</span><svg class="icon" aria-hidden="true"><use href="#i-add"/></svg></button></li>
    <li><button class="acct ghost" data-act="account" data-kind="card"><span class="acct-name">Add a credit card</span><svg class="icon" aria-hidden="true"><use href="#i-add"/></svg></button></li>
    <li><button class="acct ghost" data-act="account" data-kind="ewallet"><span class="acct-name">Add an e-wallet</span><svg class="icon" aria-hidden="true"><use href="#i-add"/></svg></button></li>
  </ul>`}
  ${b.spokenFor ? `<section class="block"><h2>Already spoken for</h2>
    <p class="spoken">${money(b.spokenFor)}</p>
    <div class="sum-group"><table class="sum-table"><tbody>
      ${b.owed ? `<tr><th scope="row">Card bills</th><td>${money(b.owed)}</td></tr>` : ''}
      ${b.unpaid ? `<tr><th scope="row">Commitments still due from bank</th><td>${money(b.unpaid)}</td></tr>` : ''}
    </tbody></table></div>
  </section>` : ''}
  ${archived.length ? `<details><summary>Archived accounts</summary>
    <ul class="rows">${archived.map(a => `<li><button class="row" data-act="restore" data-id="${esc(a.id)}">
      <span class="row-main"><span class="row-title">${esc(a.name)}</span></span><span class="row-amount">Restore</span>
    </button></li>`).join('')}</ul>
  </details>` : ''}`;
}

function viewPlan() {
  const today = localToday();
  const setup = isSetup();
  const plan = setup ? summary(data, today) : null;
  const cycle = setup ? cycleOf(today, data.meta.payday) : null;
  const pct = setup ? planFor(data, cycle).savePct : null;
  const banks = openAccounts();
  const current = setup ? data.commitments.filter(c => !c.to || c.to >= cycle.end).sort((a, b) => b.amount - a.amount) : [];
  return `<div class="topline"><h1>Plan</h1></div>
  <form id="plan-form" novalidate>
    <div class="rows form-rows">
      <label class="grow"><span>Take-home salary</span>
        <input name="salary" inputmode="decimal" autocomplete="off" aria-describedby="plan-error" value="${setup ? inputAmount(plan.salary) : ''}" placeholder="RM 0"></label>
      <label class="grow"><span>Payday, day of month</span>
        <input name="payday" inputmode="numeric" autocomplete="off" aria-describedby="plan-error" value="${data.meta.payday ?? ''}" placeholder="Day 1 to 31"></label>
      ${banks.length ? `<label class="grow"><span>Salary goes into</span>
        <select name="salaryAccount"><option value="">Choose</option>${banks.map(a => `<option value="${esc(a.id)}" ${a.id === data.meta.salaryAccountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>` : ''}
      <label class="grow"><span>Suggest savings for me</span>
        <input type="checkbox" name="auto" role="switch" ${pct == null ? 'checked' : ''}></label>
      <label class="grow" ${pct == null ? 'hidden' : ''} id="pct-field"><span>Save % of what's left</span>
        <input name="pct" inputmode="numeric" autocomplete="off" aria-describedby="plan-error" value="${pct ?? 20}"></label>
    </div>
    <p class="error" id="plan-error" role="alert"></p>
    <p class="block-note form-note">Changes apply from this pay cycle. Past cycles stay as they were.</p>
  </form>

  ${setup ? `<section class="block"><h2>Commitments</h2>
    <ul class="rows">${current.map(c => `<li><button class="row" data-act="commitment" data-id="${esc(c.id)}">
      <span class="row-main"><span class="row-title">${esc(c.name)}</span>
      <span class="row-sub">${c.amount ? `Day ${c.day}${c.accountId ? ` · ${esc(accountName(c.accountId))}` : ''}` : 'Not set'}</span></span>
      <span class="row-amount">${c.amount ? money(c.amount) : 'Add'}</span>
    </button></li>`).join('')}</ul>
    <button class="btn wide" data-act="commitment">Add commitment</button>
  </section>

  <section class="block"><ul class="rows">
    <li><button class="row" data-act="categories">
      <span class="row-main"><span class="row-title">Categories</span></span>
      <span class="row-amount">${data.categories.filter(c => !c.archived).length}</span>
    </button></li>
  </ul></section>` : ''}

  <section class="block"><ul class="rows">
    <li><button class="row" data-act="sync-settings">
      <span class="row-main"><span class="row-title">Sync with GitHub</span>
      <span class="row-sub" id="sync-status" role="status">${esc(syncText || (cfg.token ? 'Connected' : 'Saved on this device only'))}</span></span>
    </button></li>
  </ul></section>`;
}

const VIEWS = { today: viewToday, spending: viewSpending, accounts: viewAccounts, plan: viewPlan };

function render() {
  $('#view').innerHTML = VIEWS[ui.tab]();
  document.querySelectorAll('.tabs [data-tab]').forEach(b => {
    if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

/* The figure counts to its new value after an entry. */

function rollFigure(from) {
  const el = $('#figure');
  if (!el || from == null || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const to = summary(data, localToday()).left;
  if (from === to || (from < 0) !== (to < 0)) return;
  const start = performance.now();
  const final = el.textContent;
  const step = now => {
    const t = Math.min(1, (now - start) / 420);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = t < 1 ? figureText(from + (to - from) * eased) : final;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* Toast */

let toastTimer;
const hideToast = () => $('#toast').classList.remove('show');

// An undo stays until the next action, so there is no time limit on recovering an entry.
function toast(text, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(text)}</span>${undo ? '<button>Undo</button>' : ''}`;
  if (undo) el.querySelector('button').onclick = () => { el.classList.remove('show'); undo(); };
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (!undo) toastTimer = setTimeout(hideToast, 2500);
}

/* Sheets */

const sheet = $('#sheet');

let sheetOpener = null;

function openSheet({ title, body, save, saveLabel = 'Save', focus, cancel = true }) {
  if (!sheet.open) sheetOpener = document.activeElement;
  sheet.innerHTML = `<form novalidate>
    <div class="sheet-head">
      ${cancel ? '<button type="button" data-close>Cancel</button>' : '<span></span>'}
      <h2 id="sheet-title">${esc(title)}</h2>
      <button class="save">${esc(saveLabel)}</button>
    </div>
    <div class="sheet-body"><p class="error" id="sheet-error" role="alert"></p>${body}</div>
  </form>`;
  const form = sheet.querySelector('form');
  const type = form.querySelector('[name="type"]:checked');
  if (type) form.dataset.type = type.value;
  form.addEventListener('change', e => { if (e.target.name === 'type') form.dataset.type = e.target.value; });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const problem = save(new FormData(form));
    form.querySelectorAll('[aria-invalid]').forEach(el => { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); });
    if (problem) {
      const [name, text] = problem;
      form.querySelector('.error').textContent = text;
      const field = form.elements[name];
      const target = field instanceof RadioNodeList ? field[0] : field;
      target.setAttribute('aria-invalid', 'true');
      target.setAttribute('aria-describedby', 'sheet-error');
      target.focus();
      sheet.scrollTop = 0;
    } else {
      sheet.close();
    }
  });
  if (!sheet.open) sheet.showModal();
  if (focus) form.elements[focus].focus();
}

const chips = (name, legend, items, chosen, extra = '') => `<fieldset class="field ${extra}">
  <legend class="field-label">${legend}</legend>
  <div class="chips">${items.map(i => `<label>
    <input type="radio" name="${name}" value="${esc(i.id)}" ${i.id === chosen ? 'checked' : ''}><span>${esc(i.name)}</span>
  </label>`).join('')}</div>
</fieldset>`;

const segments = (name, legend, items, chosen) => `<fieldset class="seg-group">
  <legend class="visually-hidden">${legend}</legend>
  <div class="seg">${items.map(([value, label]) => `<label>
    <input type="radio" name="${name}" value="${value}" ${value === chosen ? 'checked' : ''}><span>${label}</span>
  </label>`).join('')}</div>
</fieldset>`;

function entrySheet(entry, preset = {}) {
  const accounts = openAccounts();
  if (!entry && !accounts.length) {
    toast('Add an account first');
    ui.tab = 'accounts';
    render();
    return;
  }
  const t = entry ?? {
    type: 'spend', amount: 0, date: localToday(), note: '',
    accountId: entries().find(x => x.type === 'spend')?.accountId ?? accounts[0].id,
    ...preset,
  };
  const pickable = [...accounts];
  for (const id of [t.accountId, t.toAccountId]) {
    const a = data.accounts.find(x => x.id === id);
    if (a?.archived) pickable.push(a);
  }
  const body = `
    ${segments('type', 'Entry type', [['spend', 'Spent'], ['income', 'Received'], ['transfer', 'Moved']], t.type)}
    <label class="field amount-field"><span class="field-label">Amount in RM</span>
      <input name="amount" inputmode="decimal" autocomplete="off" value="${inputAmount(t.amount)}" placeholder="0"></label>
    ${chips('categoryId', 'Category', [...categoriesByUse(), ...data.categories.filter(c => c.archived && c.id === t.categoryId)], t.categoryId, 'only-spend')}
    ${chips('accountId', 'Account', pickable, t.accountId)}
    ${chips('toAccountId', 'Moved to', pickable, t.toAccountId, 'only-transfer')}
    <label class="field"><span class="field-label">Date</span><input type="date" name="date" value="${t.date}"></label>
    <label class="field not-transfer"><span class="field-label">Note, optional</span><input name="note" autocomplete="off" value="${esc(t.note)}"></label>
    ${entry ? `<button type="button" class="btn danger" data-act="delete-entry" data-id="${esc(entry.id)}">Delete entry</button>` : ''}`;

  openSheet({
    title: entry ? 'Edit entry' : 'Add entry',
    focus: entry ? null : 'amount',
    body,
    save(f) {
      const type = f.get('type');
      const amount = parseSen(f.get('amount'));
      const date = f.get('date');
      if (!(amount > 0)) return ['amount', 'Enter an amount above zero, for example 12.50.'];
      if (type === 'spend' && !f.get('categoryId')) return ['categoryId', 'Choose a category.'];
      if (!f.get('accountId')) return ['accountId', 'Choose an account.'];
      if (type === 'transfer' && !f.get('toAccountId')) return ['toAccountId', 'Choose where the money moved to.'];
      if (type === 'transfer' && f.get('toAccountId') === f.get('accountId')) return ['toAccountId', 'Choose two different accounts.'];
      if (!date) return ['date', 'Choose a date.'];
      const fields = {
        type, amount, date, accountId: f.get('accountId'),
        categoryId: type === 'spend' ? f.get('categoryId') : null,
        toAccountId: type === 'transfer' ? f.get('toAccountId') : null,
        note: type === 'transfer' ? '' : f.get('note').trim(),
        updatedAt: Date.now(),
      };
      const before = isReady() ? summary(data, localToday()).left : null;
      if (entry) Object.assign(entry, fields);
      else data.tx.push({ id: uid(), ...fields });
      commit();
      if (ui.tab === 'today') rollFigure(before);
      toast(entry ? 'Entry updated' : `Logged ${money(amount)}`);
    },
  });
}

function accountSheet(account, kind) {
  const bal = account ? balances(data, localToday()).balances.get(account.id) : 0;
  const current = account ? (account.type === 'card' ? Math.max(0, -bal) : bal) : 0;
  const body = `
    <label class="field"><span class="field-label">Name</span><input name="name" autocomplete="off" value="${esc(account?.name)}"></label>
    ${segments('type', 'Account type', [['bank', 'Bank'], ['card', 'Credit card'], ['ewallet', 'E-wallet']], account?.type ?? kind ?? 'bank')}
    <label class="field"><span class="field-label not-card">${account ? 'Correct balance' : 'Balance today'}</span>
      <span class="field-label only-card">${account ? 'Correct amount owed' : 'Amount owed today'}</span>
      <input name="balance" inputmode="decimal" autocomplete="off" value="${current > 0 ? inputAmount(current) : ''}" placeholder="0">
      ${account ? '<span class="field-hint">Change this if it no longer matches your app or statement. It does not count as spending.</span>' : ''}</label>
    ${account ? `<button type="button" class="btn danger" data-act="archive" data-id="${esc(account.id)}">Remove account</button>` : ''}`;

  openSheet({
    title: account ? 'Edit account' : 'Add account',
    focus: account ? null : 'name',
    body,
    save(f) {
      const name = f.get('name').trim();
      const type = f.get('type');
      const text = f.get('balance').trim();
      const amount = text ? parseSen(text) : 0;
      if (!name) return ['name', 'Enter a name.'];
      if (Number.isNaN(amount)) return ['balance', 'Enter the balance as a number, for example 1200.50.'];
      const signed = type === 'card' ? -amount : amount;
      const now = Date.now();
      if (account) {
        Object.assign(account, { name, type, updatedAt: now });
        correctBalance(data, account.id, signed, localToday(), now);
      } else {
        const id = uid();
        data.accounts.push({ id, name, type, opening: signed, addedOn: localToday(), archived: false, updatedAt: now });
        if (type === 'bank' && !data.meta.salaryAccountId) {
          data.meta = { ...data.meta, salaryAccountId: id, updatedAt: now };
        }
      }
      commit();
    },
  });
}

function commitmentSheet(c) {
  const body = `
    <label class="field"><span class="field-label">Name</span><input name="name" autocomplete="off" value="${esc(c?.name)}"></label>
    <label class="field"><span class="field-label">Monthly amount in RM</span>
      <input name="amount" inputmode="decimal" autocomplete="off" value="${inputAmount(c?.amount)}" placeholder="0"></label>
    <label class="field"><span class="field-label">Paid on day of the month</span>
      <input name="day" inputmode="numeric" autocomplete="off" value="${c?.day ?? 1}"></label>
    <label class="field"><span class="field-label">Paid from</span>
      <select name="accountId"><option value="">Choose account</option>${openAccounts().map(a => `<option value="${esc(a.id)}" ${a.id === c?.accountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
      <span class="field-hint">This already counts each month, so do not log it as a purchase.</span></label>
    ${c ? `<button type="button" class="btn danger" data-act="end-commitment" data-id="${esc(c.id)}">Remove commitment</button>` : ''}`;

  openSheet({
    title: c ? 'Edit commitment' : 'Add commitment',
    focus: c ? 'amount' : 'name',
    body,
    save(f) {
      const name = f.get('name').trim();
      const amount = parseSen(f.get('amount'));
      const day = Number(f.get('day'));
      if (!name) return ['name', 'Enter a name.'];
      if (!(amount > 0)) return ['amount', 'Enter a monthly amount above zero.'];
      if (!Number.isInteger(day) || day < 1 || day > 31) return ['day', 'Enter a day from 1 to 31.'];
      const fields = { name, amount, day, accountId: f.get('accountId') || null };
      const today = localToday();
      const now = Date.now();
      if (c) changeCommitment(data, c.id, fields, today, now);
      else data.commitments.push({
        id: uid(), ...fields, from: cycleOf(today, data.meta.payday).start, to: null, addedOn: today, updatedAt: now,
      });
      commit();
    },
  });
}

function savingsSheet() {
  const s = summary(data, localToday());
  openSheet({
    title: 'Suggested savings',
    saveLabel: 'Done',
    cancel: false,
    body: `<p class="sheet-amount">${money(s.savings.amount)}</p>
      <p class="block-note">${esc(savingsNote(s.savings))}</p>
      <div class="sum-group"><table class="sum-table"><tbody>
        <tr><th scope="row">Salary</th><td>${money(s.salary)}</td></tr>
        <tr><th scope="row">Commitments</th><td>${money(-s.commitments)}</td></tr>
        <tr><th scope="row">Suggested savings</th><td>${money(-s.savings.amount)}</td></tr>
        ${s.income ? `<tr><th scope="row">Other money received</th><td>+${money(s.income)}</td></tr>` : ''}
        <tr><th scope="row">Spent so far</th><td>${money(-s.spent)}</td></tr>
        <tr class="total"><th scope="row">Left to spend</th><td>${money(s.left)}</td></tr>
      </tbody></table></div>`,
    save() {},
  });
}

function salarySheet() {
  const today = localToday();
  openSheet({
    title: 'Salary and payday',
    focus: 'salary',
    body: `<label class="field"><span class="field-label">Take-home salary in RM</span>
        <input name="salary" inputmode="decimal" autocomplete="off" value="${isSetup() ? inputAmount(summary(data, today).salary) : ''}" placeholder="0"></label>
      <label class="field"><span class="field-label">Payday, day of the month</span>
        <input name="payday" inputmode="numeric" autocomplete="off" value="${data.meta.payday ?? ''}" placeholder="1 to 31"></label>`,
    save(f) {
      const salary = parseSen(f.get('salary'));
      const payday = Number(f.get('payday'));
      if (!(salary > 0)) return ['salary', 'Enter your take-home salary, for example 6000.'];
      if (!Number.isInteger(payday) || payday < 1 || payday > 31) return ['payday', 'Enter a payday from 1 to 31.'];
      setPlan({ salary }, payday);
      commit();
    },
  });
}

function commitmentsSheet() {
  const list = data.commitments.filter(c => !c.to).sort((a, b) => a.name.localeCompare(b.name));
  const accounts = openAccounts();
  openSheet({
    title: 'Monthly commitments',
    body: `<p class="field-hint">Leave blank what you don't have. You can set pay dates later in Plan.</p>
      <div class="rows form-rows">
        ${list.map(c => `<label class="grow"><span>${esc(c.name)}</span>
          <input name="c-${esc(c.id)}" inputmode="decimal" autocomplete="off" value="${inputAmount(c.amount)}" placeholder="RM 0"></label>`).join('')}
        ${accounts.length ? `<label class="grow"><span>Paid from</span>
          <select name="accountId">${accounts.map(a => `<option value="${esc(a.id)}" ${a.id === data.meta.salaryAccountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>` : ''}
      </div>`,
    save(f) {
      const changes = [];
      for (const c of list) {
        const text = f.get(`c-${c.id}`).trim();
        if (!text) continue;
        const amount = parseSen(text);
        if (!(amount > 0)) return [`c-${c.id}`, `Enter ${c.name} as a number, for example 1800.`];
        changes.push([c, amount]);
      }
      if (!changes.length) return [`c-${list[0].id}`, 'Enter at least one monthly amount.'];
      const now = Date.now();
      const accountId = f.get('accountId');
      for (const [c, amount] of changes) {
        if (amount !== c.amount || accountId !== c.accountId) {
          changeCommitment(data, c.id, { amount, accountId: accountId ?? c.accountId }, localToday(), now);
        }
      }
      commit();
    },
  });
}

function categoriesSheet() {
  openSheet({
    title: 'Categories',
    saveLabel: 'Done',
    cancel: false,
    body: `<ul class="rows">${data.categories.filter(c => !c.archived).map(c => `<li><button type="button" class="row" data-act="category" data-id="${esc(c.id)}">
      <span class="row-main"><span class="row-title">${esc(c.name)}</span></span>
    </button></li>`).join('')}</ul>
    <button type="button" class="btn wide" data-act="category">Add category</button>`,
    save() {},
  });
}

function syncSheet() {
  openSheet({
    title: 'Sync with GitHub',
    saveLabel: 'Sync',
    body: `<label class="field"><span class="field-label">Private repo</span>
        <input name="repo" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="owner/lts-data" value="${esc(cfg.repo)}"></label>
      <label class="field"><span class="field-label">Access token</span>
        <input name="token" type="password" autocomplete="off" placeholder="github_pat_..." value="${esc(cfg.token)}">
        <span class="field-hint">Use a fine-grained token limited to that repo, with Contents set to read and write. It stays on this device.</span></label>
      ${cfg.token ? '<button type="button" class="btn danger" data-act="disconnect">Remove token</button>' : ''}`,
    save(f) {
      const repo = f.get('repo').trim();
      const token = f.get('token').trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return ['repo', 'Enter the repo as owner/name.'];
      if (!token) return ['token', 'Add your access token.'];
      cfg = { repo, token };
      localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
      sync();
    },
  });
}

function categorySheet(c) {
  openSheet({
    title: c ? 'Edit category' : 'Add category',
    focus: 'name',
    body: `<label class="field"><span class="field-label">Name</span><input name="name" autocomplete="off" value="${esc(c?.name)}"></label>
      ${c ? `<button type="button" class="btn danger" data-act="archive-category" data-id="${esc(c.id)}">Remove category</button>` : ''}`,
    save(f) {
      const name = f.get('name').trim();
      if (!name) return ['name', 'Enter a name.'];
      if (c) Object.assign(c, { name, updatedAt: Date.now() });
      else data.categories.push({ id: uid(), name, updatedAt: Date.now() });
      commit();
    },
  });
}

/* Plan form saves as each field changes */

function setPlan(patch, payday, salaryAccountId = data.meta.salaryAccountId) {
  const now = Date.now();
  const today = localToday();
  data.meta = { ...data.meta, payday, setupDate: data.meta.setupDate ?? today, salaryAccountId, updatedAt: now };
  savePlan(data, patch, today, now);
}

function savePlanForm(form) {
  const f = new FormData(form);
  const salary = parseSen(f.get('salary'));
  const payday = Number(f.get('payday'));
  const auto = f.get('auto') === 'on';
  const pct = Number(f.get('pct'));
  const error = $('#plan-error');
  $('#pct-field').hidden = auto;
  form.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
  const fail = (name, text) => { error.textContent = text; form.elements[name].setAttribute('aria-invalid', 'true'); };
  if (!f.get('salary') && !f.get('payday')) return;
  if (!(salary > 0)) return fail('salary', 'Enter your take-home salary, for example 6000.');
  if (!Number.isInteger(payday) || payday < 1 || payday > 31) return fail('payday', 'Enter a payday from 1 to 31.');
  if (!auto && !(pct >= 0 && pct <= 100)) return fail('pct', 'Enter a percentage from 0 to 100.');
  error.textContent = '';
  const first = !isSetup();
  setPlan({ salary, savePct: auto ? null : pct }, payday, f.get('salaryAccount') ?? data.meta.salaryAccountId);
  saved();
  if (first) render();
}

/* Actions */

const ACTIONS = {
  tab(el) { ui.tab = el.dataset.tab; ui.category = null; ui.cycleBack = 0; render(); scrollTo(0, 0); },
  add() { entrySheet(); },
  edit(el) { entrySheet(data.tx.find(t => t.id === el.dataset.id)); },
  account(el) { accountSheet(data.accounts.find(a => a.id === el.dataset.id), el.dataset.kind); },
  salary() { salarySheet(); },
  savings() { savingsSheet(); },
  commitments() { commitmentsSheet(); },
  commitment(el) { commitmentSheet(data.commitments.find(c => c.id === el.dataset.id)); },
  category(el) { categorySheet(data.categories.find(c => c.id === el.dataset.id)); },
  categories() { categoriesSheet(); },
  'sync-settings'() { syncSheet(); },
  cycle(el) { ui.cycleBack += Number(el.dataset.step); ui.category = null; render(); },
  filter(el) { ui.category = ui.category === el.dataset.id ? null : el.dataset.id; render(); },
  'move-leftover'(el) { entrySheet(null, { type: 'transfer', amount: Number(el.dataset.amount) }); },
  'dismiss-leftover'(el) { data.dismissed[el.dataset.id] = true; commit(); },
  'delete-entry'(el) {
    const t = data.tx.find(x => x.id === el.dataset.id);
    data.tx = data.tx.filter(x => x !== t);
    data.deleted[t.id] = Date.now();
    sheet.close();
    commit();
    toast('Entry deleted', () => {
      delete data.deleted[t.id];
      t.updatedAt = Date.now();
      data.tx.push(t);
      commit();
    });
  },
  archive(el) {
    const id = el.dataset.id;
    const a = data.accounts.find(x => x.id === id);
    const used = data.tx.some(t => t.accountId === id || t.toAccountId === id)
      || data.commitments.some(c => c.accountId === id) || data.meta.salaryAccountId === id;
    if (used) Object.assign(a, { archived: true, updatedAt: Date.now() });
    else { data.accounts = data.accounts.filter(x => x !== a); data.deleted[id] = Date.now(); }
    sheet.close();
    commit();
    toast(used ? 'Account archived. History kept.' : 'Account removed');
  },
  restore(el) {
    Object.assign(data.accounts.find(a => a.id === el.dataset.id), { archived: false, updatedAt: Date.now() });
    commit();
  },
  'end-commitment'(el) { endCommitment(data, el.dataset.id, localToday(), Date.now()); sheet.close(); commit(); },
  'archive-category'(el) {
    Object.assign(data.categories.find(c => c.id === el.dataset.id), { archived: true, updatedAt: Date.now() });
    sheet.close();
    commit();
  },
  disconnect() {
    cfg = { repo: cfg.repo };
    localStorage.setItem(SYNC_KEY, JSON.stringify(cfg));
    sheet.close();
    setSync('Token removed. Saved on this device only');
  },
};

document.addEventListener('click', e => {
  if (!e.target.closest('#toast')) hideToast();
  if (e.target.closest('[data-close]')) { sheet.close(); return; }
  if (e.target === sheet) { sheet.close(); return; }
  const el = e.target.closest('[data-act]');
  if (el) ACTIONS[el.dataset.act](el);
});

// Focus would otherwise fall to the page when the button that opened a sheet was redrawn.
sheet.addEventListener('close', () => {
  if (!sheetOpener?.isConnected) $('.tabs [aria-current="page"]')?.focus();
});

// iOS keeps fixed elements behind the keyboard, so lift the sheet above it.
window.visualViewport?.addEventListener('resize', () => {
  const v = window.visualViewport;
  sheet.style.bottom = `${Math.max(0, innerHeight - v.height - v.offsetTop)}px`;
  sheet.style.maxHeight = `${v.height - 8}px`;
});

document.addEventListener('change', e => {
  const form = e.target.closest('#plan-form');
  if (form) savePlanForm(form);
});

document.addEventListener('submit', e => {
  if (e.target.id === 'plan-form') e.preventDefault();
});

/* GitHub sync */

const b64 = s => btoa(unescape(encodeURIComponent(s)));
const unb64 = s => decodeURIComponent(escape(atob(s.replace(/\s/g, ''))));
const api = () => `https://api.github.com/repos/${cfg.repo}/contents/${DATA_FILE}`;
const headers = () => ({
  Authorization: `Bearer ${cfg.token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

function setSync(text) {
  syncText = text;
  const el = $('#sync-status');
  if (el) el.textContent = text;
}

async function pull() {
  // shortcut: the contents API returns file bodies only up to 1 MB, about 5,000 entries; move to the blobs API if reached.
  const r = await fetch(api(), { headers: headers(), cache: 'no-store' });
  if (r.status === 404) return { remote: {}, sha: null };
  if (!r.ok) throw new Error(`http${r.status}`);
  const j = await r.json();
  try {
    return { remote: JSON.parse(unb64(j.content)), sha: j.sha };
  } catch {
    // Never overwrite a remote file that could not be read.
    throw new Error('damaged');
  }
}

let busy = false;
let again = false;
let timer;

async function sync() {
  if (!cfg.token || !cfg.repo) return;
  if (busy) { again = true; return; }
  busy = true;
  setSync('Syncing');
  try {
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      const { remote, sha } = await pull();
      data = merge(data, remote);
      persist();
      if (!typing()) render();
      const body = JSON.stringify(data);
      if (sha && JSON.stringify(merge(remote, {})) === body) { done = true; break; }
      const res = await fetch(api(), {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ message: 'Update finance data', content: b64(body), sha: sha ?? undefined }),
      });
      if (res.ok) done = true;
      else if (res.status !== 409 && res.status !== 422) throw new Error(`put${res.status}`);
    }
    setSync(done ? 'Synced to GitHub' : 'Sync conflict, will retry');
  } catch (e) {
    const code = String(e.message);
    setSync(/401|403/.test(code) ? 'GitHub rejected the token'
      : code === 'damaged' ? 'GitHub file is damaged, not overwritten'
      : code === 'put404' || code === 'http404' ? 'Repo not found, check the name and token'
      : 'Offline, saved on this device');
  }
  busy = false;
  if (again) { again = false; sync(); }
}

function queueSync() {
  if (!cfg.token || !cfg.repo) return;
  clearTimeout(timer);
  timer = setTimeout(sync, 1200);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if (!typing()) render(); sync(); }
});

render();
sync();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
