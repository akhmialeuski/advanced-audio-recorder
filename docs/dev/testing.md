# Testing guide

How this repository's tests are organised, and the rules a new test is expected
to follow. It is a developer document: `docs/` proper is the user manual linked
from the README and from the plugin's settings tab, and nothing here is part of
it.

Everything below is enforced somewhere - by `eslint-plugin-jest`, by
`scripts/layer-check.mjs`, or by `scripts/coverage-diff.mjs`. Where it is, the
section says so.

## 1. Three layers, and what decides which one a test belongs to

| Layer       | Directory            | What it covers                               |
| ----------- | -------------------- | -------------------------------------------- |
| unit        | `tests/unit/`        | One module, its collaborators stubbed        |
| integration | `tests/integration/` | A handful of real modules wired together     |
| e2e         | `tests/e2e/`         | The plugin driven the way Obsidian drives it |

They are Jest projects, declared in `jest.config.mjs`, so a layer can be run on
its own:

```bash
npx jest --selectProjects unit
npx jest --selectProjects integration e2e
```

**The criterion is the import count, not the intent.** A test importing at most
four modules from `src/` is a unit test; one wiring three or more together has
earned the name integration. The overlap at three and four is deliberate - a
test in that band is defensible either way, and the author picks. Outside it
there is no argument to have, and `scripts/layer-check.mjs` (run in CI, or
`npm run test:layers`) fails the build naming the file and its count.

An e2e test loads `src/main.ts` and goes through the plugin's own entry points:
`onload()`, a registered command, a ribbon click. `tests/e2e/pluginLifecycle.e2e.test.ts`
is the reference.

## 2. One behaviour per test, Arrange / Act / Assert

A test states one thing. If its name needs an "and", it is two tests.

The three phases are separated by a blank line and nothing else - no comments
labelling them:

```ts
it('reports a dragged volume slider', () => {
	const statusBarItem = createStatusBar();
	const state = makePlaybackState();
	renderPlaybackStatusBar(statusBarItem, state);
	const volume = el<HTMLInputElement>(statusBarItem, PLAYBACK.volume);

	volume.value = '0.4';
	volume.dispatchEvent(new Event('input'));

	expect(state.onVolumeInput).toHaveBeenCalledWith(0.4);
});
```

Comments in a test explain _why_ an expectation is what it is - a platform
quirk, a bug the test guards, a contract that reads as surprising. They never
restate what the next line does.

## 3. `createSut`, not `beforeEach` with shared state

A `let sut` assigned in `beforeEach` hides what each test actually starts from,
and makes a test that needs a different starting point either impossible or a
mutation of shared state. Build the subject in a function that takes the
differences as arguments and returns everything the test needs to drive and
observe it:

```ts
function createSut(options: { duration?: number; width?: number } = {}): {
	controller: SeekController;
	seekEl: HTMLElement;
	onSeekToTime: jest.Mock;
};
```

`tests/unit/SeekController.test.ts` is the reference. Where several suites need
the same subject, the factory moves into `tests/helpers/` -
`createRecordingSut` in `tests/helpers/recordingManagerTestKit.ts`,
`fullyPopulatedSettings` in `tests/helpers/settingsFixtures.ts`.

`beforeEach` is for resetting the environment, not for building the subject.

## 4. Naming: third person, the contract in the title

A title says what the code does, in the third person singular, with no `should`:

```
returns the stored value
does not seek while the duration is unknown
End engages the timeline instead of seeking on a live stream
```

`jest/valid-title` is configured with a `mustNotMatch` pattern, so a title
starting with `should` fails `npm run lint`.

Read as `<describe> <it>`, the pair should be a sentence. `describe` names the
thing or the situation ("pointer seeking", "starting up with an interrupted
session"), `it` names the behaviour.

## 5. Mocks only at the boundaries

Mock what the process cannot own: the network, the file system, the clock,
randomness, the audio hardware, and the Obsidian API. Everything else - this
plugin's own pure functions, its own data structures - runs for real. A mocked
pure function tests the mock.

The Obsidian package ships types and no runtime (`"main": ""`), so
`tests/mocks/obsidian.ts` supplies one, wired in through `moduleNameMapper`.
**Never shadow it** with a local `jest.mock('obsidian', () => ({ … }))`: a
partial double silently no-ops whatever it left out, and the tests that did
this were passing against a `Setting` that rendered nothing. Extend the shared
mock instead (§9), or spread it and swap one export the way
`tests/mocks/modules/obsidianWithCapturingSetting.ts` does.

Timers, randomness, and platform are switched through helpers, never by
assignment: `tests/helpers/async.ts` (`tick`, `waitFor`),
`tests/helpers/platform.ts` (`useMobilePlatform`), `jest.spyOn(Math, 'random')`.

## 6. Tables for three or more cases of the same shape

Three tests differing only in their input are one `it.each` table. Use the
object form and name the case, so a failure report says which row broke:

```ts
it.each([
	{ name: 'the duration is not yet known', duration: Number.NaN },
	{ name: 'the stream is live', duration: Number.POSITIVE_INFINITY },
	{ name: 'the duration is zero', duration: 0 },
	{ name: 'the duration is negative', duration: -1 },
])('answers nothing when $name', ({ duration }) => {
	const { controller } = createSut({ duration });

	expect(controller.timeAtClientX(150)).toBeNull();
});
```

Add `satisfies { … }[]` after the array when the row type is not obvious from
the values - it catches a typo in a key that would otherwise arrive as
`undefined`.

Two cases are usually clearer written out. A table whose rows need `if`s in the
body is not one table; split it.

## 7. Boundary cases worth a row

For every value a test drives, ask what happens at the edges. The recurring
ones in this codebase:

- **Numbers**: zero, negative, `NaN`, `Infinity`, and the exact min/max of a
  declared range plus one step outside it.
- **Collections**: empty, one element, many, and duplicates.
- **Strings**: empty, whitespace only, and one carrying characters a path or a
  filename cannot.
- **Time**: before the length is known, a live stream, a position past the end.
- **Async**: rejection, a result arriving after the caller was torn down, and
  two calls overlapping.
- **Platform**: mobile as well as desktop for anything touching hardware,
  files, or the status bar.

An error path is a behaviour: assert what the user is told, not only that
something threw.

## 8. No mutating shared state

`clearMocks` and `restoreMocks` are on, which resets mocks and spies. They do
not reset a property a test assigned directly, and a test that assigns one has
made every later test depend on the order it ran in.

Change shared state only through something that undoes itself:

- `jest.spyOn(object, 'method')` for methods.
- `jest.replaceProperty(module, 'key', value)` for module-level values - this is
  what `tests/helpers/platform.ts` wraps for `Platform`.
- A helper that registers its own cleanup, like `installCanvas2dContext()` in
  `tests/helpers/canvas.ts`.

Module state the config cannot reach is reset centrally in
`tests/setupAfterEnv.ts`. If a new piece of mock state needs clearing between
tests, it belongs there rather than in each suite's `afterEach`.

Order independence is checked, not assumed: CI runs `--randomize`. A failure
under a random order is a real defect in the tests; reproduce it with the seed
the run reports (`npx jest --randomize --seed=<n>`).

## 9. Extending the Obsidian mock

When a test needs an Obsidian API the mock does not model, there are two
options, and the first is usually the better one:

1. **Move the logic out from under the API.** A function taking data and
   returning data needs no mock at all. Files in this repository that do not
   import `obsidian` sit at 97.1% statement coverage; files that do sit at
   93.7%, and the gap is almost entirely code that is awkward to reach through
   a double.
2. **Add it to `tests/mocks/obsidian.ts`**, for genuine API surface -
   `Vault.process`, a new `Menu` affordance, an event type. Model the behaviour
   the plugin depends on, not the whole API, and record what happened
   (`noticeInstances`, `menuInstances`) so tests can assert on it. Keep methods
   tests spy on as _prototype_ methods: turning `Modal.open` into an instance
   `jest.fn` breaks `jest.spyOn(Modal.prototype, 'open')`.

The mock has its own tests, under `tests/unit/mocks/`. A double complex enough
to be wrong is complex enough to test.

## 10. Assert on the UI, not on its CSS

Rendered UI is read through four helper modules, and tests carry no CSS class
strings of their own:

- `tests/helpers/selectors.ts` - every project class name, grouped by area.
- `tests/helpers/dom.ts` - `el`, `maybeEl`, `allEls`, `control`,
  `clickControl`. `el` throws naming the selector that matched nothing, instead
  of handing back a nullable that `?.` turns into a vacuous pass.
- `tests/helpers/matchers.ts` - `toHaveControl`, `toShowTime`,
  `toHaveMarkerAt`, `toBeDisabledControl`, registered globally.
- `tests/helpers/settingRows.ts` - reads a rendered settings tab by row name.

Prefer the accessible name over the class: `control(root, 'Stop playback')`
asserts the control is reachable at the same time as it finds it.

## 11. Coverage, and what to do when the guard fails

```bash
npm test              # everything
npm run test:coverage # with coverage, writes coverage/
npm run test:guard    # coverage plus the per-file regression check
npm run test:layers   # the unit/integration boundary
```

Two mechanisms guard coverage, and they catch different things.

**Thresholds** (`coverageThreshold` in `jest.config.mjs`) are aggregate floors,
global and per directory. Note the semantics: a file counts in _every_ group
whose path prefix matches it, not only the most specific one, so a file under
`src/player/views/` is counted in `src/player/views/`, `src/player/`, and
nothing else - `global` covers only what no other group matched.
`node scripts/coverage-thresholds.mjs` prints what each group currently reaches.

**The per-file guard** (`scripts/coverage-diff.mjs`) compares every file
against `tests/coverage-baseline.json`. Thresholds are averages: one file losing
fifteen points while another gains them leaves the group flat, and the guard is
what notices. It also fails if the suite shrinks - fewer tests or fewer suites
than the baseline.

When it fails it names the file and the metric:

```
regressed: src/ui/StatusBar.ts branches: 97.18% -> 91.55%
```

Work out which of these it is:

- **A test was deleted or a case was lost in a refactor.** Put the coverage
  back, not the number.
- **A line stopped being reachable because a mock got better.** This happened
  here: a `catch` was only covered because the mock lacked `vault.readBinary`.
  The fix is a test that exercises the path deliberately, never restoring the
  gap in the mock.
- **The code genuinely lost a branch.** Then the baseline moves: run
  `npm run test:baseline` and commit the change with the reason in the commit
  message.

Never lower a threshold to make a run pass. Lowering one is a deliberate act
with an explanation attached.
