/*
 * Minimal concurrency limiter: createLimiter(n) returns `limit(fn)` which runs
 * `fn` once fewer than n limited functions are in flight. Used to gate image
 * preparation (CPU) and Gemini calls (network) independently so the two stages
 * overlap across images instead of running image-by-image.
 */

function createLimiter(max) {
  const cap = Math.max(1, Math.floor(max) || 1);
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < cap && queue.length) { active++; queue.shift()(); }
  };
  const limit = async (fn) => {
    await new Promise(resolve => { queue.push(resolve); next(); });
    try { return await fn(); }
    finally { active--; next(); }
  };
  limit.max = cap;
  return limit;
}

const passthrough = (fn) => fn();

module.exports = { createLimiter, passthrough };
