// Keep the text in each reading's DOM for assistive technology. Canvas
// fallback children carry those same values without relaying out the sidebar.
export function mountInspector(aside) {
  const slots = new Map();
  const theme = new MutationObserver(refreshAll);
  const resize = new ResizeObserver(entries => {
    for (const { target, contentRect } of entries) {
      const slot = byBox.get(target);
      if (slot) refresh(slot, contentRect.width, contentRect.height);
    }
  });
  const byBox = new Map();

  function attach(element, box, unit) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    const text = element.firstChild || document.createTextNode('');
    canvas.append(text);
    canvas.className = 'inspector-ink';
    element.append(canvas);
    box.classList.add('inspector-slot');
    const slot = { element, box, unit, unitText: unit?.textContent, text, canvas, context, width: 0, height: 0 };
    slots.set(element, slot);
    byBox.set(box, slot);
    resize.observe(box);
  }

  const when = aside.querySelector('.cursor-when');
  const sample = aside.querySelector('#sample-time');
  attach(when.querySelector('strong'), when, when.querySelector('.time-unit'));
  attach(sample, sample, null);
  for (const box of aside.querySelectorAll('.metric-val')) {
    attach(box.querySelector('span'), box, box.querySelector('small'));
  }

  function fontOf(context, element) {
    const css = getComputedStyle(element);
    const font = css.fontWeight + ' ' + css.fontSize + ' ' + css.fontFamily;
    context.font = font;
    const metrics = context.measureText('0');
    const size = parseFloat(css.fontSize);
    const ascent = metrics.fontBoundingBoxAscent ?? size * .8;
    const descent = metrics.fontBoundingBoxDescent ?? size * .2;
    return { font, color: css.color, spacing: css.letterSpacing === 'normal' ? '0px' : css.letterSpacing,
      baseline: (parseFloat(css.lineHeight) - ascent - descent) / 2 + ascent };
  }

  function refresh(slot, width, height) {
    const { canvas, context, box, element, unit } = slot;
    if (!(width > 0 && height > 0)) return;
    const ratio = window.devicePixelRatio || 1;
    const w = Math.ceil(width * ratio), h = Math.ceil(height * ratio);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    context.setTransform(w / width, 0, 0, h / height, 0, 0);
    slot.width = width;
    slot.height = height;
    slot.font = fontOf(context, element);
    const css = getComputedStyle(box);
    slot.right = css.textAlign === 'right';
    slot.stacked = css.display === 'grid';
    if (unit) {
      slot.unitFont = fontOf(context, unit);
      slot.unitWidth = context.measureText(slot.unitText).width;
      slot.gap = parseFloat(getComputedStyle(unit).marginLeft);
      slot.unitY = slot.stacked ? parseFloat(css.gridTemplateRows) + slot.unitFont.baseline : slot.font.baseline;
    }
    paint(slot);
  }

  function write(context, style, text, x, y, maxWidth) {
    context.font = style.font;
    context.fillStyle = style.color;
    if ('letterSpacing' in context) context.letterSpacing = style.spacing;
    context.fillText(text, x, y, maxWidth);
  }

  function paint(slot) {
    const { context, text, width, height, font, unit, right, stacked } = slot;
    if (!font) return;
    context.clearRect(0, 0, width, height);
    context.textAlign = right ? 'right' : 'left';
    const numberWidth = Math.max(1, width - (unit && !stacked ? slot.unitWidth + slot.gap : 0));
    const x = right ? numberWidth : 0;
    write(context, font, text.data, x, font.baseline, numberWidth);
    if (unit) {
      const unitX = right ? width : stacked ? 0 : Math.min(numberWidth, context.measureText(text.data).width) + slot.gap;
      write(context, slot.unitFont, slot.unitText, unitX, slot.unitY, width);
    }
  }

  function refreshAll() {
    for (const slot of slots.values()) refresh(slot, slot.width, slot.height);
  }
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  // Moving between displays can change device scale at the same CSS width.
  window.addEventListener('resize', refreshAll);

  return function setText(element, value) {
    const slot = slots.get(element);
    if (slot) {
      if (slot.text.data !== value) {
        slot.text.data = value;
        paint(slot);
      }
    } else if (element.textContent !== value) {
      if (element.firstChild) element.firstChild.nodeValue = value;
      else element.textContent = value;
    }
  };
}
