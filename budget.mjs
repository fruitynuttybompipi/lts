// Pure money logic. Amounts are integer sen; dates are local YYYY-MM-DD strings.

const COLLECTIONS = ['accounts', 'commitments', 'categories', 'plans', 'tx'];
export const START_PCT = 20;
export const BUFFER_PCT = 10;
export const FULL_CYCLES_NEEDED = 3;
const MAX_CUT_PCT = 25;

const pad = n => String(n).padStart(2, '0');
const toIso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const utc = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const localToday = () => toIso(new Date());
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
export const addDays = (iso, n) => new Date(utc(iso) + n * 864e5).toISOString().slice(0, 10);

// Clamps to month end, so payday 31 lands on 28 Feb.
function dayIn(year, month, day) {
  const first = new Date(year, month, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return toIso(new Date(first.getFullYear(), first.getMonth(), Math.min(day, last)));
}

export function cycleOf(date, payday) {
  const [y, m] = date.split('-').map(Number);
  const here = dayIn(y, m - 1, payday);
  return date >= here
    ? { start: here, end: dayIn(y, m, payday) }
    : { start: dayIn(y, m - 2, payday), end: here };
}

const nextCycle = (cycle, payday) => cycleOf(cycle.end, payday);
export const prevCycle = (cycle, payday) => cycleOf(addDays(cycle.start, -1), payday);

// Matching on the cycle end keeps history stable if payday later moves.
const activeIn = (items, cycle) =>
  items.filter(x => x.from < cycle.end && (!x.to || x.to >= cycle.end));

export function planFor(data, cycle) {
  const fit = data.plans.filter(p => p.from < cycle.end).sort((a, b) => a.from.localeCompare(b.from));
  return fit.at(-1) ?? [...data.plans].sort((a, b) => a.from.localeCompare(b.from))[0];
}

export const commitmentsIn = (data, cycle) => activeIn(data.commitments, cycle).filter(c => c.amount > 0);
const inCycle = (t, cycle) => t.date >= cycle.start && t.date < cycle.end;
const sum = (items, f = x => x.amount) => items.reduce((a, x) => a + f(x), 0);
const spentIn = (data, cycle) => sum(data.tx.filter(t => t.type === 'spend' && inCycle(t, cycle)));
const incomeIn = (data, cycle) => sum(data.tx.filter(t => t.type === 'income' && inCycle(t, cycle)));
const afterCommitments = (data, cycle) =>
  Math.max(0, planFor(data, cycle).salary - sum(commitmentsIn(data, cycle)));

function pastCycles(data, cycle) {
  const { payday, setupDate } = data.meta;
  const first = cycleOf(setupDate, payday).start;
  const out = [];
  for (let c = prevCycle(cycle, payday); c.start >= first; c = prevCycle(c, payday)) out.unshift(c);
  return out;
}

export function spendByCategory(data, cycle) {
  const totals = new Map();
  for (const t of data.tx) {
    if (t.type === 'spend' && inCycle(t, cycle)) totals.set(t.categoryId, (totals.get(t.categoryId) ?? 0) + t.amount);
  }
  return [...totals].map(([id, amount]) => ({ id, amount })).sort((a, b) => b.amount - a.amount);
}

function overspendCauses(data, cycle) {
  const before = new Map(spendByCategory(data, prevCycle(cycle, data.meta.payday)).map(c => [c.id, c.amount]));
  return spendByCategory(data, cycle)
    .map(c => ({ id: c.id, rise: c.amount - (before.get(c.id) ?? 0) }))
    .sort((a, b) => b.rise - a.rise)
    .slice(0, 2)
    .filter(c => c.rise > 0)
    .map(c => c.id);
}

export function suggestedSavings(data, cycle) {
  const left = afterCommitments(data, cycle);
  const plan = planFor(data, cycle);
  if (plan.savePct != null) {
    return { amount: Math.round(left * plan.savePct / 100), basis: 'fixed', pct: plan.savePct, over: 0, lowered: 0, causes: [] };
  }
  const past = pastCycles(data, cycle);
  const full = past.filter(c => c.start >= data.meta.setupDate).slice(-FULL_CYCLES_NEEDED);
  let amount, basis, average = 0;
  if (full.length < FULL_CYCLES_NEEDED) {
    amount = Math.round(left * START_PCT / 100);
    basis = 'start';
  } else {
    average = Math.round(sum(full, c => spentIn(data, c)) / full.length);
    amount = Math.max(0, left - average - Math.round(left * BUFFER_PCT / 100));
    amount -= amount % 1000;
    basis = 'average';
  }
  const last = past.at(-1);
  const over = last ? Math.max(0, spentIn(data, last) - spendingBudget(data, last)) : 0;
  let lowered = 0;
  if (over) {
    lowered = Math.min(over, Math.ceil(amount * MAX_CUT_PCT / 100));
    lowered += (amount - lowered) % 1000;
    amount -= lowered;
  }
  return { amount, basis, pct: START_PCT, average, over, lowered, causes: over ? overspendCauses(data, last) : [] };
}

const spendingBudget = (data, cycle) =>
  afterCommitments(data, cycle) - suggestedSavings(data, cycle).amount + incomeIn(data, cycle);

export function summary(data, today) {
  const cycle = cycleOf(today, data.meta.payday);
  const plan = planFor(data, cycle);
  const commitments = sum(commitmentsIn(data, cycle));
  const savings = suggestedSavings(data, cycle);
  const income = incomeIn(data, cycle);
  const spent = spentIn(data, cycle);
  const budget = spendingBudget(data, cycle);
  const left = budget - spent;
  const days = daysBetween(today, cycle.end);
  const prior = prevCycle(cycle, data.meta.payday);
  // A partial first cycle or an unlogged cycle says nothing true about what was left.
  const hasPrior = prior.start >= data.meta.setupDate && spentIn(data, prior) > 0;
  return {
    cycle, salary: plan.salary, commitments, afterCommitments: plan.salary - commitments,
    savings, income, budget, spent, left, days, perDay: Math.floor(Math.max(0, left) / days),
    leftover: hasPrior ? Math.max(0, spendingBudget(data, prior) - spentIn(data, prior)) : 0,
    prior: hasPrior ? prior : null,
  };
}

export function cycleReport(data, cycle) {
  return {
    cycle, spent: spentIn(data, cycle), budget: spendingBudget(data, cycle),
    commitments: sum(commitmentsIn(data, cycle)), categories: spendByCategory(data, cycle),
  };
}

function dueIn(cycle, day) {
  const [y, m] = cycle.start.split('-').map(Number);
  const here = dayIn(y, m - 1, day);
  return here >= cycle.start ? here : dayIn(y, m, day);
}

// Salary and commitments are derived, never stored, so editing them cannot duplicate entries.
export function balances(data, today) {
  const accounts = new Map(data.accounts.map(a => [a.id, a]));
  const bal = new Map(data.accounts.map(a => [a.id, a.opening]));
  const add = (id, delta) => { if (bal.has(id)) bal.set(id, bal.get(id) + delta); };
  // The opening balance already reflects anything dated before the account was added.
  const logged = (id, delta, date) => { if (date >= accounts.get(id)?.addedOn) add(id, delta); };
  const scheduled = (id, delta, date, addedOn) => {
    const acct = accounts.get(id);
    if (acct && date > acct.addedOn && date > addedOn && date <= today) add(id, delta);
  };

  for (const t of data.tx) {
    if (t.type === 'spend') logged(t.accountId, -t.amount, t.date);
    if (t.type === 'income' || t.type === 'adjust') logged(t.accountId, t.amount, t.date);
    if (t.type === 'transfer') { logged(t.accountId, -t.amount, t.date); logged(t.toAccountId, t.amount, t.date); }
  }

  let unpaid = 0;
  if (data.plans.length) {
    const { payday, setupDate, salaryAccountId } = data.meta;
    const now = cycleOf(today, payday);
    for (let c = cycleOf(setupDate, payday); c.start <= now.start; c = nextCycle(c, payday)) {
      scheduled(salaryAccountId, planFor(data, c).salary, c.start, setupDate);
      for (const x of commitmentsIn(data, c)) {
        const due = dueIn(c, x.day);
        scheduled(x.accountId, -x.amount, due, x.addedOn);
        if (c.start === now.start && due > today && accounts.get(x.accountId)?.type === 'bank') unpaid += x.amount;
      }
    }
  }

  const owed = sum(data.accounts.filter(a => a.type === 'card'), a => Math.max(0, -bal.get(a.id)));
  return { balances: bal, owed, unpaid, spokenFor: owed + unpaid };
}

export function savePlan(data, patch, today, now) {
  const cycle = cycleOf(today, data.meta.payday);
  const current = data.plans.find(p => p.from >= cycle.start);
  if (current) { Object.assign(current, patch, { updatedAt: now }); return; }
  const base = data.plans.length ? planFor(data, cycle) : { salary: 0, savePct: null };
  data.plans.push({ ...base, ...patch, id: crypto.randomUUID(), from: cycle.start, updatedAt: now });
}

// Changes start at the current cycle; earlier cycles keep the old row.
export function changeCommitment(data, id, patch, today, now) {
  const c = data.commitments.find(x => x.id === id);
  const start = cycleOf(today, data.meta.payday).start;
  if (!c.amount) {
    Object.assign(c, patch, { from: start, addedOn: today, updatedAt: now });
  } else if (c.from >= start) {
    Object.assign(c, patch, { updatedAt: now });
  } else {
    c.to = start;
    c.updatedAt = now;
    data.commitments.push({ ...c, ...patch, id: crypto.randomUUID(), from: start, to: null, updatedAt: now });
  }
}

export function endCommitment(data, id, today, now) {
  const c = data.commitments.find(x => x.id === id);
  const start = cycleOf(today, data.meta.payday).start;
  if (!c.amount || c.from >= start) {
    data.commitments = data.commitments.filter(x => x !== c);
    data.deleted[id] = now;
  } else {
    c.to = start;
    c.updatedAt = now;
  }
}

export function correctBalance(data, accountId, target, today, now) {
  const current = balances(data, today).balances.get(accountId);
  if (target === current) return;
  data.tx.push({ id: crypto.randomUUID(), type: 'adjust', accountId, amount: target - current, date: today, updatedAt: now });
}

// Newest edit of each item wins, and deletions beat edits made before them.
export function merge(a, b) {
  const deleted = { ...a.deleted };
  for (const [id, at] of Object.entries(b.deleted ?? {})) deleted[id] = Math.max(deleted[id] ?? 0, at);
  const sorted = o => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)));
  const out = {
    meta: (b.meta?.updatedAt ?? -1) > (a.meta?.updatedAt ?? -1) ? b.meta : a.meta,
    dismissed: sorted({ ...a.dismissed, ...b.dismissed }),
    deleted: sorted(deleted),
  };
  for (const key of COLLECTIONS) {
    const items = new Map();
    for (const x of [...(a[key] ?? []), ...(b[key] ?? [])]) {
      const seen = items.get(x.id);
      if (!seen || x.updatedAt > seen.updatedAt) items.set(x.id, x);
    }
    // Sorted so identical data serialises identically and sync can skip empty commits.
    out[key] = [...items.values()].filter(x => !(deleted[x.id] >= x.updatedAt)).sort((x, y) => (x.id < y.id ? -1 : 1));
  }
  return out;
}

export function parseSen(text) {
  const clean = String(text).replace(/[,\s]/g, '').replace(/^RM/i, '');
  if (!/^\d*\.?\d{0,2}$/.test(clean) || !/\d/.test(clean)) return NaN;
  return Math.round(Number(clean) * 100);
}
