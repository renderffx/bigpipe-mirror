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
    return '<script>\nwindow.bigPipe={\nloadedCss:{},\nloadedJs:{},\nonPageletArrive:function(d){\nvar self=this;\nvar cssC=d.css.length;\nif(cssC===0){self._display(d);return}\nfor(var i=0;i<d.css.length;i++)(function(href){\nif(self.loadedCss[href]){cssC--;if(cssC===0)self._display(d);return}\nself.loadedCss[href]=true;\nvar l=document.createElement("link");\nl.rel="stylesheet";l.href=href;\nl.onload=l.onerror=function(){cssC--;if(cssC===0)self._display(d)};\ndocument.head.appendChild(l);\n})(d.css[i]);\n},\n_display:function(d){\nvar el=document.getElementById(d.id);\nif(el){el.innerHTML=d.content.markup;el.className=el.className.replace(/\\bloading\\b/g,"")}\nvar self=this;\nvar jsC=d.js.length;\nif(jsC===0){this._complete(d.id);return}\nfor(var j=0;j<d.js.length;j++)(function(src){\nif(self.loadedJs[src]){jsC--;if(jsC===0)self._complete(d.id);return}\nself.loadedJs[src]=true;\nvar s=document.createElement("script");\ns.src=src;\ns.onload=s.onerror=function(){jsC--;if(jsC===0)self._complete(d.id)};\ndocument.body.appendChild(s);\n})(d.js[j]);\n},\n_complete:function(id){}\n};\n</script>\n';
  }

  static get PHASES() {
    return PHASES;
  }
}
