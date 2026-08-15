/**
 * Verify a generated recap against the facts it was given.
 *
 * Two different failure modes, and only one of them is catchable in code:
 *
 *   1. INVENTED NUMBERS — the model states a figure that appears nowhere in
 *      FACTS. Fully deterministic to detect, and this file catches it.
 *
 *   2. WRONG CHARACTERIZATION — every figure is correct but the claim about it
 *      is false ("the only game decided by a real margin" about the week's
 *      NARROWEST margin). Observed in real output. Not detectable by number
 *      matching, so it is defended against in the prompt instead.
 *
 * Run this before anything posts. A bot that is funny and wrong gets muted by
 * exactly the people who would otherwise reply to it.
 */

/** Every distinct number that appears in a string, as normalized strings. */
function numbersIn(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/\d+(?:\.\d+)?/g)) {
    out.add(String(Number(m[0])));
  }
  return out;
}

/**
 * Comparative words that assert a ranking. The model may only use these when
 * the fact sheet actually labels the item that way — the observed failure was a
 * superlative applied to the wrong end of a ranking.
 */
const SUPERLATIVES = /\b(only|biggest|largest|smallest|closest|widest|narrowest|worst|best|highest|lowest|most|least|first|last|barely|blowout|routed?)\b/gi;

/**
 * @param text   generated recap
 * @param facts  the weekFacts object it was generated from
 * @param factsText  the exact FACTS block handed to the model
 */
function verifyRecap(text, facts, factsText) {
  const known = numbersIn(factsText);
  const used = numbersIn(text);

  // Small integers are usually prose ("two zeros", "week 10"), not claims.
  const unverified = [...used].filter(n => !known.has(n) && Number(n) > 20);

  const superlatives = [...new Set((String(text).match(SUPERLATIVES) || []).map(s => s.toLowerCase()))];

  const teamNames = (facts.standingsThisWeek || []).map(t => t.team);
  const mentioned = teamNames.filter(t => text.includes(t));

  const issues = [];
  if (unverified.length) {
    issues.push({
      severity: 'error',
      kind: 'invented_number',
      detail: `Number(s) not present in FACTS: ${unverified.join(', ')}`,
    });
  }
  if (facts.rulesWarning) {
    issues.push({ severity: 'error', kind: 'rules', detail: facts.rulesWarning });
  }
  if (superlatives.length) {
    issues.push({
      severity: 'review',
      kind: 'superlative',
      detail: `Ranking claims to eyeball against FACTS: ${superlatives.join(', ')}`,
    });
  }

  const words = String(text).trim().split(/\s+/).length;
  if (words > 130) issues.push({ severity: 'review', kind: 'length', detail: `${words} words — long for a group text` });
  if (/[*_#`]|^\s*[-•]/m.test(text)) {
    issues.push({ severity: 'review', kind: 'formatting', detail: 'Markdown or bullets — renders badly on a phone' });
  }

  return {
    ok: !issues.some(i => i.severity === 'error'),
    words,
    numbersUsed: [...used],
    unverified,
    superlatives,
    teamsMentioned: mentioned,
    issues,
  };
}

function report(v) {
  const lines = [];
  lines.push(`${v.words} words | ${v.numbersUsed.length} numbers | ${v.teamsMentioned.length} teams named`);
  if (!v.issues.length) { lines.push('No issues.'); return lines.join('\n'); }
  for (const i of v.issues) {
    lines.push(`${i.severity === 'error' ? 'ERROR ' : 'REVIEW'}  ${i.kind}: ${i.detail}`);
  }
  if (v.superlatives.length) {
    lines.push('\nSuperlatives are flagged for human review, not blocked — a correct');
    lines.push('number can still carry a false ranking claim, and only you can see that.');
  }
  return lines.join('\n');
}

module.exports = { verifyRecap, numbersIn, report };
