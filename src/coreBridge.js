// Runs getmeds-system's own route handlers (src/core/controllers) on behalf of
// the person signed in here.
//
// Those handlers are the tested, production code for everything Zoho touches
// (Sales Orders, webhooks, reconcile, retry), for attachments, Rx checks,
// holds, stock announcements, notifications and search. Rather than copy their
// logic, this app calls them, with the signed-in person as the `users` row they
// expect in req.user. src/core/middleware/auth.js lets a bridged request past
// its own token check (marked "discord-app" there).
//
// Two ways in:
//   invoke(handler, req, { params, body, query })  -> { status, body }
//       for this app's own routes, which need the handler's answer to build
//       their own (an order id here is GM-…; the core's is the row id).
//   asCore()  middleware that swaps req.user for the core's shape, for core
//       routers mounted as they are under /api/core/*.

// The users row the core expects, from this app's signed-in person.
function coreUser(user) {
  return { ...user.db, __bridged: true };
}

// Calls one core handler and resolves with what it answered. It never throws
// for an error response; the caller reads the status. A thrown error (the
// handler's own next(err)) rejects.
function invoke(handler, req, { params = {}, body = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const fakeReq = {
      user: coreUser(req.user),
      params,
      body,
      query,
      headers: req.headers,
      method: 'POST',
      get: (h) => req.get?.(h),
      protocol: req.protocol,
      hostname: req.hostname,
      originalUrl: req.originalUrl,
    };
    let statusCode = 200;
    const headers = {};
    const res = {
      status(code) { statusCode = code; return res; },
      set(k, v) { if (typeof k === 'object') Object.assign(headers, k); else headers[k] = v; return res; },
      setHeader(k, v) { headers[k] = v; return res; },
      json(payload) { resolve({ status: statusCode, body: payload, headers }); return res; },
      send(payload) { resolve({ status: statusCode, body: payload, headers }); return res; },
      end() { resolve({ status: statusCode, body: null, headers }); return res; },
      redirect(url) { resolve({ status: 302, body: null, headers: { ...headers, Location: url } }); return res; },
    };
    Promise.resolve()
      .then(() => handler(fakeReq, res, (err) => (err ? reject(err) : resolve({ status: 404, body: null, headers }))))
      .catch(reject);
  });
}

// The core answers { success, data } or { success: false, error: { message } };
// this app's pages read { …data } or { error }.
function relay(res, result) {
  const { status, body } = result;
  if (body && body.success === false) {
    return res.status(status >= 400 ? status : 400).json({ error: body.error?.message || body.message || 'That did not work.', code: body.error?.code });
  }
  return res.status(status).json(body && 'data' in body ? body.data ?? {} : body ?? {});
}

// For core routers mounted as they are: the core sees its own users row.
function asCore() {
  return (req, _res, next) => {
    req.appUser = req.user;
    req.user = coreUser(req.user);
    next();
  };
}

module.exports = { invoke, relay, asCore, coreUser };
