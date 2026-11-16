// Input is reduced to a plain state object the simulation reads: held keys, a look delta drained each
// frame, and the fire/reload/buy edges. The simulation never touches a DOM event itself.
export function createInput(element, onLockChange) {
  const keys = new Set();
  const state = {
    keys,
    firing: false,
    rightHeld: false,
    firedThisPress: false,
    lookX: 0,
    lookY: 0,
    // Edges, drained by the simulation each step.
    pressReload: false,
    pressBuy: false,
    pressUse: false,
    pressSwitch: false,
    pressGrenade: false,
  };

  const onKeyDown = (event) => {
    if (event.code === 'KeyR') state.pressReload = true;
    if (event.code === 'KeyB') state.pressBuy = true;
    if (event.code === 'KeyE') state.pressUse = true;
    if (event.code === 'KeyQ') state.pressSwitch = true;
    if (event.code === 'KeyF') state.pressGrenade = true;
    keys.add(event.code);
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(event.code)) event.preventDefault();
  };
  const onKeyUp = (event) => keys.delete(event.code);
  const onMouseMove = (event) => {
    if (document.pointerLockElement !== element) return;
    state.lookX += event.movementX;
    state.lookY += event.movementY;
  };
  const onMouseDown = (event) => {
    if (event.button === 0) state.firing = true;
    if (event.button === 2) state.rightHeld = true;
  };
  const onMouseUp = (event) => {
    if (event.button === 0) state.firing = false;
    if (event.button === 2) state.rightHeld = false;
  };
  const onContextMenu = (event) => event.preventDefault();
  const onLock = () => onLockChange?.(document.pointerLockElement === element);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('pointerlockchange', onLock);

  return {
    state,
    requestLock() {
      element.requestPointerLock?.();
    },
    release() {
      document.exitPointerLock?.();
    },
    // The look delta since the last frame, in pixels, then cleared.
    takeLook() {
      const x = state.lookX;
      const y = state.lookY;
      state.lookX = 0;
      state.lookY = 0;
      return { x, y };
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointerlockchange', onLock);
    },
  };
}
