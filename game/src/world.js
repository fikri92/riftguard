// The three.js side of the world: one merged set of static meshes from map.js, a sky dome, and the
// lighting rig. Nothing here simulates; it only builds the scene graph once and hands back the
// collider list the simulation walks against.
//
// Two rules shape this file. A walkable surface and a solid one are different questions — the floor
// carries the player but a shot passes through its plane — so colliders come from `walkable`, hit
// registration from `solid`. And a dusk scene still has to read at a glance in a thumbnail, so the
// sky is drawn as a real dome with a horizon glow rather than left as a flat clear colour.
import * as THREE from 'three';
import { BOXES, MAP_HALF, SITE } from './map.js';
import { PALETTE } from './palette.js';

// A box collider: axis-aligned, with a top the player can stand on. Ramps are handled separately.
function colliderOf(box) {
  const top = box.y + box.h;
  return {
    minX: box.x - box.w / 2,
    maxX: box.x + box.w / 2,
    minZ: box.z - box.d / 2,
    maxZ: box.z + box.d / 2,
    minY: box.y,
    maxY: top,
    role: box.role,
    ramp: box.role === 'ramp' ? { to: box.rampTo ?? top, flip: !!box.flip } : null,
  };
}

function materialFor(key) {
  const base = PALETTE[key] ?? PALETTE.surface;
  const rough = key === 'floor' ? 0.9 : key === 'accent' ? 0.45 : 0.78;
  return new THREE.MeshStandardMaterial({ color: base, roughness: rough, metalness: 0.08 });
}

// A vertical gradient dome: a large sphere seen from the inside, its colour blended in the shader from
// a warm haze at the horizon to a deep blue overhead. One draw call, no texture, no network.
function createSky(scene) {
  const geo = new THREE.SphereGeometry(200, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(PALETTE.skyTop) },
      hazeColor: { value: new THREE.Color(PALETTE.skyHaze) },
      lowColor: { value: new THREE.Color(PALETTE.skyLow) },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 hazeColor;
      uniform vec3 lowColor;
      varying vec3 vWorld;
      void main() {
        // Height above the horizon: 0 at eye level, 1 at the zenith.
        float h = clamp(normalize(vWorld).y * 1.15 + 0.06, 0.0, 1.0);
        // A narrow warm band right at the horizon, then a cool mass above it.
        float band = smoothstep(0.0, 0.30, h) * smoothstep(0.52, 0.16, h);
        vec3 sky = mix(lowColor, topColor, smoothstep(0.0, 0.85, h));
        sky = mix(sky, hazeColor, band * 0.92);
        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.frustumCulled = false;
  scene.add(dome);

  // A low sun on the west horizon, drawn as a disc so the key light has a visible source, with a wider
  // additive halo that blooms into the haze behind it.
  const sun = new THREE.Mesh(
    new THREE.CircleGeometry(9, 32),
    new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.95, depthWrite: false, fog: false }),
  );
  sun.position.set(-150, 26, 80);
  sun.lookAt(0, 6, 0);
  scene.add(sun);

  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(30, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffc47a, transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }),
  );
  halo.position.set(-150, 26, 80);
  halo.lookAt(0, 6, 0);
  scene.add(halo);
}

export function createWorld(scene) {
  scene.background = new THREE.Color(PALETTE.canvas);
  // The fog starts far enough back that the mid lane stays readable, and never hides cover.
  scene.fog = new THREE.Fog(new THREE.Color(PALETTE.skyLow), 62, 150);

  createSky(scene);

  // One material per palette key, reused by every box, so the draw calls stay cheap.
  const materials = new Map();
  const material = (key) => {
    let m = materials.get(key);
    if (m === undefined) {
      m = materialFor(key);
      materials.set(key, m);
    }
    return m;
  };

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const colliders = [];
  const shootables = [];

  for (const box of BOXES) {
    const mesh = new THREE.Mesh(geometry, material(box.color));
    mesh.scale.set(box.w, box.h, box.d);
    const y = box.y + box.h / 2;
    mesh.position.set(box.x, y, box.z);
    // A walkable surface carries the player; a solid one also stops a shot and casts a shadow.
    const walkable = box.role === 'floor' || box.role === 'catwalk' || box.role === 'ramp' || box.blocks !== false;
    const solid = box.blocks !== false && box.role !== 'floor' && box.role !== 'trim';
    mesh.castShadow = solid;
    mesh.receiveShadow = true;
    mesh.userData.solid = solid;
    scene.add(mesh);
    if (walkable) colliders.push(colliderOf(box));
    if (solid) shootables.push(mesh);
  }

  // The bomb site plate: a flat accent square, drawn and never shot. A dark inset frame under it keeps
  // it readable against the floor.
  const plateFrame = new THREE.Mesh(
    new THREE.PlaneGeometry(SITE.r * 2 + 1.1, SITE.r * 2 + 1.1),
    new THREE.MeshStandardMaterial({ color: 0x2a3238, roughness: 1 }),
  );
  plateFrame.rotation.x = -Math.PI / 2;
  plateFrame.position.set(SITE.x, 0.412, SITE.z);
  plateFrame.receiveShadow = true;
  scene.add(plateFrame);

  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(SITE.r * 2, SITE.r * 2),
    new THREE.MeshStandardMaterial({
      color: PALETTE.accent, roughness: 1, transparent: true, opacity: 0.34,
      emissive: new THREE.Color(PALETTE.accent), emissiveIntensity: 0.22,
    }),
  );
  plate.rotation.x = -Math.PI / 2;
  plate.position.set(SITE.x, 0.418, SITE.z);
  scene.add(plate);

  // A ring of low posts marks the playfield, so the edge of the map is legible at a glance. Each post
  // carries a small emissive cap, which draws a readable line around the perimeter at low light.
  const postGeo = new THREE.BoxGeometry(0.3, 2.6, 0.3);
  const postMat = material('accent');
  const capGeo = new THREE.SphereGeometry(0.13, 8, 6);
  const capMat = new THREE.MeshBasicMaterial({ color: 0xffd79a });
  for (let i = 0; i < 24; i += 1) {
    const t = (i / 24) * Math.PI * 2;
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(Math.cos(t) * (MAP_HALF - 1.6), 1.3, Math.sin(t) * (MAP_HALF - 1.6));
    post.castShadow = true;
    scene.add(post);
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.set(post.position.x, 2.7, post.position.z);
    scene.add(cap);
  }

  // Lighting: a low warm key from the west sun, a cool fill from the east, and a sky/ground hemisphere
  // so nothing in shade ever goes to pure black. The key is the only shadow caster.
  const key = new THREE.DirectionalLight(0xffd0a0, 3.1);
  key.position.set(-52, 40, 28);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 190;
  key.shadow.camera.left = -44;
  key.shadow.camera.right = 44;
  key.shadow.camera.top = 44;
  key.shadow.camera.bottom = -44;
  key.shadow.bias = -0.0012;
  key.shadow.normalBias = 0.03;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9fd8ea, 1.05);
  fill.position.set(46, 26, -34);
  scene.add(fill);

  // The bounce light: warm from the ground, cool from the sky, which is what keeps the shaded sides of
  // crates from reading as flat black.
  scene.add(new THREE.HemisphereLight(0xaad2e4, 0x6b5a44, 1.5));

  return { colliders, shootables, geometry };
}
