# WebKit camera startup test investigation (#17 / #18)

## Observed failure and cause

At `dbc5d2ae21699c6dee447eb108ef3875ea5a02f6`, [run 39124658457](https://github.com/ishiishikou/mi-tsuketa/actions/runs/39124658457)
failed the ordinary integration suite on the third camera start. `getUserMedia`
returned a live synthetic track, but native `video.play()` had not resolved,
`readyState` was 0, and the new detector had not started. All three isolated
WebKit jobs passed at the same commit; that alone did not establish stability.

The old startup helper advanced the Playwright clock 50 times by 100ms and
treated that as five seconds available to the media pipeline. This assumption
was incorrect: the JS clock controls canvas painting and application timers,
but does not accelerate native canvas capture/video delivery.

The app-free probe in `tests/browser/diagnose-camera.mjs` demonstrated the
clock mismatch in job 117667140444. Session 3's virtual five seconds completed
in 134ms real time with only one presented frame. Observing the same live stream
for another 102ms real time produced further frames. With the real-time gate,
all three sessions presented at least two frames in about 303–306ms.
This identifies a faulty test synchronization mechanism; it does not prove a
WebKit engine defect, nor does it establish the exact internal reason for every
historical stalled sample. MediaDevices wrapper replacement was not observed.

## Fix and regression coverage

- Keep native `video.play()`. Wait at most five **real** seconds for the current
  session's resolved play, two presented frames, valid video dimensions and
  readyState, and its own new inference. Then advance the game clock.
- Keep deterministic simulated `currentTime` for game-state scenarios, and
  explicitly distinguish that simulation from native frame delivery.
- Add a separate Chromium/WebKit lifecycle scenario using native `currentTime`
  and unaccelerated timers (only the date is fixed for the daytime rule).
  Start, choose, and stop three sessions; each must advance native video time,
  frame count and inference count. All old tracks must end, each detector must
  close, `srcObject` must clear, and counters must stay unchanged after stop.
- Preserve full-round, peek cleanup, face recovery, six-width animation-boundary,
  tap-target and reduced-motion assertions. No retries, skips or relaxed asserts
  are added. The independent-VM workflow requires all four WebKit scenarios,
  including the separate decorative-overflow regression described below.
- Diagnostics contain only scalar counters/states and synthetic-source data;
  no camera pixels, face images or face features are logged.

## Running and interpreting results

The first fixed-camera CI (run 39238110733) passed the native lifecycle checks
but exposed a separate layout-test failure: at width 320, the animation-start
sample was 8.016px left of center with identity transform. The test restarted
celebration by changing `data-motion` away from `happy`, which also changed
`left` from 26% to 23% and width from 48% to 54%. This introduced an artificial
layout transition (3% of the 276px forest is 8.28px). Restarting only
`animation-name` preserves the found layout, but did **not** solve the failure:
run 39238789024 still measured -8.016px, with correct computed left (71.75px)
and no active transitions. The transition-only hypothesis is therefore insufficient.

The forest used `overflow:hidden` around deliberately oversized decorations.
That clips visually but still permits internal scrolling, unlike `overflow:clip`.
Change the forest to `clip` and verify that programmatic scroll, focus and
scrollIntoView cannot pan it at all six widths. The layout-only regression also
logs a control using the old `hidden` style and an 8px scroll to compare with the
observed displacement. The integrated animation samples record and assert zero
forest scroll offsets; no test resets offsets to hide a failure. The initiating
browser focus/resize sequence for historical failures was not directly recorded.

Run the usual `npm run check`, `npm test`, `npm run build`, and
`npm run test:browser`. The PR workflow also runs all WebKit scenarios on three
fresh GitHub-hosted VMs, sequentially with `fail-fast: false`. All four jobs
must succeed on the final head. The app-free probe is diagnostic evidence,
not a pass/fail substitute for integration tests.

See Issue #17 and PR #18 for the exact final SHA, CI result and review handoff.
Synthetic browser coverage is not iPhone Safari hardware validation; real-camera,
PWA and device-specific behavior remain in #12/#13. No application runtime
changes are made to the camera lifecycle. The only application change is the
forest overflow policy; the camera synchronization fix is test-only.
