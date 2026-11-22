# Daytona USA 2 Power Edition — Web

Version 0.10.3

A static recompilation of the arcade game *Daytona USA 2 Power Edition* (Sega Model 3, 1998), running in the browser with WebAssembly and WebGPU. Single player and online linked races for up to 16 drivers.

## No ROMs included

This package does **not** contain any ROM. To play, you need your own dump of the MAME `dayto2pe` set, as one complete (non-merged) ZIP. The page checks every chip before it runs.

The ZIP is read in your browser and stored only on your device. It is never uploaded anywhere.

*Daytona USA 2* and all related names, logos and assets belong to Sega. This is an unofficial fan project, not affiliated with or endorsed by Sega.

## Requirements

- A desktop browser with WebGPU, such as a recent Chrome or Edge.
- A reasonably fast CPU. The game runs at 60 fields per second.

## Hosting on GitHub Pages

1. Put the contents of this folder at the root of a repository, or in a `docs/` folder.
2. In **Settings → Pages**, publish from that branch and folder.
3. Open the page and choose your `dayto2pe.zip`.

The `.nojekyll` file must stay so that every file is served as is. The game runs on several threads, which needs a cross-origin isolated page: `coi-sw.js` adds the required headers on hosts that cannot set them, such as GitHub Pages (the first visit reloads once). Any other static web server works too, over HTTPS or on localhost.

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Steer | ← → | Left stick |
| Accelerate / brake | ↑ ↓ | RT / LT |
| Gears 1–4 | 1 2 3 4 | B A X Y |
| Shift down / up | Q / W | LB / RB |
| Insert coin / start | 5 / Enter | Back / Start |
| Camera views | A S D F | D-pad |
| Menu / pause | Esc | — |
| Arcade TEST / SERVICE | F2 / F3 | — |

- The car starts in neutral: pick a gear before you accelerate.
- Steering wheels and touch screens are also supported. Every input can be remapped in **Settings**.
- Force feedback wheels: the arcade's own drive board program runs with the game. Its forces reach your wheel through [Arcade FFB Helper](https://github.com/johannruiz/arcade-ffb-helper), a small app for Windows and macOS: start it, then turn on **Settings → Experimental → Force feedback with FFB Helper**. Chrome asks once to allow access to apps on this device. Other wheel bridges can read the same forces (`window.arcadeForceFeedback`).

## Multiplayer

Create a private room and share its code. Up to 16 cabinets can race, and the host starts the race and sets the options.

**CPU cars** can be turned off for a race with real players only, in single player (the arcade’s Time Lap) and in rooms.

Cabinets connect directly to each other over WebRTC; the public PeerJS server is used only to find each other. A cabinet that stops responding is left out of the race and rejoins in the room for the next one.

## License

Original work © 2026 Johann Ruiz, licensed under the [Apache License 2.0](LICENSE). If you use, copy or adapt it, keep the [NOTICE](NOTICE) file and credit “Daytona USA 2 Power Edition Recomp by Johann Ruiz” in your documentation or credits.

## Third-party licenses

The runtime is built on [model3recomp](https://github.com/sp00nznet/model3recomp) and [LostWorldNative](https://github.com/snicolast/LostWorldNative), both MIT, and includes code under the licenses in `licenses/`:

- Musashi;
- SoftFloat;
- MAME-derived BSD-3-Clause parts;
- PL_MPEG and miniz (MIT);
- PeerJS (`vendor/PEERJS-LICENSE.txt`);
- the VT323 font (OFL, `fonts/`).
