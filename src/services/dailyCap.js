// Rolling 24-hour per-user cap, in memory (like rateLimiter.js). Used to bound
// how many audio versions a user who isn't paying from the weekly quota
// (a subscriber) can generate. A restart forgets it, which only ever errs
// toward allowing a few extra conversions.

const DAY_MS = 24 * 60 * 60 * 1000;

function createDailyCap({ limit, windowMs = DAY_MS, now = () => Date.now() }) {
  const uses = new Map(); // userId -> [timestamps], oldest first

  function fresh(userId, t) {
    const list = (uses.get(userId) || []).filter((at) => t - at < windowMs);
    if (list.length) uses.set(userId, list);
    else uses.delete(userId);
    return list;
  }

  return {
    limit,
    /** Records one use and returns true, or returns false if the cap is reached. */
    tryTake(userId) {
      const t = now();
      const list = fresh(userId, t);
      if (list.length >= limit) return false;
      list.push(t);
      uses.set(userId, list);
      return true;
    },
    /** Gives back the most recent use (the conversion failed). */
    giveBack(userId) {
      const list = uses.get(userId);
      if (list && list.length) list.pop();
      if (list && !list.length) uses.delete(userId);
    },
    used(userId) {
      return fresh(userId, now()).length;
    },
  };
}

module.exports = { createDailyCap };
