import { TimeoutError } from "../errors/timeout-error";

function async_with_timeout(fn, timeout = 50000) {
  return new Promise(async (f, r) => {
    const to_id = setTimeout(() => {
      r(new TimeoutError("Waited for " + (timeout / 1000) + " seconds", timeout));
    }, timeout);

    try {
      const result = await fn();
      f(result);
    } catch (err) {
      r(err);
    } finally {
      clearTimeout(to_id);
    }
  });
}

async_with_timeout.TimeoutError = TimeoutError;
module.exports = async_with_timeout;
