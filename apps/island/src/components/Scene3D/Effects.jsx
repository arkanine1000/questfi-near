import { EffectComposer, Bloom } from '@react-three/postprocessing';

/**
 * Bloom-only postprocessing. Only mounted when the capability gate in
 * worldUtils.canUseBloom() passes — the emissive materials must look good
 * on their own without it.
 */
export default function Effects() {
  return (
    <EffectComposer>
      <Bloom
        mipmapBlur
        intensity={0.85}
        luminanceThreshold={0.3}
        luminanceSmoothing={0.25}
        radius={0.7}
      />
    </EffectComposer>
  );
}
