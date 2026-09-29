// The first import registers the fail-closed device-side action gate before
// any command handler is evaluated. Firefox loads the same classic gate first.
import './privacy/privacy-core.js';
import './action-binding-runtime.js';
import './service-worker.js';
