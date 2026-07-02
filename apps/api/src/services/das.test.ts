import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAssetImage } from './das.ts';

// getAssetImage runs on the money-safety delivery path as a BEST-EFFORT lookup: it must return a URL when DAS
// exposes one, and null (never throw) for anything else — including a malformed `files` array. We drive it by
// stubbing the global fetch (das.ts calls DAS over the global fetch; no injectable client).

const realFetch = globalThis.fetch;
const mockDasResult = (result: unknown) => {
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ result }) })) as unknown as typeof fetch;
};
const mockFetch = (resp: unknown) => { globalThis.fetch = (async () => resp) as unknown as typeof fetch; };
test.after(() => { globalThis.fetch = realFetch; });

test('getAssetImage: prefers content.links.image', async () => {
  mockDasResult({ content: { links: { image: 'https://cdn/a.png' } } });
  assert.equal(await getAssetImage('Mint'), 'https://cdn/a.png');
});

test('getAssetImage: falls back to the first image-mime files[] uri when links.image is absent', async () => {
  mockDasResult({ content: { files: [{ uri: 'https://cdn/clip.mp4', mime: 'video/mp4' }, { uri: 'https://cdn/img.png', mime: 'image/png' }] } });
  assert.equal(await getAssetImage('Mint'), 'https://cdn/img.png');
});

test('getAssetImage: malformed files (null entry / non-string mime) → null, never throws', async () => {
  mockDasResult({ content: { files: [null, { mime: 123 }] } });
  assert.equal(await getAssetImage('Mint'), null); // must not throw a TypeError into the delivery path
});

test('getAssetImage: missing content / missing image / non-ok response all resolve to null', async () => {
  mockDasResult({}); // no content
  assert.equal(await getAssetImage('Mint'), null);
  mockDasResult({ content: { files: [] } }); // content but no image anywhere
  assert.equal(await getAssetImage('Mint'), null);
  mockFetch({ ok: false }); // DAS error
  assert.equal(await getAssetImage('Mint'), null);
});
