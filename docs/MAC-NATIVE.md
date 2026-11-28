# Phase 2: a Mac-native setup

Goal: on a Mac with Bambu Studio installed, the MCP prints, pauses, resumes, stops, reads status and camera for a
cloud-mode printer (no LAN Only, no Developer Mode) **without the Lima VM or the FULU bridge**, and starts in seconds.

## Outcome of the 2026-11-27 hardware spike (read first)

**The native plug-in route is blocked for signed actions.** Loaded by `native/bambu-native-print`, Bambu Studio's
02.09.02.62 plug-in refuses `start_local_print` with `-26` (`BAMBU_NETWORK_SIGNED_ERROR`; Studio's text: "Your software
is not signed, and some printing functions have been restricted") and never installs the printer certificate, so Pause
fails with `-4`. The plug-in checks the code signature of the process that loads it (Studio is signed by Bambu, team
`T3UBR9Y3B2`; the helper is ad-hoc). Unsigned actions (upload, `system.ledctrl`) still work. `BAMBU_NATIVE_CONTROLS=x1c`
therefore stays off; steps 1–4 below are superseded for X1C.

**What works instead: FULU's bridge in an Apple container.** `scripts/fulu-apple-container.sh` runs FULU's x86-64 Linux
host under QEMU 10 user-mode emulation in a native arm64 container (`scripts/fulu-host-qemu.Containerfile`): no x86
kernel boots, the bridge is up in about 4 s instead of a minute, and only the runtime, the bridge's config folder and
`TMPDIR` are mounted. Rosetta cannot run it: the plug-in's initializer reads its parent's command line and
`/proc/self/maps` (an anti-tamper check) and dies with SIGBUS; QEMU 8 crashes at the same point. Verified on the X1C
(firmware 01.12.01.00, cloud mode, no Developer Mode): print, Pause, Resume and Stop, each confirmed by a fresh MQTT
report. Resume of a job FULU placed asks a person to confirm, because the printer's copy cannot be re-read over FTPS
(550).

Setup, once: `container system start`, `container system kernel set --recommended`, then
`container build --platform linux/arm64 -t fulu-host-qemu:2 -f scripts/fulu-host-qemu.Containerfile scripts`. Point
`BAMBU_NETWORK_BRIDGE_COMMAND` at the wrapper (keep `PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION`) and keep `TMPDIR` in a
private folder under your home.

## Where things stand (fork base 1.1.103, 2026-11-24)

The working setup on the reference machine (X1C, cloud mode, AMS) uses three routes at once:

| Job | Route today | Why |
| --- | --- | --- |
| Print | FULU bridge (`bambu_network`, `lan`) through a Lima **x86 Linux VM under emulation** | Default chosen so Stop works |
| Pause / resume / stop | FULU bridge | Direct MQTT controls need Developer Mode on X1C |
| Status, AMS, HMS | Direct LAN MQTT (read-only works without Developer Mode) | — |
| Camera | RTSPS via Homebrew ffmpeg | — |
| Slicing | Bambu Studio CLI (native) | — |
| Native print / upload | `bambu_native`: `native/bambu-native-print` loads Bambu Studio's own networking plug-in | Proven for X1C upload, 2026-11-24 |

Costs of the VM route: ~1 min cold boot under emulation, a `TMPDIR` under `~` hack so the guest can see job files,
an ABI pin (`PJARCZAK_EXPECTED_BAMBU_NETWORK_VERSION`), and an upstream bridge that labels macOS work in progress.

The key finding: the native helper already sends printer commands through the plug-in
(`--command` / `--command-authorized` → `send_message_to_printer`), and `src/index.ts` already routes
pause/resume/stop/heater-off natively — but only for X2D (`nativeUnavailableReason` returns
"The selected printer is not an X2D."). Bambu Studio itself sends these controls to cloud-mode X1Cs through the
same plug-in, so lifting that gate is the likely path to retiring the VM.

## Steps

### 1. Spike: native controls on X1C (decides the plan)

Prove the plug-in authorizes controls for a cloud-mode X1C on LAN:

1. Harmless command first: chamber light off/on (`system.ledctrl`) through `--command-authorized`.
2. A sacrificial print (a 2-layer square): pause, resume, stop through the native helper, confirmed by fresh MQTT
   status each time.
3. Record what the plug-in needs: Studio logged in? which config dir? per-command connect time?

Exit: all three controls confirmed on hardware → continue. If the plug-in refuses, the fallback is keeping FULU
for controls only, and the rest of this plan still applies.

### 2. Native controls for every model on macOS

Experimental implementation: set `BAMBU_NATIVE_CONTROLS=x1c` (comma-separated
model list) to route X1C Pause/Resume/Stop (not heater-off yet) through the native
helper on macOS. It requires `BAMBU_MODEL=x1c` and a matching `00M` serial.
The default stays unchanged until step 1 passes on hardware. Other new models
remain ineligible. Choose `counterpart_print_route(route="native")` explicitly
to use native printing; this does not enable experimental controls by itself.

Controls use a separate `~/.config/bambu-printer-mcp/bambu-native-control`
directory (override with `BAMBU_NATIVE_CONFIG_DIR`). The helper waits for the
certificate (`BAMBU_NATIVE_CERT_WAIT_MS`, default 6000) and then the matching
command/sequence reply (`BAMBU_NATIVE_COMMAND_REPLY_MS`, default 6000).
A successful publish alone is reported as dispatched, unconfirmed. Stop retries
one explicit pre-dispatch connection timeout within a 60-second overall deadline;
dispatch uncertainty never triggers replay. Check printer status and job name
before manually retrying an unconfirmed control.

Validation for this implementation is mocked only; the hardware spike remains open.

- Replace the X2D-only gate with a per-model capability (start with X1C; others as hardware evidence arrives).
- Keep the shared safety gate: fresh observed identity, the job observed before a control, stop and heater-off
  never prompting.
- Add a `native` option to `counterpart_print_route` and make it the macOS default once step 1 passes.
- Regression tests at the mocked plug-in boundary for X1C routing, plus X2D unchanged.

### 3. A persistent native agent

The helper is one-shot today: each command loads the plug-in, connects, sends and exits. Make it a long-lived
child process (stdio JSON lines) that keeps the plug-in connection open:

- Fast controls (no reconnect per Stop), and a single connection for print + controls.
- Status push through the plug-in as a second source beside direct MQTT.
- Bounded per-command deadlines and no replay of a command whose fate is unknown (keep the existing rules).

### 4. Bambu Studio plug-in drift

The helper mirrors the plug-in's C++ ABI (`PrintParams` layout). Studio updates can move it.

- Read the installed Studio and plug-in versions at start; compare against a table of verified layouts.
- Fail closed with a plain message ("Bambu Studio 2.9.3 isn't verified yet; native printing is off") rather than
  calling into an unknown layout.
- A `--check-layout` helper mode that reports the plug-in's version and symbol set for verifying a new Studio.

### 5. Setup and diagnosis

- `npm run setup:mac`: checks Bambu Studio, plug-in version, native helper build, ffmpeg, CAD runtime and printer
  reachability; prints what is missing and the exact fix.
- Move printer settings from `launch.sh` exports into a config file read by the server; `launch.sh` shrinks to
  `exec node dist/index.js`.

### 6. Retire the VM

Once steps 1–3 hold for a week of normal use: drop the Lima/FULU lines from `launch.sh`, keep the bridge as an
opt-in fallback documented in docs/FULU.md, and stop the VM.

## Also queued (from the 2026-11-24 dimetrodon session)

- Floating-region locations for 3MF input (reuse the `counterpart_part_meshes` extraction).
- A mesh-mode printability report: downward faces, bed contact, and **shallow bottom ridges** — an edge whose
  neighbouring faces are both steep enough can still overhang when the edge itself rises at under 45°; that
  printed spaghetti under a raised head and tail. Neither the slicer's floating check nor a face-angle check sees it.
- `design_guidance` names for `cad_design`, `fdm_design` and `fdm_slicing` (tools-only clients can't read them).
- `counterpart_print_assess` returns the whole flight record (~66k characters); return the observation only.
- `counterpart_print_record` captured only the first-layer frame in 20 layers before a failure; check the periodic
  sampling.
- The perspective render's wide angle exaggerates the nearest part.

## Validation limits

Mocked tests prove routing, not hardware behaviour. Each control claimed on a model needs a fresh MQTT
observation on that model, recorded with firmware and Studio versions.
