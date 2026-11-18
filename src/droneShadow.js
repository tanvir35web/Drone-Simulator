import * as THREE from 'three';

/**
 * High-resolution shadow for the drone near the ground.
 *
 * The world's sun shadow map covers ~160 m at 2048 px (~8 cm per texel), so a
 * drone 0.2-1 m across only gets a few texels and its shadow turns into a faint
 * smudge. Here the drone alone is rendered from the sun direction into a small
 * silhouette texture, which is then projected onto a ground-aligned quad where
 * the sun ray through the drone hits the terrain. A soft contact (ambient
 * occlusion) blob directly under the drone grounds it when landed.
 *
 * Above FADE_END metres the effect is off and the regular shadow map takes over.
 */
const LAYER = 1;
const RES = 512;
const FADE_START = 5;  // m above ground: start fading the projected shadow
const FADE_END = 9;    // m above ground: projected shadow fully gone
const MAP_SHADOW_AGL = 6; // drone casts into the world shadow map above this

const POISSON = [
  [-0.326, -0.406], [-0.840, -0.074], [-0.696, 0.457], [-0.203, 0.621],
  [0.962, -0.195], [0.473, -0.480], [0.519, 0.767], [0.185, -0.893],
  [0.507, 0.064], [0.896, 0.412], [-0.322, -0.933], [-0.792, -0.598],
];

export class DroneShadow {
  constructor(scene, renderer, world) {
    this.scene = scene;
    this.renderer = renderer;
    this.world = world;
    this.model = null;

    this.rt = new THREE.WebGLRenderTarget(RES, RES, { depthBuffer: true });
    this.rt.texture.minFilter = THREE.LinearFilter;
    this.rt.texture.magFilter = THREE.LinearFilter;
    this.rt.texture.generateMipmaps = false;

    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 30);
    this.cam.layers.set(LAYER);
    this.silhouette = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, side: THREE.DoubleSide });

    this.uniforms = {
      map: { value: this.rt.texture },
      shadowVP: { value: new THREE.Matrix4() },
      strength: { value: 0 },
      soft: { value: 0.003 },
      aoCenter: { value: new THREE.Vector3() },
      aoRadius: { value: 0.3 },
      aoStrength: { value: 0 },
    };
    const taps = POISSON.map(([x, y]) => `s += texture2D(map, uv + vec2(${x.toFixed(3)}, ${y.toFixed(3)}) * soft).r;`).join('\n');
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map;
        uniform mat4 shadowVP;
        uniform float strength, soft, aoRadius, aoStrength;
        uniform vec3 aoCenter;
        varying vec3 vWorld;
        void main() {
          vec4 c = shadowVP * vec4(vWorld, 1.0);
          vec2 uv = c.xy / c.w * 0.5 + 0.5;
          float s = 0.0;
          if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
            ${taps}
            s /= ${POISSON.length}.0;
          }
          float d = length(vWorld.xz - aoCenter.xz) / aoRadius;
          float ao = aoStrength * pow(1.0 - smoothstep(0.0, 1.0, d), 2.0);
          float a = 1.0 - (1.0 - s * strength) * (1.0 - ao);
          if (a < 0.003) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.0, a);
        }`,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
    this.quad.renderOrder = 2;
    this.quad.frustumCulled = false;
    this.quad.visible = false;
    scene.add(this.quad);

    this._hit = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);
    this._clear = new THREE.Color();
  }

  /** Call after (re)building the drone model. */
  setModel(model, profile) {
    this.model = model;
    this.profile = profile;
    this._castMap = undefined; // new meshes: re-apply castShadow on next update
    model.root.traverse((o) => { if (o.isMesh) o.layers.enable(LAYER); });
    // spinning-prop blur discs are mostly transparent; keep them out of the silhouette
    for (const b of model.blurs) b.layers.disable(LAYER);
  }

  update(pos) {
    if (!this.model) return;
    const w = this.world;
    const groundH = w.heightAt(pos.x, pos.z);
    const agl = Math.max(0, pos.y - this.profile.gear - groundH);

    // Below MAP_SHADOW_AGL the shadow-map version is too coarse and would only add a smudge
    const castMap = agl > MAP_SHADOW_AGL;
    if (castMap !== this._castMap) {
      this._castMap = castMap;
      this.model.root.traverse((o) => { if (o.isMesh) o.castShadow = castMap; });
      for (const b of this.model.blurs) b.castShadow = false;
    }

    const fade = 1 - THREE.MathUtils.smoothstep(agl, FADE_START, FADE_END);
    const sunK = THREE.MathUtils.clamp(w.sun.intensity / 2.45, 0, 1);
    this.quad.visible = fade > 0.001;
    if (!this.quad.visible) return;

    // Where the sun ray through the drone hits the ground
    const sun = w.sunDir;
    const sy = Math.max(sun.y, 0.17); // clamp very low sun (< ~10 deg) to keep the quad bounded
    const hit = this._hit.copy(pos);
    let h = groundH;
    for (let i = 0; i < 4; i++) {
      const t = (pos.y - h) / sy;
      hit.set(pos.x - sun.x * t, h, pos.z - sun.z * t);
      h = w.heightAt(hit.x, hit.z);
    }
    hit.y = h;

    // Silhouette camera looking down the sun direction, framing just the drone
    const R = (this.profile.armLength + this.profile.propRadius) * 1.25 + 0.05;
    const cam = this.cam;
    cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
    cam.up.set(0, 1, 0);
    if (Math.abs(sun.y) > 0.99) cam.up.set(0, 0, 1);
    cam.position.copy(pos).addScaledVector(sun, 10);
    cam.lookAt(pos);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.uniforms.shadowVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    // Penumbra widens with distance to the ground (sun disc + skylight), in uv units
    const dist = Math.hypot(pos.x - hit.x, pos.y - hit.y, pos.z - hit.z);
    this.uniforms.soft.value = (0.006 + dist * 0.02) / (2 * R);
    this.uniforms.strength.value = 0.62 * sunK * fade;

    // Contact shadow directly below the drone; strongest when sitting on the ground
    const aoK = 1 - THREE.MathUtils.smoothstep(agl, 0, R * 2.5);
    this.uniforms.aoCenter.value.set(pos.x, groundH, pos.z);
    this.uniforms.aoRadius.value = R * 0.75;
    this.uniforms.aoStrength.value = (0.28 + 0.2 * (1 - sunK)) * aoK;

    // Ground-aligned quad covering both the projected shadow and the contact blob
    const e = 1.5;
    this._n.set(w.heightAt(hit.x - e, hit.z) - w.heightAt(hit.x + e, hit.z), 2 * e,
      w.heightAt(hit.x, hit.z - e) - w.heightAt(hit.x, hit.z + e)).normalize();
    this._q.setFromUnitVectors(this._up, this._n);
    const offset = Math.hypot(pos.x - hit.x, pos.z - hit.z);
    const size = (2 * R) / sy + offset * 2 + R;
    this.quad.position.set((hit.x + pos.x) / 2, hit.y + 0.005, (hit.z + pos.z) / 2);
    this.quad.position.y = w.heightAt(this.quad.position.x, this.quad.position.z) + 0.005;
    this.quad.quaternion.copy(this._q);
    this.quad.scale.set(size, 1, size);

    this.renderSilhouette();
  }

  renderSilhouette() {
    const r = this.renderer;
    const scene = this.scene;
    const prev = {
      target: r.getRenderTarget(),
      autoUpdate: r.shadowMap.autoUpdate,
      alpha: r.getClearAlpha(),
      bg: scene.background,
      override: scene.overrideMaterial,
      scissor: r.getScissorTest(),
    };
    r.getClearColor(this._clear);
    r.shadowMap.autoUpdate = false; // don't re-render the world shadow map for this pass
    scene.background = null;
    scene.overrideMaterial = this.silhouette;
    r.setScissorTest(false);
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(scene, this.cam);
    r.setRenderTarget(prev.target);
    r.setClearColor(this._clear, prev.alpha);
    r.setScissorTest(prev.scissor);
    scene.overrideMaterial = prev.override;
    scene.background = prev.bg;
    r.shadowMap.autoUpdate = prev.autoUpdate;
  }
}
