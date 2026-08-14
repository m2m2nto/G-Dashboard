import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteElementsTerm } from '../services/banking.js';

const FULL_FORMULA =
  'SUMIF(DIC!$C$39:$C$175,Table23[[#This Row],[Elements]],DIC!$G$39:$G$194)' +
  '+SUMIF(NOV!$C$28:$C$135,Table23[[#This Row],[Elements]],NOV!$G$28:$G$154)' +
  '+SUMIF(GEN!$C$3:$C$102,Table23[[#This Row],[Elements]],GEN!$G$3:$G$121)';

test('rewriteElementsTerm leaves formula untouched when headroom is sufficient', () => {
  // GEN totals row 28, criteria upper bound C102 — 74 rows headroom (>= 5).
  const out = rewriteElementsTerm(FULL_FORMULA, 'GEN', 'G', 28);
  assert.equal(out, FULL_FORMULA);
});

test('rewriteElementsTerm widens only the targeted month term', () => {
  // Pretend GEN totals row is now 100 — only 2 rows headroom over C102. Trigger.
  const out = rewriteElementsTerm(FULL_FORMULA, 'GEN', 'G', 100);
  // GEN term widened to 150 (totals 100 + buffer 50)
  assert.match(
    out,
    /SUMIF\(GEN!\$C\$3:\$C\$150,Table23\[\[#This Row\],\[Elements\]\],GEN!\$G\$3:\$G\$150\)/,
  );
  // DIC and NOV terms untouched
  assert.match(out, /SUMIF\(DIC!\$C\$39:\$C\$175,Table23\[\[#This Row\],\[Elements\]\],DIC!\$G\$39:\$G\$194\)/);
  assert.match(out, /SUMIF\(NOV!\$C\$28:\$C\$135,Table23\[\[#This Row\],\[Elements\]\],NOV!\$G\$28:\$G\$154\)/);
});

test('rewriteElementsTerm widens revenue term using F column', () => {
  const revenue =
    'SUMIF(GEN!$C$3:$C$102,Table23[[#This Row],[Elements]],GEN!$F$3:$F$21)';
  const out = rewriteElementsTerm(revenue, 'GEN', 'F', 100);
  assert.equal(
    out,
    'SUMIF(GEN!$C$3:$C$150,Table23[[#This Row],[Elements]],GEN!$F$3:$F$150)',
  );
});

test('rewriteElementsTerm preserves start row when widening', () => {
  // DIC starts at row 39 — must keep that, only widen the upper bound.
  const out = rewriteElementsTerm(FULL_FORMULA, 'DIC', 'G', 200);
  assert.match(
    out,
    /SUMIF\(DIC!\$C\$39:\$C\$250,Table23\[\[#This Row\],\[Elements\]\],DIC!\$G\$39:\$G\$250\)/,
  );
});

test('rewriteElementsTerm leaves formula untouched when month term is missing', () => {
  // Asking to widen MAR, but MAR not present in the formula.
  const partial =
    'SUMIF(GEN!$C$3:$C$102,Table23[[#This Row],[Elements]],GEN!$G$3:$G$121)';
  const out = rewriteElementsTerm(partial, 'MAR', 'G', 999);
  assert.equal(out, partial);
});

test('rewriteElementsTerm triggers exactly at the headroom threshold', () => {
  // Headroom rule: trigger when endC < totals + 5. So totals=98, endC=102 → diff 4 < 5 → trigger.
  const minimal =
    'SUMIF(GEN!$C$3:$C$102,Table23[[#This Row],[Elements]],GEN!$G$3:$G$121)';
  const tripped = rewriteElementsTerm(minimal, 'GEN', 'G', 98);
  assert.notEqual(tripped, minimal);
  // totals=97, endC=102 → diff 5 not less than 5 → no change.
  const stable = rewriteElementsTerm(minimal, 'GEN', 'G', 97);
  assert.equal(stable, minimal);
});

test('rewriteElementsTerm tolerates non-string formula input', () => {
  assert.equal(rewriteElementsTerm(null, 'GEN', 'G', 100), null);
  assert.equal(rewriteElementsTerm(undefined, 'GEN', 'G', 100), undefined);
  assert.equal(rewriteElementsTerm('', 'GEN', 'G', 100), '');
});
