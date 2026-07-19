// The fixed rotation order. Edit names here if the team changes.
const ORDER = ["Munna", "Jennie", "Peem"];

/**
 * Given how many cases have already been logged (before this new one),
 * return who this new case belongs to.
 * e.g. 0 cases logged so far -> Munna gets case #1
 *      1 case logged so far  -> Jennie gets case #2
 */
function whoIsNext(casesLoggedSoFar) {
  const idx = casesLoggedSoFar % ORDER.length;
  return ORDER[idx];
}

function upcomingOrder(casesLoggedSoFar, count = 3) {
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push(whoIsNext(casesLoggedSoFar + i));
  }
  return result;
}

module.exports = { ORDER, whoIsNext, upcomingOrder };
