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

  constructor(response, options = {}) {
    super();

    if (typeof response.write !== 'function' || typeof response.end !== 'function') {
      throw new TypeError('BigPipeEngine requires a writable stream with .write() and .end()');
    }

    this.#response = response;
    this.#phase = PHASES.INIT;
    this.#pageletCount = 0;

    this.#response.on('error', (err) => {
      this.#phase = PHASES.CLOSED;
      this.emit('error', err);
    });

    this.#response.on('close', () => {
      this.#phase = PHASES.CLOSED;
      this.emit('close');
    });
  }

  get phase() {
    return this.#phase;
  }

  get pageletCount() {
    return this.#pageletCount;
  }

  get response() {
    return this.#response;
  }

  sendHead(shellHTML) {
    if (this.#phase !== PHASES.INIT) {
      throw new Error('Cannot send head in phase "' + this.#phase + '"');
    }

    const head = shellHTML ?? '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>Page</title>\n</head>\n<body>\n';

    this.#response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'X-Powered-By': 'BigPipeEngine/1.0'
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
    if (this.#phase === PHASES.INIT) {
      throw new Error('Must call sendHead() before sending pagelets');
    }
    if (this.#phase === PHASES.CLOSED) {
      throw new Error('Cannot send pagelet after engine is closed');
    }

    if (this.#phase === PHASES.HEAD_SENT) {
      this.#phase = PHASES.STREAMING;
    }

    this.#pageletCount++;
    this.emit('pagelet:start', pagelet);

    const buffer = Buffer.from(pagelet.toScriptTag(), 'utf-8');

    if (this.#response.destroyed) {
      throw new Error('Underlying response stream is destroyed');
    }

    const ok = this.#response.write(buffer);
    this.emit('pagelet:complete', pagelet);
    return ok;
  }

  flush() {
    if (typeof this.#response.flush === 'function') {
      this.#response.flush();
    }
    this.emit('flush');
    return this;
  }

  close(footerHTML) {
    if (this.#phase === PHASES.CLOSED) return this;
    if (this.#phase === PHASES.INIT) this.sendHead();
    if (footerHTML) {
      this.#response.write(Buffer.from(footerHTML, 'utf-8'));
    }
    this.#phase = PHASES.CLOSED;
    this.#response.end();
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
