// Sensitivity reshapes the response, preserving the dead zone and full lock.
// 100% reproduces the existing softened stick response exactly.
export function gamepadSteering(axis,sensitivity=1,deadzone=.08) {
  const stick=Math.max(-1,Math.min(1,Number.isFinite(axis)?axis:0));
  const response=Math.max(0.25,Math.min(1.75,Number.isFinite(sensitivity)?sensitivity:1));
  const centre=Math.max(0,Math.min(.30,Number.isFinite(deadzone)?deadzone:.08));
  const travel=Math.max(0,(Math.abs(stick)-centre)/(1-centre));
  return Math.round(Math.sign(stick)*Math.pow(travel,1.6/response)*100)||0;
}
