/* Shared chart plumbing for the Weight and History views, so the two can't
   drift apart. Inline SVG throughout: no charting library, no dependency. */

export const DAY = 24 * 60 * 60 * 1000;

/* Surface-relative chart ink for the app's dark theme. The categorical series
   colours live with each chart, validated for how that chart uses them. */
export const INK = {
  grid: '#232a35',
  axis: '#2f3845',
  tick: '#898781',
  cross: '#5b6574',
  surface: '#0e1116',
};

export const escapeHTML = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

export function dayStart(t) {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function shortDate(t) {
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function longDate(t) {
  return new Date(t).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

/* A clean gridline step for a span of values. */
export function niceStep(span) {
  if (span <= 4) return 1;
  if (span <= 10) return 2;
  if (span <= 25) return 5;
  if (span <= 60) return 10;
  if (span <= 150) return 25;
  return 50;
}

/* Low and high bounds snapped to the step, with a little air either side.
   Deliberately NOT from zero: on a strength or bodyweight chart the change is
   the whole story, and zero would flatten it into a straight line. */
export function tightDomain(values, { air = 1 } = {}) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = niceStep(max - min + air * 2);
  return {
    lo: Math.floor((min - air) / step) * step,
    hi: Math.ceil((max + air) / step) * step,
    step,
  };
}

/* A rectangle rounded only at the top: the data end of a bar gets a 4px
   radius, the baseline stays square. */
export function roundedTopRect(x, y, w, h, r = 4) {
  const radius = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h} L${x},${y + radius} Q${x},${y} ${x + radius},${y}`
    + ` L${x + w - radius},${y} Q${x + w},${y} ${x + w},${y + radius}`
    + ` L${x + w},${y + h} Z`;
}

/* Horizontal gridlines with their tick labels on the left. */
export function yGrid({ lo, hi, step, y, left, right, format = (v) => String(v) }) {
  const out = [];
  for (let v = lo; v <= hi + 1e-9; v += step) {
    out.push(`
      <line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}"
            stroke="${INK.grid}" stroke-width="1"/>
      <text class="ch-tick" x="${left - 8}" y="${y(v) + 4}" text-anchor="end">${format(v)}</text>`);
  }
  return out.join('');
}
