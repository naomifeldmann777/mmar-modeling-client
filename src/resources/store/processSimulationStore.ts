import { create } from "zustand"; // the store library of this client
import type { SimulationGraph } from "@/resources/process-simulation/graph"; // what a run works on
import type { Step } from "@/resources/process-simulation/firing"; // what the user picks
import { startRun, takeStep, type Run } from "@/resources/process-simulation/stepper"; // the run itself (Phase 7)
import type { ValidationProblem } from "@/resources/process-simulation/validator"; // why a run did not start

/**
 * processSimulationStore — the state of the process-simulation stepper while it is open
 * (plan Phase 8).
 *
 * Why a store, while the concept mapping lives in localStorage: the mapping must survive a
 * reload and is read once, when the popup opens or a run starts. A run is the opposite: it
 * only lives while the stepper is open, must NOT survive a reload (the model may have changed
 * by then), and many parts of the client follow it at the same time: the stepper panel, the
 * highlighting in the 3D model and the right column (stepper panel instead of attribute
 * window). A Zustand store tells all of them at once when the run changes.
 *
 * Who writes it: `stepper-session.ts` (views/process-simulation) reads the open model, builds
 * the graph and calls `open`; the stepper panel calls `pick`, `restart` and `close`. Everyone
 * else only reads.
 *
 * Deliberately NOT here, like the client's historyStore: no engine, no MMAR, no three.js. The
 * store only holds the run and calls stepper.ts, so it is tested on its own. Everything with a
 * side effect (reading the model, locking it, highlighting) lives in views/process-simulation.
 */

interface ProcessSimulationState {
  active: boolean; // the stepper is open: its panel is shown and the model is locked
  sceneInstanceId: string | null; // the model the stepper was opened on, to notice a tab change
  run: Run | null; // the current run; null while the stepper is closed or the run could not start
  problems: ValidationProblem[]; // why the run could not start (spec 8, step 1); empty otherwise
  message: string | null; // a problem before the validator, e.g. the stored mapping could not be read

  /** Opens the stepper on `graph`: runs the validator and starts the run, or keeps the problems. */
  open: (sceneInstanceId: string, graph: SimulationGraph) => void;
  /** Opens the stepper with a message instead of a run, when not even a graph could be built. */
  openWithMessage: (sceneInstanceId: string, message: string) => void;
  /** Carries out the step the user picked; it must be one of `run.steps`. */
  pick: (step: Step) => void;
  /** Starts the run again from the beginning, on the same graph: the model is locked, so it has not changed. */
  restart: () => void;
  /** Closes the stepper ("Stop simulation"): no run, no panel, no lock. */
  close: () => void;
  /** Back to the as-loaded state (logout, see services/session-reset). */
  reset: () => void;
}

const CLOSED = { active: false, sceneInstanceId: null, run: null, problems: [], message: null }; // the state while the stepper is not open

export const useProcessSimulationStore = create<ProcessSimulationState>((set, get) => ({
  ...CLOSED, // closed until the user starts the stepper

  open: (sceneInstanceId, graph) => {
    const started = startRun(graph); // the validator first, then the run (spec 8, step 1)
    set({
      active: true, // the panel shows the run or the problems
      sceneInstanceId, // the model it belongs to
      run: started.ok ? started.run : null, // the run, if it may start
      problems: started.ok ? [] : started.problems, // otherwise what keeps it from starting
      message: null, // a message of an earlier attempt no longer applies
    });
  },

  openWithMessage: (sceneInstanceId, message) => set({ ...CLOSED, active: true, sceneInstanceId, message }), // the panel shows the message and "Stop simulation"

  pick: (step) => {
    const { run } = get(); // the run the user is looking at
    if (run) set({ run: takeStep(run, step) }); // the new run replaces the old one; takeStep refuses a step that is not possible
  },

  restart: () => {
    const { run } = get(); // restart is only offered while a run exists
    if (!run) return; // nothing to restart: the run never started
    const started = startRun(run.graph); // validates again: passes, since the graph is the same
    if (started.ok) set({ run: started.run }); // back to the token in front of the Start
  },

  close: () => set(CLOSED), // "Stop simulation"

  reset: () => set(CLOSED), // logout: nothing of the previous user's run may survive
}));
