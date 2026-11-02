// @vitest-environment jsdom
//
// CameraToggle drives the engine camera. Toggling 2D->3D must call
// engine.setThreeDimensional(true) (the facade's single camera-swap path) and point
// transformControls at the new camera. `@/engine` is mocked (real barrel builds a
// WebGLRenderer). engine.isInitialized is true so the handlers run.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const cam2d = { position: { set: vi.fn() }, zoom: 1 };
  const cam3d = { position: { set: vi.fn() }, zoom: 1 };
  return {
    cam2d,
    cam3d,
    engine: { isInitialized: true, setThreeDimensional: vi.fn() },
    globalObject: {
      threeDimensional: false,
      normalCamera2d: cam2d,
      normalCamera3d: cam3d,
      orbitControls2d: { reset: vi.fn() },
      orbitControls3d: { reset: vi.fn() },
      transformControls: { camera: cam2d, setMode: vi.fn() },
      camera: cam2d,
    },
    globalStateObject: {
      setState: vi.fn(),
      isEditable: vi.fn(() => true), // an ordinary mode, unless a test says otherwise
      getState: vi.fn(() => "ProcessSimulationMode"),
      stateNames: ["SelectionMode (drag)", "ViewMode", "DrawingMode (insert)", "DrawingModeRelationClass (line)", "SimulationMode", "ProcessSimulationMode"],
    },
    logger: { log: vi.fn() },
  };
});

vi.mock("@/engine", () => ({
  engine: mocks.engine,
  globalObject: mocks.globalObject,
  globalStateObject: mocks.globalStateObject,
}));
vi.mock("@/resources/services/logger", () => ({ logger: mocks.logger }));

import CameraToggle from "./CameraToggle";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.globalObject.threeDimensional = false;
  cleanup();
});

describe("CameraToggle", () => {
  it("keeps a mode in which the model cannot be edited, instead of going to view mode", () => {
    mocks.globalStateObject.isEditable.mockReturnValueOnce(false); // e.g. the process-simulation stepper is open
    render(<CameraToggle />);
    fireEvent.click(screen.getByRole("button", { name: "Reset View" }));
    expect(mocks.globalStateObject.setState).toHaveBeenCalledWith(5); // ProcessSimulationMode set again, the run goes on
    expect(mocks.globalStateObject.setState).not.toHaveBeenCalledWith(1);
  });

  it("switches the world to 3D via engine.setThreeDimensional", () => {
    // engine.setThreeDimensional is mocked, so emulate its effect on the flag.
    mocks.engine.setThreeDimensional.mockImplementation((is3d: boolean) => {
      mocks.globalObject.threeDimensional = is3d;
      mocks.globalObject.camera = is3d ? mocks.cam3d : mocks.cam2d;
    });

    render(<CameraToggle />);
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);

    expect(mocks.engine.setThreeDimensional).toHaveBeenCalledWith(true);
    // resetView() -> ViewMode on both sides of the swap.
    expect(mocks.globalStateObject.setState).toHaveBeenCalledWith(1);
    // transformControls repointed at the (new) active camera.
    expect(mocks.globalObject.transformControls.camera).toBe(mocks.cam3d);
  });

  it("sets the transform-controls mode from the toolbar buttons", () => {
    render(<CameraToggle />);
    fireEvent.click(screen.getByLabelText("Translate"));
    expect(mocks.globalObject.transformControls.setMode).toHaveBeenCalledWith("translate");
  });
});
