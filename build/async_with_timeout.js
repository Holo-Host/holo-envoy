
class TimeoutError extends Error {

    constructor( message, timeout, ...params ) {
	// Pass remaining arguments (including vendor specific ones) to parent constructor
	super( message );

	// Maintains proper stack trace for where our error was thrown (only available on V8)
	if ( Error.captureStackTrace ) {
	    Error.captureStackTrace( this, TimeoutError );
	}

	this.name			= 'TimeoutError';
	this.timeout			= timeout;
    }
}

function async_with_timeout ( fn, timeout = 2000 ) {
    return new Promise(async (f,r) => {
	const to_id			= setTimeout(() => {
	    r( new TimeoutError("Waited for " + (timeout/1000) + " seconds", timeout ) );
	}, timeout);

	try {
	    const result		= await fn();
	    f( result );
	} catch ( err ) {
	    r( err );
	} finally {
	    clearTimeout( to_id );
	}
    });
}

async_with_timeout.TimeoutError		= TimeoutError;
module.exports				= async_with_timeout;
