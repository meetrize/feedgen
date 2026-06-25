import assert from 'assert';
import {
  normalizeUrl,
  canonicalizeSelectorRules,
  buildSourceFingerprint,
} from './sourceFingerprint';

function testNormalizeUrl() {
  assert.strictEqual(
    normalizeUrl('https://Example.com/feed/?utm_source=x'),
    'https://example.com/feed'
  );
  assert.strictEqual(
    normalizeUrl('http://example.com:80/path/'),
    'https://example.com/path'
  );
  assert.strictEqual(
    normalizeUrl('https://example.com/rss?b=2&a=1'),
    'https://example.com/rss?a=1&b=2'
  );
}

function testCanonicalizeSelectorRules() {
  const a = canonicalizeSelectorRules({ z: 1, a: { y: 2, x: 1 } });
  const b = canonicalizeSelectorRules({ a: { x: 1, y: 2 }, z: 1 });
  assert.strictEqual(a, b);
}

function testBuildSourceFingerprint() {
  const native1 = buildSourceFingerprint({
    url: 'https://example.com/feed.xml',
    source_type: 'native',
  });
  const native2 = buildSourceFingerprint({
    url: 'https://example.com/feed.xml?utm_campaign=test',
    source_type: 'native',
  });
  assert.strictEqual(native1, native2);

  const parsed1 = buildSourceFingerprint({
    url: 'https://example.com/news',
    source_type: 'parsed',
    selector_rules: { title: '.title', body: '.content' },
  });
  const parsed2 = buildSourceFingerprint({
    url: 'https://example.com/news',
    source_type: 'parsed',
    selector_rules: { body: '.content', title: '.title' },
  });
  const parsed3 = buildSourceFingerprint({
    url: 'https://example.com/news',
    source_type: 'parsed',
    selector_rules: { title: '.other', body: '.content' },
  });
  assert.strictEqual(parsed1, parsed2);
  assert.notStrictEqual(parsed1, parsed3);
}

testNormalizeUrl();
testCanonicalizeSelectorRules();
testBuildSourceFingerprint();
console.log('sourceFingerprint tests passed');
