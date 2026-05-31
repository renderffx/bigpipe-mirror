# BigPipe Engine

BigPipe streaming for Node.js. Pagelets arrive **out of order** - the browser renders each section as soon as it's ready, without waiting for the slowest one.

## Architecture

```
                           ╔═══════════════════╗
  Request ───────────────▶ ║  BigPipeEngine    ║
                           ║                   ║
                           ║  1. sendHead()    ║ ──▶ Shell HTML + JS runtime
                           ║  2. sendPagelet() ║ ──▶ <script> tags (out of order)
                           ║  3. close()       ║ ──▶ Footer HTML
                           ╚═══════════════════╝
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              ┌──────────┐   ┌──────────┐   ┌──────────┐
              │ Pagelet  │   │ Pagelet  │   │ Pagelet  │
              │  (nav)   │   │ (feed)   │   │(sidebar) │
              └──────────┘   └──────────┘   └──────────┘
```

### How it works

1. **Shell** - The server immediately flushes the HTML `<head>`, page skeleton, and the BigPipe JavaScript runtime. The browser can start rendering the empty layout while data is still being fetched.

2. **Pagelets** - Individual page sections (e.g., nav, feed, sidebar) are fetched concurrently on the server. Each one is streamed to the browser as a `<script>` tag the moment it's ready, not in any particular order.

3. **Runtime** - The `bigPipe.onPageletArrive()` JS function receives each pagelet, loads any CSS/JS dependencies, and swaps the content into the correct DOM element, removing the loading shimmer.

### Why BigPipe?

- **TTFB (Time to First Byte)** is nearly instant - the shell is sent before any data queries finish
- **Perceived performance** is better - fast pagelets appear immediately
- **Out-of-order streaming** means slow backend endpoints don't block fast ones
- **Progressive enhancement** - CSS/JS dependencies are loaded per-pagelet and deduplicated

## Files

| File | Role |
|---|---|
| `BigPipeEngine.js` | Manages the HTTP response stream (head / pagelet / close) |
| `Pagelet.js` | A self-contained page section with HTML, CSS, JS, and priority |
| `server.js` | Demo server with a 3-column dashboard example |
| `test/` | Test suite (node --test, 51 tests) |

## Usage

```js
import http from 'node:http';
import BigPipeEngine from './BigPipeEngine.js';
import Pagelet from './Pagelet.js';

http.createServer((req, res) => {
  const engine = new BigPipeEngine(res);

  // 1. Send the shell immediately
  engine.sendHead('<html>...<div id="main"></div>');

  // 2. Stream pagelets as data arrives
  fetchData().then(html => {
    engine.sendPagelet(new Pagelet({ id: 'main', html }));
  });

  // 3. Close when all pagelets are done
  engine.close('</html>');
});
```

## Demo

```bash
node server.js
```

Open http://localhost:3000 - watch each column load independently. The sidebar arrives first (~400ms), nav second (~800ms), and the feed last (~2000ms). The page is interactive from the first paint.

## Pagelet API

```js
const pagelet = new Pagelet({
  id: 'unique-id',            // Required - matches the DOM container
  html: '<h1>Hello</h1>',     // The HTML content (alias: markup)
  css: ['/styles.css'],       // CSS URLs to load before displaying
  js: ['/app.js'],            // JS URLs to load after displaying
  phase: PRIORITY.NORMAL,     // 0-3 or PRIORITY enum value
});
```

### Priority levels

| Phase | Constant | Use case |
|---|---|---|
| 0 | `PRIORITY.LOW` | Below-fold content, analytics |
| 1 | `PRIORITY.NORMAL` | Standard page sections |
| 2 | `PRIORITY.HIGH` | Navigation, search |
| 3 | `PRIORITY.CRITICAL` | Above-fold, hero content |

## How the runtime works (`clientRuntime`)

The inline `<script>` injected by `BigPipeEngine.clientRuntime()` creates a global `window.bigPipe` object with:

- **`onPageletArrive(data)`** - Called by each `<script>` tag. Loads CSS (deduplicated via `loadedCss`), injects markup into the matching `id` element, then loads JS (deduplicated via `loadedJs`).
- **`_display(data)`** - Replaces innerHTML and removes the `loading` CSS class (which controls the shimmer animation).
- **`_complete(id)`** - Hook for post-render logic (e.g., analytics).

## Tests

```bash
npm test
```
