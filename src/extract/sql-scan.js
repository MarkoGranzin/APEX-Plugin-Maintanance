/**
 * Gemeinsame Primitive fuer das Scannen von PL/SQL-Quelltext (vorher 5× dupliziert in
 * extract.js/inline.js/reinject.js). Reines Verhalten, durch Charakterisierungstests
 * (test/sql-scan.test.js) abgesichert.
 *
 *  - skipString(text, i): ueberspringt EIN '..'-Literal, das bei text[i]==="'" beginnt; '' ist
 *    ein Escape (kein Stringende). Liefert den Index direkt HINTER dem schliessenden Quote.
 *  - unquote/requote: SQL-Single-Quote-Escaping hin und zurueck.
 *
 * Resultat: src/extract/sql-scan.js
 */

export function skipString(text, i) {
  i++; // oeffnendes '
  while (i < text.length) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") { i += 2; continue; } // '' = Escape
      return i + 1; // hinter dem schliessenden Quote
    }
    i++;
  }
  return i; // unterminiert → Ende
}

export const unquote = (s) => s.replace(/''/g, "'");
export const requote = (s) => s.replace(/'/g, "''");
