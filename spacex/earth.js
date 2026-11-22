/* Earth constants shared by the globe (globe-core.js), the trajectory code (spacex.js) and the
   ascent model (ascent.js). No imports, so node tests can load it. */
export const R_E = 6371;              // km, mean radius (the globe is a sphere)
export const D2R = Math.PI / 180;
export const MU = 398600.4418;        // km^3/s^2
export const OMEGA_E = 7.2921159e-5;  // rad/s, Earth's rotation
