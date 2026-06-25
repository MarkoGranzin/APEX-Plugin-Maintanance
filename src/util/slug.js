/**
 * Einheitliche Slug-Bildung für Datei-/Branch-/Verzeichnisnamen (vorher dupliziert in
 * service/assign-repo.js und start.js).
 *
 * Resultat: src/util/slug.js
 */

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '') || 'plugin';
