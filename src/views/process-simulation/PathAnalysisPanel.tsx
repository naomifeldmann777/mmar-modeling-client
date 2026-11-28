/**
 * The path-analysis panel: settings, results and the selected path, in the right column
 * (Plan2 B2, spec 9 and 9.1).
 *
 * What it shows, from top to bottom:
 * - the settings: the number of runs (1000 proposed, at most MAX_RUNS), "Seed" with its
 *   "Value" to repeat an analysis exactly, and "Start";
 * - a note when the model was changed after the analysis, or why the analysis could not run;
 * - the summary: runs, expected execution and cycle time, runs that did not finish, the seed;
 * - the distribution of the execution or the cycle time over the finished runs: a chart
 *   (TimeDistributionChart), per value (a bar per value) or cumulative (steps, with the 90 %
 *   line), or how the mean converges as runs are added (ConvergenceChart, with its 95 %
 *   confidence band); the figures E with its confidence interval, σ, minimum, maximum and the
 *   90 % quantile, and the values as a table, folded away;
 * - the paths: number, probability, execution time, cycle time, sortable. A click on a path
 *   shows it in the model (path-highlight) and lists its elements below the table, the
 *   branches of a split indented and marked "*", as in BEE-UP (path-report);
 * - the executions per node, folded away since the list can be long;
 * - "Export CSV" and "Close".
 *
 * Who it talks to: it reads pathAnalysisStore; selecting and sorting go to the store, since
 * they only change what is shown. "Start", "Export CSV" and "Close" go to path-analysis-session,
 * since they read the model, download a file or stop watching the model.
 *
 * Path numbers are the order by probability (path 1 is the most probable, as in BEE-UP) and
 * stay with the path when the table is sorted otherwise.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react"; // the settings, the highlighting in step with the selection, the figures computed once per time
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Icon,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import type { SimulationGraph } from "@/resources/process-simulation/graph";
import { DEFAULT_RUNS, MAX_RUNS } from "@/resources/process-simulation/path-analysis"; // the proposed and the largest number of runs
import { convergence, pathLines, timeDistribution, type CompletedAnalysis, type TimeQuantity } from "@/resources/process-simulation/path-report"; // the element list of a path; the distribution of a time and how its mean converges
import { usePathAnalysisStore, type PathSort } from "@/resources/store/pathAnalysisStore";
import { clearPathHighlight, PATH_COLOUR, showPath } from "./path-highlight"; // the selected path in the 3D model, and its colour
import { closePathAnalysis, exportPathAnalysis, runPathAnalysis } from "./path-analysis-session"; // what touches the model or the browser
import ConvergenceChart from "./ConvergenceChart"; // how the mean settles over the runs
import TimeDistributionChart, { type DistributionView } from "./TimeDistributionChart"; // the distribution as a chart

export default function PathAnalysisPanel() {
  const graph = usePathAnalysisStore((s) => s.graph); // the model as analysed
  const result = usePathAnalysisStore((s) => s.result); // the paths, if an analysis ran
  const problems = usePathAnalysisStore((s) => s.problems); // why it could not run
  const message = usePathAnalysisStore((s) => s.message); // a problem before the validator
  const stale = usePathAnalysisStore((s) => s.stale); // the model changed since
  const selectedPath = usePathAnalysisStore((s) => s.selectedPath); // the path shown in the model
  const sort = usePathAnalysisStore((s) => s.sort); // the order of the table
  const select = usePathAnalysisStore((s) => s.select);
  const sortBy = usePathAnalysisStore((s) => s.sortBy);

  // The settings, as typed: checked on "Start".
  const [runs, setRuns] = useState(String(DEFAULT_RUNS)); // 1000 proposed
  const [seedOn, setSeedOn] = useState(false); // without a seed, a new one is chosen every time
  const [seed, setSeed] = useState(""); // the seed's value
  const runCount = Number(runs); // what the field says, as a number
  const runsValid = Number.isInteger(runCount) && runCount >= 1 && runCount <= MAX_RUNS; // a whole number in the allowed range
  const seedValid = !seedOn || /^\d+$/.test(seed.trim()); // a whole number of 0 or more, when a seed is wanted

  // The model shows the selected path, and nothing when there is none or the result is outdated.
  useEffect(() => {
    if (graph && result && selectedPath !== null) showPath(graph, result.paths[selectedPath]); // orange outlines and lines
    else clearPathHighlight();
    return () => clearPathHighlight(); // before the next path, and when the panel closes
  }, [graph, result, selectedPath]);

  const start = () => runPathAnalysis({ runs: runCount, seed: seedOn ? Number(seed.trim()) : undefined }); // the session reads the model as it is now

  return (
    <Stack spacing={1.5} sx={{ fontSize: "0.875rem" }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        Path Analysis
      </Typography>

      {/* Settings: runs and seed side by side, Start underneath */}
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "flex-start" }}>
            <TextField label="Runs" size="small" value={runs} onChange={(event) => setRuns(event.target.value)} error={!runsValid} helperText={`1 to ${MAX_RUNS}`} sx={{ flex: 1 }} />
            <Stack direction="row" sx={{ flex: 1, alignItems: "flex-start" }}>
              <FormControlLabel control={<Checkbox size="small" checked={seedOn} onChange={(event) => setSeedOn(event.target.checked)} />} label="Seed" sx={{ mt: 0.5, mr: 0.5 }} />
              <TextField label="Value" size="small" value={seed} onChange={(event) => setSeed(event.target.value)} disabled={!seedOn} error={!seedValid} helperText={seedOn ? "repeats an analysis" : " "} sx={{ flex: 1 }} />
            </Stack>
          </Stack>
          <Button variant="contained" size="small" fullWidth startIcon={<Icon>play_arrow</Icon>} onClick={start} disabled={!runsValid || !seedValid}>
            Start
          </Button>
        </Stack>
      </Paper>

      {/* Notes */}
      {stale && <Alert severity="warning">The model was changed after this analysis. Start it again to see the paths of the model as it is now.</Alert>}
      {message && <Alert severity="error">{message}</Alert>}
      {problems.length > 0 && (
        <Alert severity="error">
          The analysis cannot run. Correct these problems in the model, and start again:
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {problems.map((problem, index) => (
              <li key={index}>
                Check {problem.check}: {problem.message}
              </li>
            ))}
          </Box>
        </Alert>
      )}

      {graph && result && (
        <>
          <Summary result={result} />
          <Distribution result={result} />
          <PathTable result={result} sort={sort} selected={selectedPath} stale={stale} onSort={sortBy} onSelect={(index) => select(index === selectedPath ? null : index)} />
          {selectedPath !== null && <PathDetails graph={graph} result={result} index={selectedPath} />}
          <NodeExecutions graph={graph} result={result} />
        </>
      )}

      {/* Export and close */}
      <Stack direction="row" spacing={1}>
        {result && (
          <Button variant="outlined" size="small" startIcon={<Icon>download</Icon>} onClick={exportPathAnalysis}>
            Export CSV
          </Button>
        )}
        <Button variant="outlined" size="small" onClick={closePathAnalysis}>
          Close
        </Button>
      </Stack>
    </Stack>
  );
}

/** The figures of the whole analysis: the expected times and the runs as large figures, the rest in one line underneath. */
function Summary({ result }: { result: CompletedAnalysis }) {
  const figures: [string, string][] = [
    ["Expected ET", seconds(result.expectedExecutionTime)], // spec 9.1
    ["Expected CT", seconds(result.expectedCycleTime)],
    ["Runs", String(result.runs)],
  ];
  const notes = [`Seed ${result.seed}`, ...(result.aborted > 0 ? [`${result.aborted} aborted (step limit)`] : []), ...(result.noStep > 0 ? [`${result.noStep} without a further step`] : [])]; // the seed to repeat it; runs that formed no path, only when there are any
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" spacing={1}>
        {figures.map(([label, value]) => (
          <Box key={label} sx={{ flex: 1, textAlign: "center" }}>
            <Typography variant="h6" sx={{ lineHeight: 1.2 }}>
              {value}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {label}
            </Typography>
          </Box>
        ))}
      </Stack>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ textAlign: "center", mt: 0.5 }}>
        {notes.join(" · ")}
      </Typography>
    </Paper>
  );
}

/** How the chosen time spreads over the finished runs: the chart, its figures, and its values as a table. */
function Distribution({ result }: { result: CompletedAnalysis }) {
  const [quantity, setQuantity] = useState<TimeQuantity>("executionTime"); // ET first, as in the summary
  const [view, setView] = useState<DistributionView | "convergence">("perValue"); // the share of each value first; the others on request
  const distribution = useMemo(() => timeDistribution(result, quantity), [result, quantity]); // null when no run finished; sorting 100 000 runs once, not on every render
  const points = useMemo(() => convergence(result, quantity), [result, quantity]); // the mean after k runs
  const name = quantity === "executionTime" ? "execution time" : "cycle time"; // for the chart's description
  const figures: [string, string][] = distribution
    ? [
        [distribution.halfWidth95 === null ? "E" : `E ± ${seconds(distribution.halfWidth95)}`, seconds(distribution.mean)], // the expected value, as in the summary, and how sure it is
        ["σ", seconds(distribution.standardDeviation)], // the standard deviation; the variance is its square, in s²
        ["Min", seconds(distribution.minimum)],
        ["Max", seconds(distribution.maximum)],
        ["90 %", seconds(distribution.quantile90)], // 90 % of the runs took this long or less
      ]
    : [];
  return (
    <Section title="Distribution over the runs">
      <ToggleButtonGroup size="small" exclusive value={quantity} onChange={(_, value: TimeQuantity | null) => value && setQuantity(value)} sx={{ my: 0.5 }} /* null: the chosen one was clicked again, which keeps it */>
        <ToggleButton value="executionTime" sx={{ textTransform: "none" }} /* written out: "ET" and "CT" already sort the path table */>Execution time</ToggleButton>
        <ToggleButton value="cycleTime" sx={{ textTransform: "none" }}>Cycle time</ToggleButton>
      </ToggleButtonGroup>
      <ToggleButtonGroup size="small" exclusive value={view} onChange={(_, value: DistributionView | "convergence" | null) => value && setView(value)} sx={{ my: 0.5, ml: 1 }}>
        <ToggleButton value="perValue" sx={{ textTransform: "none" }}>Per value</ToggleButton>
        <ToggleButton value="cumulative" sx={{ textTransform: "none" }}>Cumulative</ToggleButton>
        <ToggleButton value="convergence" sx={{ textTransform: "none" }}>Convergence</ToggleButton>
      </ToggleButtonGroup>
      {distribution === null ? (
        <Typography variant="body2">No run reached an End element.</Typography>
      ) : (
        <Paper variant="outlined" sx={{ p: 1 }}>
          {view === "convergence" ? <ConvergenceChart points={points} name={name} /> : <TimeDistributionChart distribution={distribution} name={name} view={view} />}
          <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
            {figures.map(([label, value]) => (
              <Box key={label} sx={{ flex: 1, textAlign: "center" }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {value}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {label}
                </Typography>
              </Box>
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
            Over the {distribution.runs} finished runs.{distribution.halfWidth95 === null ? "" : " ±: the 95 % confidence interval of E; more runs make it narrower."} σ: how far the times lie from E on average. 90 %: nine in ten runs took this long or less.
            {distribution.grouped ? " More than 30 different times: grouped into 20 classes of equal width." : ""}
          </Typography>
          <Accordion disableGutters variant="outlined" slotProps={{ transition: { unmountOnExit: true } }} sx={{ mt: 1 }} /* the table view: every value without hovering */>
            <AccordionSummary>
              <Typography variant="subtitle2">Values as a table</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{distribution.grouped ? "From – to" : "Time"}</TableCell>
                    <TableCell align="right">Runs</TableCell>
                    <TableCell align="right">Share</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {distribution.entries.map((entry) => (
                    <TableRow key={entry.from}>
                      <TableCell>{entry.from === entry.to ? seconds(entry.from) : `${seconds(entry.from)} – ${seconds(entry.to)}`}</TableCell>
                      <TableCell align="right">{entry.runs}</TableCell>
                      <TableCell align="right">{percent(entry.share)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </AccordionDetails>
          </Accordion>
        </Paper>
      )}
    </Section>
  );
}

/** The paths, one row each, sortable; a click shows a path in the model. */
function PathTable(props: { result: CompletedAnalysis; sort: PathSort; selected: number | null; stale: boolean; onSort: (sort: PathSort) => void; onSelect: (index: number) => void }) {
  const { result, sort, selected, stale, onSort, onSelect } = props;
  const order = [...result.paths.keys()].sort((a, b) => result.paths[b][sort] - result.paths[a][sort]); // indices, descending by the criterion; ties keep the order by probability
  const header = (key: PathSort, label: string) => (
    <TableCell align="right">
      <TableSortLabel active={sort === key} direction="desc" onClick={() => onSort(key)}>
        {label}
      </TableSortLabel>
    </TableCell>
  );
  return (
    <Section title={`Paths (${result.paths.length})`}>
      {result.paths.length === 0 ? (
        <Typography variant="body2">No run reached an End element.</Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ pl: 1.375 }}>Path</TableCell>
              {header("probability", "Probability")}
              {header("executionTime", "ET")}
              {header("cycleTime", "CT")}
            </TableRow>
          </TableHead>
          <TableBody>
            {order.map((index) => (
              <TableRow
                key={index}
                hover={!stale}
                selected={selected === index}
                onClick={() => !stale && onSelect(index)} // an outdated path is not shown in the model
                sx={{ cursor: stale ? "default" : "pointer", "&.Mui-selected, &.Mui-selected:hover": { bgcolor: `${PATH_COLOUR}26` } }} // the selected path tinted in the colour it has in the model (26: about 15 % opacity)
              >
                <TableCell sx={{ pl: 1, borderLeft: `3px solid ${selected === index ? PATH_COLOUR : "transparent"}` }}>{index + 1}</TableCell>
                <TableCell align="right">{percent(result.paths[index].probability)}</TableCell>
                <TableCell align="right">{seconds(result.paths[index].executionTime)}</TableCell>
                <TableCell align="right">{seconds(result.paths[index].cycleTime)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Typography variant="caption" color="text.secondary">
        ET: execution time, the work of all executed elements. CT: cycle time, from the start to the end.{stale ? "" : " Click a path to show it in the model."}
      </Typography>
    </Section>
  );
}

/** The elements of the selected path, as BEE-UP lists them. */
function PathDetails({ graph, result, index }: { graph: SimulationGraph; result: CompletedAnalysis; index: number }) {
  const path = result.paths[index]; // the selected path
  return (
    <Box sx={{ borderLeft: `3px solid ${PATH_COLOUR}`, pl: 1.5 }}>
      <Typography variant="subtitle2">{`Path ${index + 1}`}</Typography>
      <Typography variant="body2">
        Probability {percent(path.probability)} ({path.count} of {result.runs} runs) · ET {seconds(path.executionTime)} · CT {seconds(path.cycleTime)}
      </Typography>
      <Box sx={{ fontSize: "0.8125rem", mt: 0.5 }}>
        {pathLines(graph, path.trace).map((line, lineIndex) => (
          <Box key={lineIndex} sx={{ pl: line.depth * 2 }}>
            {line.branchStart && <Box>*</Box>}
            {line.text}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** How often each node ran, folded away. */
function NodeExecutions({ graph, result }: { graph: SimulationGraph; result: CompletedAnalysis }) {
  const rows = Object.entries(result.nodeExecutions).sort(([, a], [, b]) => b - a); // the most executed first
  return (
    <Accordion disableGutters variant="outlined">
      <AccordionSummary>
        <Typography variant="subtitle2">Executions per node</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ p: 0 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Node</TableCell>
              <TableCell align="right">Executions</TableCell>
              <TableCell align="right">Per run</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(([nodeId, count]) => (
              <TableRow key={nodeId}>
                <TableCell>{`${graph.nodes[nodeId].concept} "${graph.nodes[nodeId].label}"`}</TableCell>
                <TableCell align="right">{count}</TableCell>
                <TableCell align="right">{(count / result.runs).toFixed(2)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </AccordionDetails>
    </Accordion>
  );
}

/** A titled part of the panel, as in the stepper panel. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="subtitle2">{title}</Typography>
      {children}
    </Box>
  );
}

/** A probability as a percentage with two decimals, e.g. 79.60 %. */
function percent(probability: number): string {
  return `${(probability * 100).toFixed(2)} %`;
}

/** A time in seconds, rounded to two decimals; "–" when there is none. */
function seconds(value: number | null): string {
  return value === null ? "–" : `${Math.round(value * 100) / 100} s`;
}
