# Facebook BigPipe — Exact Architecture

> Reference: "BigPipe: Pipelining Web Pages for High Performance" — Chang et al., Facebook, 2010

---

## 1. Core Concept

BigPipe breaks a page into independent **pagelets**, streams the page shell immediately via HTTP/1.1 chunked encoding, then flushes each pagelet as a `<script>` tag payload the instant its backend data is ready — without waiting for other pagelets. The browser renders progressively as chunks arrive.

```
Time ──────────────────────────────────────────────────────►

┌──────────────────────────────────────────────────────────┐
│ 1. PAGE SHELL (flushed immediately)                       │
│    DOCTYPE + <head> + CSS framework + BigPipe runtime     │
│    + placeholder <div id="pagelet_N"> tags               │
│    + </head><body> opening                                │
├──────────────────────────────────────────────────────────┤
│ 2. PAGELET STREAM (each flushed as soon as it renders)   │
│    <script>bigPipe.onPageletArrive({...pagelet_A...});</> │
│    <script>bigPipe.onPageletArrive({...pagelet_B...});</> │
│          ↑ out-of-order — first ready, first flushed      │
│    <script>bigPipe.onPageletArrive({...pagelet_C...});</> │
├──────────────────────────────────────────────────────────┤
│ 3. CLOSING TAGS                                           │
│    </body></html>                                         │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Wire Format (Exact)

Facebook's BigPipe sends raw HTML interspersed with `<script>` tags over a single chunked HTTP response:

### 2.1 Page Shell (first chunk)

```html
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Transfer-Encoding: chunked

<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Facebook</title>
  <link rel="stylesheet" href="/css/base.css" />
  <script src="/js/bigpipe.js"></script>   <!-- client runtime -->
</head>
<body>
  <div id="pagelet_nav"></div>
  <div id="pagelet_feed"></div>
  <div id="pagelet_ads"></div>
  <!-- flush() called here — shell sent to browser immediately -->
```

Shell sent via `flush()` — browser can begin loading CSS/JS resources in `<head>` while server continues rendering pagelets.

### 2.2 Each Pagelet Flush (sent as ready)

```html
<script>
bigPipe.onPageletArrive({
  id: "pagelet_nav",
  content: {
    markup: "<ul><li>Home</li><li>Profile</li></ul>",
    css: ["/css/nav.css", "/css/icons.css"],
    js:  ["/js/nav.js"]
  },
  css: ["/css/nav.css"],
  js:  ["/js/nav.js"],
  phase: 0            ← see §3.2
});
</script>
<!-- flush() here — immediately sent down the wire -->
```

### 2.3 Footer (last chunk)

```html
  <script>bigPipe.pageComplete();</script>
</body>
</html>
<!-- end of response -->
```

---

## 3. Client-Side Runtime (`bigPipe.js`)

### 3.1 Global Registry

A single `window.bigPipe` object manages all pagelets:

```js
var bigPipe = {
  queue: [],                // pending pagelets awaiting CSS/JS
  loadedCss: {},            // deduplication cache
  loadedJs: {},
  onPageletArrive: function(data) { /* see below */ },
  showPagelet: function(id) { /* inject HTML into placeholder */ },
  executeJS: function(id) { /* eval pagelet JS */ },
  onPageletError: function(id) { /* timeout / error recovery */ }
};
```

### 3.2 Multi-Phase Lifecycle Per Pagelet

Each pagelet progresses through **4 phases**, tracked on both server and client:

| Phase | Name         | Meaning                                        |
|-------|--------------|-------------------------------------------------|
| 0     | `ARRIVE`     | Script tag parsed; begin loading CSS resources  |
| 1     | `DISPLAY`    | All CSS loaded; inject HTML into placeholder div |
| 2     | `INTERACTIVE`| All JS loaded; execute JS                       |
| 3     | `COMPLETE`   | Pagelet fully rendered and interactive          |

The `phase` field in the `onPageletArrive` payload tells the client what stage to enter immediately.

### 3.3 CSS Loading Strategy (Critical)

BigPipe's key innovation: **CSS loading is parallelized across pagelets**, not sequential.

```
Standard page (blocking):      <link rel="stylesheet"> → parse → <link> → parse → render
BigPipe (parallel):            ┌─ nav.css ─┐
                               ├─ feed.css ─┤── all load in parallel → inject HTML
                               └─ ads.css ──┘
```

When `onPageletArrive` fires for a pagelet, the client:
1. Checks if its CSS URLs are already cached
2. If not, creates `<link rel="stylesheet">` tags dynamically
3. Tracks load completion
4. Once CSS is ready, calls `showPagelet(id)` to inject HTML
5. Then loads JS via `<script>` tag injection

### 3.4 Actual Facebook Client Code (Reconstructed Logic)

```js
onPageletArrive: function(data) {
  bigPipe.queue.push(data);
  bigPipe.loadResources(data);
},

loadResources: function(data) {
  var pending = data.css.length + data.js.length;
  if (pending === 0) {
    bigPipe.showPagelet(data.id);
    return;
  }

  data.css.forEach(function(href) {
    if (bigPipe.loadedCss[href]) {
      pending--;
      if (pending === 0) bigPipe.showPagelet(data.id);
      return;
    }
    bigPipe.loadedCss[href] = true;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = link.onerror = function() {
      pending--;
      if (pending === 0) bigPipe.showPagelet(data.id);
    };
    document.head.appendChild(link);
  });

  // JS handled similarly with <script> tags
}
```

---

## 4. Server-Side Pipeline (PHP Implementation)

Facebook used PHP (compiled to C++ via HipHop). The server pipeline:

```
Request ──► 1. Parse & auth ──► 2. Identify pagelets ──► 3. Fetch data
                  │                                              │
                  │    4. Render shell + flush() ◄────────────────┘
                  │              │
                  │    5. For each pagelet (parallel or sequential):
                  │       ┌─ Render pagelet markup
                  │       ├─ Wrap in <script> tag
                  │       ├─ flush()
                  │       └─ Emit event
                  │
                  ▼    6. Render footer + close()
```

**Key: PHP's `flush()` forces the web server (Apache) to send buffered data immediately via chunked encoding.**

```php
// Simplified Facebook pattern
echo $pageShell;
flush();  // ← Critical: sends shell + HTTP headers immediately

// Pagelet rendering pipeline
foreach ($pagelets as $pagelet) {
    $data = $pagelet->getData();    // may block on DB
    echo $pagelet->render($data);   // wraps in <script> tag
    flush();                        // ← Flushes immediately
}

echo $footer;
```

---

## 5. Differences From Our Implementation

| Aspect                    | Facebook BigPipe (2010)                   | Our Implementation                     |
|---------------------------|-------------------------------------------|----------------------------------------|
| **Pagelet content**       | External CSS/JS URLs (resource URLs)      | Inline `css`, `js` strings             |
| **Client phases**         | 4-phase lifecycle (0→1→2→3)               | Single-phase (onPageletArrive → inject)|
| **CSS loading**           | Parallel `<link>` injection, load tracking| Synchronous `<style>` injection        |
| **JS execution**          | `<script>` tag injection (async)          | `new Function()` eval                  |
| **Error recovery**        | Timeout-based fallback per pagelet        | None (unhandled rejection → engine closes) |
| **Priority**              | Implicit (render order ≈ data-ready order)| Explicit `PRIORITY` enum (0–100)       |
| **Queue**                 | None — pagelets flushed immediately       | Priority-sorted queue with backpressure|
| **Backpressure**          | None (PHP blocking I/O model)             | `drain` event gating                   |
| **Stream format**         | Raw HTML + `<script>` tags, no JSON wrapper| `toScriptTag()` produces same format  |
| **Resource dedup**        | Global CSS/JS dedup cache (`loadedCss`)   | Not implemented (inline only)          |
| **Server language**       | PHP (HipHop-compiled)                     | Node.js ES modules                     |
| **Chunked encoding**      | Apache `flush()` → kernel `write()`       | Node.js `response.write()` (auto-chunked)|
| **Concurrency model**     | Single-threaded, async I/O multiplexed    | Event loop + async Promises            |

---

## 6. What Facebook Got Right (And We Don't)

### 6.1 Resource Parallelism

Facebook loaded CSS across pagelets **in parallel**. Multiple pagelets sharing the same CSS file only triggered one `<link>` load. Our inline approach works for demos but doesn't scale — real pages need external stylesheet deduplication.

### 6.2 Phase Gating

Facebook's 4-phase model prevented Flash of Unstyled Content (FOUC) by deferring HTML injection until CSS was confirmed loaded. Our runtime injects HTML immediately, which can cause a brief unstyled flash if the browser hasn't processed the inline `<style>` tag yet.

### 6.3 Error Resilience

Facebook had configurable timeouts per pagelet. If a pagelet's CSS failed to load within N seconds, it fell back to a minimal rendering. Our implementation has no recovery path.

### 6.4 Resource Ordering Dependencies

Facebook tracked inter-pagelet dependencies (e.g., a `feed_story` pagelet depending on the `feed` container). Our model treats each pagelet as fully independent.

---

## 7. How to Make Our Implementation Match Facebook's Exactly

To bridge the gap, these changes would be needed:

1. **Pagelet.js**: Change `css`/`js` from strings to arrays of URLs (`css: string[]`, `js: string[]`). Add `content: { markup, css, js }` nesting in `toJSON`.

2. **BigPipeEngine.clientRuntime()**: Replace with full 4-phase client:
   - Phase 0: Arrive → load CSS/JS resources
   - Phase 1: CSS loaded → `innerHTML` into placeholder div
   - Phase 2: JS loaded → execute
   - Phase 3: Complete
   - Add URL dedup cache
   - Add per-pagelet timeout fallback

3. **Wire format**: Change `toScriptTag()` to match Facebook's exact payload shape:
   ```json
   {
     "id": "pagelet_nav",
     "content": { "markup": "...", "css": ["..."], "js": ["..."] },
     "css": ["..."],
     "js": ["..."],
     "phase": 0
   }
   ```

4. **Engine**: Remove priority queue. Pagelets should flush immediately when data resolves, not be sorted. Backpressure handling is fine but should not reorder.

---

## 8. References

- Chang et al., "BigPipe: Pipelining Web Pages for High Performance", Facebook, USENIX ;login:, 2010
- [Facebook BigPipe paper (PDF)](https://www.usenix.org/legacy/event/login/2010/download/chang.pdf)
- [Engineering at Meta — BigPipe retrospective](https://engineering.fb.com/web/bigpipe-pipelining-web-pages-for-high-performance/)
