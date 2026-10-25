import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { type AppEnv, auth, requireUser } from './auth.ts';
import { HttpError, toHttpError } from './errors.ts';
import { routes } from './routes.ts';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The API, independent of where it runs: the Worker (worker.ts) and the tests both call app.fetch with a pool
 * and a configuration. Everything is under /api; the Worker serves the app's files for every other path.
 */
export const app = new Hono<AppEnv>().basePath('/api');

app.use(async (c, next) => {
  const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  const started = Date.now();
  await next();
  c.header('X-Request-Id', requestId);
  c.env.config.log({
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    ms: Date.now() - started,
    user: c.var.user?.id,
  });
});

app.use(secureHeaders());
app.use(
  bodyLimit({ maxSize: 64 * 1024, onError: (c) => errorResponse(c, new HttpError(413, 'TOO_LARGE', 'Too large')) }),
);

/**
 * Cross-site request forgery: a request that changes anything must come from this site's own pages. Browsers
 * always send Origin on such requests, and a page elsewhere cannot fake it. SameSite=Lax on the session cookie
 * is the second layer.
 */
app.use(async (c, next) => {
  if (UNSAFE.has(c.req.method) && c.req.header('Origin') !== new URL(c.req.url).origin) {
    throw new HttpError(403, 'BAD_ORIGIN', 'Requests that change data must come from Eventide itself');
  }
  await next();
});

app.get('/health', (c) => c.json({ ok: true }));
app.route('/auth', auth);
app.use(requireUser);
app.route('/', routes);

app.notFound((c) => errorResponse(c, new HttpError(404, 'NOT_FOUND', 'Not found')));

app.onError((error, c) => {
  const http = toHttpError(error);
  if (http.status >= 500) {
    c.env.config.log({
      level: 'error',
      requestId: c.get('requestId'),
      error: String(error),
      stack: (error as Error).stack,
    });
  }
  return errorResponse(c, http);
});

function errorResponse(c: Context<AppEnv>, http: HttpError) {
  const body: { code: string; message: string; details?: unknown } = { code: http.code, message: http.message };
  if (http.details !== undefined) body.details = http.details;
  return c.json({ error: body }, http.status);
}
