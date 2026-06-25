import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { changedArtifacts, changedFilesSince, currentHead, diffStep } from '../src/diff/diff.js';

let dir;
let g;
let firstCommit;

const artifacts = [
  { name: 'slider', files: ['src/slider/slider.js'] },
  { name: 'other', files: ['src/other/other.js'] },
];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aispp-diff-'));
  g = simpleGit({ baseDir: dir });
  await g.init();
  await g.addConfig('user.email', 't@e.x');
  await g.addConfig('user.name', 'T');
  const w = (rel, c) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  };
  w('src/slider/slider.js', 'v1');
  w('src/other/other.js', 'v1');
  await g.add('.');
  await g.commit('init');
  firstCommit = (await g.revparse(['HEAD'])).trim();
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('T-3 Diff seit letztem Lauf', () => {
  it('Baseline: ohne lastCommit gelten alle versionierten Dateien als geändert', async () => {
    const files = await changedFilesSince(dir, null);
    expect(files).toEqual(expect.arrayContaining(['src/slider/slider.js', 'src/other/other.js']));
  });

  it('nach Änderung nur die betroffene Datei im Diff', async () => {
    fs.writeFileSync(path.join(dir, 'src/slider/slider.js'), 'v2');
    await g.add('.');
    await g.commit('change slider');

    const files = await changedFilesSince(dir, firstCommit);
    expect(files).toEqual(['src/slider/slider.js']);
  });

  it('changedArtifacts liefert nur betroffene Artefakte als Trigger', () => {
    const triggers = changedArtifacts(artifacts, ['src/slider/slider.js']);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].artifact.name).toBe('slider');
    expect(triggers[0].changedFiles).toEqual(['src/slider/slider.js']);
  });

  it('diffStep meldet head, baseline-Flag und Trigger', async () => {
    const repoBaseline = { lastProcessedCommit: null };
    const step1 = await diffStep(dir, repoBaseline, artifacts);
    expect(step1.baseline).toBe(true);
    expect(step1.triggers.length).toBe(2);

    const repoInc = { lastProcessedCommit: firstCommit };
    const step2 = await diffStep(dir, repoInc, artifacts);
    expect(step2.baseline).toBe(false);
    expect(step2.triggers.map((t) => t.artifact.name)).toEqual(['slider']);
    expect(step2.head).toBe(await currentHead(dir));
  });
});
