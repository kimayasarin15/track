# Wiggle

Wiggle is a trackpad based animation tool, that lets you animate through direct physical movement. Pushing again the traditional methods of keyframes, you record your cursor path in real time and it captures your movement. The idea came from questioning the conventions of traditional animation software, technical, tedious and disconnected from our bodies. I wanted to make animation feel more intuitive. 

Shapes, text and images are drawn directly onto the canvas by dragging, then brought to life by switching into animate mode and moving your mouse across the screen. Multiple layers allow you to build up compositions, with each object animated independently. Recorded paths can be constrained to a single axis for precise, linear movement, and layers can be edited or cleared at any point without affecting the rest of the composition.


wiggleanimate.com

---

## Features

### Drawing
- Rectangle, circle, line, text, and image tools
- Color picker and size controls
- Horizontal and vertical alignment
- Shape inspector for editing after placement

### Animation
- Record trackpad/mouse movement to animate any object
- Duration options: 3s, 5s, 10s, 15s, 30s
- Playback controls and timeline scrubbing
- Ghost preview while recording (hold Shift)

### Layers
- Up to 15 independent layers
- Drag to reorder
- Copy / paste between layers
- Each new object automatically creates a new layer

### Canvas
- Aspect ratios: 16:9, 1:1, 9:16
- Custom background color
- Responsive — adapts to window size

### Export & Saving
- Export as WebM video
- Auto-saves to local storage
- Installable as a PWA (works offline)

---

## Tech Stack

- Vanilla JavaScript — no frameworks or build step
- HTML5 Canvas API
- CSS custom properties
- Service Worker for offline support
- Local Storage for persistence

---

## File Structure

```
wiggle/
├── index.html       — markup, modals, toolbar
├── app.js           — all application logic
├── style.css        — all styling
├── sw.js            — service worker (offline/caching)
├── manifest.json    — PWA manifest
├── favicon/         — 16, 32, 64px favicons
└── icons/           — 192px and 512px app icons
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `R` | Start / stop recording |
| `Space` | Play / pause |
| `⌘C` | Copy active layer |
| `⌘V` | Paste to new layer |
| `Delete` | Delete shape or animation |
| `Shift` (while drawing) | Constrain to square / 45° |
| `Shift` (while recording) | Show ghost preview |

---

## Credits

Designed and built by Kimaya Sarin  
MPS Communication Design, Parsons School of Design  
Major Studio 2
Capstone Project 
2026
