/**
 * The stepper panel: shows one run of the process simulation in the right column and lets
 * the user advance it step by step (plan Phase 8, spec 8).
 *
 * What it shows, from top to bottom:
 * - where the run stands: choose the next step, the run is over, no further step is
 *   possible, or why the run cannot start (the validator's problems, spec 8 step 1);
 * - the possible steps as buttons, one per step (Phase 7: the user confirms even a single
 *   step). Where a value is drawn, the button names it with its probability, which is shown
 *   for information only (spec 8); at a Decision or OR-Split it names where the token goes;
 * - the values of the variables, the flows that carry a token, and the trace of executed
 *   nodes;
 * - "Restart" (from the beginning) and "Stop simulation" (closes the panel, unlocks the model).
 *
 * Who it talks to: it reads processSimulationStore; a step button calls `pick`, "Restart"
 * calls `restart`, both in the store, since they only compute with the graph. "Stop
 * simulation" calls `stopStepper` (stepper-session), since it also unlocks the model. While
 * it is shown, it keeps the highlighting in the 3D model up to date (stepper-highlight).
 *
 * RightNav shows it instead of the attribute window while the stepper is open; it is started
 * from the menu "Process Simulation → Stepper".
 */
import { useEffect, type ReactNode } from "react"; // to keep the 3D highlighting in step with the run
import { Alert, Box, Button, Stack, Table, TableBody, TableCell, TableRow, Typography } from "@mui/material";
import type { Step } from "@/resources/process-simulation/firing";
import type { SimulationGraph } from "@/resources/process-simulation/graph";
import { runStatus } from "@/resources/process-simulation/stepper";
import { useProcessSimulationStore } from "@/resources/store/processSimulationStore";
import { clearHighlights, showHighlights } from "./stepper-highlight"; // boxes, colours and labels in the 3D model
import { stopStepper } from "./stepper-session"; // closes the store and unlocks the model

export default function StepperPanel() {
  const run = useProcessSimulationStore((s) => s.run); // re-renders after every step
  const problems = useProcessSimulationStore((s) => s.problems); // why the run could not start
  const message = useProcessSimulationStore((s) => s.message); // a problem before the validator
  const pick = useProcessSimulationStore((s) => s.pick); // carries out a step
  const restart = useProcessSimulationStore((s) => s.restart); // back to the beginning

  // The 3D model shows the same state as the panel: redrawn after every step, removed when
  // the panel goes (stop, tab change, logout).
  useEffect(() => {
    if (run) showHighlights(run); // nodes that can run, the last one that ran, tokens, drawn values
    return () => clearHighlights(); // before the next drawing, and when the panel unmounts
  }, [run]);

  const status = run ? runStatus(run) : null; // null: there is no run to show
  const variables = run ? variableRows(run.graph, run.state.values) : []; // name -> value, for the table

  return (
    <Stack spacing={1.5} sx={{ fontSize: "0.875rem" }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        Process Simulation
      </Typography>

      {/* Where the run stands, or why there is none */}
      {message && <Alert severity="error">{message}</Alert>}
      {problems.length > 0 && (
        <Alert severity="error">
          The run cannot start. Stop the simulation, correct these problems in the model or the concept mapping, and start again:
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {problems.map((problem, index) => (
              <li key={index}>
                Check {problem.check}: {problem.message}
              </li>
            ))}
          </Box>
        </Alert>
      )}
      {status === "running" && <Alert severity="info">{run!.steps.length === 1 ? "Confirm the next step." : "Choose the next step."}</Alert>}
      {status === "finished" && <Alert severity="success">The run is over.</Alert>}
      {status === "noStep" && <Alert severity="warning">No further step is possible.</Alert>}

      {/* The possible steps, one button each */}
      {run && run.steps.length > 0 && (
        <Stack spacing={0.5}>
          {run.steps.map((step, index) => (
            <Button key={index} variant="outlined" size="small" onClick={() => pick(step)} sx={{ justifyContent: "flex-start", textTransform: "none", textAlign: "left" }}>
              {describeStep(run.graph, step)}
            </Button>
          ))}
        </Stack>
      )}

      {/* The state of the run: values, tokens, trace */}
      {run && (
        <>
          <Section title="Variables">
            {variables.length === 0 ? (
              <Typography variant="body2">The model has no variables.</Typography>
            ) : (
              <Table size="small">
                <TableBody>
                  {variables.map(([name, value]) => (
                    <TableRow key={name}>
                      <TableCell sx={{ pl: 0 }}>{name}</TableCell>
                      <TableCell>{value ?? "not drawn yet"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>

          <Section title="Tokens">
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {run.state.sourceToken && <li>in front of the Start</li>}
              {Object.entries(run.state.tokens).map(([flowId, count]) => (
                <li key={flowId}>
                  {describeFlow(run.graph, flowId)}
                  {count > 1 ? ` (${count} tokens)` : ""}
                </li>
              ))}
              {!run.state.sourceToken && Object.keys(run.state.tokens).length === 0 && <li>none</li>}
            </Box>
          </Section>

          <Section title="Trace">
            {run.state.trace.length === 0 ? (
              <Typography variant="body2">Nothing has run yet.</Typography>
            ) : (
              <Box component="ol" sx={{ m: 0, pl: 3 }}>
                {run.state.trace.map((nodeId, index) => (
                  <li key={index}>{describeNode(run.graph, nodeId)}</li>
                ))}
              </Box>
            )}
          </Section>
        </>
      )}

      {/* Restart and stop */}
      <Stack direction="row" spacing={1}>
        {run && (
          <Button variant="outlined" size="small" onClick={restart}>
            Restart
          </Button>
        )}
        <Button variant="contained" color="error" size="small" onClick={stopStepper}>
          Stop simulation
        </Button>
      </Stack>
    </Stack>
  );
}

/** A titled part of the panel. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="subtitle2">{title}</Typography>
      {children}
    </Box>
  );
}

/**
 * The text of a step button. Examples:
 *   Activity "Check stock": lager = ja (80 %)
 *   Decision "In stock?" → Ship
 *   OR-Split "Extras" → Gift wrap, Card
 */
function describeStep(graph: SimulationGraph, step: Step): string {
  const node = graph.nodes[step.node]; // the node the step runs
  const draws = step.draws.map((draw) => `${draw.variableName} = ${draw.value}${draw.probability === null ? "" : ` (${Math.round(draw.probability * 1000) / 10} %)`}`); // the probability is information only (spec 8)
  const where = node.concept === "Decision" || node.concept === "OR-Split" ? ` → ${step.produces.map((flowId) => graph.nodes[graph.flows[flowId].target ?? ""]?.label ?? "?").join(", ")}` : ""; // where the token goes follows from the values
  return `${describeNode(graph, step.node)}${draws.length > 0 ? `: ${draws.join(", ")}` : ""}${where}`;
}

/** A node as the user reads it, e.g. Activity "Check stock". */
function describeNode(graph: SimulationGraph, nodeId: string): string {
  const node = graph.nodes[nodeId]; // always present: steps and the trace only hold nodes of the graph
  return `${node.concept} "${node.label}"`;
}

/** A flow as the user reads it, e.g. "Name" (Check stock → In stock?): flows are rarely named. */
function describeFlow(graph: SimulationGraph, flowId: string): string {
  const flow = graph.flows[flowId]; // a flow that carries a token
  const end = (nodeId: string | null) => (nodeId ? (graph.nodes[nodeId]?.label ?? "?") : "?"); // the name of one end
  return `"${flow.label}" (${end(flow.source)} → ${end(flow.target)})`;
}

/** Every named variable of the model with its value; undefined while it has not been drawn. */
function variableRows(graph: SimulationGraph, values: Readonly<Record<string, string>>): [string, string | undefined][] {
  const names = [...new Set(Object.values(graph.variables).map((variable) => variable.name).filter((name): name is string => !!name))]; // by name, as conditions use them
  return names.sort().map((name) => [name, Object.hasOwn(values, name) ? values[name] : undefined]); // alphabetical, so the table does not jump around
}
