# UrbanFlow AI: Development Log

This is the public development history of UrbanFlow AI, built for the Nebius x NVIDIA Global AI Hackathon 2026 (Physical AI track). It records how the idea started, what was proposed, what was actually built, what failed, and why each major decision was made.

For setup and the current feature set, see [README.md](README.md). All performance figures below come from the project's own simulators (SUMO in the early phases, the custom JavaScript simulation later). None are real-world measurements.

**Status legend**

| Label | Meaning |
| --- | --- |
| Proposed | In the original proposal, not built |
| Implemented | In the current code |
| Tested | Implemented and measured in simulation |
| Future | Planned beyond the hackathon |

---

### Original Idea: Raw Freewrite

The first description of the idea, kept exactly as written:

> Okay so let's say I want to build like an AI tool where let's say it either uses cameras of traffic intersections and/or GPS of phones. and basically it controls future traffic signals based on traffic flow. This also helps with Police work and embulance emergency where for the police work it could either be chasing someone and sort of helps with the diverting the person they are chasing, or if an ambulance comes in the way it makes sure that it is more safe for the intersections to cross by making it red for everyone but for the way the ambulance intends to go, and this basically works out by the ambulance report via GPS telling the agent per se to it's end location of the hospital or where the person they are going to is at. There are defentiley some build up to this idea needed for as a base how does this sounds how will this fit into for this hackathon  

---

### Initial Project Proposal

The freewrite was then turned into a formal proposal. The scenario section is reproduced below as a historical record. It describes the original vision, not the system that was built.

> Project Proposal: UrbanFlow AI – Dynamic Physical AI Traffic Signal Management & Emergency Routing System
>
> Executive Summary & Elevator Pitch
>
> UrbanFlow AI is an autonomous, vision- and telemetry-driven Physical AI system designed to dynamically optimize municipal traffic signal networks. Traditional signal controllers rely on static timers or basic induction loops, resulting in severe urban congestion, delayed emergency response times, and ineffective pursuit management during law enforcement actions.
>
> By combining real-time camera computer vision feeds with telemetry data (GPS/ambulance reports), UrbanFlow AI deploys an agentic decision system powered by NVIDIA Nemotron running on Nebius AI Cloud. The platform dynamically adjusts signal timing to eliminate bottlenecks, opens instant "Green Corridors" for high-priority emergency vehicles, and enables tactical signal manipulation for law enforcement routing. Demonstrated through a high-fidelity simulation, UrbanFlow AI proves how Physical AI can modernize urban transportation infrastructure.
>
> ---
>
> Targeted Problem & Real-World Scenarios
>
> Scenario 1: Gridlock and Intersection Idle Time
>
> -   The Problem: Fixed-timer signals hold lights red even when intersecting lanes are completely empty, needlessly building traffic queues and increasing emissions.
> -   The AI Solution: Continuous visual monitoring detects real-time queue density, dynamically extending or shortening signal phases to maximize vehicle throughput across the grid.
>
> Scenario 2: Emergency Medical & First Responder Transit
>
> -   The Problem: Ambulances and fire engines lose critical minutes navigating congested intersections, facing high risks of broadside collisions when crossing on red lights.
> -   The AI Solution: The system consumes destination telemetry directly from incoming emergency reports via GPS. It calculates the vehicle's arrival time at subsequent intersections and establishes a progressive wave of green lights while holding opposing directions red.
>
> Scenario 3: Tactical Traffic Containment for Law Enforcement
>
> -   The Problem: High-speed police chases put civilian lives at risk when fleeing suspects weave through uncontrolled traffic.
> -   The AI Solution: Utilizing target trajectory prediction and camera tracking, the AI subtly manipulates signal phases along escape routes—holding suspects at controlled intersections while opening clear, safe passage for pursuing officers.
>

The full proposal also suggested:
- a vision-language model reading intersection camera frames;
- OpenCV/TensorRT perception;
- a multi-agent design;
- SUMO with TraCI as the simulator;
- a Streamlit or Next.js + Mapbox dashboard;
- a KPI panel showing example figures such as "38% faster transit time";
- priority tiers for two emergency vehicles meeting at one intersection;
- fallback to fixed timers when the model is slow;
- an A/B comparison mode.

The "38%" was an illustrative example in the proposal, not a measurement.

**Proposed vs. what exists now**

| Proposed | Status | Notes |
| --- | --- | --- |
| Adaptive signal timing from live queues | Implemented, tested | Nemotron 3 Nano recommends switches; queue data comes from the simulation, not cameras |
| Ambulance green corridor from destination and ETA | Implemented, tested | Predictive Green Corridor (deterministic code) |
| Ambulance route planning | Implemented | Nemotron 3 Super picks among candidate routes (not used in the locked-route demo) |
| Camera-based perception (vision model, OpenCV/TensorRT) | Future | Never built; queues are read directly from the simulation |
| Phone or ambulance GPS telemetry | Future | Ambulance position comes from the simulation |
| Police pursuit containment | Dropped | Removed from the MVP on Oct 14, 2026; would need ethical and legal review |
| Two emergencies at one intersection | Implemented | First come, first served; the second gets green right after (not a priority-tier system) |
| Fallback when the model is slow or fails | Implemented, tested | Falls back to local rules, not fixed timers |
| A/B comparison | Implemented, tested | Cross-Town Emergency demo, run sequentially rather than side by side |
| SUMO + TraCI simulation | Built, then replaced | See phases 2 and 3 |
| Streamlit / Next.js + Mapbox dashboard | Not used | React/Vite + Three.js in the SUMO era; plain Three.js now |

---

### Narrowing to the MVP

The proposal covered too much for a hackathon with no hardware. On **Oct 14, 2026** the scope was locked to two problems that could be shown end to end in simulation:

1. **Everyday congestion:** adaptive signals reacting to queues.
2. **Ambulance response:** route choice plus an emergency corridor.

**What was dropped or deferred, and why:**
- **Police pursuits:** dropped. They added risk and controversy without strengthening the core demo.
- **Fail-safes:** deferred until the MVP worked end to end.
- **Camera perception:** postponed. NVIDIA Cosmos was parked because it was not in the Token Factory lineup and would have needed separate GPU jobs; a vision-capable Nemotron model was noted as the cheaper future path.

**Two architectural rules were set at the same point:**
- The model is never inside the per-frame simulation loop. It decides every few seconds, and its decisions are applied to the simulation.
- Safety stays in deterministic code.

---

## Development Phases

### Phase 1: Problem identification and research (Sep 2026)

**Objective.** Turn the freewrite into a project that fits the Physical AI track and can be demonstrated without real infrastructure.

**Technical challenges.**
- The track expects a physical system.
- There was no access to real signal controllers, intersection cameras or ambulance telemetry.

**Architectural decisions.**
- Prove the idea in simulation.
- Use NVIDIA Nemotron models served through Nebius Token Factory for decisions.
- Treat the video as the demonstration of the physical behaviour (the track asks for at least a minute of the key modules in action).

**Model choice.** Nemotron 3 Super was preferred over Ultra for its balance of reasoning and responsiveness. The split between Nano and Super was left open until integration.

**Results.**
- The written proposal and the Physical AI track choice.
- A clear statement of the problem: fixed-time signals waste green time, and ambulances meet queues that nobody cleared for them.

### Phase 2: Early SUMO experimentation (Sep 20 – Oct 13, 2026)

**Objective.** Build the traffic foundation on an established simulator and test whether a language model can safely improve signal control.

**Implementation.**
- Eclipse SUMO 1.27 with SUMO-GUI (XQuartz on macOS) and TraCI from Python.
- A generated urban grid with signalised intersections and simulated traffic.
- A SUMO driver collecting vehicle counts, phases, lane states, queues and waiting times; a 300-step run verified clean startup, telemetry and shutdown.
- A live 3D view, built with React, Vite and Three.js, streaming SUMO state over WebSocket.
- An **advisory** Nemotron pipeline (`nvidia/Nemotron-3_5-Lightning`).
- A deterministic validator and capability-protected "guarded actuation" layer.
- A route-aware emergency corridor: a 22 s lead, a three-signal horizon and an 8 m/s floor on the ETA.

**Technical challenges and findings.**

*Model output.* Schema-valid advice could still be factually wrong. One recommendation came with 0.95 confidence while misstating the traffic facts it was based on. This is why every model decision is re-checked against the live state.

*Signal control.* In repeated experiments, safe model-guided interventions **did not beat SUMO's native actuated signal control**. The conclusion recorded at the time was "safe does not imply useful".

*Emergency corridor.* Tested on five held-out seeds:

| Measure | Without corridor | With corridor | Change |
| --- | --- | --- | --- |
| Mean ambulance travel time | 62.84 s | 55.98 s | −10.9% |
| Ambulance waiting time | 6.60 s | 0.18 s | — |
| Civilian waiting time | 3.83 s | 4.76 s | +24.1% |

Results were mixed: three seeds improved and two got worse.

**Results.**
- A working SUMO stack with 87 Python and 5 JavaScript tests.
- Two lessons that carried into the final design: validate every model output deterministically, and an emergency corridor helps the ambulance at a real cost to everyone else, so its timing matters.

### Phase 3: Transition to the custom simulation (Oct 14 – Oct 20, 2026)

**Objective.** Build a dashboard judges could understand in seconds, and a simulation fully under the project's control.

**Technical challenges.**
- The SUMO view looked too plain for a demo.
- Bridging SUMO to a browser added moving parts and recording risk.
- The SUMO-era experiments had shown that the hard problems were in the control logic, not in the simulator.

**Architectural decisions.**
- An in-browser JavaScript simulation was written as a stand-in. It mirrored what SUMO provides (vehicles on lanes, signal phases, queues, waiting times), so SUMO could have been reconnected later.
- **On Oct 20, 2026, SUMO was dropped.** The custom simulation became the real one: self-contained, controllable and low-risk to record.
- A rule-based controller was added as a stand-in for the model, ending empty greens and serving long queues.

**Implementation.**
- A 5 × 4 grid with one lane each way, fixed 18 s timers when AI is off, and ambulance dispatch to the nearest hospital.
- A first corridor that went green about 14 s before arrival and recalculated the route at each intersection.

**Results.**
- Early stand-in numbers (8 dispatches each way):

  | Measure | Rule-based controller | Fixed timers |
  | --- | --- | --- |
  | Ambulance trip | 0:23 | 0:43 |
  | Average car wait | 17 s | 30 s |

  These came from a simulation that, as phase 4 showed, still allowed collisions. They are kept here as history, not as results.
- SUMO is no longer part of the code, and this phase remains in the log only as project history.

### Phase 4: Traffic behaviour and collision safety (Oct 20 – Oct 28, 2026)

**Objective.** Make the traffic believable and provably free of collisions and gridlock.

**Technical challenges and fixes.**

*Root cause of collisions.* Cars kept gaps within a lane but had no rules inside intersections: left turns didn't yield, merges weren't checked, and the ambulance ignored crossing cars.

*Intersection rewrite.*
- Multi-lane roads and lane changes.
- Intersections reserved before entry: every pair of paths through an intersection is checked in advance, and a vehicle enters only when its path is clear and its exit lane has room.
- Left turns yield to oncoming traffic, and right turns have a proper radius.

*Display offset.* Cars had been drawn half a car-length ahead of their simulated position, which made them look like they were colliding.

*Ambulance interaction.*
- Cars pull over: into the outer lane on two-lane roads, or to the curb on one-lane roads.
- With normal signals, an ambulance at a red light crosses cautiously when no cross traffic is coming, and the cars in front of it edge through to make room, as real ones do.
- After a corridor, the held directions get a 9 s recovery green, after back-to-back ambulances were found to starve one approach.

*Queues stalling at green.* About two in three green starts had the front car waiting over 1.5 s, about 5 s on average. Two causes:
- Car-to-car paths were checked at ambulance size. They now use car-sized footprints, with the larger footprint kept wherever an ambulance is involved.
- Left-turners from the other side jumped ahead of the straight-through queue. They now give way to the first oncoming car waiting at the line.

*Smoothness.* Lane changes became eased S-curves; peak sideways jerk fell from about 60 to 22 m/s².

*Ambulance waiting at its own green.* Cars beyond the intersection had been pulling over too early and filling the space it needed. Time spent stopped at green lights fell from 31.6 s to 10.9 s across three runs.

**Architectural decisions.**
- A headless collision checker (`dashboard/tools/collision-check.mjs`) became the quality gate, run before every recording.
- The city grew to an 8 × 6 grid with mixed one- and two-lane roads and three hospitals, with forecourt bays where ambulances park.

**Results.** Every change was gated on 0 vehicle overlaps and 0 vehicles stuck over 90 s:
- across several seeds, both with adaptive and fixed signals;
- including 30-minute runs and rush-hour density (300–360 cars).

The checker found and fixed several deadlocks, including cars waiting for a blocked ambulance, signals held for a rerouted ambulance, and an ambulance looping near a stop line.

### Phase 5: 3D dashboard (Oct 14 – Oct 28, 2026)

**Objective.** Show the system clearly enough that a judge can follow an ambulance and every decision made for it.

**Architectural decisions.**
- Plain Three.js with ES modules and no build step, served by the local server.
- A night isometric "diorama" look with a dark, in-car-display style.

**Implementation.**
- Three camera modes:
  - **Omniscient** view: isometric, with pan, zoom up to 14×, tilt and rotate.
  - **Chase** cam.
  - **Intersection** cams: mounted over the road (earlier positions sat inside corner buildings), with orbit, pull-back, a see-through mode, and an **Intersections ahead** list.
- Numbered map callouts for each signal on the ambulance's route, clickable to open that camera.
- A plain-English decision feed that names who acted.
- KPI tiles with sparklines and an ambulance-response comparison panel.
- Instanced cars and merged building geometry keep about 190–300 cars smooth.

**Results.**
- A dashboard that opens on fixed timers with AI off, so a demo can start from the baseline.
- Tested at desktop and phone width in a headless browser.

### Phase 6: Nemotron and Nebius integration (Oct 20 – Oct 24, 2026)

**Objective.** Put real NVIDIA models in the decision loop without letting them compromise safety.

**Architectural decisions.**
- **Option B of the model plan:**
  - Nemotron 3 Nano for frequent signal decisions, called every 4 simulated seconds.
  - Nemotron 3 Super only on ambulance dispatch, to choose a route.
- A local Python server (standard library) relays calls to Nebius Token Factory and keeps the API key on the user's machine.
- Every recommendation passes through deterministic checks: a guardrail against cutting a busier green, and system-inserted yellow and all-red. Emergency priority never depends on the model.
- Fallback to local rules after two failed or two slow replies, with automatic recovery.

**Technical challenges and fixes.**

*macOS certificates.* The first live test failed with `CERTIFICATE_VERIFY_FAILED`, because python.org builds of Python ship without root certificates. The server now finds certificates through a fallback chain, and verification always stays on.

*First live run (Oct 20).* Replies came back in about 1.3 s, but there were four problems:

| Problem | Fix |
| --- | --- |
| Some replies weren't valid JSON, triggering fallbacks every half minute | JSON mode, plus recovery of complete entries from cut-off replies |
| Garbled reasons, and switches that cut a busier green | Named fields in the snapshot, an example in the prompt, and the guardrail |
| Every trip counted as "controller changed mid-trip" | Each trip is credited to the chosen controller, with fallback seconds reported |
| The corridor was announced before Super had chosen a route | Announced only after the choice |

*Second live run (Oct 24).*
- No fallbacks and sensible reasons.
- Ambulance trips under Nemotron control were about 0:24–0:29 in the everyday city.
- Reasons that named the wrong road are now dropped from the feed.

**Results.** Both models working live through Token Factory, with deterministic validation and fallback.

### Phase 7: Predictive Green Corridor (Oct 24 – Oct 28, 2026)

**Objective.** Give the ambulance green lights exactly when it needs them, with as little disruption to cross traffic as possible.

**How the name evolved.** During development the original fixed-window corridor was called V1 and its replacement "Predictive Green Corridor V2"; the V2 label briefly appeared in the dashboard and feed (`CORRIDOR V2`). Once the fixed-window rule was retired, the finished algorithm took the single name **Predictive Green Corridor**. The earlier rule and its measurements are kept below as history.

**Starting point.**
- The original corridor used a fixed activation window, $T = 20 + \min(22,\ 2.5Q)$ seconds, where $Q$ is the number of stopped cars on the approach.
- The window was briefly widened on Oct 25 so longer queues started clearing earlier.

**Audit (Oct 28, no code changes).** The corridor worked for the ambulance: it never stopped, and queues had cleared by the time it arrived. But it was far too generous:

| Finding | Detail |
| --- | --- |
| Early greens | 10–25 s before arrival (median hold 15 s) |
| Simultaneous holds | Up to 5–6 intersections at once |
| Cross-traffic queues | Up to 15 cars |
| Unbounded holds | No timeout (worst case 87 s) |
| Weak queue term | Rarely mattered |
| Dead lookahead limit | The 48 s cap never applied |
| ETA error | Up to 13 s, from a speed floor |
| Blocked roads ignored | A full road beyond the intersection wasn't considered; one ambulance sat about 80 s at a green held for it |
| Hospital corner | Held 31 s for an ambulance that turned in before reaching it |

**Implementation.** Each intersection gets its own lead time:

```math
T_{\text{activation}} = T_{\text{switch}} + T_{\text{clear}} + T_{\text{margin}}
```

- **Signal state:** the switch time comes from the current signal state.
- **Queue discharge:** clearance time uses rates measured in this simulator (3.0 s for the first car, 2.7 s for each after).
- **Margin:** grows with the prediction horizon.
- **ETA:** route-aware, covering acceleration, cruise, turn slowdowns and cars to pass.
- **States:** intersections move through NORMAL → PLANNED → CLEARING → PRIORITY_ACTIVE → RELEASED. Existing greens are held rather than switched, and holds are re-planned only when the ambulance falls well behind schedule.

The README has the full description.

**Supporting fixes found while benchmarking:**
- Ambulance/car paths are checked at each vehicle's own size.
- Cars on two-lane roads no longer stop or crawl in the ambulance's lane.
- Left turns can go at the end of the oncoming green.

**Results.** 58 ambulance trips; 5 routes × 4 seeds × 190/300/360 cars; local-rules controller:

| Metric | Before | After | Change |
| --- | --- | --- | --- |
| Ambulance travel time | 40.8 s | 41.0 s | +0.2 ± 1.0 s, not significant |
| Intersection-seconds under priority | 125.9 | 91.7 | −27% |
| Hold per intersection | 17.6 s | 13.3 s | −25% |
| Cross-traffic queue-seconds | 440.5 | 353.6 | −20% |
| Conflicting greens | 0 | 0 | — |

- **Isolating the algorithm:** compared with the old rule on the same supporting fixes, the new algorithm alone gave −25% priority time and −12% cross-traffic queueing, for +0.4 ± 0.5 s of ambulance travel time.
- **ETA accuracy:** mean error fell from 3–9 s to 1–3 s.

**Negative results kept on record:**
- Some short routes became slightly slower.
- Under extreme stress (360 cars, an ambulance every 20 s), one seed developed a left-turn jam away from any corridor in both versions, and it was worse with the new code (14 stuck cars vs 5).

### Phase 8: Testing, evaluation and final demo (Oct 24 – Oct 29, 2026)

**Objective.** A repeatable, honest comparison between conventional signals and UrbanFlow AI.

**Iterations.**

| Version | Change | Reason |
| --- | --- | --- |
| Oct 24 | Two ambulances, three controllers and automatic camera cuts | First repeatable scenario |
| Oct 24, revised | Simplified to one ambulance, manual cameras | Easier to record |
| Oct 25 | Lengthened to a cross-town route | The first live comparison showed only 0:42 vs 0:38: the route was too short, and cautious red-light crossing was nearly as fast as a green |
| Oct 27 | Rush-hour density | Too few queues to show the difference |
| Oct 27 | Removed at the user's request | To be redesigned |
| Oct 28 | **Cross-Town Emergency** | Final design, below |

**Final demo design (Oct 28).**
- **Identical starts:** seed 4242, 300 cars, 75 s build-up on fixed signals, and an ambulance dispatched at an exact simulation time.
- **Same route in both runs:** Maple St → 2nd Ave, 10 signals. Nemotron 3 Super route choice is therefore not used in the demo.
- **Run 1:** fixed 18 s signals.
- **Run 2:** live Nemotron 3 Nano plus the Predictive Green Corridor.
- **Honesty checks:**
  - Run 2 confirms the model answers before starting.
  - A mock server is labelled "stand-in, not live" everywhere.
  - Fallback time is reported.
  - Every result is measured in the run.

**Results (headless test, Oct 28):**
- 22 of 22 checks passed.
- Run 1 replayed identically at 1:17.
- Run 2 with the offline stand-in model took 0:55. This is **not** a Nemotron result.
- 0 conflicting greens and 0 overlaps.
- Run 2 refused to start with no key or an unreachable endpoint.
- The final collision sweep was clean on 14 runs in both modes.

**Late fix: unused greens under Nemotron control (Oct 30).**
- **Observation:** a live run showed an empty green at Cedar St & 2nd Ave while 5 cars waited on red.
- **Cause:** model capacity. At every tested density about 18–20 intersections at a time had an unused green with cars waiting, but each Nano reply is asked for at most 6 switches (the prompt's limit; the code's internal acceptance cap is 8), once every 4 s. The rest waited for a later reply or the 40 s maximum green.
- **Measurement:** a stand-in that follows the prompt exactly left idle greens of up to 34 s and as much total idle-green time as fixed timers.
- **Fix:**
  - A deterministic idle-green safeguard (Nemotron mode only, labelled `IDLE GREEN`, never credited to the model): it ends a green that has gone unused for 3 s after its minimum while cars wait on red.
  - Clearest cases now listed first in the snapshot.
- **Unchanged:** the prompt, call rate and limit.
- **Result** (same stand-in, 12 runs):
  - idle-green time −51%, longest idle green 34 s → 3 s;
  - average car waiting −28%, car trips +21%;
  - ambulance travel time unchanged within noise;
  - 0 conflicts, overlaps or stuck vehicles.
- **Demo:** Run 2 with the stand-in re-measured at 0:55–0:56.

**Rendering fix (Oct 30).**
- **Symptom:** in the demo many cars were invisible even though their detection boxes showed.
- **Cause:** each demo reset brought ~300 new cars before the ~190 old ones released their instance slots, pushing slot numbers to 485 against a 420-instance mesh. 40–65 cars could not be drawn, and the leak persisted after leaving the demo.
- **Fix:** the renderer now clears its slots when the simulation resets, frees departed cars before assigning new slots, and never draws beyond the mesh capacity (`dashboard/src/scene.js`). Simulation untouched.
- **Verified:** five consecutive demo launches and exits in one browser session, every car drawn at its detection box, no stale models; demo regression 22/22, Conventional replay still exactly 1:17.

**Final milestone: live Nemotron demo (Oct 30).** The Cross-Town Emergency comparison ran live on the presenter's Mac:
- **Ambulance:** 1:17 conventional vs **0:55** with UrbanFlow AI and live Nemotron 3 Nano.
- **Model:** 16 of 16 calls answered, no fallback to local rules.
- **Safety:** 0 safety violations in either run.
- **Throughput:** lower in the UrbanFlow AI run, 131 vs 139 car trips per minute. Not every metric improved.

**Still to do before submission:**
- Recording the video.

---

## Lessons

1. **Validate model outputs deterministically.** A valid JSON reply can still be wrong about the facts it cites.
2. **Safety and usefulness are separate tests.** In SUMO, safe model interventions did not beat a good conventional controller.
3. **Emergency priority has a cost to everyone else.** The right question is how little priority the ambulance needs, not how much it can be given.
4. **A testable simulator beats a prettier one.** Owning the simulation made it possible to build a collision gate and fix behaviour at the root.
5. **Keep negative results.** Mixed seeds, slower short routes and stress-test jams are part of the evidence.
