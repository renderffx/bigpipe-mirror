import { EventEmitter } from 'node:events';
import Pagelet from './Pagelet.js';

const PHASES = Object.freeze({
  INIT: 'init',
  HEAD_SENT: 'head_sent',
  STREAMING: 'streaming',
  CLOSED: 'closed'
});

export { PHASES };

export default class BigPipeEngine extends EventEmitter {
  #response;
  #phase;
  #pageletCount;
  #closed;
  #sentIds;
  #cleanup;

  constructor(response, options = {}) {
    super();

    if (typeof response.writeHead !== 'function') {
      throw new TypeError('BigPipeEngine requires a response with .writeHead()');
    }
    if (typeof response.write !== 'function' || typeof response.end !== 'function') {
      throw new TypeError('BigPipeEngine requires a writable stream with .write() and .end()');
    }
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('BigPipeEngine options must be an object');
    }

    this.#response = response;
    this.#phase = PHASES.INIT;
    this.#pageletCount = 0;
    this.#closed = false;
    this.#sentIds = new Set();

    this.setMaxListeners(Infinity);

    const onError = (err) => {
      this.#phase = PHASES.CLOSED;
      this.#closed = true;
      this.#detach();
      this.emit('error', err);
    };

    const onClose = () => {
      this.#phase = PHASES.CLOSED;
      if (!this.#closed) {
        this.#closed = true;
        this.#detach();
        this.emit('close');
      }
    };

    const onDrain = () => {
      this.emit('drain');
    };

    this.#cleanup = () => {
      response.off('error', onError);
      response.off('close', onClose);
      response.off('drain', onDrain);
      this.#cleanup = null;
    };

    response.on('error', onError);
    response.on('close', onClose);
    response.on('drain', onDrain);
  }

  #detach() {
    if (this.#cleanup) this.#cleanup();
  }

  get phase() {
    return this.#phase;
  }

  get pageletCount() {
    return this.#pageletCount;
  }

  sendHead(shellHTML) {
    if (this.#phase !== PHASES.INIT) {
      throw new Error('Cannot send head in phase "' + this.#phase + '"');
    }
    if (shellHTML !== undefined && shellHTML !== null && typeof shellHTML !== 'string') {
      throw new TypeError('sendHead shellHTML must be a string');
    }
    if (this.#response.destroyed) {
      throw new Error('Cannot send head: underlying response stream is destroyed');
    }

    const head = shellHTML ?? '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>Page</title>\n</head>\n<body>\n';

    this.#response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Transfer-Encoding': 'chunked'
    });

    this.#response.write(BigPipeEngine.clientRuntime());
    this.#response.write(head);

    this.#phase = PHASES.HEAD_SENT;
    this.emit('head:sent');
    return this;
  }

  sendPagelet(pagelet) {
    if (!(pagelet instanceof Pagelet)) {
      throw new TypeError('sendPagelet expects a Pagelet instance');
    }
    if (this.#response.destroyed) {
      throw new Error('Cannot send pagelet "' + pagelet.id + '": underlying response stream is destroyed');
    }
    if (this.#phase === PHASES.INIT) {
      throw new Error('Must call sendHead() before sending pagelets');
    }
    if (this.#phase === PHASES.CLOSED) {
      throw new Error('Cannot send pagelet "' + pagelet.id + '" after engine is closed');
    }
    if (this.#sentIds.has(pagelet.id)) {
      throw new Error('Duplicate pagelet id "' + pagelet.id + '"');
    }

    if (this.#phase === PHASES.HEAD_SENT) {
      this.#phase = PHASES.STREAMING;
    }

    this.#sentIds.add(pagelet.id);
    this.#pageletCount++;
    this.emit('pagelet:start', pagelet);

    try {
      const buffer = Buffer.from(pagelet.toScriptTag(), 'utf-8');
      const ok = this.#response.write(buffer);
      this.emit('pagelet:complete', pagelet);
      return ok;
    } catch (err) {
      this.#sentIds.delete(pagelet.id);
      this.#pageletCount--;
      throw err;
    }
  }

  hasPagelet(id) {
    return this.#sentIds.has(id);
  }

  flush() {
    if (this.#response.destroyed) return this;
    if (typeof this.#response.flush === 'function') {
      this.#response.flush();
    }
    this.emit('flush');
    return this;
  }

  close(footerHTML) {
    if (this.#phase === PHASES.CLOSED || this.#closed) return this;

    if (footerHTML !== undefined && footerHTML !== null && typeof footerHTML !== 'string') {
      throw new TypeError('close footerHTML must be a string');
    }

    if (this.#phase === PHASES.INIT) {
      try {
        this.sendHead();
      } catch {
        this.#phase = PHASES.CLOSED;
        this.#closed = true;
        this.#detach();
        return this;
      }
    }

    this.#phase = PHASES.CLOSED;
    this.#closed = true;
    this.#detach();

    try {
      if (!this.#response.destroyed) {
        this.#response.write('<script>bigPipe.pageComplete();</script>\n');
        if (typeof this.#response.flush === 'function') this.#response.flush();
      }
      if (footerHTML && !this.#response.destroyed) {
        this.#response.write(Buffer.from(footerHTML, 'utf-8'));
      }
      if (!this.#response.destroyed) {
        this.#response.end();
      }
    } catch {
      // stream already destroyed or errored
    }

    this.emit('close');
    return this;
  }

  static clientRuntime() {
    return '<script>\nwindow.bigPipe={\nq:{},\nc:{},\nj:{},\nonPageletArrive:function(d){\nbigPipe.q[d.id]=d;\nvar n=d.css.length;\nif(n===0){bigPipe.show(d.id);return}\nfor(var i=0;i<d.css.length;i++)(function(h){\nif(bigPipe.c[h]){n--;if(n===0)bigPipe.show(d.id);return}\nbigPipe.c[h]=1;\nvar l=document.createElement("link");\nl.rel="stylesheet";l.href=h;\nl.onload=l.onerror=function(){n--;if(n===0)bigPipe.show(d.id)};\ndocument.head.appendChild(l);\n})(d.css[i]);\n},\nshow:function(id){\nvar d=bigPipe.q[id];\nif(!d)return;\nvar e=document.getElementById(id);\nif(e){e.innerHTML=d.content.markup;e.className=e.className.replace(/\\bloading\\b/g,"")}\nvar n=d.js.length;\nif(n===0){bigPipe.done(id);return}\nfor(var j=0;j<d.js.length;j++)(function(s){\nif(bigPipe.j[s]){n--;if(n===0)bigPipe.done(id);return}\nbigPipe.j[s]=1;\nvar t=document.createElement("script");\nt.src=s;\nt.onload=t.onerror=function(){n--;if(n===0)bigPipe.done(id)};\ndocument.body.appendChild(t);\n})(d.js[j]);\n},\ndone:function(id){\ndelete bigPipe.q[id];\nif(typeof bigPipe._c==="function")bigPipe._c(id);\n},\nonPageletError:function(id){\ndelete bigPipe.q[id];\nvar e=document.getElementById(id);\nif(e)e.className=e.className.replace(/\\bloading\\b/g,"");\n},\n_c:function(id){},\npageComplete:function(){}\n};\n</script>\n';
  }

  static get PHASES() {
    return PHASES;
  }
}
