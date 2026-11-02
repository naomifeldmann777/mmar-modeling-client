/**
 * Starting and stopping the process-simulation stepper: the part that touches the client.
 *
 * Who calls what:
 * - The menu entry "Process Simulation → Stepper" calls `startStepper`. It reads the open
 *   model, loads and checks the stored mapping, builds the graph and hands it to the store,
 *   whose `open` runs the validator and starts the run. Then it puts the client into
 *   ProcessSimulationMode, as the Simulation menu puts it into SimulationMode.
 * - The stepper panel calls `stopStepper` ("Stop simulation"). It closes the store and goes
 *   back to ViewMode.
 * - Steps and restarts do not come here: they only compute with the graph, so the panel calls
 *   the store directly (processSimulationStore: `pick`, `restart`).
 *
 * The lock (decided in Phase 8): while the stepper is open, the model must not change, since
 * the run and its highlighting are built from the model as it was at the start.
 * - The run is shown in its own mode, ProcessSimulationMode (engine/global-state-object). Like
 *   every mode it decides itself what the user can do: the camera still rotates and zooms, but
 *   no click selects, moves or draws, and Delete, undo / redo and the arrow keys are refused,
 *   since the mode is not editable.
 * - Like every mode it is left by choosing another one (View Mode, the palette, …). Then the
 *   model may be edited again, so the run stops, with a message.
 * - The right column shows the stepper panel instead of the attribute window.
 * - Whatever still changes the model stops the run with a message. In ProcessSimulationMode
 *   that is above all another user of a shared model: their edits arrive live, announced as
 *   `remoteSceneInstanceChanged` (collaboration/shared-doc-service), also when they only move
 *   an element, since the highlighting would then sit in the wrong place. Locally, every known
 *   way to change the model asks the mode first (Delete, undo / redo, arrow keys, Algorithms);
 *   should a local change still happen and announce itself as `sceneInstanceMutated`, it stops
 *   the run as well (a safety net).
 * - Switching to another tab stops the run too: the run belongs to the model it started on.
 *
 * Deliberately NOT here: the run itself (stepper.ts, held by processSimulationStore), the
 * display (StepperPanel) and the highlighting in the 3D model.
 */
import { globalObject, globalStateObject } from "@/engine"; // the open tabs and the interaction mode
import { eventBus, type Subscription } from "@/resources/services/event-bus"; // tab changes and model changes
import { useStateStore } from "@/resources/store/stateStore"; // the active mode, to notice when the user leaves ProcessSimulationMode
import { logger } from "@/resources/services/logger"; // "error" shows the message in the snackbar
import { loadMapping } from "@/resources/process-simulation/mapping"; // the stored mapping, checked against the model
import { readMappableModel, transformModel } from "@/resources/process-simulation/transformer"; // the model's element list, and the graph
import { useProcessSimulationStore } from "@/resources/store/processSimulationStore"; // the run, shared with the panel and the highlighting

const PROCESS_SIMULATION_MODE = 5; // the mode numbers of the client (engine/global-state-object): the stepper's own mode
const VIEW_MODE = 1; // the mode the client returns to after the stepper, as after the robot simulation

let watching: Subscription[] = []; // the event subscriptions of the open stepper, ended by stopStepper

/** Opens the stepper on the model of the active tab: model → mapping → graph → run, then locks the model. */
export function startStepper(): void {
  const tab = globalObject.tabContext[globalObject.selectedTab]; // the open model; undefined when no tab is open
  if (!tab) {
    logger.log("Open a model first, then start the process simulation.", "error"); // nothing to simulate
    return;
  }
  if (useProcessSimulationStore.getState().active) stopStepper(); // a second start replaces the first run
  endWatching(); // subscriptions of a stepper that was closed from outside, e.g. by logging out

  const sceneInstanceId = tab.sceneInstance.uuid; // the model the run belongs to
  const tabIndex = globalObject.selectedTab; // and the tab it is open in: other users' changes name the tab
  const loaded = loadMapping(readMappableModel(tab.sceneType, tab.sceneInstance), window.localStorage); // the stored mapping, without entries for deleted elements or attributes
  if (loaded.ok) {
    useProcessSimulationStore.getState().open(sceneInstanceId, transformModel(tab.sceneType, tab.sceneInstance, loaded.mapping)); // the validator runs in there: the run, or the problems
  } else {
    useProcessSimulationStore.getState().openWithMessage(sceneInstanceId, `The stored concept mapping could not be read: ${loaded.reason} Check it under "Concept Mapping…".`); // no graph without a mapping
  }

  globalStateObject.setState(PROCESS_SIMULATION_MODE); // look only: the mode is not editable
  const modeName = globalStateObject.stateNames[PROCESS_SIMULATION_MODE]; // "ProcessSimulationMode", as the state window shows it
  const leftMode = useStateStore.subscribe((state) => {
    if (state.activeState !== modeName) stopWithMessage("The process simulation was stopped because another mode was chosen.", false); // the model may be edited again; the user's new mode stays
  });
  watching = [
    { dispose: leftMode }, // a store subscription is ended by calling it; wrapped to look like the others
    eventBus.subscribe("tabChanged", () => stopWithMessage("The process simulation was stopped because you switched tabs. Start it again from the Process Simulation menu.")), // the run belongs to the model it started on
    eventBus.subscribe("remoteSceneInstanceChanged", (payload) => {
      if (payload?.tabIndex === tabIndex) stopWithMessage("The process simulation was stopped because another user changed the model. Start it again from the Process Simulation menu."); // a shared model: their edits arrive live
    }),
    eventBus.subscribe("sceneInstanceMutated", (payload) => {
      if (payload?.sceneInstanceUuid === sceneInstanceId) stopWithMessage("The process simulation was stopped because the model was changed. Start it again from the Process Simulation menu."); // safety net: a local change that did not ask the mode
    }),
  ];
}

/** Closes the stepper ("Stop simulation") and goes back to ViewMode. */
export function stopStepper(): void {
  close();
  globalStateObject.setState(VIEW_MODE); // back to the client's normal mode, where the model may be edited
}

/** Closes the stepper without changing the mode. */
function close(): void {
  endWatching(); // no more listening for changes, also not for the mode change that may follow
  useProcessSimulationStore.getState().close(); // the panel goes, the attribute window comes back
}

/** Ends the event subscriptions of the open stepper. */
function endWatching(): void {
  for (const subscription of watching) subscription.dispose(); // each one stops listening
  watching = [];
}

/**
 * Stops the stepper because something outside it happened, and says why. `leaveMode` is false
 * when the user has already chosen another mode: that mode stays.
 */
function stopWithMessage(message: string, leaveMode = true): void {
  if (!useProcessSimulationStore.getState().active) return; // already stopped
  if (leaveMode) stopStepper();
  else close();
  logger.log(message, "error"); // "error" raises the snackbar, so the user sees why the panel closed
}
