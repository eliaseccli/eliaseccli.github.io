import * as THREE from "/vendor/three.module.min.js";
import { starfield } from "/spacex/globe-core.js?v=g3";
import { bodyAxes } from "./bodies.js?v=5";

/* The far-away sky: Milky Way panorama + stars, drawn around the camera
   (rotation only) before everything else. Shared by space and the ground. */
export class Sky {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    const tex = new THREE.TextureLoader().load(new URL("./tex/milky-way-2k.webp", import.meta.url).href);
    tex.colorSpace = THREE.NoColorSpace;
    this.u = { map: { value: tex }, k: { value: 1 } };
    const mw = new THREE.Mesh(new THREE.SphereGeometry(80, 64, 32), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, uniforms: this.u,
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: `uniform sampler2D map; uniform float k; varying vec2 vUv;
        void main(){ vec3 c = pow(texture2D(map, vUv).rgb, vec3(2.6)) * 0.9 * k; gl_FragColor = vec4(pow(c, vec3(1.0/2.2)), 1.0); }`
    }));
    // the panorama is in equatorial coordinates: orient like a body whose pole is the celestial pole
    const ax = bodyAxes({ pole: [0, 90] }, 0, -90, {});
    const m = new THREE.Matrix4().set(ax.x[0], ax.y[0], ax.z[0], 0, ax.x[1], ax.y[1], ax.z[1], 0, ax.x[2], ax.y[2], ax.z[2], 0, 0, 0, 0, 1);
    mw.quaternion.setFromRotationMatrix(m);
    mw.scale.x = -1;                // seen from inside
    this.mw = mw;
    this.stars = starfield(2400, 60, 1337);
    this.stars.material.depthTest = false;
    this.scene.add(mw, this.stars);
  }
  render(renderer, cam, k) {
    if (k <= 0.002) return;
    this.u.k.value = k;
    this.stars.material.opacity = Math.min(1, k * 1.2);
    this.camera.fov = cam.fov; this.camera.aspect = cam.aspect; this.camera.updateProjectionMatrix();
    this.camera.quaternion.copy(cam.quaternion);
    renderer.render(this.scene, this.camera);
  }
}
