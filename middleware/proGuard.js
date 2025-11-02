// src/middleware/proGuard.js

// Si el usuario intenta 'real' sin PRO ni claves, degradamos a 'sim' para proteger la UX.
export function proGuard(req, _res, next) {
  req.state = req.state || {};
  const st = req.state;

  if (st.mode === "real" && !(st.isPro || st.hasKeys)) {
    console.log("proGuard> forcedSim=1 reason=no-permission");
    st.mode = "sim";
    // Por compatibilidad con handlers que lean body.mode
    req.body = req.body || {};
    req.body.mode = "sim";
  } else {
    console.log("proGuard> forcedSim=0");
  }

  return next();
}
