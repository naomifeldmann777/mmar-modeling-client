import { useState } from "react"; // whether the log is folded
import { Box, Divider } from "@mui/material";
import { useStateStore } from "@/resources/store/stateStore";
import LogWindow from "@/views/log-window/LogWindow";
import AttributeWindow from "@/views/attribute-window/AttributeWindow";
import SimulationWindow from "@/views/simulation-window/SimulationWindow";
import StepperPanel from "@/views/process-simulation/StepperPanel"; // the process-simulation stepper
import { useProcessSimulationStore } from "@/resources/store/processSimulationStore"; // whether the stepper is open
import PathAnalysisPanel from "@/views/process-simulation/PathAnalysisPanel"; // the process-simulation path analysis
import { usePathAnalysisStore } from "@/resources/store/pathAnalysisStore"; // whether the path analysis is open

// Right column: the simulation window in simulation mode and the attribute window in
// every other mode (the switch reads `stateStore`), with the log window underneath.
// While the process-simulation stepper is open, its panel takes the place of both: the
// model is locked then, so there is nothing to edit in the attribute window.
// While the path analysis is open, its panel sits above the attribute window: the model
// may still be edited then, and the panel says when its result is outdated.
//
// The simulation window is mounted ONLY in simulation mode, so it rebuilds its sliders
// on every entry into that mode rather than showing a stale list.
//
// The log takes 40 % of the column, or only its title line when the user folds it, so a
// long panel above (e.g. a path analysis) gets the whole height.
export default function RightNav() {
  const activeState = useStateStore((s) => s.activeState);
  const isSimulation = activeState === "SimulationMode";
  const stepperOpen = useProcessSimulationStore((s) => s.active); // set by stepper-session when the stepper starts
  const pathAnalysisOpen = usePathAnalysisStore((s) => s.active); // set by path-analysis-session when the panel opens
  const editor = isSimulation ? <SimulationWindow /> : <AttributeWindow />; // what the column shows for the mode
  const [logFolded, setLogFolded] = useState(false); // open at first, as before

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Box sx={{ flex: 1, overflowY: "auto", p: 1, minHeight: 0 }}>
        {stepperOpen ? (
          <StepperPanel />
        ) : pathAnalysisOpen ? (
          <>
            <PathAnalysisPanel />
            <Divider sx={{ my: 1.5 }} />
            {editor}
          </>
        ) : (
          editor
        )}
      </Box>
      <Box sx={{ flex: logFolded ? "0 0 auto" : "0 0 40%", minHeight: 0, borderTop: "1px solid", borderColor: "divider" }} /* folded: as high as the title line */>
        <LogWindow folded={logFolded} onToggleFold={() => setLogFolded(!logFolded)} />
      </Box>
    </Box>
  );
}
