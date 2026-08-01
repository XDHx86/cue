// Full-resolution screenshot via desktopCapturer (main process), then downscaled to a compact
// JPEG before it ever leaves the process. First capture triggers the macOS Screen-Recording
// permission prompt for the app.
//
// Vision perf (Phase 5, F12): vision providers downscale to ≤1568 px on their long edge anyway,
// so a full-res PNG is wasted bandwidth and base64. captureScreenshot() now caps the longest edge
// to MAX_EDGE (1568) preserving aspect ratio, re-encodes as JPEG (q 0.85), and caches the result
// for CACHE_TTL_MS (1.5 s) so a rapid burst of asks (Ctrl+Alt+A → Assist → ask) reuses one
// capture instead of re-grabbing the screen three times in a second.
//
// The dimension math (scaleToMaxEdge) and the cache-freshness check (cacheFresh) are pure and
// exported for unit testing; only captureScreenshot() touches Electron's desktopCapturer/screen.
// src/llm.js needs no change — stripDataUrl already passes the mime through, so image/jpeg is
// routed correctly to OpenAI (image_url), Anthropic (image/media_type), and Gemini (inlineData).

const { desktopCapturer, screen } = require('electron');

const MAX_EDGE = 1568;       // longest-edge cap, in pixels (vision providers downscale to this range)
const JPEG_QUALITY = 85;   // 0–100; 85 is visually clean for screen text at KB, not MB
const CACHE_TTL_MS = 1500;   // reuse the last capture within this window for rapid ask bursts

// Pure: resize dims preserving aspect ratio so the longest edge ≤ maxEdge. No upscale — an image
// already within the cap is returned unchanged (resize would bilinearly upsample a smaller image,
// blurring it for no benefit). Handles zero/missing dims by passing them through untouched.
function scaleToMaxEdge(w, h, maxEdge) {
  if (!w || !h || maxEdge <= 0) return { width: w, height: h };
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h };
  const k = maxEdge / longest;
  return { width: Math.round(w * k), height: Math.round(h * k) };
}

// Pure cache-freshness predicate. now and cachedAt are ms epochs; ttlMs the reuse window.
function cacheFresh(now, cachedAt, ttlMs) {
  return cachedAt != null && typeof cachedAt === 'number' &&
    typeof now === 'number' && typeof ttlMs === 'number' && (now - cachedAt) < ttlMs;
}

let _cache = null; // { dataUrl, at } — last capture; null until the first successful grab

function clearCache() { _cache = null; }

async function captureScreenshot({ ttlMs = CACHE_TTL_MS, maxEdge = MAX_EDGE, quality = JPEG_QUALITY } = {}) {
  const now = Date.now();
  if (_cache && cacheFresh(now, _cache.at, ttlMs)) return _cache.dataUrl;

  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
  });
  if (!sources.length) return null;
  // Prefer the primary display source (multi-monitor: getSources order is not guaranteed).
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;

  // Downscale to ≤MAX_EDGE on the longest side, preserving aspect ratio (no upscale). The OS may
  // already have capped the thumbnail below native; getSize() reads the actual buffer dims.
  const { width: iw, height: ih } = img.getSize();
  const { width: tw, height: th } = scaleToMaxEdge(iw, ih, maxEdge);
  const resized = (tw !== iw) ? img.resize({ width: tw, height: th, quality: 'good' }) : img;

  const dataUrl = 'data:image/jpeg;base64,' + resized.toJPEG(quality).toString('base64');
  _cache = { dataUrl, at: now };
  return dataUrl;
}

module.exports = {
  captureScreenshot,
  clearCache,
  scaleToMaxEdge,
  cacheFresh,
  MAX_EDGE,
  JPEG_QUALITY,
  CACHE_TTL_MS,
};
