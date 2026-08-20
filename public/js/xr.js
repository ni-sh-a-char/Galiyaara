/**
 * Galiyaara in a headset.
 *
 * Two very different things share this file because they share a renderer:
 *
 *   VR  — the corridor is already a room-scale space, so immersive-vr just puts
 *         you in it. Thumbstick to walk, snap-turn to look around without
 *         motion sickness, trigger to step up to a frame.
 *
 *   AR  — a corridor makes no sense over passthrough, so AR does the one thing
 *         a photographer actually wants from it: hangs the print you are
 *         looking at on your real wall, at its real size.
 *
 * Both are progressive enhancement. The buttons only exist if navigator.xr says
 * the mode is supported, so a phone, a laptop and a headset all get the same
 * page and only the headset sees the extra doors.
 */
import * as THREE from '../vendor/three.module.min.js';

const PRINT_LONG_EDGE = 0.6;   // metres — a 60cm print, the size people buy
const SNAP = Math.PI / 6;      // 30° snap turn; smooth turning is what makes people ill
const WALK_SPEED = 1.6;        // m/s, roughly a gallery amble
const DEADZONE = 0.18;
const FREE_DIST = 1.4;         // metres out front when no wall could be detected

/** Feature detection, cheap and safe on browsers with no navigator.xr at all. */
export async function xrSupport() {
  if (!navigator.xr?.isSessionSupported) return { vr: false, ar: false };
  const check = async (mode) => {
    try { return await navigator.xr.isSessionSupported(mode); } catch { return false; }
  };
  const [vr, ar] = await Promise.all([check('immersive-vr'), check('immersive-ar')]);
  return { vr, ar };
}

// --- VR ---------------------------------------------------------------------

function buildControllers(renderer, rig, onSelect) {
  // A thin line down the pointing direction, so aiming at a frame is possible.
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -4),
  ]);
  const mat = new THREE.LineBasicMaterial({
    color: 0xc9a86a, transparent: true, opacity: 0.5, depthWrite: false, fog: false,
  });

  const controllers = [];
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i);
    c.add(new THREE.Line(geo, mat));
    c.addEventListener('selectstart', () => onSelect(c));
    rig.add(c);
    controllers.push(c);
  }
  return controllers;
}

/**
 * Thumbstick locomotion. Movement is relative to where you are looking, which
 * is the only mapping that feels right in a headset; turning is snapped.
 */
function makeMover({ renderer, camera, rig, corridor }) {
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const head = new THREE.Quaternion();
  let turnLatched = false;

  // Returns true on the frames it actually walked you somewhere, so the caller
  // knows to drop whatever it was gliding you toward.
  return (dt) => {
    let moved = false;
    const session = renderer.xr.getSession();
    if (!session) return moved;

    let mx = 0, my = 0, turn = 0;
    for (const src of session.inputSources) {
      const axes = src.gamepad?.axes;
      if (!axes) continue;
      // xr-standard puts the thumbstick on axes 2/3; older mappings use 0/1.
      const x = axes[2] ?? axes[0] ?? 0;
      const y = axes[3] ?? axes[1] ?? 0;
      if (src.handedness === 'right') turn += Math.abs(x) > 0.6 ? Math.sign(x) : 0;
      else { mx += Math.abs(x) > DEADZONE ? x : 0; my += Math.abs(y) > DEADZONE ? y : 0; }
    }

    // Snap turn once per push, not once per frame.
    if (turn && !turnLatched) { rig.rotation.y -= Math.sign(turn) * SNAP; turnLatched = true; }
    if (!turn) turnLatched = false;

    if (!mx && !my) return moved;

    camera.getWorldQuaternion(head);
    forward.set(0, 0, -1).applyQuaternion(head);
    forward.y = 0;
    forward.normalize();
    right.set(1, 0, 0).applyQuaternion(head);
    right.y = 0;
    right.normalize();

    const step = WALK_SPEED * dt;
    rig.position.addScaledVector(forward, -my * step);
    rig.position.addScaledVector(right, mx * step);
    moved = true;

    // Same walls as the flat-screen walk — you cannot stroll through plaster.
    const { HALF_W, LENGTH } = corridor;
    rig.position.x = Math.min(HALF_W - 0.5, Math.max(-HALF_W + 0.5, rig.position.x));
    rig.position.z = Math.min(10, Math.max(-(LENGTH - 24), rig.position.z));
    return moved;
  };
}

// --- AR ---------------------------------------------------------------------

/**
 * A minimal scene of its own: a reticle, and whatever prints have been hung.
 * The corridor stays out of it — over passthrough you want your room, not ours.
 */
function buildArScene() {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 2.2));

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.075, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xc9a86a, transparent: true, opacity: 0.9 })
  );
  ring.matrixAutoUpdate = false;
  ring.visible = false;
  scene.add(ring);

  return { scene, reticle: ring };
}

function buildPrint(texture, w, h) {
  const group = new THREE.Group();
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.05, h + 0.05, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.6, metalness: 0.2 })
  );
  const art = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
  );
  art.position.z = 0.011;
  group.add(frame, art);
  return group;
}

/**
 * Put a print where the visitor asked for it: on the detected surface if there
 * was one, otherwise FREE_DIST down their line of sight. Upright and facing
 * them either way — hit-test poses lie flat along the surface, which is not how
 * anyone hangs a photograph.
 *
 * Exported because this is the entire answer to "did anything land on my wall",
 * and it is the one part of AR that can be checked without a headset.
 */
export function aimPrint(print, eye, dir, surface = null) {
  if (surface) print.position.setFromMatrixPosition(surface);
  else print.position.copy(eye).addScaledVector(dir, FREE_DIST);

  print.quaternion.identity();
  // YXZ, not the default XYZ: in XYZ the yaw term is entangled with the pitch,
  // so dropping the pitch of a print hung above or below eye level leaves it
  // aimed several degrees off the viewer. In YXZ, y IS the bearing.
  print.rotation.order = 'YXZ';
  print.lookAt(eye);
  print.rotation.x = 0;          // stand it up; a print is not a floor tile
  print.rotation.z = 0;
  print.translateZ(0.02);        // off the plaster, or the wall z-fights the frame
  return print;
}

// --- Wiring -----------------------------------------------------------------

/**
 * @param {object} xr      the `xr` surface returned by createGallery()
 * @param {object} hooks   { onSession(mode|null), onPlaced() }
 */
export function setupXR(xr, hooks = {}) {
  const { renderer, camera, rig, pickables, focusAt } = xr;
  const raycaster = new THREE.Raycaster();
  const tmp = new THREE.Matrix4();
  let session = null;
  let mode = null;

  const move = makeMover(xr);

  buildControllers(renderer, rig, (controller) => {
    if (mode !== 'vr') return;
    // Aim down the controller and take the first frame it crosses.
    tmp.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmp);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    if (hit) focusAt(hit.object.userData.index);
  });

  const ar = buildArScene();
  let hitTestSource = null;
  let placed = null;
  let pendingPrint = null;   // { texture, aspect } — texture may still be loading
  let wantsPlace = false;    // tapped before the print finished downloading

  // Hit-testing is an enhancement, not a prerequisite. It is allowed to be
  // unavailable or to find nothing; what is not allowed is for the session to
  // end up with no reticle and no way to hang anything, which is what happened
  // when this rejection went unhandled inside an async caller: the 'select'
  // listener below it was never attached either.
  async function startAR(s) {
    try {
      const viewer = await s.requestReferenceSpace('viewer');
      const source = await s.requestHitTestSource({ space: viewer });
      if (session !== s) { source?.cancel?.(); return; }   // they already left
      hitTestSource = source;
    } catch (err) {
      console.warn('no hit-testing in this session — free placement only', err);
      hitTestSource = null;
    }
  }

  const eye = new THREE.Vector3();      // shared scratch: where the viewer is
  const aim = new THREE.Vector3();      // and which way they are looking
  const UP = new THREE.Vector3(0, 1, 0);
  const ONE = new THREE.Vector3(1, 1, 1);
  const at = new THREE.Vector3();
  const facing = new THREE.Quaternion();
  let onSurface = false;

  /** Reticle floating at arm's length, turned to face the viewer. */
  function aimFree() {
    camera.getWorldPosition(eye);
    camera.getWorldDirection(aim);
    at.copy(eye).addScaledVector(aim, FREE_DIST);
    // The ring's own normal is +Y, so point that back down the line of sight.
    facing.setFromUnitVectors(UP, aim.negate());   // getWorldDirection is unit already
    ar.reticle.matrix.compose(at, facing, ONE);
    return false;
  }

  function arFrame(frame) {
    if (mode !== 'ar') return;
    const refSpace = renderer.xr.getReferenceSpace();
    let found = false;

    if (frame && hitTestSource && refSpace) {
      const hits = frame.getHitTestResults(hitTestSource);
      const pose = hits.length ? hits[0].getPose(refSpace) : null;
      if (pose) {
        ar.reticle.matrix.fromArray(pose.transform.matrix);
        found = true;
      }
    }
    if (!found) aimFree();

    // The reticle is ALWAYS visible. A ring the visitor can aim is the only
    // feedback that the session is alive, and a blank painted wall — the exact
    // surface people want a print on — is the one thing hit-testing reliably
    // fails to see. Hiding the ring there left a working session looking dead.
    ar.reticle.visible = true;
    if (found !== onSurface) {
      onSurface = found;
      hooks.onAim?.(found);
    }
  }

  // In AR, a tap places (or re-places) the print where the reticle is.
  //
  // A tap ALWAYS hangs something. The two ways this used to end in a blank
  // room are both handled here rather than ignored:
  //
  //   no surface — ARCore finds a plane by its texture, and the blank painted
  //                wall someone actually wants a print on is the hardest thing
  //                in the room for it to see. Waiting for a hit that never
  //                comes is not a feature. Fall back to hanging it where the
  //                visitor is looking, at arm's length.
  //
  //   no texture — the print is a 2 MP download and the tap can easily beat
  //                it. Latch the intent and hang it the moment it lands,
  //                rather than swallowing the tap.
  function placePrint() {
    if (mode !== 'ar') return;
    if (!pendingPrint?.texture) { wantsPlace = true; return; }
    wantsPlace = false;

    if (!placed) {
      const { texture, aspect } = pendingPrint;
      const w = aspect >= 1 ? PRINT_LONG_EDGE : PRINT_LONG_EDGE * aspect;
      const h = aspect >= 1 ? PRINT_LONG_EDGE / aspect : PRINT_LONG_EDGE;
      placed = buildPrint(texture, w, h);
      ar.scene.add(placed);
    }

    camera.getWorldPosition(eye);
    camera.getWorldDirection(aim);
    aimPrint(placed, eye, aim, onSurface ? ar.reticle.matrix : null);
    hooks.onPlaced?.();
  }

  // Returns true only when VR locomotion actually moved the rig — the corridor
  // uses that to drop a dock glide the moment the visitor walks off on their own.
  xr.setMover((dt, frame) => {
    if (mode === 'vr') return move(dt);
    if (mode === 'ar') arFrame(frame);
    return false;
  });

  // Where the corridor left the walker standing. AR has to borrow the rig at
  // the origin (see below) and give it back when the session ends.
  const rigWas = { pos: new THREE.Vector3(), rot: 0 };

  /**
   * Tear a session down. Attached to 'end' BEFORE anything is awaited, because
   * a visitor can leave AR at any moment — including during the seconds a 2 MP
   * print spends downloading. Registered after those awaits (as it was), the
   * 'end' event fires into a void: `session` stays set, so `if (session)
   * return` below rejects every later attempt and the whole feature works
   * exactly once per page load, for whichever photograph was tried first.
   */
  function teardown(isAR) {
    session = null;
    mode = null;
    hitTestSource?.cancel?.();
    hitTestSource = null;
    if (placed) {
      ar.scene.remove(placed);
      // Each print is its own full-resolution texture; without this every
      // "see it on your wall" leaks one for the life of the page.
      placed.traverse((o) => {
        o.geometry?.dispose();
        o.material?.map?.dispose();
        o.material?.dispose();
      });
      placed = null;
    }
    pendingPrint = null;
    wantsPlace = false;
    onSurface = false;
    if (isAR) { rig.position.copy(rigWas.pos); rig.rotation.y = rigWas.rot; }
    ar.reticle.visible = false;
    xr.setScene(null);
    hooks.onSession?.(null);
  }

  async function enter(which, print) {
    if (session) return;
    const isAR = which === 'ar';
    if (isAR) {
      if (!print) return;
      pendingPrint = print;
    }

    let s;
    try {
      s = await navigator.xr.requestSession(isAR ? 'immersive-ar' : 'immersive-vr', {
        optionalFeatures: isAR
          ? ['dom-overlay', 'light-estimation']
          : ['local-floor', 'bounded-floor', 'hand-tracking'],
        requiredFeatures: isAR ? ['hit-test'] : ['local-floor'],
        domOverlay: isAR ? { root: document.body } : undefined,
      });
    } catch (err) {
      console.warn('could not start the XR session', err);
      session = null;
      hooks.onSession?.(null, err);
      return;
    }

    session = s;
    mode = isAR ? 'ar' : 'vr';
    s.addEventListener('end', () => teardown(isAR));

    // Every await below can outlive the session, so each one is followed by a
    // check that the session we are still setting up is the current one.
    const live = () => session === s;

    if (isAR) {
      // The camera is a child of the rig, so three multiplies every headset
      // pose by wherever the rig is standing in the corridor. Harmless in VR —
      // the rig IS the walker — but in AR the hit-test poses and the print live
      // in raw reference space, so a rig parked 40m down the arcade puts the
      // whole room 40m behind you and the wall you are pointing at gets
      // nothing. Park the rig at the origin for the duration.
      rigWas.pos.copy(rig.position);
      rigWas.rot = rig.rotation.y;
      rig.position.set(0, 0, 0);
      rig.rotation.y = 0;
      // Swap the scene before the session opens, so not one frame of corridor
      // is drawn over the passthrough.
      xr.setScene(ar.scene);
    }

    renderer.xr.setReferenceSpaceType(isAR ? 'local' : 'local-floor');
    await renderer.xr.setSession(s);
    if (!live()) return;

    hooks.onSession?.(mode);   // get the page chrome out of the way immediately

    if (isAR) {
      await startAR(s);        // never rejects; hit-test is optional
      if (!live()) return;
      s.addEventListener('select', placePrint);
      // The texture is still in flight — requesting the session first is what
      // keeps the visitor's tap "recent" enough for the browser to allow it.
      try {
        const texture = await pendingPrint.texture;
        if (!live()) { texture?.dispose?.(); return; }
        pendingPrint.texture = texture;
        if (wantsPlace) placePrint();        // they tapped while it downloaded
      } catch (err) {
        console.warn('the print did not load', err);
        pendingPrint = null;
        if (live()) hooks.onSession?.('ar', err);
      }
    }
  }

  return {
    enterVR: () => enter('vr'),
    /** @param print {{texture: THREE.Texture|Promise<THREE.Texture>, aspect: number}} */
    enterAR: (print) => enter('ar', print),
    end: () => session?.end(),
    get mode() { return mode; },
  };
}
