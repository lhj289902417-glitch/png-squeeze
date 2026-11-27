# png-squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/lhj289902417-glitch/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/lhj289902417-glitch/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG squeezer for 1280×720 RGBA screenshots: it decodes each image, tries every exact colour form (palette by count / luminance / first occurrence, grey, grey+alpha, RGB, RGBA, with a tRNS key when one transparent value covers all non-opaque pixels), screens each form's filter choices (fixed filters, minimum signed-sum, fewest distinct byte pairs, and per-row brute force) with zlib level 6, then writes the winner with the smallest of three streams: a bounded optimal-parse DEFLATE written from scratch in `deflate.js` (hash-chain match finding with a Pareto frontier of length/distance pairs, DP optimal parse, iterative dynamic Huffman with zlib-style length-limited code lengths), zlib level 9, and the level-6 screen stream. Deterministic: every search is bounded by fixed work, never by the clock, so two runs write identical bytes. Runs under Node 22 with no dependencies; reads cases from `/input` (or `$MAKEFUN_INPUT_DIR`) and writes answers to `/output` (or `$MAKEFUN_OUTPUT_DIR`).

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=rb4wc6wh&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
