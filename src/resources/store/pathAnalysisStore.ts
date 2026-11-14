import { create } from "zustand";
import type { SimulationGraph } from "@/resources/process-simulation/graph"; // the model the result belongs to, for names and conditions
import type { PathAnalysisResult } from "@/resources/process-simulation/path-analysis"; // what an analysis returns
import type { CompletedAnalysis } from "@/resources/process-simulation/path-report"; // a result that ran
import type { ValidationProblem } from "@/resources/process-simulation/validator"; // why an analysis could not run

/**
 * pathAnalysisStore — the state of the path-analysis panel while it is open (Plan2 B2).
 *
 * Why a store: the panel, the highlighting in the 3D model and the right column all follow
 * the same result, and the session (path-analysis-session) changes it from outside the panel,
 * e.g. when the model changes after the analysis.
 *
 * Who writes it: `path-analysis-session.ts` opens and closes it, shows a result or a message,
 * and marks the result outdated; the panel selects a path and sorts the table. Everyone else
 * only reads.
 *
 * Deliberately NOT here, as in processSimulationStore: no engine, no MMAR, no three.js, and
 * no computing. The analysis runs in the session; the store only holds what it returned.
 */

/** What the path table is sorted by, descending as in BEE-UP. */
export type PathSort = "probability" | "executionTime" | "cycleTime";

interface PathAnalysisState {
  active: boolean; // the panel is open
  sceneInstanceId: string | null; // the model it was opened on, to notice a tab change
  graph: SimulationGraph | null; // the model as analysed, for names and conditions in the panel
  result: CompletedAnalysis | null; // the last analysis that ran; null before the first or after a refusal
  problems: ValidationProblem[]; // why the last analysis could not run (spec 10); empty otherwise
  message: string | null; // a problem before the validator, e.g. the model's metamodel has no mapping
  selectedPath: number | null; // index in result.paths of the path shown in the model, if any
  sort: PathSort; // the order of the path table
  stale: boolean; // the model has changed since the result was computed

  /** Opens the panel on a model, with no result yet: the user sets the runs and starts. */
  open: (sceneInstanceId: string) => void;
  /** Keeps what an analysis of `graph` returned: the result, or the validator's problems. */
  showResult: (graph: SimulationGraph, result: PathAnalysisResult) => void;
  /** Keeps a message instead of a result, when not even a graph could be built. */
  showMessage: (message: string) => void;
  /** Shows a path in the model, or none with null. Refused while the result is outdated. */
  select: (index: number | null) => void;
  /** Sorts the path table. */
  sortBy: (sort: PathSort) => void;
  /** The model has changed: the result stays readable, but no path is shown in the model any more. */
  markStale: () => void;
  /** Closes the panel. */
  close: () => void;
  /** Back to the as-loaded state (logout, see services/session-reset). */
  reset: () => void;
}

const EMPTY = { graph: null, result: null, problems: [], message: null, selectedPath: null, stale: false }; // no analysis yet
const CLOSED = { active: false, sceneInstanceId: null, sort: "probability" as PathSort, ...EMPTY }; // the state while the panel is not open

export const usePathAnalysisStore = create<PathAnalysisState>((set, get) => ({
  ...CLOSED, // closed until the user opens the path analysis

  open: (sceneInstanceId) => set({ ...CLOSED, active: true, sceneInstanceId }), // a fresh panel: nothing of an earlier analysis

  showResult: (graph, result) =>
    set({
      ...EMPTY, // a new analysis replaces the old one, its selection and its outdated mark
      graph, // the model as analysed
      result: result.ok ? result : null, // the paths, if it could run
      problems: result.ok ? [] : result.problems, // otherwise what kept it from running
      selectedPath: result.ok && result.paths.length > 0 ? 0 : null, // the most probable path is shown at once, so it is clear that paths can be selected
    }),

  showMessage: (message) => set({ ...EMPTY, message }), // e.g. no mapping for the metamodel

  select: (index) => {
    if (get().stale && index !== null) return; // an outdated path could sit in the wrong place
    set({ selectedPath: index });
  },

  sortBy: (sort) => set({ sort }),

  markStale: () => set({ stale: true, selectedPath: null }), // the highlighting goes with the selection

  close: () => set(CLOSED),

  reset: () => set(CLOSED), // logout: nothing of the previous user's analysis may survive
}));
