// Input conventions are independent of the chosen speedometer display units.
export function leftTraffic(settings = {}, fisker) {
  if (settings.trafficSide === 'left') return true;
  if (settings.trafficSide === 'right') return false;
  return fisker?.road?.trafficSide === 'Left_Hand_Traffic';
}

export function cameraSignUnit(settings = {}, tsr = {}) {
  return ['mph', 'kmh'].includes(settings.cameraSignUnits) ? settings.cameraSignUnits : tsr.unit;
}

/**
 * Which speed-limit sign to draw: the round red-ringed one ('eu': the UK and Europe) or the US rectangle ('us').
 * The setting picks one outright; otherwise the US sign is for mph on the right, since the UK reads mph too.
 */
export function signStyle(settings = {}, unit, fisker) {
  if (settings.signStyle === 'round') return 'eu';
  if (settings.signStyle === 'us') return 'us';
  return unit === 'mph' && !leftTraffic(settings, fisker) ? 'us' : 'eu';
}

export function cameraSignValue(settings, tsr, displayUnit) {
  const source = cameraSignUnit(settings, tsr);
  return source && source !== displayUnit
    ? Math.round(tsr.speedLimit * (displayUnit === 'kmh' ? 1.609344 : 1 / 1.609344))
    : tsr.speedLimit;
}
