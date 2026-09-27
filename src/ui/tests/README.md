# Browser regressions

Run project code inside Container-Use, from `src/ui`:

```sh
npm ci
npx vite build --config tests/vite.config.mjs
npx vite preview --config tests/vite.config.mjs --host 0.0.0.0
```

## Agent copy names

Open `/tests/agent-copy-name.html` and repeat with `?wire=1` and `?default=1`. Each page must
report `PASS`. The fixture mounts the real Agent Configurations screen,
clones an agent, edits its name, and checks the submitted POST and the card
after reloading. The two cases cover a human-readable name and a wire-style
name while retaining the clone ID. The default case checks that Name
matches the card immediately after Clone and saves without editing it,
preserving the separately generated ID. Only HTTP responses are substituted.

Repeat with `?custom-id=1` to edit only the technical ID, and with `?nested=1`
to rename an unsaved draft and clone it again. The copied label must survive
saving, nested IDs must stay valid, and the parent draft must stay unchanged.
Renaming a clone preserves its ID. New agents created from scratch derive an ID
from Name until the first manual ID edit, including clearing the ID field.
The unit cases are in `src/pages/agentIdentity.test.mjs`.

## Run navigation

Open `/tests/run-trace-navigation.html` on the preview server. The page must
report `PASS`. Repeat with `?missing=1` to exercise a source lookup that
returns 404 and succeeds on Retry, and `?absentActive=1` to load the current
Run outside the list response. Use `?long=1` at a narrow viewport to inspect
wrapping. These flags can be combined.

Use `?projectSwitch=1` to switch the mounted monitor across projects while a
summary response is delayed. It checks that requests never mix a new project
with an old Run, old traces disappear, and the late summary cannot replace the
current trace or chat draft.

Use `?checkpointError=403` or `?checkpointError=network` to check that a failed
checkpoint request shows an error and Retry while keeping the recorded ID and
source trace; Retry must load the checkpoint. Use `?checkpointMissing=1` for a
successful lookup with no matching checkpoint, which keeps its distinct empty
message and does not offer an error retry.

The fixture mounts the real ExecutionMonitor, Router and auth provider, and
substitutes only HTTP responses. The project summary contains `current_run_id`
without `run_id`; the source Run is absent from the list response. The router
starts with an old `?run=parent-run` URL. Assertions check the active trace
in the collapsed panel, the source's own trace and exact checkpoint, no
activation, page navigation or chat remount, and closing with Escape and
focus return. A delayed source response after switching projects must not
reopen the old details or expose its trace link. The source view replaces
the former source-row focus assertions because it now shows actual details.

The fixture and its HTTP substitution are separate from the application entry
point. Node rendering and HTTP helper tests remain in
`src/components/monitor/RunTraceNavigation.test.mjs`.

## Chat tool groups

Open `/tests/chat-tool-groups.html` on the preview server. Run
`CHAT_TEST_ORIGIN=http://localhost:4173 node tests/chat-tool-groups.browser.cjs`
with Playwright available, or set `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH`.
The fixture mounts the real chat and substitutes HTTP and SSE responses.
It checks collapsed summaries, keyboard disclosure, live appends, late results,
project/run/revert reset, and desktop/mobile wrapping.

## Project events

Open `/tests/project-events.html`. The page must report `PASS`. The fixture
mounts the real `useProjectEvents` hook and substitutes only HTTP responses:
the event stream replays history the way the backend route does, then sends
`replay_complete`, then delivers live events. It switches Runs A → B → A after
a revert in A and checks that each Run's Events log holds its own history once,
and that the replayed revert neither prefills nor resets the composer. It then
refreshes between `project_reverting` and `project_reverted` twice. An outcome
that arrives live after the replay prefills and resets the composer once. An
outcome that is both replayed and delivered again from the live queue, as the
route does for an event saved while it reads history, appears once in the
Events log and changes nothing else; after a reload the composer text comes
from the chat revert itself (see Chat revert). The pure revert rules are in
`src/utils/revertEffects.test.mjs`.

## Chat revert

Open `/tests/chat-revert.html`. The page must report `PASS`. The fixture
mounts the real ExecutionMonitor and substitutes only HTTP responses. It clicks
Revert to here on a user message, confirms, and reloads the page (unmounts and
mounts it again) while the revert request is unanswered: the composer holds the
message text after the reload and is empty after the next one. It repeats the
reload with the request failing as the page unloads and a project summary that
still carries an older revert's `last_revert_prefill`; the message text wins. A
revert the server has answered, with success or 409, is not restored by a later
reload.
