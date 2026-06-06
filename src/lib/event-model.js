// ── Event/Scenario Overlay Model ────────────────────────────────────────
// Mixture distribution: blend conditional distributions given discrete events.
// P(S) = Σ P(eventᵢ) × P(S | eventᵢ)
//
// Each event has: probability, price impact (mean return + vol), vol impact.
// The base distribution is the "no event" case.

// Generate a log-normal conditional PDF for a given event
function conditionalPDF(spot, eventMeanReturn, eventVol, T, strikes) {
  const mu = Math.log(spot) + eventMeanReturn - 0.5 * eventVol ** 2 * T;
  const sigma = eventVol * Math.sqrt(T);

  return strikes.map((K) => {
    if (K <= 0 || sigma <= 0) return 0;
    const d = (Math.log(K) - mu) / sigma;
    return Math.exp((-d * d) / 2) / (K * sigma * Math.sqrt(2 * Math.PI));
  });
}

// Build a mixture PDF from events + base distribution
export function buildEventOverlay(events, basePDF, spot, T) {
  const strikes = basePDF.strikes;
  const step = strikes.length > 1 ? strikes[1] - strikes[0] : 1;

  // compute remaining probability for base case
  const eventProbSum = events.reduce((s, e) => s + e.prob, 0);
  const baseProbability = Math.max(0, 1 - eventProbSum);

  // start with weighted base distribution
  const mixture = strikes.map((_, i) => baseProbability * (basePDF.density[i] || 0));

  // add each event's conditional distribution
  for (const event of events) {
    if (event.prob <= 0) continue;

    const eventVol = event.vol || 0.2; // vol of the conditional distribution
    const meanReturn = event.priceMove || 0; // expected log return under this event

    const conditional = conditionalPDF(spot, meanReturn, eventVol, T, strikes);

    // normalize conditional
    const condTotal = conditional.reduce((s, d) => s + d * step, 0);
    if (condTotal > 0) {
      for (let i = 0; i < strikes.length; i++) {
        conditional[i] /= condTotal;
      }
    }

    // add weighted conditional to mixture
    for (let i = 0; i < strikes.length; i++) {
      mixture[i] += event.prob * conditional[i];
    }
  }

  // normalize final mixture
  const total = mixture.reduce((s, d) => s + d * step, 0);
  if (total > 0) {
    for (let i = 0; i < mixture.length; i++) mixture[i] /= total;
  }

  // compute CDF
  const cdf = new Array(strikes.length);
  let cumulative = 0;
  for (let i = 0; i < strikes.length; i++) {
    cumulative += mixture[i] * step;
    cdf[i] = Math.min(cumulative, 1);
  }

  return {
    strikes,
    density: mixture,
    cdf,
    dte: basePDF.dte,
    spot,
    strikeStep: step,
    events,
    baseProbability,
    expectedValue: strikes.reduce((s, k, i) => s + k * mixture[i] * step, 0),
    variance: (() => {
      const mean = strikes.reduce((s, k, i) => s + k * mixture[i] * step, 0);
      return strikes.reduce((s, k, i) => s + (k - mean) ** 2 * mixture[i] * step, 0);
    })(),
  };
}

// Convenience: create an event object
export function makeEvent(name, prob, priceMove, vol = 0.2, ivShift = 0) {
  return { name, prob, priceMove, vol, ivShift };
}
