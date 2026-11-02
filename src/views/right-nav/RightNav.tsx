import { Box } from "@mui/material";
import { useStateStore } from "@/resources/store/stateStore";
import LogWindow from "@/views/log-window/LogWindow";
import AttributeWindow from "@/views/attribute-window/AttributeWindow";
import SimulationWindow from "@/views/simulation-window/SimulationWindow";
import StepperPanel from "@/views/process-simulation/StepperPanel"; // the process-simulation stepper
import { useProcessSimulationStore } from "@/resources/store/processSimulationStore"; // whether the stepper is open

// Right column: the simulation window in simulation mode and the attribute window in
// every other mode (the switch reads `stateStore`), with the log window underneath.
// While the process-simulation stepper is open, its panel takes the place of both: the
// model is locked then, so there is nothing to edit in the attribute window.
//
// The simulation window is mounted ONLY in simulation mode, so it rebuilds its sliders
// on every entry into that mode rather than showing a stale list.
export default function RightNav() {
  const activeState = useStateStore((s) => s.activeState);
  const isSimulation = activeState === "SimulationMode";
  const stepperOpen = useProcessSimulationStore((s) => s.active); // set by stepper-session when the stepper starts

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Box sx={{ flex: 1, overflowY: "auto", p: 1, minHeight: 0 }}>
        {stepperOpen ? <StepperPanel /> : isSimulation ? <SimulationWindow /> : <AttributeWindow />}
      </Box>
      <Box sx={{ flex: "0 0 40%", minHeight: 0, borderTop: "1px solid", borderColor: "divider" }}>
        <LogWindow />
      </Box>
    </Box>
  );
}
