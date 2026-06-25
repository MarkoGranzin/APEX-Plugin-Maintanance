/**
 * Minimaler Cron-Matcher für den automatischen Check-Zeitplan.
 *
 * Felder: Minute Stunde Tag-im-Monat Monat Wochentag. Unterstützt Stern, Zahl, Liste a,b,
 * Bereich a-b und Schrittweite (Slash-n, auch a-b mit Schritt). Wochentag 0=Sonntag. Reicht,
 * um den automatischen Check deterministisch je Minute zu prüfen — ohne externe Abhängigkeit.
 *
 * Resultat: src/service/cron.js
 */

function fieldMatches(field, val, min, max) {
  return String(field).split(',').some((tok) => {
    let step = 1;
    let range = tok;
    const sm = tok.match(/^(.+)\/(\d+)$/);
    if (sm) { range = sm[1]; step = Number(sm[2]); }
    let lo;
    let hi;
    if (range === '*') { lo = min; hi = max; }
    else {
      const rm = range.match(/^(\d+)-(\d+)$/);
      if (rm) { lo = Number(rm[1]); hi = Number(rm[2]); }
      else { lo = hi = Number(range); }
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) return false;
    for (let v = lo; v <= hi; v += step) if (v === val) return true;
    return false;
  });
}

export function cronMatches(expr, date = new Date()) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [mi, ho, dom, mo, dow] = parts;
  return (
    fieldMatches(mi, date.getMinutes(), 0, 59) &&
    fieldMatches(ho, date.getHours(), 0, 23) &&
    fieldMatches(dom, date.getDate(), 1, 31) &&
    fieldMatches(mo, date.getMonth() + 1, 1, 12) &&
    fieldMatches(dow, date.getDay(), 0, 6)
  );
}

/** Menschenlesbare Kurzbeschreibung gängiger Ausdrücke (Fallback: roher Ausdruck). */
export function describeCron(expr) {
  const map = {
    '0 3 * * 1': 'wöchentlich montags 03:00',
    '0 3 * * *': 'täglich 03:00',
    '0 * * * *': 'stündlich',
    '*/15 * * * *': 'alle 15 Minuten',
  };
  return map[String(expr).trim()] ?? `Cron: ${expr}`;
}
