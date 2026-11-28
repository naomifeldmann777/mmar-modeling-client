/**
 * How the mean of a time settles as the runs of a path analysis are added: a line, the mean of
 * the first k finished runs over k; a band around it, the 95 % confidence interval of that
 * mean, from 30 runs on; and a line at the final mean E. Early the line jumps and the band is
 * wide; once there are enough runs, the line lies still inside a narrow band. So the chart
 * answers "were there enough runs?".
 *
 * The runs axis is logarithmic: 1, 10, 100, 1000, … lie equally far apart. On a linear axis to
 * 100 000 the first thousand runs, where the mean still moves, would take one hundredth of the
 * width; here every tenfold of runs gets the same room. The data are the same either way.
 *
 * A line is right here, unlike for the distribution: there is a mean for every k, and nothing
 * between two k exists that the line could invent.
 *
 * Used by: PathAnalysisPanel, as the "Convergence" view of the distribution section. The
 * points come from `convergence` in path-report.ts (at most 400, so 100 000 runs draw fast).
 *
 * Deliberately NOT here: no statistics, no hovering or clicking (as for the distribution chart:
 * the figures and the table give the numbers), no chart library, no colour of its own.
 */
import { Box, Typography, useTheme } from "@mui/material";
import type { ConvergencePoint } from "@/resources/process-simulation/path-report"; // what is drawn
import { formatNumber, niceTicks } from "./chart-scale"; // clean axis numbers, as in the distribution chart

const WIDTH = 320; // the drawing's own units; it is scaled to the width of the panel
const HEIGHT = 150;
const MARGIN = { top: 10, right: 14, bottom: 22, left: 44 }; // room for times such as "4000 s" on the left, runs below, "E" on the right
const PLOT_BOTTOM = HEIGHT - MARGIN.bottom; // the lower edge of the plot

export default function ConvergenceChart({ points, name }: { points: ConvergencePoint[]; name: string }) {
  const theme = useTheme(); // the client's colours, light or dark
  const last = points[points.length - 1]; // after all runs: its mean is E
  const right = WIDTH - MARGIN.right; // where the plot ends

  // Runs axis, logarithmic: from the first run to the last.
  const runsMax = Math.max(2, last.runs); // a single run still needs an axis (log 1 = 0)
  const x = (runs: number) => MARGIN.left + (Math.log10(runs) / Math.log10(runsMax)) * (right - MARGIN.left);
  const runTicks = Array.from({ length: Math.floor(Math.log10(runsMax)) + 1 }, (_, power) => 10 ** power); // 1, 10, 100, … up to the last run

  // Time axis: every mean and every band edge fits, with a little room above and below.
  const values = points.flatMap((point) => (point.halfWidth === null ? [point.mean] : [point.mean - point.halfWidth, point.mean + point.halfWidth])); // what must be visible
  const lowest = Math.min(...values);
  const highest = Math.max(...values);
  const pad = highest > lowest ? (highest - lowest) * 0.06 : Math.max(1, Math.abs(lowest) * 0.1); // a flat line still needs room
  const y = (time: number) => PLOT_BOTTOM - ((time - (lowest - pad)) / (highest - lowest + 2 * pad)) * (PLOT_BOTTOM - MARGIN.top);
  const timeTicks = niceTicks(lowest - pad, highest + pad, 3).filter((tick) => tick >= lowest - pad && tick <= highest + pad); // clean numbers inside the axis

  const ink = theme.palette.text.secondary; // axis text and the E line wear text colours, never the data colour
  const grid = theme.palette.divider; // hairlines, recessive
  const mark = theme.palette.primary.main; // the one series

  // The line through the means, and the band: along its upper edge, then back along its lower one.
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"} ${x(point.runs)} ${y(point.mean)}`).join(" ");
  const banded = points.filter((point) => point.halfWidth !== null); // from 30 runs on
  const band = banded.length < 2 ? null : [...banded.map((point, index) => `${index === 0 ? "M" : "L"} ${x(point.runs)} ${y(point.mean + point.halfWidth!)}`), ...[...banded].reverse().map((point) => `L ${x(point.runs)} ${y(point.mean - point.halfWidth!)}`), "Z"].join(" "); // `!`: filtered above

  return (
    <Box>
      <Box
        component="svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Mean ${name} over the number of runs, with its 95 % confidence interval`}
        sx={{ width: "100%", display: "block", fontSize: 10, fontVariantNumeric: "tabular-nums" }}
      >
        {/* Time gridlines and ticks */}
        {timeTicks.map((tick) => (
          <g key={tick}>
            <line x1={MARGIN.left} x2={right} y1={y(tick)} y2={y(tick)} stroke={grid} strokeWidth={1} />
            <text x={MARGIN.left - 4} y={y(tick)} dy="0.32em" textAnchor="end" fill={ink}>
              {formatNumber(tick)} s
            </text>
          </g>
        ))}

        {/* Runs ticks */}
        {runTicks.map((tick) => (
          <text key={tick} x={x(tick)} y={PLOT_BOTTOM + 14} textAnchor="middle" fill={ink}>
            {formatRuns(tick)}
          </text>
        ))}

        {/* The band, a wash under the line; the final mean E, labelled in the right margin */}
        {band && <path d={band} fill={mark} fillOpacity={0.3} stroke="none" /* 30 %: visible also with a light theme colour, yet the line stays in front */ />}
        <line x1={MARGIN.left} x2={right} y1={y(last.mean)} y2={y(last.mean)} stroke={ink} strokeWidth={1} />
        <text x={right + 3} y={y(last.mean)} dy="0.32em" fill={ink}>
          E
        </text>

        {/* The mean so far */}
        <path d={line} fill="none" stroke={mark} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* Axis line below */}
        <line x1={MARGIN.left} x2={right} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} stroke={ink} strokeWidth={1} />
      </Box>
      <Typography variant="caption" color="text.secondary" component="div">
        The mean {name} of the first k runs, on a logarithmic axis (1, 10, 100, … equally far apart). The band is its 95 % confidence interval, from 30 runs on: it narrows as runs are added, and the true expected value lies inside it with 95 % confidence.
      </Typography>
    </Box>
  );
}

/** A number of runs for the axis: in full below 10 000, then in thousands, e.g. 50k. */
function formatRuns(runs: number): string {
  return runs < 10000 ? String(runs) : `${formatNumber(runs / 1000)}k`;
}
