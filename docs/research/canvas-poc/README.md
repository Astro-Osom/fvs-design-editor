# Canvas library proof of concept

`run.mjs` runs Fabric.js 7.4.0 and Konva 10.10.0 in headless Chrome at 2x screen
density and checks the features the editor depends on. `results.json` is its output
from 20 November 2026. The conclusions are in [docs/architecture.md](../../architecture.md).

To run it again, use an empty folder outside this repo:

```bash
pnpm add fabric@7.4.0 konva@10.10.0 playwright-core
```

Copy `run.mjs` into that folder, then:

```bash
node run.mjs
```

It needs Google Chrome installed.
