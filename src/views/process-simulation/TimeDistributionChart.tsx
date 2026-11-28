/**
 * The distribution of a time over the finished runs of a path analysis, as a chart, in one of
 * two views:
 * - "perValue": one bar per value that occurred, as tall as its share of the runs; when the
 *   values are grouped into classes (path-report.ts), one bar per class (a histogram). The chart
 *   also groups them itself when single bars would be thinner than MIN_BAR, e.g. because two
 *   times lie close together on a long axis, and says so below the chart; the table still lists
 *   every time. So one model looks the same with 1000 runs as with 100 000. A thin line marks
 *   the expected value E.
 * - "cumulative": a step line, the share of the runs that took a time or less; a dashed line at
 *   90 % meets it at the 90 % quantile, which is written next to it ("90 % finish within 40 s"),
 *   where the steps cannot cover it (see quantileLabel).
 *
 * Why bars and steps, and never a line through the values: with fixed execution times a time
 * takes only a few values, one per path. A line from 6 s to 65 s would show times in between
 * that no run ever took. The step line is flat between two values, so it shows none either.
 *
 * Used by: PathAnalysisPanel, which passes the distribution of the chosen time and the view, and
 * shows the figures (E, σ, …) and the table view next to it.
 *
 * Deliberately NOT here:
 * - No statistics (timeDistribution in path-report.ts computes them).
 * - No chart library (plain SVG, no new dependency), no colour of its own (the client's theme,
 *   so a dark theme is followed).
 * - No hovering, no clicking and no numbers on the bars (decided with the user): every value
 *   and share is in the panel's table view.
 */
import { Box, Typography, useTheme } from "@mui/material";
import { formatShare, groupIntoClasses, type TimeDistribution } from "@/resources/process-simulation/path-report"; // the share axis' ticks, e.g. 50 %; classes when bars would be too thin

/** Which view of the distribution is drawn (see the top of the file). */
export type DistributionView = "perValue" | "cumulative";

const WIDTH = 320; // the drawing's own units; it is scaled to the width of the panel
const HEIGHT = 150;
const MARGIN = { top: 18, right: 12, bottom: 22, left: 36 }; // room for the share ticks on the left, the time ticks below, labels on top
const PLOT_BOTTOM = HEIGHT - MARGIN.bottom; // the baseline
const MAX_BAR = 24; // a bar is never wider; narrower when two values lie close together
const MIN_BAR = 6; // a single bar thinner than this cannot be read: the values are drawn as classes instead
const MIN_HEIGHT = 2; // a share too small to see still shows as a sliver; its share is in the table
const CHAR_WIDTH = 5.6; // about how wide a character of the 10-unit text is, a little more rather than less, to judge where a label fits

export default function TimeDistributionChart({ distribution, name, view }: { distribution: TimeDistribution; name: string; view: DistributionView }) {
  const theme = useTheme(); // the client's colours, light or dark
  const { mean, cumulative, quantile90 } = distribution;

  // Time axis: from the first to the last value, with a little room on both sides.
  const low = distribution.entries[0].from; // ascending
  const high = distribution.entries[distribution.entries.length - 1].to;
  const pad = high > low ? (high - low) * 0.06 : Math.max(1, low * 0.1); // a single value still needs room on both sides
  const x = (time: number) => MARGIN.left + ((time - (low - pad)) / (high - low + 2 * pad)) * (WIDTH - MARGIN.left - MARGIN.right);

  // Per value: how wide a single bar may be without touching its neighbour; classes when that is too thin.
  const values = distribution.entries; // single values, or classes already (more than 30 values)
  const gaps = values.slice(1).map((entry, index) => x(entry.from) - x(values[index].from)); // between neighbouring values
  const barWidth = Math.min(MAX_BAR, ...gaps.map((gap) => gap - 2)); // a 2 px gap between neighbours
  const crowded = !distribution.grouped && barWidth < MIN_BAR; // single bars would be too thin to see
  const entries = crowded ? groupIntoClasses(values) : values; // what is drawn
  const grouped = distribution.grouped || crowded; // classes, either way
  const timeTicks = niceTicks(low - pad, high + pad, 4).filter((tick) => tick >= low - pad && tick <= high + pad); // clean numbers inside the axis

  // Share axis: per value from 0 to a clean number above the largest share; cumulative always to 100 %.
  const top = view === "cumulative" ? 1 : niceCeiling(Math.max(...entries.map((entry) => entry.share))); // e.g. a largest share of 0.8 gives an axis to 100 %, 0.3 one to 50 %
  const y = (share: number) => PLOT_BOTTOM - (share / top) * (PLOT_BOTTOM - MARGIN.top);
  const shareTicks = [0, top / 2, top]; // three are enough in a narrow panel

  const ink = theme.palette.text.secondary; // axis text and reference lines wear text colours, never the data colour
  const grid = theme.palette.divider; // hairlines, recessive
  const mark = theme.palette.primary.main; // the one series
  const surface = theme.palette.background.paper; // the ring around the 90 % dot

  const barTop = (share: number) => Math.min(y(share), PLOT_BOTTOM - MIN_HEIGHT); // at least a sliver

  // Cumulative: the step line, flat after each value up to the next one, rising at each value.
  const left = x(low - pad); // where the axis begins
  const right = WIDTH - MARGIN.right; // where it ends
  const stepPath = [`M ${left} ${y(0)}`, ...cumulative.flatMap((step) => [`H ${x(step.time)}`, `V ${y(step.share)}`]), `H ${right}`].join(" "); // 0 before the first value, 100 % after the last
  const quantileShare = cumulative.find((step) => step.time === quantile90)?.share ?? 0.9; // where the 90 % line meets the steps: the quantile is always one of the times
  const label = quantileLabel(quantile90, x(quantile90) - MARGIN.left, right - x(quantile90)); // where its text has room

  return (
    <Box>
      <Box
        component="svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${view === "cumulative" ? "Cumulative distribution" : "Distribution"} of the ${name} over the finished runs`}
        sx={{ width: "100%", display: "block", fontSize: 10, fontVariantNumeric: "tabular-nums" }}
      >
        {/* Share gridlines and ticks */}
        {shareTicks.map((tick) => (
          <g key={tick}>
            <line x1={MARGIN.left} x2={right} y1={y(tick)} y2={y(tick)} stroke={grid} strokeWidth={1} />
            <text x={MARGIN.left - 4} y={y(tick)} dy="0.32em" textAnchor="end" fill={ink}>
              {formatShare(tick)}
            </text>
          </g>
        ))}

        {/* Time ticks */}
        {timeTicks.map((tick) => (
          <text key={tick} x={x(tick)} y={PLOT_BOTTOM + 14} textAnchor="middle" fill={ink}>
            {formatNumber(tick)} s
          </text>
        ))}

        {view === "perValue" ? (
          <>
            {/* The expected value */}
            <line x1={x(mean)} x2={x(mean)} y1={MARGIN.top - 2} y2={PLOT_BOTTOM} stroke={ink} strokeWidth={1} />
            <text x={x(mean)} y={MARGIN.top - 6} textAnchor="middle" fill={ink}>
              E
            </text>

            {/* A bar per value, or per class with a 2 px gap between neighbours */}
            {entries.map((entry, index) => {
              if (entry.runs === 0) return null; // an empty class draws nothing
              const barLeft = grouped ? x(entry.from) + 1 : x(entry.from) - barWidth / 2; // a class spans its range; a value's bar is centred on it
              const barRight = grouped ? x(entry.to) - 1 : x(entry.from) + barWidth / 2;
              return <path key={index} d={barPath(barLeft, barRight, barTop(entry.share))} fill={mark} />;
            })}

          </>
        ) : (
          <>
            {/* The 90 % line, down to the quantile, and what it says */}
            <line x1={MARGIN.left} x2={right} y1={y(0.9)} y2={y(0.9)} stroke={ink} strokeWidth={1} strokeDasharray="4 3" />
            <line x1={x(quantile90)} x2={x(quantile90)} y1={y(quantileShare)} y2={PLOT_BOTTOM} stroke={ink} strokeWidth={1} strokeDasharray="4 3" />
            <text x={label.above ? x(quantile90) - LABEL_GAP : x(quantile90) + LABEL_GAP} y={label.above ? y(0.9) - 3 : y(0.9) + 11} textAnchor={label.above ? "end" : "start"} fill={ink}>
              {label.text}
            </text>

            {/* The steps, and the point where the 90 % line meets them */}
            <path d={stepPath} fill="none" stroke={mark} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(quantile90)} cy={y(quantileShare)} r={4} fill={mark} stroke={surface} strokeWidth={2} />
          </>
        )}

        {/* Baseline, drawn over the bars' feet */}
        <line x1={MARGIN.left} x2={right} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} stroke={ink} strokeWidth={1} />
      </Box>
      {crowded && view === "perValue" && (
        <Typography variant="caption" color="text.secondary" component="div">
          Some times lie too close together for a bar each, so the bars show classes of equal width; the table lists every time.
        </Typography>
      )}
    </Box>
  );
}

const LABEL_GAP = 8; // between the label and the quantile's vertical line, clear of its dot

/**
 * Where "90 % finish within …" goes, so the steps never cover it. Two places are always free:
 * - left of the quantile, above the 90 % line: before the quantile fewer than 90 % are done, so
 *   the steps run below the line there (`above`, ending just before the quantile);
 * - right of the quantile, below the line: from the quantile on 90 % or more are done, so the
 *   steps run above it (starting just after the quantile).
 * The full text goes where it has room, left first; otherwise the short "90 %: 1275 s", which
 * always fits on the wider side. `roomLeft` and `roomRight` are the widths on either side.
 */
function quantileLabel(quantile: number, roomLeft: number, roomRight: number): { text: string; above: boolean } {
  const texts = [`90 % finish within ${formatNumber(quantile)} s`, `90 %: ${formatNumber(quantile)} s`]; // full, then short
  const fits = (text: string, room: number) => text.length * CHAR_WIDTH + LABEL_GAP <= room; // its estimated width, with the gap
  for (const text of texts) {
    if (fits(text, roomLeft)) return { text, above: true };
    if (fits(text, roomRight)) return { text, above: false };
  }
  return { text: texts[1], above: roomLeft >= roomRight }; // a very narrow chart: the short text on the wider side
}

/** A number with at most two decimals, e.g. 52.5 or 6, for the time ticks. */
function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** The top of the share axis: the smallest of 1, 2, 2.5, 5 × a power of ten that reaches `value`. */
function niceCeiling(value: number): number {
  if (value <= 0) return 1; // no share at all: any axis will do
  const power = 10 ** Math.floor(Math.log10(value)); // e.g. 0.1 for 0.6
  return [1, 2, 2.5, 5, 10].map((step) => step * power).find((candidate) => candidate >= value - 1e-12)!; // e.g. 0.3: 0.1, 0.2, 0.25 are too small, 0.5 reaches it; the tolerance keeps 0.2 at 0.2
}

/** About `count` clean ticks from `low` to `high`: multiples of 1, 2 or 5 × a power of ten. */
function niceTicks(low: number, high: number, count: number): number[] {
  const rough = (high - low) / count; // the step if any number would do
  const power = 10 ** Math.floor(Math.log10(rough)); // its order of magnitude
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough)!; // the next clean step
  const ticks: number[] = [];
  for (let tick = Math.ceil(low / step) * step; tick <= high + 1e-9; tick += step) ticks.push(Math.round(tick * 1e9) / 1e9); // rounded, so 0.1 + 0.2 shows as 0.3
  return ticks;
}

/** A bar from `left` to `right`, up to `topY`, its top corners rounded by up to 4 px and square at the baseline. */
function barPath(left: number, right: number, topY: number): string {
  const width = Math.max(1, right - left); // a bar is never thinner than a pixel
  const radius = Math.min(4, width / 2, PLOT_BOTTOM - topY); // a low or narrow bar gets smaller corners
  return `M ${left} ${PLOT_BOTTOM} V ${topY + radius} Q ${left} ${topY} ${left + radius} ${topY} H ${left + width - radius} Q ${left + width} ${topY} ${left + width} ${topY + radius} V ${PLOT_BOTTOM} Z`;
}
