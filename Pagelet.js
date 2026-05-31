export const PRIORITY = Object.freeze({
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  CRITICAL: 3,
});

export default class Pagelet {
  #id;
  #markup;
  #css;
  #js;
  #phase;

  constructor(options = {}) {
    const {
      id,
      markup = options.html ?? '',
      css = [],
      js = [],
      phase = options.priority ?? 0,
    } = options;

    if (!id || typeof id !== 'string') {
      throw new TypeError('Pagelet requires a non-empty string `id`');
    }
    if (typeof markup !== 'string') {
      throw new TypeError('Pagelet markup must be a string');
    }
    if (!Array.isArray(css) || !css.every(s => typeof s === 'string')) {
      throw new TypeError('Pagelet css must be an array of URL strings');
    }
    if (!Array.isArray(js) || !js.every(s => typeof s === 'string')) {
      throw new TypeError('Pagelet js must be an array of URL strings');
    }

    const p = typeof phase === 'string' && phase.toUpperCase() in PRIORITY
      ? PRIORITY[phase.toUpperCase()]
      : Number.isInteger(phase) ? phase : 0;

    if (p < 0 || p > 3) {
      throw new TypeError('Pagelet phase must be 0–3');
    }

    this.#id = id;
    this.#markup = markup;
    this.#css = css;
    this.#js = js;
    this.#phase = p;
  }

  get id() { return this.#id; }
  get markup() { return this.#markup; }
  get css() { return [...this.#css]; }
  get js() { return [...this.#js]; }
  get phase() { return this.#phase; }

  set phase(v) {
    if (!Number.isInteger(v) || v < 0 || v > 3) {
      throw new TypeError('Pagelet phase must be an integer 0–3');
    }
    this.#phase = v;
  }

  toJSON() {
    return {
      id: this.#id,
      content: {
        markup: this.#markup,
        css: [...this.#css],
        js: [...this.#js],
      },
      css: [...this.#css],
      js: [...this.#js],
      phase: this.#phase,
    };
  }

  toScriptTag() {
    const raw = JSON.stringify(this.toJSON());
    const sanitised = raw
      .replace(/</g, '\\u003C')
      .replace(/>/g, '\\u003E')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    return `<script>bigPipe.onPageletArrive(${sanitised});</script>\n`;
  }

  static get PRIORITY() { return PRIORITY; }
}
