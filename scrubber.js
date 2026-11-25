// Pointer samples may arrive several times between paints. Only the newest x
// is relevant; keyboard navigation and range changes can cancel queued input.
export function bindScrubber(host, { surface = host, onPosition, onDragStart, hover = true }) {
  let frame = 0, pendingPageX = 0, pendingDragStart = false;
  let boundsValid = false, pageLeft = 0, width = 0;
  let drag = null, suppressClick = false;
  const listeners = new AbortController();
  const options = { passive: true, signal: listeners.signal };

  function invalidateBounds() {
    boundsValid = false;
  }

  function cancelFrame() {
    cancelAnimationFrame(frame);
    frame = 0;
    pendingDragStart = false;
  }

  function flush() {
    frame = 0;
    const startingDrag = pendingDragStart;
    pendingDragStart = false;
    if (!surface.isConnected) return;
    if (!boundsValid) {
      const bounds = surface.getBoundingClientRect();
      pageLeft = bounds.left + window.scrollX;
      width = bounds.width;
      boundsValid = true;
    }
    if (width <= 0) return;
    const fraction = (pendingPageX - pageLeft) / width;
    if (startingDrag) onDragStart?.(fraction);
    onPosition(fraction);
  }

  function queue(pageX) {
    pendingPageX = pageX;
    if (!frame) frame = requestAnimationFrame(flush);
  }

  host.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick = false;
    invalidateBounds();
    drag = { id: event.pointerId, x: event.clientX, moved: false };
    // Capture on the original hit target so ordinary phase-button taps keep
    // their click target while a held drag can continue outside the chart.
    if (event.isTrusted) event.target.setPointerCapture(event.pointerId);
    if (hover) queue(event.pageX);
  }, options);

  host.addEventListener('pointermove', event => {
    if (drag && event.pointerId !== drag.id) return;
    if (!drag && (event.pointerType === 'touch' || !hover)) return;
    if (drag && !drag.moved && Math.abs(event.clientX - drag.x) >= 4) {
      drag.moved = true;
      pendingDragStart = true;
    }
    if (hover || drag?.moved) queue(event.pageX);
  }, options);

  host.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (hover || drag.moved) queue(event.pageX);
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
    if (boundsValid && scroller !== window.document && scroller.contains?.(surface)) invalidateBounds();
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
