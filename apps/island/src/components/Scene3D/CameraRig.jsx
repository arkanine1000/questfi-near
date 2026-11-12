import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';

const DEG = Math.PI / 180;

// Home framing: island centered, ~40° polar, slight azimuth so the volcano
// reads in relief
const HOME_TARGET = new THREE.Vector3(0, 0.3, 0);
const HOME_POSITION = new THREE.Vector3(-1.9, 8.7, 7.4);
const INTRO_POSITION = new THREE.Vector3(-3.8, 14.5, 12.5);

// Pan clamp — keep the orbit target over the table
const TARGET_BOUNDS = {
  min: new THREE.Vector3(-6.5, 0, -4.6),
  max: new THREE.Vector3(6.5, 2.5, 4.6),
};

const FOCUS_DISTANCE = 4;
const FOCUS_DURATION = 0.8;
const INTRO_DURATION = 1.2;

// Soft-follow ease rate — higher eases faster. Frame-rate independent via
// 1 - e^(-rate * delta), so it feels the same at 30fps and 120fps.
const FOLLOW_EASE = 3.0;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

const _dir = new THREE.Vector3();
const _followPoint = new THREE.Vector3();
const _followOffset = new THREE.Vector3();

export default function CameraRig({
  focusRequest, followTarget, onUnfollow, enabled, reducedMotion,
}) {
  const controlsRef = useRef();
  const flightRef = useRef(null);
  const { camera } = useThree();
  // Read fresh every frame without re-subscribing the frame loop —
  // followTarget changes once per tick, not every frame.
  const followTargetRef = useRef(followTarget);
  followTargetRef.current = followTarget;
  const onUnfollowRef = useRef(onUnfollow);
  onUnfollowRef.current = onUnfollow;
  // What WE last set controls.target to — lets us tell "OrbitControls
  // panned it since last frame" apart from our own follow-easing.
  const lastTargetRef = useRef(null);

  // The table spins slowly until the user takes the controls
  const [autoRotate, setAutoRotate] = useState(!reducedMotion);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls || !autoRotate) return undefined;
    const stop = () => setAutoRotate(false);
    controls.addEventListener('start', stop);
    return () => controls.removeEventListener('start', stop);
  }, [autoRotate]);

  const startFlight = (toTarget, toPosition, duration) => {
    const controls = controlsRef.current;
    if (!controls) return;
    flightRef.current = {
      fromTarget: controls.target.clone(),
      fromPosition: camera.position.clone(),
      toTarget,
      toPosition,
      duration,
      elapsed: 0,
    };
  };

  // Intro ease from a higher/farther pose on first mount
  useEffect(() => {
    const controls = controlsRef.current;
    if (reducedMotion || !controls) {
      camera.position.copy(HOME_POSITION);
      controls?.target.copy(HOME_TARGET);
      controls?.update();
      return;
    }
    camera.position.copy(INTRO_POSITION);
    controls.target.copy(HOME_TARGET);
    controls.update();
    startFlight(HOME_TARGET.clone(), HOME_POSITION.clone(), INTRO_DURATION);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus-fly to a hex / back home
  useEffect(() => {
    if (!focusRequest) return;
    const controls = controlsRef.current;
    if (!controls) return;
    setAutoRotate(false);
    const duration = reducedMotion ? 0.01 : FOCUS_DURATION;
    if (focusRequest.type === 'hex') {
      const point = new THREE.Vector3(...focusRequest.point);
      _dir.copy(camera.position).sub(controls.target).normalize();
      if (_dir.y < 0.45) _dir.y = 0.45; // keep within polar limits when tight
      const position = point.clone().add(_dir.normalize().multiplyScalar(FOCUS_DISTANCE));
      startFlight(point, position, duration);
    } else {
      startFlight(HOME_TARGET.clone(), HOME_POSITION.clone(), duration);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    // A manual pan moves the orbit TARGET itself (translating the whole
    // view); pure rotation orbits the camera around a fixed target and
    // never touches it. So if controls.target differs from whatever WE
    // set it to last frame, the user grabbed the view — stop following.
    // Rotation stays free to compose with an active follow.
    if (
      followTargetRef.current && !flightRef.current && lastTargetRef.current
      && controls.target.distanceToSquared(lastTargetRef.current) > 1e-5
    ) {
      followTargetRef.current = null;
      onUnfollowRef.current?.();
    }

    const flight = flightRef.current;
    if (flight) {
      flight.elapsed += delta;
      const t = Math.min(flight.elapsed / flight.duration, 1);
      const k = easeInOutCubic(t);
      camera.position.lerpVectors(flight.fromPosition, flight.toPosition, k);
      controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
      controls.update();
      if (t >= 1) flightRef.current = null;
      (lastTargetRef.current ??= new THREE.Vector3()).copy(controls.target);
      return;
    }

    // Soft follow: once the initial fly-in above lands, keep easing the
    // orbit target toward the followed agent's live position every frame.
    // The camera's relative offset (distance + angle) is preserved and
    // translated along with it — manual orbit/zoom stays fully free, since
    // this just reads whatever camera.position/controls.target already are.
    if (followTargetRef.current) {
      _followPoint.set(...followTargetRef.current);
      _followOffset.copy(camera.position).sub(controls.target);
      const k = reducedMotion ? 1 : 1 - Math.exp(-FOLLOW_EASE * delta);
      controls.target.lerp(_followPoint, k);
      camera.position.copy(controls.target).add(_followOffset);
      controls.update();
    }

    // Clamp pan to island bounds
    controls.target.clamp(TARGET_BOUNDS.min, TARGET_BOUNDS.max);
    (lastTargetRef.current ??= new THREE.Vector3()).copy(controls.target);
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enabled={enabled}
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.6}
      autoRotate={autoRotate}
      autoRotateSpeed={0.5}
      minPolarAngle={25 * DEG}
      maxPolarAngle={68 * DEG}
      minDistance={2.5}
      maxDistance={18}
    />
  );
}
