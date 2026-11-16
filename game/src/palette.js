// Palette: one chosen scheme, six tokens, no colour outside it. Sand-and-teal refinery at dusk.
// Every material in the world is built from these values, so the scene reads as one place. The
// values sit deliberately high in luminance: a dusk scene still has to read at a glance in a
// thumbnail, so the lightest surfaces are near-white and the darkest stay well above black.
export const PALETTE = {
  canvas: 0x1a262e,
  skyTop: 0x243b49,
  skyHaze: 0xc98a4b,
  skyLow: 0x3d4f5a,
  surface: 0x6d7876,
  wall: 0x8a8b80,
  floor: 0x5c6668,
  crate: 0xa9803f,
  barrel: 0xb0503a,
  ink: 0xe9e6df,
  muted: 0x9aa7ad,
  accent: 0xf0aa3c,
  team: 0x54b6c9,
  hostile: 0xd3563f,
  shadow: 0x000000,
};

// Six UI colours, the same six the 3D scene is built from.
export const CSS = {
  canvas: '#0e1418',
  surface: '#22333a',
  hairline: '#3a4a4e',
  ink: '#e9e6df',
  muted: '#9aa7ad',
  accent: '#e8a13a',
  team: '#54b6c9',
  hostile: '#d3563f',
};
