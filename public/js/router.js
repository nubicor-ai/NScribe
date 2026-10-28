// Voice bed routing: "bed R2 ...", "H three B ...", "red zone 4 ...", "reassess H2A ..."
// Pure functions, no DOM. Returns what to do; the caller decides (never guesses when unsure).
const NUM_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NUM = '(\\d{1,2}|' + Object.keys(NUM_WORDS).join('|') + ')';

const LEAD = '(?:(?:reassess(?:ment)?|re ?assess|update|next|now|ok|okay|so|for|in|at|to|go to|move to|patient|pt|the|bed|number|no|on|about|regarding)[\\s,:-]+)*';
const ZONE = '(red\\s*zone|redzone|hdu|h\\.?d\\.?u\\.?|aitch|each|r|h)';
const LETTER = '(a|ay|eh|alpha|b|bee|be|bravo)';
const ROUTE_RE = new RegExp('^\\s*' + LEAD + '(?:' + ZONE + '[\\s.,:-]*(?:bed[\\s.,:-]*)?' + NUM + '[\\s.,:-]*' + LETTER + '?|bed[\\s.,:-]*' + NUM + '[\\s.,:-]*' + LETTER + '?)(?![a-z0-9])[\\s.,:;-]*', 'i');
const UNIT_AFTER = /^(?:hours?|hrs?|days?|mins?|minutes?|weeks?|years?|months?|mg|mcg|ml|units?|times|percent|%|\/|bpm|mmhg|degrees?)\b/i;

const letterOf = (w) => (!w ? '' : /^(a|ay|eh|alpha)$/i.test(w) ? 'A' : 'B');

/**
 * @param {string} text   decoded English (or typed) text
 * @param {Array} slots   from slotsOf(layout)
 * @param {Array} zones   layout.zones (for prefixes)
 * @returns {{kind:'none'}|{kind:'ok',bed:string,rest:string,spoken:string}|{kind:'ambiguous',options:string[],rest:string,spoken:string}|{kind:'missing',spoken:string,rest:string}}
 */
export function parseBedRoute(text, slots, zones) {
  const t = String(text || '').trim();
  const m = ROUTE_RE.exec(t);
  if (!m) return { kind: 'none' };
  const rest = t.slice(m[0].length).trim();
  if (UNIT_AFTER.test(rest)) return { kind: 'none' }; // "R 2 hours" is not a bed
  const hadReassess = /re ?assess/i.test(m[0]);
  const keep = hadReassess ? 'Reassessment. ' + rest : rest;

  let zoneTok = m[1] ? m[1].toLowerCase().replace(/[\s.]/g, '') : '', num = m[2] || m[4], letter = letterOf(m[3] || m[5]);
  if (!num) return { kind: 'none' };
  num = String(/^\d/.test(num) ? parseInt(num, 10) : NUM_WORDS[num.toLowerCase()]);
  let prefix = '';
  if (zoneTok) {
    if (zoneTok.startsWith('red') || zoneTok === 'r') prefix = 'R';
    else prefix = 'H';
  }
  const spoken = (prefix || 'bed ') + num + letter;
  if (!prefix) { // "bed 4": any zone with that number
    const opts = slots.filter((s) => s.bedNo === parseInt(num, 10) && (!letter || s.letter === letter)).map((s) => s.id);
    if (opts.length === 1) return { kind: 'ok', bed: opts[0], rest: keep, spoken };
    return opts.length ? { kind: 'ambiguous', options: opts, rest: keep, spoken } : { kind: 'missing', spoken, rest: keep };
  }
  const z = zones.find((zz) => zz.prefix === prefix);
  if (!z) return { kind: 'missing', spoken, rest: keep };
  const cands = slots.filter((s) => s.zone === z.id && s.bedNo === parseInt(num, 10));
  if (!cands.length) return { kind: 'missing', spoken, rest: keep };
  if (z.perBed === 1) return { kind: 'ok', bed: cands[0].id, rest: keep, spoken };
  if (letter) {
    const hit = cands.find((s) => s.letter === letter);
    return hit ? { kind: 'ok', bed: hit.id, rest: keep, spoken } : { kind: 'missing', spoken, rest: keep };
  }
  return { kind: 'ambiguous', options: cands.map((s) => s.id), rest: keep, spoken };
}
