'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePypiMetadata, extractMetadata } = require('../../src/measurements/pypi');

// extractMetadata is pure and needs no fixture server or cache isolation.

test('extractMetadata finds the oldest release across all versions, not the first key', () => {
  const pypiJson = {
    releases: {
      '2.0.0': [{ upload_time_iso_8601: '2020-01-01T00:00:00Z' }],
      '1.0.0': [{ upload_time_iso_8601: '2015-06-15T00:00:00Z' }], // actually oldest
      '3.0.0': [{ upload_time_iso_8601: '2022-01-01T00:00:00Z' }],
    },
  };
  const meta = extractMetadata('somepkg', pypiJson);
  assert.equal(meta.first_version, '1.0.0');
  assert.equal(meta.name, 'somepkg');
  assert.ok(meta.age_days > 0);
});

test('extractMetadata skips releases with no files or no upload date', () => {
  const pypiJson = {
    releases: {
      '0.1.0': [], // yanked/empty release, no files
      '0.2.0': [{}], // file with no upload_time_iso_8601
      '1.0.0': [{ upload_time_iso_8601: '2019-03-01T00:00:00Z' }],
    },
  };
  const meta = extractMetadata('somepkg', pypiJson);
  assert.equal(meta.first_version, '1.0.0');
});

test('extractMetadata returns null when there are no usable releases', () => {
  assert.equal(extractMetadata('somepkg', { releases: {} }), null);
  assert.equal(extractMetadata('somepkg', null), null);
  assert.equal(extractMetadata('somepkg', {}), null);
});

// resolvePypiMetadata tests use an isolated cache dir and a fake fetchJson,
// so no live network call and no interference with a developer's real cache.

let cacheDir;

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-policies-pypi-test-'));
});

afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('resolvePypiMetadata fetches and returns metadata on first call', async () => {
  let fetchCount = 0;
  const fakeFetch = async () => {
    fetchCount += 1;
    return { releases: { '1.0.0': [{ upload_time_iso_8601: '2020-01-01T00:00:00Z' }] } };
  };

  const meta = await resolvePypiMetadata('fastapi', { cacheDir, fetchJson: fakeFetch });
  assert.equal(fetchCount, 1);
  assert.equal(meta.name, 'fastapi');
  assert.ok(meta.age_days > 0);
});

test('resolvePypiMetadata returns null for a package with no PyPI data, without throwing', async () => {
  const fakeFetch = async () => null;
  const meta = await resolvePypiMetadata('totally-fake-package-xyz', { cacheDir, fetchJson: fakeFetch });
  assert.equal(meta, null);
});

test('resolvePypiMetadata caches the result and does not refetch within the TTL', async () => {
  let fetchCount = 0;
  const fakeFetch = async () => {
    fetchCount += 1;
    return { releases: { '1.0.0': [{ upload_time_iso_8601: '2020-01-01T00:00:00Z' }] } };
  };

  const first = await resolvePypiMetadata('requests', { cacheDir, fetchJson: fakeFetch });
  const second = await resolvePypiMetadata('requests', { cacheDir, fetchJson: fakeFetch });

  assert.equal(fetchCount, 1, 'second call must be served from cache, not refetched');
  assert.deepEqual(second, first);
});

test('resolvePypiMetadata caches a "not found" result too, avoiding repeated failing lookups', async () => {
  let fetchCount = 0;
  const fakeFetch = async () => {
    fetchCount += 1;
    return null;
  };

  await resolvePypiMetadata('nonexistent-pkg', { cacheDir, fetchJson: fakeFetch });
  await resolvePypiMetadata('nonexistent-pkg', { cacheDir, fetchJson: fakeFetch });

  assert.equal(fetchCount, 1);
});

test('a cache write failure does not prevent resolvePypiMetadata from returning a result', async () => {
  const fakeFetch = async () => ({
    releases: { '1.0.0': [{ upload_time_iso_8601: '2020-01-01T00:00:00Z' }] },
  });
  // Point at a path that can't be created as a directory (a file, not a dir).
  const blockedCacheDir = path.join(cacheDir, 'blocked-file');
  fs.writeFileSync(blockedCacheDir, 'not a directory');

  const meta = await resolvePypiMetadata('anypkg', { cacheDir: blockedCacheDir, fetchJson: fakeFetch });
  assert.equal(meta.name, 'anypkg');
});
