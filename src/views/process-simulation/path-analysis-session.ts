/**
 * Opening the path analysis, running it and closing it: the part that touches the client
 * (Plan2 B2). The analysis itself is path-analysis.ts.
 *
 * Who calls what:
 * - The menu entry "Process Simulation → Path Analysis" calls `openPathAnalysis`. It opens
 *   the panel on the model of the active tab, empty: the user sets the runs and the seed.
 * - The panel's "Start" calls `runPathAnalysis`. It reads the model as it is now, picks the
 *   mapping of its scene type, builds the graph, runs the analysis and hands the result to the
 *   store. Starting again later analyses the model as it is then.
 * - The panel's "Export CSV" calls `exportPathAnalysis`, which downloads the result as a file.
 * - The panel's "Close" calls `closePathAnalysis`.
 *
 * The model and the analysis (decided for B2):
 * - While the analysis runs, the model cannot change: it runs in one go, and the client does
 *   not take a click before it is done (at most MAX_RUNS runs, about a second).
 * - Afterwards the model may be edited, unlike with the stepper: the result is a finished
 *   snapshot. Once the model differs from the analysed one, the store marks the result as
 *   outdated: the panel says so and the highlighted path goes, since it could sit in the
 *   wrong place.
 * - How a change is noticed: the client announces local edits in no single way (moving,
 *   editing an attribute, drawing and deleting each flag the model as unsaved on their own),
 *   so the session compares a fingerprint of the model, its elements as JSON, with the one
 *   taken at the analysis, once a second, until it differs. That covers local edits and those
 *   of other users alike.
 * - Switching to another tab closes the analysis, as it does the stepper: it belongs to the
 *   model it was made on.
 * - The right column shows either the stepper or the path analysis: opening one closes the
 *   other.
 *
 * Deliberately NOT here: the analysis (path-analysis.ts), the display (PathAnalysisPanel) and
 * the highlighting (path-highlight).
 */
import type { SceneInstance } from "@gds";
import { globalObject } from "@/engine"; // the open tabs
import { eventBus, type Subscription } from "@/resources/services/event-bus"; // tab changes
import { logger } from "@/resources/services/logger"; // "error" shows the message in the snackbar
import { mappingFor } from "@/resources/process-simulation/mappings"; // the mapping of the model's language
import { analysePaths, type PathAnalysisOptions } from "@/resources/process-simulation/path-analysis"; // the runs
import { pathAnalysisCsv } from "@/resources/process-simulation/path-report"; // the result as CSV text
import { transformModel } from "@/resources/process-simulation/transformer"; // model + mapping -> graph
import { usePathAnalysisStore } from "@/resources/store/pathAnalysisStore"; // the result, shared with the panel
import { useProcessSimulationStore } from "@/resources/store/processSimulationStore"; // whether the stepper is open
import { stopStepper } from "./stepper-session"; // the stepper gives way to the path analysis

const CHANGE_CHECK_MS = 1000; // how often the model is compared with the analysed one

let watching: Subscription[] = []; // the event and store subscriptions of the open panel
let changeCheck: ReturnType<typeof setInterval> | null = null; // the comparison with the analysed model, while one runs

/** Opens the path-analysis panel on the model of the active tab. */
export function openPathAnalysis(): void {
  const tab = globalObject.tabContext[globalObject.selectedTab]; // the open model; undefined when no tab is open
  if (!tab) {
    logger.log("Open a model first, then start the path analysis.", "error"); // nothing to analyse
    return;
  }
  if (useProcessSimulationStore.getState().active) stopStepper(); // one panel at a time in the right column
  closePathAnalysis(); // a second opening starts afresh

  usePathAnalysisStore.getState().open(tab.sceneInstance.uuid); // the panel, without a result yet
  const closed = usePathAnalysisStore.subscribe((state) => {
    if (!state.active) endWatching(); // closed from anywhere (Close, the stepper, logout): stop watching
  });
  watching = [
    { dispose: closed }, // a store subscription is ended by calling it; wrapped to look like the others
    eventBus.subscribe("tabChanged", () => closeWithMessage("The path analysis was closed because you switched tabs. Open it again from the Process Simulation menu.")), // it belongs to the model it was opened on
  ];
}

/** Analyses the model as it is now, with the user's settings, and shows the result. */
export function runPathAnalysis(options: PathAnalysisOptions): void {
  const store = usePathAnalysisStore.getState(); // where the result goes
  const tab = globalObject.tabContext[globalObject.selectedTab]; // the model of the panel: a tab change closes the panel
  if (!store.active || !tab || tab.sceneInstance.uuid !== store.sceneInstanceId) return; // the panel is not open on this model

  stopChangeCheck(); // the result about to be shown is the one to compare with
  const mapping = mappingFor(tab.sceneType.name); // e.g. the mapping of "BPMN 2.0"
  if (!mapping) {
    store.showMessage(`The process simulation has no mapping for the metamodel "${tab.sceneType.name}", so it cannot analyse this model.`); // as for the stepper
    return;
  }
  const graph = transformModel(tab.sceneType, tab.sceneInstance, mapping); // the model as it is now
  const result = analysePaths(graph, options); // the validator first, then the runs
  store.showResult(graph, result); // the paths, or the problems
  if (result.ok) startChangeCheck(tab.sceneInstance); // from now on, notice when the model differs
}

/**
 * Downloads the result as a CSV file named after the model, e.g. "path-analysis-Order.csv".
 * The file starts with a byte order mark, so Excel reads umlauts in names correctly.
 */
export function exportPathAnalysis(): void {
  const { graph, result } = usePathAnalysisStore.getState(); // the result on show
  const tab = globalObject.tabContext[globalObject.selectedTab]; // the model it was made on: a tab change closes the panel
  if (!graph || !result || !tab) return; // nothing to export
  const name = tab.sceneInstance.name ?? "model"; // the model's name, for the file and its first line
  const file = new Blob(["\uFEFF" + pathAnalysisCsv(graph, result, name)], { type: "text/csv;charset=utf-8" }); // the byte order mark tells Excel it is UTF-8
  const url = URL.createObjectURL(file); // a temporary address the browser can download from
  const link = document.createElement("a"); // the usual way to start a download from a page
  link.href = url;
  link.download = `path-analysis-${name}.csv`; // the file name the browser proposes
  link.click();
  URL.revokeObjectURL(url); // the download has started; the address is no longer needed
}

/** Closes the panel ("Close"). */
export function closePathAnalysis(): void {
  usePathAnalysisStore.getState().close(); // the store subscription then ends the watching
  endWatching(); // also when the panel was not open
}

/** Closes the panel because something outside it happened, and says why. */
function closeWithMessage(message: string): void {
  if (!usePathAnalysisStore.getState().active) return; // already closed
  closePathAnalysis();
  logger.log(message, "error"); // "error" raises the snackbar, so the user sees why the panel closed
}

/** Compares the model with the analysed one once a second, and marks the result outdated once it differs. */
function startChangeCheck(sceneInstance: SceneInstance): void {
  const analysed = fingerprint(sceneInstance); // the model as analysed
  changeCheck = setInterval(() => {
    if (fingerprint(sceneInstance) === analysed) return; // unchanged
    usePathAnalysisStore.getState().markStale(); // the panel says so; the highlighted path goes
    stopChangeCheck(); // once outdated, it stays so until the next analysis
  }, CHANGE_CHECK_MS);
}

/** Stops comparing the model. */
function stopChangeCheck(): void {
  if (changeCheck !== null) clearInterval(changeCheck);
  changeCheck = null;
}

/** Ends every subscription of the open panel, and the comparison. */
function endWatching(): void {
  for (const subscription of watching) subscription.dispose(); // each one stops listening
  watching = [];
  stopChangeCheck();
}

/**
 * The model's elements as text: every box and line with its attributes and position. Two
 * fingerprints differ exactly when something was added, deleted, moved or edited. The client
 * saves a model as JSON the same way, so this always works on a scene instance.
 */
function fingerprint(sceneInstance: SceneInstance): string {
  return JSON.stringify([sceneInstance.class_instances, sceneInstance.relationclasses_instances]);
}
