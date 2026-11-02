import test from 'node:test';
import assert from 'node:assert/strict';
import * as b from './budget.mjs';

const sen = rm => rm * 100;
const base = (over = {}) => ({
  meta: { payday: 25, setupDate: '2026-10-25', salaryAccountId: 'bank', updatedAt: 1 },
  accounts: [
    { id: 'bank', type: 'bank', opening: sen(5000), addedOn: '2026-10-25', updatedAt: 1 },
    { id: 'card', type: 'card', opening: 0, addedOn: '2026-10-25', updatedAt: 1 },
  ],
  commitments: [{ id: 'c1', name: 'Loans', amount: sen(3500), day: 1, accountId: 'bank', from: '2026-10-25', addedOn: '2026-10-25', updatedAt: 1 }],
  categories: [{ id: 'food', name: 'Food', updatedAt: 1 }],
  plans: [{ id: 'p1', salary: sen(6000), savePct: null, from: '2026-10-25', updatedAt: 1 }],
  tx: [], deleted: {}, dismissed: {}, ...over,
});
const spend = (date, rm, categoryId = 'food', accountId = 'card') =>
  ({ id: crypto.randomUUID(), type: 'spend', date, amount: sen(rm), categoryId, accountId, updatedAt: 1 });

test('cycles run payday to payday and clamp to month end', () => {
  assert.deepEqual(b.cycleOf('2026-11-02', 25), { start: '2026-10-25', end: '2026-11-25' });
  assert.deepEqual(b.cycleOf('2026-11-25', 25), { start: '2026-11-25', end: '2026-12-25' });
  assert.deepEqual(b.cycleOf('2027-02-28', 31), { start: '2027-02-28', end: '2027-03-31' });
  assert.deepEqual(b.cycleOf('2027-01-05', 25), { start: '2026-12-25', end: '2027-01-25' });
});

test('matches the worked example', () => {
  const data = base({ tx: [spend('2026-11-01', 800)] });
  const s = b.summary(data, '2026-11-10');
  assert.equal(s.afterCommitments, sen(2500));
  assert.equal(s.savings.amount, sen(500));
  assert.equal(s.budget, sen(2000));
  assert.equal(s.left, sen(1200));
  assert.equal(s.days, 15);
  assert.equal(s.perDay, sen(80));
});

test('transfers, bill payments and corrections are not spending', () => {
  const data = base({ tx: [
    spend('2026-11-01', 800),
    { id: 't', type: 'transfer', date: '2026-11-02', amount: sen(800), accountId: 'bank', toAccountId: 'card', updatedAt: 1 },
    { id: 'a', type: 'adjust', date: '2026-11-02', amount: sen(-50), accountId: 'bank', updatedAt: 1 },
  ] });
  assert.equal(b.summary(data, '2026-11-10').spent, sen(800));
  const { balances, owed } = b.balances(data, '2026-11-10');
  assert.equal(owed, 0);
  assert.equal(balances.get('bank'), sen(5000 - 800 - 50 - 3500));
});

test('purchase before the account was added is already in its balance', () => {
  const data = base({ tx: [spend('2026-10-20', 100, 'food', 'bank')] });
  assert.equal(b.balances(data, '2026-10-26').balances.get('bank'), sen(5000));
});

test('salary and commitments reach accounts on their dates, and unpaid is spoken for', () => {
  const before = b.balances(base({ tx: [spend('2026-10-26', 300)] }), '2026-10-30');
  assert.equal(before.balances.get('bank'), sen(5000));
  assert.equal(before.owed, sen(300));
  assert.equal(before.unpaid, sen(3500));
  assert.equal(before.spokenFor, sen(3800));
  assert.equal(b.balances(base(), '2026-11-01').balances.get('bank'), sen(1500));
  assert.equal(b.balances(base(), '2026-11-25').balances.get('bank'), sen(7500));
});

test('subscription on a card raises what is owed once, not spending', () => {
  const data = base();
  data.commitments[0].accountId = 'card';
  assert.equal(b.balances(data, '2026-11-02').owed, sen(3500));
  assert.equal(b.summary(data, '2026-11-02').spent, 0);
});

test('savings move to average spending after 3 full cycles, keeping a buffer', () => {
  const data = base({ tx: [
    spend('2026-11-01', 1700), spend('2026-12-01', 1700), spend('2027-01-01', 1700),
  ] });
  const s = b.summary(data, '2027-02-01');
  assert.equal(s.savings.basis, 'average');
  assert.equal(s.savings.amount, sen(550));
});

test('first partial cycle does not count towards the average', () => {
  const data = base({ tx: [spend('2026-11-01', 100), spend('2026-12-01', 100), spend('2027-01-01', 100)] });
  data.meta.setupDate = '2026-11-02';
  assert.equal(b.summary(data, '2027-01-30').savings.basis, 'start');
});

test('overspending lowers the next suggestion slightly and names the rise', () => {
  const data = base({
    categories: [{ id: 'food', name: 'Food', updatedAt: 1 }, { id: 'shop', name: 'Shopping', updatedAt: 1 }],
    tx: [spend('2026-11-01', 1500, 'food'), spend('2026-12-01', 1500, 'food'), spend('2026-12-02', 1000, 'shop')],
  });
  const s = b.summary(data, '2026-12-30').savings;
  assert.equal(s.over, sen(500));
  assert.equal(s.lowered, sen(130));
  assert.equal(s.amount, sen(370));
  assert.deepEqual(s.causes, ['shop']);
});

test('leftover from last cycle is reported', () => {
  const data = base({ tx: [spend('2026-11-01', 1700)] });
  assert.equal(b.summary(data, '2026-11-26').leftover, sen(300));
});

test('partial first cycle reports no leftover', () => {
  const data = base({ tx: [spend('2026-11-03', 1700)] });
  data.meta.setupDate = '2026-11-02';
  assert.equal(b.summary(data, '2026-11-26').leftover, 0);
});

test('cycle with nothing logged reports no leftover', () => {
  assert.equal(b.summary(base(), '2026-11-26').leftover, 0);
});

test('own percentage overrides the suggestion', () => {
  const data = base();
  data.plans[0].savePct = 10;
  assert.equal(b.summary(data, '2026-11-02').savings.amount, sen(250));
});

test('editing a commitment or salary leaves past cycles alone', () => {
  const data = base();
  b.changeCommitment(data, 'c1', { amount: sen(3000) }, '2026-12-01', 2);
  b.savePlan(data, { salary: sen(7000) }, '2026-12-01', 2);
  assert.equal(b.summary(data, '2026-11-02').commitments, sen(3500));
  assert.equal(b.summary(data, '2026-11-02').salary, sen(6000));
  assert.equal(b.summary(data, '2026-12-01').commitments, sen(3000));
  assert.equal(b.summary(data, '2026-12-01').salary, sen(7000));
});

test('ending a commitment stops it from the current cycle only', () => {
  const data = base();
  b.endCommitment(data, 'c1', '2026-12-01', 2);
  assert.equal(b.summary(data, '2026-11-02').commitments, sen(3500));
  assert.equal(b.summary(data, '2026-12-01').commitments, 0);
});

test('moving payday keeps salary and commitments in the cycle', () => {
  const data = base();
  data.meta.payday = 20;
  const s = b.summary(data, '2026-11-02');
  assert.equal(s.salary, sen(6000));
  assert.equal(s.commitments, sen(3500));
});

test('correcting a balance logs the difference and no spending', () => {
  const data = base();
  b.correctBalance(data, 'bank', sen(4000), '2026-10-26', 2);
  assert.equal(b.balances(data, '2026-10-26').balances.get('bank'), sen(4000));
  assert.equal(b.summary(data, '2026-10-26').spent, 0);
});

test('merge keeps newest edit, honours deletions, and lets undo revive', () => {
  const x = spend('2026-11-01', 10);
  const y = { ...x, amount: sen(20), updatedAt: 5 };
  assert.equal(b.merge(base({ tx: [x] }), base({ tx: [y] })).tx[0].amount, sen(20));
  assert.equal(b.merge(base({ tx: [y] }), base({ deleted: { [x.id]: 6 } })).tx.length, 0);
  assert.equal(b.merge(base({ tx: [{ ...y, updatedAt: 7 }] }), base({ deleted: { [x.id]: 6 } })).tx.length, 1);
});

test('parses money input strictly', () => {
  assert.equal(b.parseSen('1,200.50'), 120050);
  assert.equal(b.parseSen('RM 12'), 1200);
  assert.equal(b.parseSen('.5'), 50);
  assert.ok(Number.isNaN(b.parseSen('abc')));
  assert.ok(Number.isNaN(b.parseSen('1.234')));
  assert.ok(Number.isNaN(b.parseSen('')));
});
