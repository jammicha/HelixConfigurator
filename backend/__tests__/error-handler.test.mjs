// backend/__tests__/error-handler.test.mjs
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';
import errorHandlerPkg from '../errorHandler.js';

const { errorHandler } = errorHandlerPkg;
// errorHandler.js reaches errorLog via require(); use the same CJS instance
// here so we observe the buffer the handler actually writes to.
const require = createRequire(import.meta.url);
const errorLog = require('../errorLog.js');

// Build a tiny app that mounts a throwing route, then the terminal handler —
// mirrors how index.js registers it after every route.
const buildApp = (mount) => {
  const app = express();
  mount(app);
  app.use(errorHandler);
  return app;
};

describe('errorHandler (global Express error middleware)', () => {
  beforeEach(() => {
    errorLog._reset();
    // The handler logs to the console by design; silence it so deliberately
    // triggered errors don't pollute test output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('turns a synchronous throw into a 500 JSON envelope', async () => {
    const app = buildApp((a) =>
      a.get('/boom', () => {
        throw new Error('sync boom');
      }),
    );
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.details).toBe('sync boom');
  });

  it('catches a rejected async handler (Express 5 forwards rejections to error mw)', async () => {
    const app = buildApp((a) =>
      a.get('/boom', async () => {
        throw new Error('async boom');
      }),
    );
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.details).toBe('async boom');
  });

  it('records the failure in the error log so the dashboard can surface it', async () => {
    const app = buildApp((a) =>
      a.get('/boom', () => {
        throw new Error('logged boom');
      }),
    );
    await request(app).get('/boom');
    const recent = errorLog.recent(5);
    expect(recent.some((e) => e.message === 'logged boom')).toBe(true);
  });

  it('delegates to next() instead of double-sending when headers were already sent', () => {
    let forwarded;
    const res = {
      headersSent: true,
      status() {
        throw new Error('must not set status after headers sent');
      },
      json() {
        throw new Error('must not send body after headers sent');
      },
    };
    const err = new Error('late boom');
    errorHandler(err, { method: 'GET', url: '/late' }, res, (e) => {
      forwarded = e;
    });
    expect(forwarded).toBe(err);
  });
});
