import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';

// Y-axis VIEW-PLANE billboard. drei's <Billboard> orients by looking at
// the camera's position — correct for orbiting cameras, but the crawler
// rig rotates the camera IN PLACE (idle sway, look-around beats), and a
// position-lookAt is invariant under pure rotation: sprites visibly stop
// tracking mid-animation. Aligning to the camera's yaw every frame is the
// classic Doom-sprite behavior and stays glued through any rig motion.
//
// That yaw comes from CrawlerRig's BASE facing (camera.userData.
// crawlerBaseYaw), not the camera's own live rotation.y — the rig's idle
// sway/look-around is a camera-only flourish layered on top of the base
// yaw, and copying the camera's full rotation dragged engaged enemies
// around with every idle glance. Falls back to the camera's own rotation
// if the rig hasn't stamped a base yaw yet (e.g. the very first frame).

export default function FacingBillboard({ children, ...props }) {
  const ref = useRef();
  useFrame(({ camera }) => {
    if (!ref.current) return;
    ref.current.rotation.y = camera.userData.crawlerBaseYaw ?? camera.rotation.y;
  });
  return (
    <group ref={ref} {...props}>
      {children}
    </group>
  );
}
