# Process simulation — Phase 0 notes

Answers to the seven Phase 0 questions of the implementation plan
(*MMAR_Stepper_Implementierungsplan.md*), with the concrete paths every later phase
refers to. Written 2026-10-21 against branch `develop` of `mmar-modeling-client-react`
(working tree clean, last commit `a405dec`).

Paths are relative to the `mmar-modeling-client-react/` root unless they start with
`../` (a sibling repository) or `@gds` (the shared DTOs, see 1).

This file records what exists. It does not decide anything for later phases; where a
finding bears on a later phase it is listed under [For later phases](#for-later-phases)
as a question.

## Decisions taken in Phase 0

| Topic | Decision |
|---|---|
| Location | Split like the existing code: algorithm and data in `src/resources/process-simulation/`, UI in `src/views/process-simulation/`. This file lives in the algorithm folder. |
| Language | English for this file and for all code comments, like the rest of the repository. Concept names are written exactly as in the specification. |
| Stack | Use the installed versions (see 2). No change to `package.json`. |

---

## 1. Folders, and which one is the modeling client

`/usr/src/app/shared/mmar/` holds one repository per folder:

| Folder | What it is | Touch? |
|---|---|---|
| `mmar-modeling-client-react/` | **The modeling client.** React app where models are drawn and edited. All new code goes here. | yes |
| `mmar-metamodeling-client-react/` | Sibling client where metamodels (scene types, classes, attributes) are designed. Phase 1 is done here, by hand. | no |
| `mmar-global-data-structure/` | Shared TypeScript DTOs ("gds"), consumed from source through the `@gds` alias. | **no** (plan 1.4) |
| `mmar-server/` | REST backend, port 8000. | **no** (plan 1.4) |
| `mmar-sync-server/` | yjs WebSocket server for live collaboration, port 8060. | no |
| `mmar-database/` | `init.sql` and example metamodels. | **no** (plan 1.4) |
| `dist/` | Build output of gds and server. | no |

`mmar-database/example_metamodels/up_to_date/` contains `1_bpmn_metamodel.json` and
`7_petrinet_metamodel.json`: the existing BPMN metamodel the plan's "2.0" suffix keeps
apart from, and a Petri net metamodel.

## 2. How the client is built

Stack as installed (`package.json`, checked in `node_modules`):

| | Plan says | Installed |
|---|---|---|
| React | 18 | **19.2.8** |
| MUI | 5 | **9.4.0** (+ Emotion, `@mui/icons-material` 9.4.0) |
| Zustand | — | 5.0.15 |
| Vite | 5 | **8.2.2** |
| TypeScript | 5, strict | 5.9.3, `strict: true` (`strictPropertyInitialization: false`) |
| Tests | Vitest | Vitest 4.1.11 + Testing Library + jsdom |

Also present: three.js 0.169 (the canvas), yjs (collaboration), `uuid`,
`class-transformer`. There is no router.

Layout of `src/` (full description in `README.md` and `CODE_GUIDE.md`):

| Folder | Holds |
|---|---|
| `src/engine/` | The three.js engine: plain TypeScript module singletons, no React. `global-definition.ts` is the shared state object `globalObject`; `index.ts` is the composition root and the `@/engine` barrel. |
| `src/resources/services/` | Framework-free services: REST (`api.ts`, `backend-service.ts`), lookups (`meta-utility.ts`, `instance-utility.ts`), `event-bus.ts`, `logger.ts`, undo (`history-service.ts`), … |
| `src/resources/store/` | Zustand stores, one per file (`uiStore`, `tabsStore`, `selectionStore`, `stateStore`, …). |
| `src/resources/collaboration/` | yjs sessions, presence renderers. |
| `src/resources/util/` | Small helpers. |
| `src/views/` | React components (MUI), one folder per region: `layout/`, `top-nav-bar/`, `right-nav/`, `attribute-window/`, `dialogs/`, `simulation-window/`, … |

Conventions that matter for new code:

- **The engine owns the model; stores mirror it.** The open model is a graph of gds
  objects mutated in place by the engine. Stores are one-way mirrors for React. Read a
  store with the hook form (`useXStore((s) => s.slice)`) inside a component body, and
  with `useXStore.getState()` everywhere else.
- **Event bus** (`src/resources/services/event-bus.ts`): channels are typed in
  `EventPayloads`; `subscribe` returns `{ dispose }`. Subscribers must never be `async`.
- **Logging:** `logger.log(message, status)` from `src/resources/services/logger.ts`.
  The status is a Material Icons name (`"info"`, `"done"`, `"close"`, `"error"`); only
  `"error"` raises the snackbar.
- **Logic in plain modules, React state in the component.** Example:
  `src/views/attribute-window/attributeModel.ts` (logic, unit-tested) next to
  `AttributeWindow.tsx` (rendering).
- **Tests sit next to the file** (`x.ts` → `x.test.ts`), as the plan asks.
- **Imports:** `@/…` for `src/…`, `@gds` for the shared DTOs. Both aliases are declared
  three times (`vite.config.ts`, `vitest.config.ts`, `tsconfig.json`).

## 3. The type of a loaded scene, and its two lists

The type is **`SceneInstance`** from `@gds`
(`../mmar-global-data-structure/models/instance/Instance_scenes.structure.ts`).

| Field | Type | Note |
|---|---|---|
| `class_instances` | `ClassInstance[]` | the nodes. **Also holds the bendpoints of relations** (see below). |
| `relationclasses_instances` | `RelationclassInstance[]` | the relations. Note the spelling: `relationclasses_`, plural. |
| `attribute_instances` | `AttributeInstance[]` | the scene's own attributes, not those of its elements |
| `role_instances`, `port_instances` | | |
| `uuid_scene_type` | `UUID` | the scene type (metamodel) it is an instance of |

Every instance has `uuid` (from `ObjectInstance`, `instance_objects.structure.ts`).

- **Where the open scene is:** `globalObject.tabContext[globalObject.selectedTab]`
  (`src/engine/global-definition.ts`) is
  `{ sceneType, sceneInstance, threeScene, contextDragObjects, isShared }`.
  `instanceUtility.getTabContextSceneInstance()` returns the `sceneInstance` (async,
  `undefined` when no tab is open). "No tab open" means the entry is `undefined`;
  `selectedTab` starts at `0`, not `-1`.
- **Metaclass of an element:** `ClassInstance.uuid_class` →
  `sceneType.classes[].uuid`; `RelationclassInstance.uuid_relationclass` →
  `sceneType.relationclasses[].uuid`. The metaclass has `name` and `attributes`
  (meta `Attribute[]`). `metaUtility.getMetaClass` / `getMetaRelationclass`
  (`src/resources/services/meta-utility.ts`) do this lookup against the open tab.
- **Display name of an element:** `src/views/model-tree/ModelTree.tsx` reads the
  attribute instance whose `uuid_attribute` is `NAME_ATTRIBUTE_UUID`
  (`src/constants.ts`, a fixed uuid "every metamodel uses") and falls back to the
  metaclass name.
- **Bendpoints:** a relation's intermediate points are `ClassInstance`s in
  `class_instances`, of the class named in `Relationclass.bendpoint`. `ModelTree.tsx`
  filters them out by collecting `sceneType.relationclasses[].bendpoint`.
- `RelationclassInstance` **extends** `ClassInstance`, so a relation also carries
  `uuid_class` (set to the same value as `uuid_relationclass`).
- Server responses are revived into real gds classes with `X.fromJS(…)`; the client
  relies on `instanceof`. Never use the app's own `plainToInstance`.

## 4. `AttributeInstance`, and how table attributes are stored

`AttributeInstance` (`@gds`,
`../mmar-global-data-structure/models/instance/Instance_attributes.structure.ts`):

| Field | Meaning |
|---|---|
| `uuid` | the attribute instance |
| `uuid_attribute` | the **meta** `Attribute` it is an instance of |
| `value` | **always a string**; an unset value is `""` (older models may hold `"not defined"` / `"undefined"`) |
| `assigned_uuid_class_instance` / `assigned_uuid_scene_instance` / `assigned_uuid_port_instance` | its owner |
| `table_attributes` | the cells, when this instance is a table |
| `table_attribute_reference` | on a cell: the uuid of the table instance it belongs to |
| `table_row` | on a cell: its row, counted from 0 |
| `role_instance_from` | for reference attributes only |

Where an element keeps its attributes — the field name differs:

| Owner | Field |
|---|---|
| `ClassInstance` | `attribute_instance` (singular) |
| `RelationclassInstance` | `attribute_instance` (inherited from `ClassInstance`) |
| `PortInstance` | `attribute_instances` |
| `SceneInstance` | `attribute_instances` |

The meta side (`../mmar-global-data-structure/models/meta/`): `Attribute` has `uuid`,
`name`, `facets` (a `|`-separated string, e.g. `==|!=|<|<=|>|>=`), `min`, `max`,
`sequence`, `ui_component`, and `attribute_type: AttributeType`. An attribute is a
**table** when `attribute_type.has_table_attribute` (a `ColumnStructure[]`) is not
empty.

**Tables.** The rules are documented at the top of
`../mmar-global-data-structure/models/instance/Instance_tables.ts`:

- **Columns** come from the meta side: `ColumnStructure` =
  `{ attribute: Attribute, sequence (from 1), width, comment, ui_component }`. The
  column's name and facets are those of `column.attribute`.
- **Cells** are `AttributeInstance`s in the table instance's `table_attributes`. A cell's
  `uuid_attribute` is its column's `attribute.uuid`; `table_row` is its row. The cell
  itself does **not** carry the column name — that is reached through
  `uuid_attribute` → column → `attribute.name`.
- Rows are numbered `0..n-1` without gaps, at most one cell per column per row. A row
  can lack the cell of a column added later (that position is empty).
- Pure helpers in the same file, which accept plain objects as well as gds instances:
  `table_columns_in_order(columns)`, `table_row_count(table)`, and
  `table_rows(table, columns)`, which returns the grid as
  `(cell | undefined)[][]`, rows in order, cells in column order.
- `ColumnStructure` is not exported from the `@gds` barrel; it is deep-imported as
  `@gds/models/meta/Metamodel_columns.structure` (as
  `src/views/attribute-window/TableAttributeDialog.tsx` does).
- How the client reads a table: `TableAttributeDialog.tsx`, function `load`: meta
  attribute → `table_columns_in_order(metaAttribute.attribute_type.has_table_attribute)`
  → `table_rows(attributeInstance, columns)`.

## 5. From a relation to its source and target

`RelationclassInstance` (`@gds`, `Instance_relationclasses.structure.ts`) has
`role_instance_from` and `role_instance_to`, both `RoleInstance`
(`Instance_roles.structure.ts`). The connected element is the role's
**`uuid_has_reference_class_instance`**:

```
source uuid = relation.role_instance_from.uuid_has_reference_class_instance
target uuid = relation.role_instance_to.uuid_has_reference_class_instance
```

A role can instead point at a port, scene, attribute or relation instance
(`uuid_has_reference_port_instance`, `…_scene_instance`, `…_attribute_instance`,
`…_relationclass_instance`). The uuid is then looked up in
`sceneInstance.class_instances`.

Existing helpers in `src/resources/services/instance-utility.ts`:
`getOutgoingRelationsFromInstance(uuid, metaClassUuid?)` and
`getIncomingRelationsFromInstance(uuid, metaClassUuid?)`. Both are async, read the open
tab, and compare only `uuid_has_reference_class_instance`.

## 6. Where a new dialog or mode is hooked into the UI

**Dialog** — three existing files are involved:

1. `src/resources/store/uiStore.ts`: add the name to the `DialogName` union and to
   `DIALOG_NAMES`. The store then provides `dialogs[name]` (open flag),
   `openDialog(name, payload?)`, `closeDialog(name)`, `getDialogPayload(name)`.
2. `src/views/layout/AppLayout.tsx`: mount the dialog component once, next to the
   other dialogs. It renders closed and opens itself from `uiStore`.
3. `src/views/top-nav-bar/TopNavBar.tsx`: add a menu entry in `buildMenus`, either
   `{ label, icon, dialog: "<name>" }` or `{ label, icon, onSelect: () => … }`. The
   icons are Material Icons ligature names. `menus[0..4]` are File, View, Edit,
   Diagram and Settings; `menus[5]` is the existing **Simulation** menu (robot
   simulation).

Pattern to copy: `src/views/dialogs/AlgorithmDialog.tsx` (reads
`useUiStore((s) => s.dialogs.algorithm)`, loads its data in an effect when `open`
turns true). MUI components in use for dialogs: `Dialog`, `DialogTitle`,
`DialogContent`, `DialogActions`, `Select` + `MenuItem` + `FormControl` +
`InputLabel`, `Table*`, `TextField`, `Button`, `Typography`, `Stack`/`Box`.

**Mode / side panel:**

- Interaction modes are numbered 0–4 in `src/engine/global-state-object.ts`
  (`stateNames` and `MODE_SETTINGS`): Selection, View, Drawing, DrawingRelationClass,
  **SimulationMode (4, the robot simulation)**. `globalStateObject.setState(n)`
  mirrors the name into `stateStore`; mode names are compared as strings.
- `src/views/right-nav/RightNav.tsx` shows `SimulationWindow` while
  `activeState === "SimulationMode"`, otherwise `AttributeWindow`, with the log window
  underneath.

**Highlighting.** Every model element is drawn as a three.js mesh whose `uuid` equals
the instance uuid (`CODE_GUIDE.md`, "Mesh uuid = instance uuid"). The only existing
highlights are the red `BoxHelper` of the single selection
(`src/engine/global-selected-object.ts`) and the boxes drawn around collaborators'
selections (`src/resources/collaboration/remote-selection-renderer.ts`). There is no
API for highlighting several elements at once.

## 7. Running the client and the tests

The client already runs inside the container: `/usr/src/app/start-node-modeling-client-react.sh`
starts `npm run start` (`vite --host`) at container start. It answers on
**http://localhost:8085** (checked: HTTP 200). Sign in with `admin` / `admin`. From inside
the container the servers are reachable as `mmar-server:8000` and
`mmar-sync-server:8060`; the browser on the host uses `localhost`.

| Command (in `mmar-modeling-client-react/`) | Does |
|---|---|
| `npm run dev` | Vite dev server on port 8085 |
| `npm run test` | `vitest run`, all suites |
| `npx vitest run <path>` | one test file, e.g. `npx vitest run src/resources/process-simulation/firing.test.ts` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint src` |
| `npm run build` | typecheck + production build |

Baseline on 2026-10-21: `npm run typecheck` clean; `npx vitest run` → **76 files,
707 tests, all passing** (≈ 112 s, integration suites included).

Test setup (`vitest.config.ts`, `src/test-setup.ts`):

- Only `src/**/*.test.ts` and `src/**/*.test.tsx` are collected.
- The default environment is `node`; a component test opts into jsdom with a
  `// @vitest-environment jsdom` comment at the top of the file.
- `src/test-setup.ts` imports `reflect-metadata` first, which the gds decorators need.
- Anything that imports `@/engine` or `@/engine/global-definition`, even transitively,
  must be mocked: that module builds a `WebGLRenderer` when it loads.
- `*.integration.test.ts` files hit the live servers and skip themselves when they are
  unreachable.

---

## Decisions by phase (Phases 1 to 8)

### Phase 1: the metamodel "BPMN 2.0" (created by hand)

- Classes `Start Event 2.0`, `End Event 2.0`, `Task 2.0`, `Exclusive Gateway 2.0`,
  `Parallel Gateway 2.0`, `Inclusive Gateway 2.0`, `Variable 2.0`, each with `Name`.
- Relation classes `Sequence Flow 2.0` (`Name`, `Transition Condition Table 2.0` with the
  columns Variable | Operator | Value | Logical Operator) and `Random Generator 2.0` (the
  plan's "Triggers": `Name`, `Distribution Type 2.0`, `Discrete Distribution Table 2.0` with
  the columns Value | Probability).
- New elements are named `Name`. Every new table starts with one row; in a condition table
  it is Variable "", Operator "==", Value "", Logical Operator "-".
- Known issues, to be fixed in the metamodel later: the target role of `Sequence Flow 2.0`
  has `max = 1` for every class (no element can get two incoming flows, so no joins, merges
  or loops can be drawn); the Operator and Logical Operator columns have
  `ui_component = text` (no dropdown); the Operator facets contain `=>` instead of `>=`; the
  Probability column has no minimum and maximum.

### Phase 2: `vocabulary.ts`

- Element and data concepts with their meanings, verbatim from spec 2.1 and 2.2;
  `NODE_CONCEPTS` (spec 7), `WAITING_CONCEPTS` (spec 5.3), `DATA_CONCEPT_OWNERS` (spec 2.2).

### Phase 3: the mapping (`mapping.ts`, `views/process-simulation/MappingDialog.tsx`)

- Format: `{ sceneInstanceId, elements: { <element uuid>: { concept, data? } } }`; `data`
  maps a data concept to the uuid of the element's own **attribute instance**. No version
  field: a stored or imported text that does not have this shape is discarded whole.
- Kept in localStorage, one entry per model (`process-simulation-mapping:<scene uuid>`),
  saved on every change; export and import as a JSON file from the popup. A mapping of
  another model is refused on import; entries for deleted elements are dropped (silently
  when the popup opens, listed on import). The file stores uuids only, no names.
- No separate store for the mapping: localStorage is the source of truth, later code calls
  `loadMapping`. Server-side storage is future work (comment "FUTURE WORK" in `mapping.ts`).
- No concepts are proposed from metaclass names.
- Popup: menu **Process Simulation → Concept Mapping…**; one row per element with icon,
  name, metaclass, and for relations "name (source → target)"; bendpoints hidden; status
  "mapped" / "not mapped"; meanings as tooltips; the second dropdown is labelled with its
  data concept. No attribute is preselected.

### Phase 4: graph and transformer (`graph.ts`, `transformer.ts`)

- `graph.ts` (with `vocabulary.ts` and the algorithms) is the part that can become a
  library; `transformer.ts` is the MMAR adapter. No language-specific name appears in code.
- Format rule: the attribute mapped as TransitionCondition is a table with the columns
  1 variable, 2 operator, 3 value, 4 logical operator; the one mapped as Distribution a
  table with 1 value, 2 probability. Column order = `sequence` in the metamodel.
- Rows whose variable and value (or value and probability) are both empty are skipped;
  half-filled rows are kept for the validator. Numbers are read with a comma or a dot.
- A random generator's node and variable are found from the concepts of the line's ends,
  in either direction. Generators drawn as elements of their own are not read (issue).
- In the graph, `null` means "data concept not mapped" and `[]` "mapped but empty"; a flow
  without condition rows is always taken. `ConditionRow.variableName` is a name, matched
  against `GraphVariable.name`; `GraphGenerator.variable` is a uuid.
- The transformer raises issues only for mistakes a user can make in the popup.

### Phase 5: validator (`validator.ts`, `condition.ts`)

- All 22 checks of spec 10; every failed check is an error, so the run does not start.
- Check 2 includes the transformer's issues. Check 14 needs no code: a Distribution table
  "value | probability" is discrete by its format, and `Distribution Type 2.0` is not read.
  Check 17 requires an operator of `== != < <= > >=` and AND / OR after the first row.
  Check 16 counts a variable as drawn where paths meet only if it is drawn on every incoming
  path; at an AND-Join or SynchronizedActivity (all branches have run) on any of them
  (changed in Phase 7, after the one value store per run of Phase 6).
  Checks 20 to 22 try every combination of the values the variables can take.
- `condition.ts` evaluates a condition (AND before OR, an undrawn variable is false,
  `==` / `!=` compare text, `<` and `>` compare numbers) for the validator and the firing rule.
- Limitations written up for the thesis: conflicts in Petri nets without data (preferred
  fix: give the Petri net metamodel a variable, a random generator and a condition table on
  arcs); only discrete distributions (preferred future extension: a data concept
  `DistributionType`).

### Phase 6: firing rule (`firing.ts`, `pairs.ts`, `numbers.ts`)

- Open question 5: OR-Split and OR-Join follow spec 5.2 literally. A branch that is not
  taken gets a skip token on the flow where it enters its OR-Join (`pairs.ts` finds that
  flow by walking the branch, nesting-aware); the OR-Join then waits like an AND-Join.
- Open question 6: one value store per run (plan 6). A draw is visible everywhere at once.
- `possibleSteps` (operation 1) and `executeStep` (operation 2) work on the graph; no Petri
  net is built. A node that does not wait takes the token of the input it arrived on.
- `pairs.ts` and `numbers.ts` were split out so the validator does not depend on the firing
  rule. Library files (vocabulary, graph, numbers, condition, pairs, firing, validator,
  stepper, mapping) import only each other; `transformer.ts` is the only MMAR adapter.
- New validator checks beyond spec 10: 23 (no variable drawn in two parallel branches, nor
  by two generators at one node), 24 (splits and joins form matching pairs: every branch
  ends at exactly one input of its join on every path, no path jumps out to an End, every
  join input is a branch end of one and the same split, no flow leads into a branch from
  outside the pair), 25 (conditions only on outgoing flows of a Decision or OR-Split).
  Check 9 also requires exactly one outgoing flow for Start, Activity and the joins.

### Phase 7: stepper (`stepper.ts`) and further checks

- `startRun` validates first; `takeStep` carries out the picked step; `runStatus` is
  `running`, `finished` (an End was reached) or `noStep`.
- The stepper waits for the user after every step, even when only one step is possible, so
  the user can follow the token. This deviates on purpose from spec 8 ("executed directly").
- Open question 7: when no step is possible, the stepper says so in neutral words: "The run
  is over." or "No further step is possible." (never "deadlock").
- New check 26: every loop can be left. Every loop is checked on its own (also loops inside
  loops): its conditions must read a variable that is drawn again on the loop; a loop through
  an AND-Join or SynchronizedActivity counts the draws of all branches of that pair.
- Limitation written up: checks 20 to 22 and 26 do not know which values can reach an
  element, so they may raise a false alarm, but never miss a real problem.
- `readMappableModel` moved from the popup into `transformer.ts`: popup and stepper both need
  the element list to load and check the stored mapping.

### Phase 8: stepper user interface

- `resources/store/processSimulationStore.ts` holds the open stepper (run, problems,
  message); it is pure state. The mapping stays in localStorage: it must survive a reload,
  a run must not.
- `views/process-simulation/stepper-session.ts`: started from "Process Simulation → Stepper",
  it reads the open model, loads the mapping, builds the graph, opens the store and switches
  to ProcessSimulationMode; "Stop simulation" goes back to ViewMode. A tab change, another
  mode, an edit by another user of a shared model (`remoteSceneInstanceChanged`, also a mere
  move) or a local change announced as `sceneInstanceMutated` stops the run with a message.
- The lock is a mode like the others: engine mode 5 "ProcessSimulationMode" (look only).
  Every mode says whether it is `editable`; only mode 5 is not, so Delete, undo/redo, the
  arrow keys and the Algorithms dialog (which ask `globalStateObject.canEdit()`) do nothing there. The engine does not
  know the stepper. The 2D/3D switch and "Reset View" keep a non-editable mode (they only
  change the camera; `isEditable()` asks without a pop-up). Choosing another mode leaves mode 5
  like any mode; the stepper notices
  (stateStore) and stops its run with a message. The attribute window is replaced by the
  stepper panel while the stepper is open.
- `StepperPanel.tsx` (right column, instead of the attribute window): status, possible
  steps as buttons (drawn values with their probability, the target at a Decision or
  OR-Split), variable values, flows with tokens, trace, Restart, Stop simulation.
- `stepper-highlight.ts`: a bright, luminous green glow around nodes that can run now, a pale,
  matte green glow around the node that ran last (one see-through band with rounded corners, like a highlighter; WebGL draws
  plain lines only one pixel wide), each token as a black dot with a white rim on its flow,
  just in front of the element it waits for (with a number when several lie there), and a label
  "variable = value" to the right of each variable that has a value (not at the random
  generator, where it covered the node). Labels keep their size until the next step.
- Logging out resets the store (`session-reset.ts`).

## Findings of Phase 0 for later phases

These were the open findings of Phase 0; they are answered in the section above, except
highlighting and the store of the stepper, answered in Phase 8.

| Phase | Finding | Question |
|---|---|---|
| 3 | `localStorage` is already used (`authStore` keeps `jwtToken`; the panel layout persists through `react-resizable-panels`). | Open question 1 of the plan: should the mapping also survive in `localStorage`? |
| 3 | The display name comes from `NAME_ATTRIBUTE_UUID`, a fixed uuid in `src/constants.ts`. The plan forbids uuids in new code. | May the mapping dialog read the name through this existing constant, or should it show something else (e.g. the metaclass name only)? |
| 3 | Bendpoints are `ClassInstance`s in `class_instances`. | Should the mapping dialog hide them, as `ModelTree.tsx` does? |
| 3 | Opening a dialog means editing `uiStore.ts`, `AppLayout.tsx` and `TopNavBar.tsx`. The existing "Simulation" menu belongs to the robot simulation (plan 1.4). | Where does the menu entry go: a new menu, or an entry in an existing one? |
| 3, 8 | Signing out runs `src/resources/services/session-reset.ts`, which resets every store so the next user starts clean. | Should the mapping and the run state be reset there as well? |
| 4 | `numerise` (`src/resources/services/format.ts`) uses `parseFloat`, which reads `"0,8"` as `0`. | The plan requires both `0,8` and `0.8`; the transformer needs its own parsing. |
| 4 | A table cell knows its column only by `uuid_attribute`; the column's name is on the meta `Attribute`. | Open question 3 of the plan: how does the transformer recognise the Variable, Operator, Value and Logical Operator columns (names, order, or mapped)? |
| 4 | The gds table helpers (`table_rows`, `table_columns_in_order`) are pure functions that also accept plain objects. | May the transformer use them, given the plan keeps gds classes out of what the algorithm processes? |
| 4 | A relation end may be a port instead of a class instance (`uuid_has_reference_port_instance`). | Ignore such relations, or report them? |
| 8 | The only highlight is the single-selection `BoxHelper`; elements are found by mesh uuid. | How should active elements and token-carrying flows be highlighted? |
| 8 | Stores live in `src/resources/store/`, one Zustand store per file. | Does the stepper store go there, or into `src/resources/process-simulation/`? |

## Open questions of the plan (section 13)

| # | Phase | Question | Status |
|---|---|---|---|
| 1 | 3 | Keep the mapping in `localStorage` as well? | answered: yes |
| 2 | 3 | Propose concepts from the metaclass name? | answered: no |
| 3 | 4 | How does the transformer recognise the individual table columns? | answered: fixed column order (format rule) |
| 4 | 5 | Which validator checks are errors, which warnings? | answered: all are errors; all 22 checks of spec 10 |
| 5 | **6** | **How does an `OR-Join` find the branches it waits for?** | answered: skip tokens as in spec 5.2 |
| 6 | **6** | **Which variable values does the token keep at an `AND-Join`?** | answered: one value store per run; check 23 |
| 7 | 6 | What happens when no step is possible but tokens are still under way? | answered: neutral message "No further step is possible." |
