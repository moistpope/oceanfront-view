// Input conventions are independent of the chosen speedometer display units. Each setting's Auto goes by the country
// the car is in (region.js, set here by main.js) and, before that is known, by what the car says.

let country = null;

/** The country the car is in (region.js countryInfo()), or null while unknown. */
export function setCountry(c) { country = c || null; }
export function currentCountry() { return country; }

export function leftTraffic(settings = {}, fisker) {
  if (settings.trafficSide === 'left') return true;
  if (settings.trafficSide === 'right') return false;
  if (country) return country.left;
  return fisker?.road?.trafficSide === 'Left_Hand_Traffic';
}

/** The unit of the camera's speed-limit readings: the setting's, else the country's (the ADAS reports UK signs in
 *  km/h when the head unit says nothing, and 30 mph showed as 19), else what the ADAS says. */
export function cameraSignUnit(settings = {}, tsr = {}) {
  if (['mph', 'kmh'].includes(settings.cameraSignUnits)) return settings.cameraSignUnits;
  if (country) return country.mph ? 'mph' : 'kmh';
  return tsr.unit;
}

/**
 * Which speed-limit sign to draw: the round red-ringed one ('eu': the UK and Europe) or the US rectangle ('us').
 * The setting picks one outright; otherwise the country's, or before that's known, the US sign for mph on the right,
 * since the UK reads mph too.
 */
export function signStyle(settings = {}, unit, fisker) {
  if (settings.signStyle === 'round') return 'eu';
  if (settings.signStyle === 'us') return 'us';
  if (country) return country.usSign ? 'us' : 'eu';
  return unit === 'mph' && !leftTraffic(settings, fisker) ? 'us' : 'eu';
}

export function cameraSignValue(settings, tsr, displayUnit) {
  const source = cameraSignUnit(settings, tsr);
  return source && source !== displayUnit
    ? Math.round(tsr.speedLimit * (displayUnit === 'kmh' ? 1.609344 : 1 / 1.609344))
    : tsr.speedLimit;
}
