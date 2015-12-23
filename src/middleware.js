import fetch from 'isomorphic-fetch';
import isPlainObject from 'lodash.isplainobject';

import CALL_API from './CALL_API';
import { isRSAA, validateRSAA } from './validation';
import { InvalidRSAA, RequestError, ApiError } from './errors' ;
import { getJSON, normalizeTypeDescriptors, actionWith, delay } from './util';


/**
 * A Redux middleware that processes RSAA actions.
 *
 * @type {ReduxMiddleware}
 * @access public
 */
function apiMiddleware(options) {
  options = {
    queuedRetries: 100,      // how many times to retry a queued response before giving up
    queuePollInterval: 3000, // how often to poll queued analytics in MS
    ...options
  };

  return (({ getState }) => (next) => async (action) => {
    // Do not process actions without a [CALL_API] property
    if (!isRSAA(action)) {
      return next(action);
    }

    // Try to dispatch an error request FSA for invalid RSAAs
    const validationErrors = validateRSAA(action);
    if (validationErrors.length) {
      const callAPI = action[CALL_API];
      if (callAPI.types && Array.isArray(callAPI.types)) {
        let requestType = callAPI.types[0];
        if (requestType && requestType.type) {
          requestType = requestType.type;
        }
        next({
          type: requestType,
          payload: new InvalidRSAA(validationErrors),
          error: true
        });
      }
      return;
    }

    // Parse the validated RSAA action
    const callAPI = action[CALL_API];
    var { endpoint, headers } = callAPI;
    const { method, body, credentials, bailout, types, canQueue } = callAPI;
    const [requestType, successType, failureType] = normalizeTypeDescriptors(types);

    // Should we bail out?
    try {
      if ((typeof bailout === 'boolean' && bailout) ||
          (typeof bailout === 'function' && bailout(getState()))) {
        return;
      }
    } catch (e) {
      return next(await actionWith(
        {
          ...requestType,
          payload: new RequestError('[CALL_API].bailout function failed'),
          error: true
        },
        [action, getState()]
      ));
    }

    // Process [CALL_API].endpoint function
    if (typeof endpoint === 'function') {
      try {
        endpoint = endpoint(getState());
      } catch (e) {
        return next(await actionWith(
          {
            ...requestType,
            payload: new RequestError('[CALL_API].endpoint function failed'),
            error: true
          },
          [action, getState()]
        ));
      }
    }

    // Process [CALL_API].headers function
    if (typeof headers === 'function') {
      try {
        headers = headers(getState());
      } catch (e) {
        return next(await actionWith(
          {
            ...requestType,
            payload: new RequestError('[CALL_API].headers function failed'),
            error: true
          },
          [action, getState()]
        ));
      }
    }

    // We can now dispatch the request FSA
    next(await actionWith(
      requestType,
      [action, getState()]
    ));
    // As we have dispatched the request FSA, all other
    // dispatches must now be either success or failure

    try {
      // Make the API call
      var fn = canQueue ? fetchPollingQueued : fetch;

      var res = await fn(endpoint, { method, body, credentials, headers }, options);
    } catch(e) {
      // The request was malformed, or there was a network error
      return next(await actionWith(
        {
          ...failureType,
          payload: new RequestError(e.message),
          error: true
        },
        [action, getState()]
      ));
    }

    // Process the server response
    if (res.ok) {
      return next(await actionWith(
        successType,
        [action, getState(), res]
      ));
    } else {
      return next(await actionWith(
        {
          ...failureType,
          error: true
        },
        [action, getState(), res]
      ));
    }
  });
}

async function fetchPollingQueued(endpoint, { method, body, credentials, headers }, options) {
  // if response is { queued: true }, poll every n seconds until we get a
  // real response
  let retries = options.queuedRetries;
  while (retries--) {
    var res = await fetch(endpoint, { method, body, credentials, headers });

    try {
      var json = await res.clone().json();
      if (json.queued) {
        await delay(options.queuePollInterval);
        continue;
      }
    } catch (e) { /* ignore and continue */}

    return res;
  }
}

export { apiMiddleware };
