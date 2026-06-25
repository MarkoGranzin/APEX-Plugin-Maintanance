/**
 * T-12 — Secrets verschlüsselt speichern (maskierte Anzeige).
 *
 * API-Keys/Git-Tokens werden mit AES-256-GCM verschlüsselt abgelegt (Schlüssel via scrypt aus
 * einer Passphrase/Master-Key). In der Persistenz liegt NIE Klartext; die Anzeige ist maskiert
 * (Wissen #503). Entschlüsseln gelingt nur mit korrektem Master-Key — falscher Key scheitert
 * (GCM-Auth-Tag). Passt zur devhub-Regel: Secrets ausschließlich über get_connection auflösen,
 * niemals loggen.
 *
 * Resultat: src/config/secrets.js
 */

import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

/** Verschlüsselt einen Klartext. @returns {{salt,iv,tag,data}} (alles base64) */
export function encryptSecret(plaintext, passphrase) {
  if (plaintext == null) throw new Error('Kein Secret übergeben');
  if (!passphrase) throw new Error('Master-Key fehlt');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: enc.toString('base64'),
  };
}

/** Entschlüsselt; wirft bei falschem Master-Key (GCM-Auth schlägt fehl). */
export function decryptSecret(blob, passphrase) {
  if (!passphrase) throw new Error('Master-Key fehlt');
  const key = crypto.scryptSync(passphrase, Buffer.from(blob.salt, 'base64'), 32);
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Entschlüsselung fehlgeschlagen (falscher Master-Key?)');
  }
}

/** Maskiert ein Secret für die Anzeige (zeigt nie den vollen Wert). */
export function mask(plaintext) {
  const s = String(plaintext ?? '');
  if (s.length <= 4) return '****';
  return `${s.slice(0, 3)}${'*'.repeat(Math.max(4, s.length - 7))}${s.slice(-4)}`;
}

/** Verschlüsselter Secret-Speicher; persistiert ausschließlich Chiffrate. */
export class SecretStore {
  constructor(passphrase, initial = {}) {
    Object.defineProperty(this, '_pass', { value: passphrase, enumerable: false });
    this.blobs = { ...initial }; // name -> {salt,iv,tag,data}
  }

  set(name, plaintext) {
    this.blobs[name] = encryptSecret(plaintext, this._pass);
    return this;
  }

  /** Klartext (nur transient zur Verwendung, z.B. an das KI-Backend / git). */
  get(name) {
    if (!(name in this.blobs)) return null;
    return decryptSecret(this.blobs[name], this._pass);
  }

  /** Maskierte Anzeige aller Secrets — niemals Klartext. */
  display() {
    const out = {};
    for (const name of Object.keys(this.blobs)) out[name] = mask(this.get(name));
    return out;
  }

  /** Persistierbare Sicht: nur Chiffrate, kein Klartext. */
  toJSON() {
    return { blobs: this.blobs };
  }
}
