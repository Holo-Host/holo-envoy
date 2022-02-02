export class CustomError extends Error {
    constructor(message) {
      // Pass remaining arguments (including vendor specific ones) to parent constructor
      super(message);
  
      // Maintains proper stack trace for where our error was thrown (only available on V8)
      if (Error.captureStackTrace) {
        Error.captureStackTrace(this, this.constructor);
      }
  
      this.name = this.constructor.name;
  
      // Fix for Typescript
      //   - https://github.com/Microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
      Object.setPrototypeOf(this, this.constructor.prototype);
    }
  
    toJSON() {
      return {
        "name": this.name,
        "message": this.message,
      };
    }
  }