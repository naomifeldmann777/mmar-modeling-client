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

## For later phases

These are facts from Phase 0 that a later phase has to deal with. Each ends in the
question that has to be answered there; none of them is decided here.

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

## Open questions carried over from the plan

Unchanged from section 13 of the plan; the bold ones block their phase.

| # | Phase | Question |
|---|---|---|
| 1 | 3 | Keep the mapping in `localStorage` as well? |
| 2 | 3 | Propose concepts from the metaclass name? |
| 3 | **4** | **How does the transformer recognise the individual table columns?** |
| 4 | 5 | Which validator checks are errors, which warnings? |
| 5 | **6** | **How does an `OR-Join` find the branches it waits for?** |
| 6 | **6** | **Which variable values does the token keep at an `AND-Join`?** (to be settled with the supervisor) |
| 7 | 6 | What happens when no step is possible but tokens are still under way? |

Note for open question 4: section 10 of the specification lists **22** checks; section 7
of the plan lists 8. Phase 5 has to settle which list is meant before it starts.
