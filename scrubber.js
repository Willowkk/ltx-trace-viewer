// Pointer samples may arrive several times between paints. Only the newest x
// is relevant; keyboard navigation and range changes can cancel queued input.
export function bindScrubber(host, { surfaceFor, onPosition, onDragStart, hover = true }) {
  let frame = 0, pendingSurface = null, pendingPageX = 0, pendingDragStart = false;
  let measuredSurface = null, pageLeft = 0, width = 0;
  let drag = null, suppressClick = false;
  const listeners = new AbortController();
  const options = { passive: true, signal: listeners.signal };

  function invalidateBounds() {
    measuredSurface = null;
  }

  function cancelFrame() {
    cancelAnimationFrame(frame);
    frame = 0;
    pendingSurface = null;
    pendingDragStart = false;
  }

  function flush() {
    frame = 0;
    const surface = pendingSurface;
    const startingDrag = pendingDragStart;
    pendingSurface = null;
    pendingDragStart = false;
    if (!surface || !surface.isConnected) return;
    if (surface !== measuredSurface) {
      const bounds = surface.getBoundingClientRect();
      pageLeft = bounds.left + window.scrollX;
      width = bounds.width;
      measuredSurface = surface;
    }
    if (width <= 0) return;
    const fraction = (pendingPageX - pageLeft) / width;
    if (startingDrag) onDragStart?.(fraction);
    onPosition(fraction);
  }

  function queue(surface, pageX) {
    pendingSurface = surface;
    pendingPageX = pageX;
    if (!frame) frame = requestAnimationFrame(flush);
  }

  host.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const surface = surfaceFor(event.target);
    if (!surface) return;
    suppressClick = false;
    invalidateBounds();
    drag = { id: event.pointerId, surface, x: event.clientX, moved: false };
    // Capture on the original hit target so ordinary phase-button taps keep
    // their click target while a held drag can continue outside the chart.
    if (event.isTrusted) event.target.setPointerCapture(event.pointerId);
    if (hover) queue(surface, event.pageX);
  }, options);

  host.addEventListener('pointermove', event => {
    if (drag && event.pointerId !== drag.id) return;
    if (!drag && (event.pointerType === 'touch' || !hover)) return;
    const surface = drag ? drag.surface : surfaceFor(event.target);
    if (!surface) return;
    if (drag && !drag.moved && Math.abs(event.clientX - drag.x) >= 4) {
      drag.moved = true;
      pendingDragStart = true;
    }
    if (hover || drag?.moved) queue(surface, event.pageX);
  }, options);

  host.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (hover || drag.moved) queue(drag.surface, event.pageX);
    suppressClick = drag.moved;
    drag = null;
  }, options);
  function endDrag(event) {
    if (event.pointerId !== drag?.id) return;
    drag = null;
    cancelFrame();
  }
  host.addEventListener('pointercancel', endDrag, options);
  host.addEventListener('lostpointercapture', endDrag, options);
  host.addEventListener('click', event => {
    if (suppressClick && event.detail > 0) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
    suppressClick = false;
  }, { capture: true, signal: listeners.signal });
  // Both pointer and bounds are in document coordinates. Only scrolling an
  // ancestor inside the document can shift this surface relative to the page.
  window.addEventListener('scroll', event => {
    const scroller = event.target;
    if (measuredSurface && scroller !== window.document && scroller.contains?.(measuredSurface)) invalidateBounds();
  }, { ...options, capture: true });
  window.addEventListener('resize', invalidateBounds, options);

  return {
    cancelFrame,
    reset() {
      cancelFrame();
      invalidateBounds();
      drag = null;
      suppressClick = false;
    },
    destroy() {
      cancelFrame();
      listeners.abort();
    },
  };
}
