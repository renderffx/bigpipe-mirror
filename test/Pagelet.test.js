import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Pagelet, { PRIORITY } from '../Pagelet.js';

describe('Pagelet', () => {
  it('creates a pagelet with required id', () => {
    const p = new Pagelet({ id: 'foo' });
    assert.equal(p.id, 'foo');
    assert.equal(p.markup, '');
    assert.deepEqual(p.css, []);
    assert.deepEqual(p.js, []);
    assert.equal(p.phase, 0);
  });

  it('accepts all options', () => {
    const p = new Pagelet({
      id: 'bar',
      markup: '<p>hello</p>',
      css: ['/a.css'],
      js: ['/a.js'],
      phase: 2,
    });
    assert.equal(p.id, 'bar');
    assert.equal(p.markup, '<p>hello</p>');
    assert.deepEqual(p.css, ['/a.css']);
    assert.deepEqual(p.js, ['/a.js']);
    assert.equal(p.phase, 2);
  });

  it('accepts html alias for markup', () => {
    const p = new Pagelet({ id: 'x', html: '<div/>' });
    assert.equal(p.markup, '<div/>');
  });

  it('markup takes precedence over html alias', () => {
    const p = new Pagelet({ id: 'x', markup: 'a', html: 'b' });
    assert.equal(p.markup, 'a');
  });

  it('accepts priority alias for phase', () => {
    const p = new Pagelet({ id: 'x', priority: 3 });
    assert.equal(p.phase, 3);
  });

  it('accepts string phase matching PRIORITY keys', () => {
    const p = new Pagelet({ id: 'x', phase: 'HIGH' });
    assert.equal(p.phase, 2);
  });

  it('throws for non-string id', () => {
    assert.throws(() => new Pagelet({ id: '' }), TypeError);
    assert.throws(() => new Pagelet({ id: 123 }), TypeError);
  });

  it('throws for non-string markup', () => {
    assert.throws(() => new Pagelet({ id: 'x', markup: 123 }), TypeError);
  });

  it('throws for non-array css', () => {
    assert.throws(() => new Pagelet({ id: 'x', css: 'a.css' }), TypeError);
    assert.throws(() => new Pagelet({ id: 'x', css: [1] }), TypeError);
  });

  it('throws for non-array js', () => {
    assert.throws(() => new Pagelet({ id: 'x', js: 'a.js' }), TypeError);
    assert.throws(() => new Pagelet({ id: 'x', js: [1] }), TypeError);
  });

  it('throws for out-of-range phase', () => {
    assert.throws(() => new Pagelet({ id: 'x', phase: -1 }), TypeError);
    assert.throws(() => new Pagelet({ id: 'x', phase: 4 }), TypeError);
  });

  it('clamps unknown string phase to 0', () => {
    const p = new Pagelet({ id: 'x', phase: 'bogus' });
    assert.equal(p.phase, 0);
  });

  it('deduplicates css urls', () => {
    const p = new Pagelet({ id: 'x', css: ['/a.css', '/a.css', '/b.css'] });
    assert.deepEqual(p.css, ['/a.css', '/b.css']);
  });

  it('deduplicates js urls', () => {
    const p = new Pagelet({ id: 'x', js: ['/a.js', '/a.js', '/b.js'] });
    assert.deepEqual(p.js, ['/a.js', '/b.js']);
  });

  it('toJSON() returns correct shape', () => {
    const p = new Pagelet({ id: 'x', markup: 'm', css: ['c'], js: ['j'], phase: 1 });
    const json = p.toJSON();
    assert.equal(json.id, 'x');
    assert.equal(json.content.markup, 'm');
    assert.deepEqual(json.content.css, ['c']);
    assert.deepEqual(json.content.js, ['j']);
    assert.deepEqual(json.css, ['c']);
    assert.deepEqual(json.js, ['j']);
    assert.equal(json.phase, 1);
  });

  it('toJSON() returns defensive copies', () => {
    const p = new Pagelet({ id: 'x', css: ['c'] });
    const json = p.toJSON();
    json.css.push('d');
    assert.deepEqual(p.css, ['c']);
  });

  it('toScriptTag() produces valid script tag', () => {
    const p = new Pagelet({ id: 'x', markup: 'hello' });
    const tag = p.toScriptTag();
    assert.ok(tag.startsWith('<script>bigPipe.onPageletArrive('));
    assert.ok(tag.endsWith(');</script>\n'));
    assert.ok(tag.includes('"id":"x"'));
  });

  it('toScriptTag() sanitizes < and >', () => {
    const p = new Pagelet({ id: 'x', markup: '<script>alert(1)</script>' });
    const tag = p.toScriptTag();
    const json = tag.slice(tag.indexOf('(') + 1, tag.lastIndexOf(')'));
    assert.ok(!json.includes('</script>'));
    assert.ok(!json.includes('<script>'));
    assert.ok(json.includes('\\u003C'));
    assert.ok(json.includes('\\u003E'));
  });

  it('set phase validates range', () => {
    const p = new Pagelet({ id: 'x' });
    p.phase = 0;
    assert.equal(p.phase, 0);
    p.phase = 3;
    assert.equal(p.phase, 3);
    assert.throws(() => { p.phase = -1; }, TypeError);
    assert.throws(() => { p.phase = 4; }, TypeError);
    assert.throws(() => { p.phase = '1'; }, TypeError);
  });

  it('exposes PRIORITY map', () => {
    assert.equal(Pagelet.PRIORITY.LOW, 0);
    assert.equal(Pagelet.PRIORITY.NORMAL, 1);
    assert.equal(Pagelet.PRIORITY.HIGH, 2);
    assert.equal(Pagelet.PRIORITY.CRITICAL, 3);
  });

  it('PRIORITY is frozen', () => {
    assert.throws(() => { PRIORITY.LOW = 99; }, TypeError);
  });

  it('getters return fresh arrays', () => {
    const p = new Pagelet({ id: 'x', css: ['a'], js: ['b'] });
    const css = p.css;
    const js = p.js;
    css.push('x');
    js.push('y');
    assert.deepEqual(p.css, ['a']);
    assert.deepEqual(p.js, ['b']);
  });

  it('constructor accepts no options', () => {
    assert.throws(() => new Pagelet(), TypeError);
  });
});
