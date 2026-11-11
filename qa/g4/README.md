# qa/g4 — proposal / accept / undo probes

## Run order matters (fixture dependency)

`compile-fix.mjs`, `conflict-during-generation.mjs` and `structure-protection.mjs`
do **not** create their own project. They read a project id from
`qa/g1/artifacts/02-project-id.txt`, which only exists after G1 probe 02 has run
against the *same* CE database.

If that fixture is missing or stale (e.g. after `scripts/down.sh --purge`, a
`docker compose down -v`, or any volume wipe), these three fail with:

```
TimeoutError: page.waitForSelector: Timeout 60000ms exceeded
  - waiting for locator('.cm-content') to be visible
```

That is a **stale fixture**, not a product regression — the editor is fine; the
navigated project no longer exists. Fix by recreating the fixture first:

```bash
export CE_BASE_URL=http://127.0.0.1:8081
export AILS_ADMIN_EMAIL=... AILS_ADMIN_PASS=...     # from .env, do not commit
node qa/g1/02-project-compile.mjs                    # (re)writes 02-project-id.txt
node qa/g4/compile-fix.mjs                           # then the g4 probes
```

`proposal-accept-undo.mjs` is self-contained; `qa/g5/run-g5.mjs` creates its own
project per run and is also independent of this fixture.

## Note

`reset-doc.mjs` resets the fixture project's document to a known baseline; run it
between g4 probes if a previous probe left the document modified.

Second failure mode (also a fixture problem, not a regression): `compile-fix.mjs`
injects a bad command and expects `Errors1`. If the document has drifted (a previous
run's accept already removed the bad line, or another probe edited it), the probe
reports:

```
[error-compile] {"hasError":false,...}
FAIL g4-compile-fix: assertions failed
```

`hasError:false` right after injecting a bad command means the injection did not take
because the baseline moved — run `reset-doc.mjs` first. Sequence that works:

```bash
node qa/g1/02-project-compile.mjs     # fixture project id (after a wipe)
node qa/g4/reset-doc.mjs              # known baseline document
node qa/g4/compile-fix.mjs
```

A third, environment-only failure: `page.waitForFunction: Target crashed` is a
Chromium renderer crash (memory pressure when several suites run back-to-back), not a
product fault — run the probes one at a time.

## A second kind of stale fixture: the document, not the project

`structure-protection.mjs` asks the model to polish a sentence that must exist
verbatim in the fixture ("As shown in Equation…"). If an earlier probe in the
same batch has edited the document, the model can quote text that is no longer
there, the proposal is refused with `PROPOSAL_INVALID (OLD_TEXT_NOT_FOUND)` —
and that failure appears in the probe output looking like a product defect.

Measured 2026-11-03: failing in a batch run, `PASS` on a freshly recreated
fixture (structure counts identical, recompile clean). The probe now appends
that explanation to the error itself.

Rule of thumb: run `node qa/g1/02-project-compile.mjs` before each structural
probe, not once per batch.
