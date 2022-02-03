export class TimeoutError extends Error {
  timeout: number

  constructor(message, timeout, ...params) {
    // Pass remaining arguments (including vendor specific ones) to parent constructor
    super(message)

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TimeoutError)
    }

    this.name = 'TimeoutError'
    this.timeout = timeout
  }
}
