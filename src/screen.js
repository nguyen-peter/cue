// Screenshot via desktopCapturer (main process), sized for LLM vision input.
// The first call can trigger the system permission prompt for the app.
const { desktopCapturer, screen } = require('electron');

// Vision providers downscale big images server-side before the model sees them
// (Anthropic: 1568px long edge; OpenAI: fit 2048² then 768px short side; Gemini
// tiles at 768²) — so capturing beyond ~1920px long edge only adds capture,
// encode, and upload time without giving the model any extra detail. Capturing
// at the capped size directly also makes desktopCapturer itself much faster.
const MAX_CAPTURE_EDGE = 1600;
// JPEG instead of PNG: a full-screen PNG is easily 2–8 MB (seconds of upload);
// JPEG at 78 quality is ~45% smaller than 85 while keeping code/text crisp for vision models.
const JPEG_QUALITY = 78;

// desktopCapturer's full-screen capture can include cue's own overlay window,
// which means the model would see (and imitate) cue's previous answer. Hiding
// the window for the moment of capture guarantees cue never feeds its own UI
// back into the model. A short delay lets the compositor drop the window first.
//
// On Windows builds with WDA_EXCLUDEFROMCAPTURE active the compositor already
// drops cue from every capture path (the same mechanism that hides it from
// screen shares), so the caller passes skipHide=true there — saving the ~90ms
// wait plus the hide/show flicker on every capture.
async function captureScreenshot(windowToHide, { skipHide = false } = {}) {
  const shouldHide = !skipHide
    && windowToHide
    && !windowToHide.isDestroyed()
    && windowToHide.isVisible();

  if (shouldHide) {
    windowToHide.hide();
    await new Promise((resolve) => setTimeout(resolve, 90));
  }

  try {
    let targetDisplay = screen.getPrimaryDisplay();
    if (windowToHide && !windowToHide.isDestroyed() && typeof windowToHide.getBounds === 'function') {
      try {
        targetDisplay = screen.getDisplayMatching(windowToHide.getBounds()) || targetDisplay;
      } catch (_) {}
    }
    const { width, height } = targetDisplay.size;
    const scale = targetDisplay.scaleFactor || 1;
    const physW = Math.max(1, Math.floor(width * scale));
    const physH = Math.max(1, Math.floor(height * scale));
    // Fit within MAX_CAPTURE_EDGE, never upscale small displays.
    const fit = Math.min(1, MAX_CAPTURE_EDGE / Math.max(physW, physH));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(physW * fit), height: Math.round(physH * fit) }
    });
    if (!sources.length) return null;
    // Prefer the display where the cue overlay currently sits.
    const src = sources.find((s) => String(s.display_id) === String(targetDisplay.id)) || sources[0];
    const img = src.thumbnail;
    if (!img || img.isEmpty()) return null;
    return 'data:image/jpeg;base64,' + img.toJPEG(JPEG_QUALITY).toString('base64');
  } finally {
    if (shouldHide && !windowToHide.isDestroyed()) {
      windowToHide.showInactive();
      windowToHide.setAlwaysOnTop(true, 'screen-saver', 1);
      // hide/show can drop WDA_EXCLUDEFROMCAPTURE / NSWindowSharingNone.
      // The caller re-applies setContentProtection after this returns.
    }
  }
}

module.exports = { captureScreenshot };
