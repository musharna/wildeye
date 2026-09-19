# Lessons

One line per miss: the class of miss and the mechanism that now catches it.

- 2026-09-18 (R13-M3): a client method made a second request for data only one caller shows, adding a failure path for callers that never use it; the lookup moved to the caller that shows the name, pinned by a test that maps an EXACT synonym while the lookup fails.
- 2026-09-18 (R13-M4): only one of two entry points advanced the cancellation generation, so a stale async answer overwrote a newer choice; every entry point now starts a new choice, pinned by a race test and a test that fails when the lookup drops its abort signal.
- 2026-09-18 (R13-M5): a key handler on one part of a composite widget (the combobox input) let the same key from its other part (the listbox) reach document listeners; the handler is on both, pinned by a unit test and the qa `escape` Tab-to-suggestion step.
- 2026-09-18 (R13-M8): a container that fills with long content was itself an aria-live region; the card is labelled instead and a separate one-line status region announces, pinned by a markup test.
