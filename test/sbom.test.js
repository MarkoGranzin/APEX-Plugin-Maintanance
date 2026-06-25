import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { fingerprint, buildSbom, checkUpdates, scanArtifact } from '../src/sbom/sbom.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('T-7 Fingerprinting → SBOM', () => {
  it('erkennt Lib per Hash-Fingerprint', () => {
    const code = 'jQuery v3.4.1 minified blob';
    const hashDb = { [sha(code)]: { name: 'jquery', version: '3.4.1' } };
    const bundle = { artifact: 'w', js: [{ name: 'vendor.js', code }], css: [], referencedUrls: [] };
    const comps = fingerprint(bundle, { hashDb });
    expect(comps[0]).toMatchObject({ name: 'jquery', version: '3.4.1', detectedBy: 'hash' });
  });

  it('erkennt vendored Lib aus referenzierter URL mit Version', () => {
    const bundle = { artifact: 'w', js: [], css: [], referencedUrls: [{ url: 'https://cdn/chart-2.9.4.min.js', version: '2.9.4' }] };
    const comps = fingerprint(bundle);
    expect(comps).toContainEqual(expect.objectContaining({ name: 'chart', version: '2.9.4', detectedBy: 'url' }));
  });

  it('Dateiname-Heuristik als Fallback', () => {
    const bundle = { artifact: 'w', js: [{ name: 'lodash-4.17.21.min.js', code: 'x' }], css: [] };
    const comps = fingerprint(bundle);
    expect(comps[0]).toMatchObject({ name: 'lodash', version: '4.17.21', detectedBy: 'filename' });
  });

  it('SBOM ist CycloneDX-Format', () => {
    const sbom = buildSbom('w', [{ name: 'jquery', version: '3.4.1', detectedBy: 'hash', evidence: 'v.js' }]);
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.specVersion).toBe('1.5');
    expect(sbom.components[0]).toMatchObject({ type: 'library', name: 'jquery', version: '3.4.1', purl: 'pkg:generic/jquery@3.4.1' });
  });
});

describe('T-7 Update-Check', () => {
  it('erkennt veraltete Version gegen aktuelle', () => {
    const res = checkUpdates([{ name: 'jquery', version: '3.4.1' }], { jquery: '3.7.1' });
    expect(res[0]).toEqual({ name: 'jquery', current: '3.4.1', latest: '3.7.1', outdated: true });
  });

  it('aktuelle Version ist nicht veraltet', () => {
    const res = checkUpdates([{ name: 'jquery', version: '3.7.1' }], { jquery: '3.7.1' });
    expect(res[0].outdated).toBe(false);
  });

  it('scanArtifact liefert SBOM + Updates in einem Schritt', () => {
    const bundle = { artifact: 'w', js: [{ name: 'lodash-4.17.20.min.js', code: 'x' }], css: [], referencedUrls: [] };
    const r = scanArtifact(bundle, { latestVersions: { lodash: '4.17.21' } });
    expect(r.sbom.bomFormat).toBe('CycloneDX');
    expect(r.updates[0].outdated).toBe(true);
  });
});
