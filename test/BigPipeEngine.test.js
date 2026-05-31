import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import BigPipeEngine, { PHASES } from '../BigPipeEngine.js';
import Pagelet from '../Pagelet.js';

function fakeResponse() {
  const chunks = [];
  let headersSent = false;
  let destroyed = false;

  const res = new EventEmitter();
  res.writeHead = mock.fn((status, headers) => {
    headersSent = true;
    res.statusCode = status;
    res.headers = headers;
  });
  res.write = mock.fn((chunk) => {
    if (destroyed) throw new Error('write after end');
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  });
  res.end = mock.fn((chunk) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    destroyed = true;
  });
  res.off = mock.fn((event, handler) => {
    res.removeListener(event, handler);
    return res;
  });
  Object.defineProperty(res, 'destroyed', { get: () => destroyed });
  Object.defineProperty(res, 'headersSent', { get: () => headersSent });
  res._chunks = chunks;
  return res;
}

describe('BigPipeEngine', () => {
  describe('constructor', () => {
    it('creates engine in INIT phase', () => {
      const engine = new BigPipeEngine(fakeResponse());
      assert.equal(engine.phase, PHASES.INIT);
      assert.equal(engine.pageletCount, 0);
    });

    it('throws for non-writable response', () => {
      assert.throws(() => new BigPipeEngine({}), TypeError);
    });

    it('throws for missing writeHead', () => {
      assert.throws(() => new BigPipeEngine({ write() {}, end() {} }), TypeError);
    });

    it('throws for null options', () => {
      assert.throws(() => new BigPipeEngine(fakeResponse(), null), TypeError);
    });

    it('sets max listeners to Infinity', () => {
      const engine = new BigPipeEngine(fakeResponse());
      assert.equal(engine.getMaxListeners(), Infinity);
    });
  });

  describe('sendHead', () => {
    it('sends headers, runtime, and shell', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      engine.sendHead('<body>');
      assert.equal(res.writeHead.mock.calls.length, 1);
      assert.equal(res.writeHead.mock.calls[0].arguments[0], 200);
      assert.equal(res.write.mock.calls.length, 2);
      assert.ok(res.write.mock.calls[0].arguments[0].includes('window.bigPipe'));
      assert.equal(res.write.mock.calls[1].arguments[0], '<body>');
      assert.equal(engine.phase, PHASES.HEAD_SENT);
    });

    it('does not send X-Powered-By header', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      engine.sendHead();
      const headers = res.writeHead.mock.calls[0].arguments[1];
      assert.equal(headers['X-Powered-By'], undefined);
    });

    it('uses default shell when not provided', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      engine.sendHead();
      assert.ok(res.write.mock.calls[1].arguments[0].includes('<!DOCTYPE'));
    });

    it('throws if called twice', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      assert.throws(() => engine.sendHead(), Error);
    });

    it('throws for non-string shellHTML', () => {
      const engine = new BigPipeEngine(fakeResponse());
      assert.throws(() => engine.sendHead(123), TypeError);
    });

    it('throws if response is destroyed', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      res.end();
      assert.throws(() => engine.sendHead(), Error);
    });

    it('emits head:sent event', () => {
      const engine = new BigPipeEngine(fakeResponse());
      const events = [];
      engine.on('head:sent', () => events.push('head:sent'));
      engine.sendHead();
      assert.deepEqual(events, ['head:sent']);
    });
  });

  describe('sendPagelet', () => {
    it('sends a pagelet script tag', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      engine.sendHead();
      const p = new Pagelet({ id: 'x', markup: 'hi' });
      engine.sendPagelet(p);
      assert.equal(res.write.mock.calls.length, 3);
      const written = res.write.mock.calls[2].arguments[0].toString();
      assert.ok(written.includes('bigPipe.onPageletArrive'));
      assert.ok(written.includes('"id":"x"'));
    });

    it('transitions to STREAMING on first pagelet', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      engine.sendPagelet(new Pagelet({ id: 'x' }));
      assert.equal(engine.phase, PHASES.STREAMING);
    });

    it('throws if head not sent', () => {
      const engine = new BigPipeEngine(fakeResponse());
      assert.throws(() => engine.sendPagelet(new Pagelet({ id: 'x' })), Error);
    });

    it('throws if engine is closed', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      engine.close();
      assert.throws(() => engine.sendPagelet(new Pagelet({ id: 'x' })), Error);
    });

    it('throws if response is destroyed', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      engine.close();
      assert.throws(() => engine.sendPagelet(new Pagelet({ id: 'x' })), Error);
    });

    it('throws for non-Pagelet argument', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      assert.throws(() => engine.sendPagelet({ id: 'x' }), TypeError);
    });

    it('throws on duplicate pagelet id', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      engine.sendPagelet(new Pagelet({ id: 'x' }));
      assert.throws(() => engine.sendPagelet(new Pagelet({ id: 'x' })), Error);
    });

    it('increments pageletCount', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      engine.sendPagelet(new Pagelet({ id: 'a' }));
      engine.sendPagelet(new Pagelet({ id: 'b' }));
      assert.equal(engine.pageletCount, 2);
    });

    it('decrements pageletCount on serialization failure', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      const p = new Pagelet({ id: 'x' });
      p.toScriptTag = () => { throw new Error('boom'); };
      assert.throws(() => engine.sendPagelet(p), Error);
      assert.equal(engine.pageletCount, 0);
    });

    it('removes id from sent set on serialization failure', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      const p = new Pagelet({ id: 'x' });
      p.toScriptTag = () => { throw new Error('boom'); };
      assert.throws(() => engine.sendPagelet(p), Error);
      assert.equal(engine.hasPagelet('x'), false);
    });

    it('emits pagelet events', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      const events = [];
      engine.on('pagelet:start', (p) => events.push(`start:${p.id}`));
      engine.on('pagelet:complete', (p) => events.push(`end:${p.id}`));
      engine.sendPagelet(new Pagelet({ id: 'x' }));
      assert.deepEqual(events, ['start:x', 'end:x']);
    });
  });

  describe('hasPagelet', () => {
    it('returns true for sent pagelet ids', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      engine.sendPagelet(new Pagelet({ id: 'x' }));
      assert.equal(engine.hasPagelet('x'), true);
    });

    it('returns false for unsent pagelet ids', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      assert.equal(engine.hasPagelet('x'), false);
    });
  });

  describe('flush', () => {
    it('calls response.flush if available', () => {
      const res = fakeResponse();
      res.flush = mock.fn();
      const engine = new BigPipeEngine(res);
      engine.sendHead();
      engine.flush();
      assert.equal(res.flush.mock.calls.length, 1);
    });

    it('does not throw when response.flush is undefined', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      engine.flush();
    });

    it('emits flush event', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      const events = [];
      engine.on('flush', () => events.push('flush'));
      engine.flush();
      assert.deepEqual(events, ['flush']);
    });

    it('no-ops when response is destroyed', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      engine.sendHead();
      engine.close();
      const events = [];
      engine.on('flush', () => events.push('flush'));
      engine.flush();
      assert.deepEqual(events, []);
    });
  });

  describe('close', () => {
    it('ends the response', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      engine.sendHead();
      engine.close();
      assert.equal(res.end.mock.calls.length, 1);
      assert.equal(engine.phase, PHASES.CLOSED);
    });

    it('sends footer before ending', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      engine.sendHead();
      engine.close('</html>');
      const last = res.write.mock.calls[res.write.mock.calls.length - 1].arguments[0].toString();
      assert.ok(last.includes('</html>'));
    });

    it('throws for non-string footerHTML', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.sendHead();
      assert.throws(() => engine.close(123), TypeError);
    });

    it('sends head automatically if in INIT phase', () => {
      const engine = new BigPipeEngine(fakeResponse());
      engine.close();
      assert.equal(engine.phase, PHASES.CLOSED);
    });

    it('is idempotent', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      engine.close();
      engine.close();
      assert.equal(res.end.mock.calls.length, 1);
    });

    it('emits close once', () => {
      const engine = new BigPipeEngine(fakeResponse());
      const events = [];
      engine.on('close', () => events.push('close'));
      engine.close();
      assert.deepEqual(events, ['close']);
    });

    it('removes response event listeners', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      engine.sendHead();
      const before = res.listenerCount('error');
      engine.close();
      const after = res.listenerCount('error');
      assert.ok(after < before);
    });
  });

  describe('response error and close', () => {
    it('transitions to CLOSED on response error', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      engine.on('error', () => {});
      res.emit('error', new Error('boom'));
      assert.equal(engine.phase, PHASES.CLOSED);
    });

    it('emits error on response error and detaches', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      const errors = [];
      engine.on('error', (e) => errors.push(e.message));
      res.emit('error', new Error('boom'));
      assert.deepEqual(errors, ['boom']);
      assert.equal(res.listenerCount('error'), 0);
    });

    it('transitions to CLOSED on response close', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      res.emit('close');
      assert.equal(engine.phase, PHASES.CLOSED);
    });
  });

  describe('clientRuntime', () => {
    it('returns a string with bigPipe object', () => {
      const runtime = BigPipeEngine.clientRuntime();
      assert.ok(typeof runtime === 'string');
      assert.ok(runtime.includes('window.bigPipe'));
      assert.ok(runtime.includes('onPageletArrive'));
      assert.ok(runtime.includes('_display'));
      assert.ok(runtime.includes('_complete'));
    });
  });

  describe('PHASES', () => {
    it('exposes frozen phase map', () => {
      assert.equal(BigPipeEngine.PHASES.INIT, 'init');
      assert.equal(BigPipeEngine.PHASES.HEAD_SENT, 'head_sent');
      assert.equal(BigPipeEngine.PHASES.STREAMING, 'streaming');
      assert.equal(BigPipeEngine.PHASES.CLOSED, 'closed');
      assert.throws(() => { BigPipeEngine.PHASES.INIT = 'x'; }, TypeError);
    });
  });

  describe('drain forwarding', () => {
    it('re-emits drain from response', () => {
      const res = fakeResponse();
      const engine = new BigPipeEngine(res);
      const drains = [];
      engine.on('drain', () => drains.push('drain'));
      res.emit('drain');
      assert.deepEqual(drains, ['drain']);
    });
  });
});
