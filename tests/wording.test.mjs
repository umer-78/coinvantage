// Run: node --test tests/
// Sentences that state a count must count the cases they describe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyVerdict } from '../js/lib/history.js';

test('the long-range summary counts the cases that went the way it says', () => {
  const fell = historyVerdict({ ok: true, stats: { 30: { upCount: 2, total: 10, median: -3.2, best: 4, worst: -12, probUp: 0.2 } } }, null, null, 30);
  assert.match(fell.text, /^8 of 10 times when this chart looked like today, price was lower 30 days later \(median -3\.2%\)/);
  const rose = historyVerdict({ ok: true, stats: { 30: { upCount: 7, total: 10, median: 2.5, best: 9, worst: -3, probUp: 0.7 } } }, null, null, 30);
  assert.match(rose.text, /^7 of 10 times when this chart looked like today, price was higher 30 days later \(median \+2\.5%\)/);
});

test('the position size is stated as a share of the account, and says when it means borrowing', async () => {
  const { sizeText } = await import('../js/lib/summary.js');
  assert.match(sizeText(2.65), /about 0\.38× to 0\.75× your account balance/);   // 1/2.65 and 2/2.65
  assert.match(sizeText(1.5), /about 0\.67× your account balance; 2% would take more than all of it/);
  assert.match(sizeText(0.6), /even your whole balance risks less than 1%/);
  assert.match(sizeText(8), /^With an 8% stop/);
});
