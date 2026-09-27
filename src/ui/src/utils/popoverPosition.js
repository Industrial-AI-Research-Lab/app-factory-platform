const GUTTER = 8 // min space kept between the panel and any viewport edge
const GAP = 6 // space between the anchor and the panel

/**
 * Fixed-position coordinates for a popover anchored to a trigger button, given the
 * button's viewport rect. The panel is portaled to <body>, so it positions against
 * the viewport, not the (overflow-clipped) event row it visually belongs to.
 *
 * Right-aligns to the anchor, prefers opening below, and flips above only when the
 * panel would run past the bottom AND a measured height proves it fits above; with
 * no measured height (first pass, height 0) it stays below and a later pass corrects.
 */
export function computePopoverPosition(anchor, viewport, opts = {}) {
  const width = opts.width || 288
  const height = opts.height || 0
  const vw = viewport?.width || 0
  const vh = viewport?.height || 0

  let left = anchor.right - width
  const maxLeft = Math.max(GUTTER, vw - width - GUTTER)
  if (left < GUTTER) left = GUTTER
  else if (left > maxLeft) left = maxLeft

  let top = anchor.bottom + GAP
  if (height > 0 && top + height > vh - GUTTER) {
    const above = anchor.top - GAP - height
    top = above >= GUTTER ? above : Math.max(GUTTER, vh - GUTTER - height)
  }

  return { top: Math.round(top), left: Math.round(left) }
}
