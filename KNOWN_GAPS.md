# Known Gaps

Tracked here intentionally rather than silently left out, since this prototype
is meant to demonstrate product/engineering judgment as much as the UI itself.

## 1. Cross-at-bat baserunner advancement isn't tracked

Each grid cell's diamond shows the base path for **that specific at-bat's
result only** (e.g., a single draws home→1st). In a real scorebook, a runner
who reaches first on a single and *later* scores on a teammate's double has
their original cell updated too — the path extends and the diamond eventually
fills in, even though the advancing action happened on someone else's line.

Implementing that correctly requires the data model to track each baserunner
by identity through a half-inning (not just "who's on base after this play,"
which `gameData.json` already captures, but "which original at-bat does this
runner's path belong to"), then back-write earlier cells as the inning
progresses. That's a sim/data change, not just a rendering change, so it's
being treated as its own follow-up task rather than bolted on.

Current behavior: a runner's cell freezes at the base they reached on their
own at-bat, even if they're later driven in. The result code (1B, 2B, BB,
etc.) is still accurate — only the visual "how far did they ultimately get"
is incomplete.
