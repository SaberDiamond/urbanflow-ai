# UrbanFlow AI — 3D Command Dashboard

A browser dashboard for UrbanFlow AI: a 3D city with live traffic, AI signal control, ambulance dispatch with green-wave corridors, and three camera views.

## Run it

```bash
cd dashboard
python3 server.py
```

Then open http://localhost:8000 in Chrome or Safari. It needs no installs (Python standard library only). An internet connection is needed for Three.js, fonts and the model calls.

### Connect Nemotron (Nebius Token Factory)

1. Click the **gear button** next to the controller badge in the top bar.
2. Paste your Token Factory API key, then click **Test connection**. You should see "Connected. Nemotron 3 Nano replied in … ms."
3. Choose **Nemotron** under "Signal decisions made by". The badge shows the live model and its average latency, and the switch reads "AI control".

The key goes only to `server.py` on your computer, which keeps it in memory and adds it to calls to Token Factory. It is never stored in the browser or sent anywhere else. Tick **Also save it to dashboard/.env** to keep it between restarts. `.env` is git-ignored, and the server refuses to serve it.

You can also put the key in `dashboard/.env` before starting:

```
NEBIUS_API_KEY=your-key
NEMOTRON_SIGNAL_MODEL=nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B
NEMOTRON_DISPATCH_MODEL=nvidia/nemotron-3-super-120b-a12b
```

No key yet? `python3 server.py --mock` runs a clearly labelled stand-in model so you can try the flow offline.

**"CERTIFICATE_VERIFY_FAILED" on a Mac?** Python from python.org ships without root certificates. The server now finds them by itself: it uses certifi if installed, then the macOS system file `/etc/ssl/cert.pem`, then the macOS keychain. It prints which one it uses at startup. Verification always stays on. If it still fails, run `pip3 install certifi`, or open Applications › Python 3.x › Install Certificates.command, then restart the server.

### What Nemotron does

| Job | Model (default) | How often | What it decides |
| --- | --- | --- | --- |
| Signal timing | Nemotron 3 Nano | every 4 sim-seconds | which intersections should end their green now, with a reason for each |
| Ambulance routing | Nemotron 3 Super | once per dispatch, when Nemotron is in control (not in the Demo, which uses a fixed route) | which of up to three candidate routes to take, with a reason |

Each call sends a compact snapshot of the city: only the intersections whose green could end, with named fields for the green road, the red road and the cars waiting on each. Nemotron answers in JSON (the server asks for JSON mode, and the dashboard recovers complete entries from a reply that is cut off). The simulation re-checks every decision against the live state before applying it and adds the yellow and all-red clearance itself. A guardrail refuses any switch that would cut a green road still as busy as the red one, and the feed shows those as SAFETY CHECK lines. Feed lines always show the live car counts, followed by Nemotron's reason in quotes when it reads clearly. Emergency preemption stays in code, so a slow or wrong reply can never make a light unsafe. If two calls in a row fail or time out (9 s), the local rules take over and the feed says so. When Nemotron answers again, it resumes control on its own. Reasoning ("thinking") is turned off for these calls to keep them fast; if an endpoint rejects that option, the server retries without it.

**Idle-green safeguard (deterministic, not the model).** The prompt asks Nemotron for at most 6 switches per reply, every 4 s (the code would accept up to 8 from one reply as an internal cap). At every tested density, about 18–20 intersections at a time can have a green nobody is using. So while Nemotron is in control, code also ends a green once it has run its 6 s minimum and then gone 3 s in a row with nobody stopped on it or approaching within 60 m, while cars wait on red.

- **Never touches:** an intersection the Predictive Green Corridor holds or plans.
- **Transitions:** the usual yellow and all-red.
- **Labelling:** shows as IDLE GREEN in the feed, and is counted separately in the demo results.
- **When it runs:** not in local-rules or fallback mode, where the rules already do this.

The snapshot sent to Nemotron also lists the clearest cases first.

The settings panel shows live stats: model calls, average latency, signals switched, routes chosen and tokens used.

## Reading the numbers

**City right now** (sparklines cover the last 3 sim-minutes; hover one to read a point):

| Tile | Meaning |
| --- | --- |
| Cars stopped | Cars standing still right now, out of all cars on the road |
| Time stopped per trip | Average seconds each finished car trip spent stopped, over the last 2 minutes |
| Trips completed | Cars reaching their destination per minute |
| Signal decisions | Greens ended early by the controller per minute. Fixed timers make none |

**Ambulance response** compares average dispatch-to-hospital time for Nemotron, local rules and fixed timers, with the number of trips, seconds held up in traffic and the best trip. Trips where the controller changed mid-way are left out. To fill it for the video: run a few trips with control off, then a few with Nemotron.

## Demo: Cross-Town Emergency (Conventional Traffic vs. UrbanFlow AI)

Click **Demo** in the top bar. The panel shows the scenario and two runs:

| | Run 1 · Conventional traffic | Run 2 · UrbanFlow AI (live Nemotron) |
| --- | --- | --- |
| Ordinary signals | Fixed 18 s timers | Nemotron 3 Nano recommends switches (live via Nebius Token Factory), checked by the safety controller |
| Emergency priority | None. Drivers still make way, and the ambulance crosses red carefully when the intersection is clear | Predictive Green Corridor (deterministic code, not the model) |

**Same start every time.** Seed 4242, rush hour (300 cars) built up for 75 s on ordinary fixed signals, ambulance A-1 dispatched 6 s into the run from Maple St (between 8th and 7th Ave) to Riverside Medical Center. Dispatch happens at an exact simulation time, so Run 1 replays identically. The route is fixed for the comparison (Maple St → 2nd Ave, 10 signals) so both runs cross the same intersections; the route planner (Nemotron 3 Super) is not used in the demo, and the feed says so. Outside the demo, routing works as usual.

**Run 2 needs the live model.** Before Run 2 starts, the dashboard asks the model for a test reply. With no key, or no answer, it shows an error and does not start; it never quietly runs local rules instead. If you start the server with `--mock`, Run 2 runs against a stand-in model and is labelled "stand-in model, not live" everywhere, including the results. If the model fails or is slow during the run, local rules take over (feed: FALLBACK) and the results report for how long.

**While a run is going:** the top bar shows the run, its clock and the ambulance's progress, with **Pause** and **Stop**. The cameras are yours: Chase cam, Omniscient view and Intersection cams all work, and **Intersections ahead** (in Intersection cams) jumps to any signal still ahead of the ambulance so you can watch its queue clear before it arrives. Pausing does not change the run. Dispatch Ambulance, the AI switch and the controller choice are locked during a run.

**Results** (shown when a run finishes, and with **Compare results**): ambulance travel time, time stopped, time held up (under 4 m/s), intersections traversed, car trips per minute, average car waiting time, intersection-seconds of emergency priority, safety violations (conflicting greens and vehicle overlaps, checked during the run), Nemotron calls (answered, failed, latency, switches applied and refused) and any fallback. Everything is measured in the run. Results are kept in this browser until you clear them; **Replay run 1 / 2** runs either again. **Exit demo** returns to the everyday city (190 cars) with your previous settings.

**Feed labels during Run 2:** NEMOTRON = model recommendation that was applied · CORRIDOR = deterministic emergency priority · SAFETY CHECK = a model recommendation the safety controller refused · FALLBACK = local rules covering for the model · IDLE GREEN = the deterministic idle-green safeguard ending a green nobody was using (not the model) · YIELD = drivers making way.

## Map callouts

When an ambulance is dispatched, every signal on its route gets a callout, numbered in order (1/6, 2/6 …) with its live status:

- **Predictive Green Corridor · 3 queued · starts clearing in ~12 s** (blue): planned; the light starts clearing when its own lead time (switch + queue + margin) is reached. If it is already green: **green now · priority in ~X s**
- **Switching to green for A-5** (blue): the corridor is clearing, cross traffic is being held
- **GREEN for A-5 · 6 s** (green): held green until the ambulance is through
- **✓ A-5 through** (grey): shown for a few seconds after it passes
- **Fixed timer · RED now · not pre-cleared** (red): with AI control off, nothing is cleared ahead of it

Overlapping callouts are lifted on longer leader lines instead of being hidden.

## Controls

| Control | What it does |
| --- | --- |
| Dispatch Ambulance (or `D`) | Spawns an ambulance at a random point and routes it to the nearest hospital |
| AI control / Adaptive control switch | Off at start: fixed 18 s timers. On: Nemotron (or the local rules) times the signals and clears ambulance corridors |
| Chase cam / Omniscient view / Intersection cams (or `1` `2` `3`) | Switch camera |
| Omniscient view: drag / right-drag / scroll | Pan / tilt / zoom the isometric city |
| Omniscient view: ⟲ ⟳ (or `Q` `E`), − +, ⌖ | Rotate 90°, zoom, recenter |
| Hover an intersection (Omniscient view) | Shows its signal state |
| 1× 2× 4× | Simulation speed |
| Intersection cams ‹ › | Step through intersection cameras; "Follow ambulance" jumps to the next one on its route |
| Intersection cams: ⟲ ⟳ (or `Q` `E`), drag sideways, scroll | Orbit the camera around the intersection; scroll pulls it back for a wider view |
| Intersection cams: Intersections ahead ▾ | While an ambulance is en route: every signal still ahead of it, with its light for the ambulance's road, the cars waiting there, distance and ETA. Click one to jump the camera there |
| Intersection cams: See-through | Cuts away buildings between the camera and the intersection so the cars stay visible (on by default) |
| Callouts (Omniscient view) | Choose which map callouts show: ambulance route signals, ambulances, hospitals, Nemotron signal decisions, congestion |
| Click a callout | Signal callouts open that intersection's camera; ambulance callouts open the chase cam; hospital callouts zoom to the campus |

## Files

| File | Role |
| --- | --- |
| `src/config.js` | City size (8 × 6 intersections), street names, lanes per road, hospitals, districts, signal timing |
| `src/sim.js` | Traffic simulation: multi-lane roads, lane changes, intersection reservations, the Predictive Green Corridor, cars pulling over for ambulances. `_decide()` is the local-rules signal controller; Nemotron's recommendations are applied through the same safety checks |
| `src/scene.js` | Night isometric city: the traffic grid inside a beltway, a winding river with bridges, varied blocks (downtown, plaza, school, car parks, gas station, construction site), hospital campuses with ambulance bays, suburbs, fields and forest beyond, lamps, instanced vehicles, animated route |
| `src/cameras.js` | Isometric Omniscient view (orthographic) plus Chase cam and Intersection cams |
| `src/ui.js` | HUD, floating info cards, decision feed, KPIs, detection boxes |
| `src/main.js` | Renderer, bloom, main loop |
| `src/nemotron.js` | Nemotron controller: prompts, calls through the local server, applying decisions, fallback |
| `src/demo.js` | Cross-Town Emergency demo: scenario, the two runs, measurements and saved results |
| `server.py` | Local server: serves the dashboard, holds the API key, relays calls to Token Factory |
| `tools/collision-check.mjs` | Headless test: runs the traffic and reports any vehicle overlaps or gridlock |

## Predictive Green Corridor

With adaptive control on (local rules or Nemotron), every signal still ahead of an ambulance is planned from its own numbers. Emergency priority is plain code (`corridorPlan()` and `_preempt()` in `src/sim.js`); the models never control it.

**When a light starts clearing:** once the ambulance's predicted arrival falls inside

`T_activation = T_switch + T_clear + T_margin`

| Term | How it is worked out |
| --- | --- |
| `T_switch` | Time until that approach can show green from the signal's current state: 0 if it is already green (the green is just held), the rest of the yellow plus the all-red, or a full yellow + all-red (4.2 s) if the other road has green. A left turn across oncoming traffic, or a car ahead waiting to turn left, needs the oncoming direction stopped too. |
| `T_clear` | Cars that must get through ahead of the ambulance, in its lane: stopped or slow ones while the light is green, all of them (plus cars about to turn into that road) while it is red. Discharge is 3.0 s for the first car and 2.7 s for each further one, as measured in this simulator, plus 1 s per turning car and the time for the ambulance to cover the length of that queue. If the road beyond is already full (a standing queue), 3 s more, and the next light along starts early enough to drain it. |
| `T_margin` | 3 s plus 8% of the ETA, at most 6 s, because estimates further ahead are less certain. |

**ETA** is route-aware: the time lost getting up to speed from the current speed, cruising at 17 m/s, braking for each turn (5.5 m/s right, 7 m/s left) and speeding up again, and about 0.35 s for each stopped car in its lane that it has to pass. It runs to the point where the ambulance commits to the intersection, is recalculated every step and lightly smoothed so priority doesn't flicker.

**States** (`sim.corridorState(node)`): NORMAL → PLANNED (inside 10 s of needing to start; an existing green for the ambulance is not allowed to end) → CLEARING (switching, or queue still leaving) → PRIORITY_ACTIVE (green, its lane clear) → RELEASED (the ambulance has passed: normal signals right away, and 9 s before the intersection can be held again).

**Re-planning:** if the ambulance ends up more than 10 s later than predicted (stuck elsewhere), a hold is released so cross traffic can move, and it is planned again. This never happens while the ambulance is on that intersection's approach, inside it, or within 12 s of it.

**Hospital:** the light beyond the hospital entrance is not held unless its queue has backed up past the driveway.

## How the traffic stays collision-free

- **Intersections are reserved.** Before a vehicle enters, it checks every vehicle already inside. Every pair of paths through the intersection was tested ahead of time, using car-sized footprints between cars and ambulance-sized footprints whenever an ambulance is involved, so a vehicle waits if its path would touch an occupied one. It also needs room on its exit lane, so nobody stops inside the box.
- **Left turns yield** to oncoming cars that are about to arrive.
- **Emergency priority never creates conflicting greens.** If the ambulance's approach is already green and nothing conflicts, that green is simply held; otherwise only the ambulance's approach gets green and every other direction is held red.
- **Ambulances may cross on red, carefully.** If the intersection is plainly empty they slow to about 30 km/h and drive through. When an ambulance comes up behind a queue at a red light, the cars ahead of it edge through the red one at a time once no cross traffic is coming, at walking pace, and the ambulance follows the same way. Cross traffic that sees it holds back. It still loses time compared with a green corridor, which is the point of the comparison.
- **Cars move over.** On two-lane roads they change into the outer lane. On one-lane roads they edge to the curb and stop, and the ambulance edges toward the centre line to pass. If the ambulance stops making progress, cars give up waiting, so nothing deadlocks.

- **Ambulances pull into the hospital.** Each hospital has a forecourt with three ambulance bays under a glass canopy. Routes finish on a road with the campus on the right, the ambulance waits until the lanes it crosses are clear, then drives into a free bay, switches its lights off and stays parked for a while.

Run the check before recording a demo:

```bash
cd dashboard
node tools/collision-check.mjs 10        # 10 sim-minutes, adaptive and fixed-timer modes
node tools/collision-check.mjs 10 42     # same with a different traffic seed
node tools/collision-check.mjs 10 4242 300   # rush-hour density, as in the demo
```

It should report `overlaps 0` and `stopped >90s 0` for both modes.

## Where this is heading

- **Next:** record the video, publish the repo and submit.
