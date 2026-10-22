'use strict';

// HTTP errors and input checks shared by the routes. An error with a `status` is sent to the client as is;
// anything else becomes a 500 (see dispatch in routes/index.js).

const httpError = (status, message) => Object.assign(new Error(message), { status });
const badRequest = (message) => httpError(400, message);
const notFound = (message) => httpError(404, message);
const forbidden = (message) => httpError(403, message);

function number(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${name} must be a number`);
  return parsed;
}

const percent = (value) => Math.max(0, Math.min(100, Math.round(number(value, 'level'))));

module.exports = { httpError, badRequest, notFound, forbidden, number, percent };
