---
name: better-result
description: Apply when writing or reviewing TypeScript error handling with the `better-result` library. Encodes best-practice use of typed domain errors, Result composition, and boundary handling.
---

# Error Handling with `better-result`

Guide for [`better-result`](https://github.com/dmmulroy/better-result). Existing code may predate these conventions — treat it as a migration target, not a template.

## Core Principles

1. **No `try/catch` in business code.** Wrap throwing functions at I/O boundaries with `Result.try` / `Result.tryPromise`; propagate `Result<T, E>` inward.
2. **Typed domain errors.** Every failure mode is a `TaggedError`. Functions return `Result<T, DomainError>`, never `Result<T, Error | unknown>`.
3. **Preserve causes.** Wrapping errors declare `cause: unknown` in Props and pass the original through. This keeps the stack chain alive until the terminal log.
4. **Compose with `Result.gen`** for any flow with 2+ Result-returning calls. `.isErr()` ladders are an anti-pattern beyond a single step.
5. **Propagate by default; recover deliberately.** `.unwrapOr` and friends are a design decision, not a reflex. See [Propagate vs Recover](#propagate-vs-recover).
6. **Log at lifecycle ends only** — terminal boundaries and recovery sites. Never in `catch` / `mapError` transformations.
7. **Never leak raw `Result` objects to the client.** Return plain objects or let the framework handle serialization.

## Defining Tagged Errors

Factory signature: `TaggedError("Tag")<Props>()`. Always include `message`.

```ts
import { TaggedError } from "better-result";

// Minimum viable — pure domain condition
export class NotFoundError extends TaggedError("NotFoundError")<{
  message: string;
}>() {}

// Wraps an underlying exception — MUST declare cause
export class DbError extends TaggedError("DbError")<{
  operation: string;
  message: string;
  cause: unknown;
}>() {
  constructor(args: { operation: string; cause: unknown }) {
    const detail = args.cause instanceof Error ? args.cause.message : String(args.cause);
    super({ ...args, message: `Database ${args.operation} failed: ${detail}` });
  }
}

// Domain context — fields the handler will actually use
export class RateLimitError extends TaggedError("RateLimitError")<{
  resource: string;
  retryAfterMs: number;
  message: string;
}>() {
  constructor(args: { resource: string; retryAfterMs: number }) {
    super({
      ...args,
      message: `Rate limited on ${args.resource}, retry after ${args.retryAfterMs}ms`,
    });
  }
}
```

`cause` is not implicit. The base constructor plumbs it to `Error.cause` and appends its stack under `Caused by:`, but TypeScript only lets you pass it if it's declared in `Props`. Any error constructed inside a `catch` handler must declare `cause: unknown`.

### Conventions

- **Co-locate errors with the function that raises them** — never a separate `errors.ts`. Add a linter ignore comment when a file has multiple errors if your tooling requires it.
- **Export a union** when callers handle several together:
  ```ts
  export type UserStoreError = NotFoundError | DbError | ValidationError;
  ```
- **Naming:** prefix with domain + failure category, suffix with `Error`. `UserDbError`, `ConfigParseError`. Avoid generic `ApiError` / `DbError` — they collide across domains and lose meaning in logs.

## Wrapping I/O Boundaries

Always use the object form `{ try, catch }`. The bare thunk form collapses the error type to `UnhandledException` and erases domain info.

```ts
const result = await Result.tryPromise({
  try: () => db.query("SELECT * FROM users WHERE id = ?", userId),
  catch: (e) => new DbError({ operation: "select", cause: e }),
});
```

`catch` is a transformation: map unknown → typed error, preserve `cause`, return. No logging.

Sync parsing:

```ts
const parsed = Result.try({
  try: () => JSON.parse(input) as Config,
  catch: (e) => new ConfigParseError({ cause: e }),
});
```

External APIs with retry — scope retries to specific failure modes, only for idempotent operations (GET/read, natural-key upserts):

```ts
const result = await Result.tryPromise(
  {
    try: () => apiClient.post(url, payload),
    catch: (e) =>
      e instanceof TypeError || apiClient.isNetworkError(e)
        ? new NetworkError({ message: "network failure", cause: e })
        : new ApiValidationError({ message: String(e) }),
  },
  {
    retry: {
      times: 3,
      delayMs: 200,
      backoff: "exponential",
      shouldRetry: (e) => e._tag === "NetworkError",
    },
  },
);
```

## Composing Operations

Use `Result.gen` for any flow with 2+ Result-returning calls. `yield*` short-circuits on the first `Err`; yielded error types union into the return type automatically.

```ts
function runAnalysis(
  userId: string,
): Promise<Result<AnalysisResult, DbError | ServiceError>> {
  return Result.gen(async function* () {
    const cached = yield* Result.await(findAnalysis(userId));
    if (cached !== null) {
      return Result.ok({ userId, result: cached, cached: true });
    }

    const analysis = yield* Result.await(analyzeUser(userId));
    const persisted = yield* Result.await(saveAnalysis(userId, analysis));

    return Result.ok({ userId, result: persisted, cached: false });
  });
}
```

`Result.await` yields a `Promise<Result<T, E>>`.

### Normalising error unions

Collapse disparate error types with `mapError`. Always pass the original as `cause` — otherwise the stack chain is severed before it reaches the terminal log.

```ts
// ✓ chain preserved: ProcessingError → ParseError → SyntaxError
.mapError((e) => new ProcessingError({ source: e._tag, message: e.message, cause: e }))

// ✗ chain severed — terminal log shows only ProcessingError
.mapError((e) => new ProcessingError({ source: e._tag, message: e.message }))
```

`ProcessingError`'s Props must declare `cause: unknown`.

### When `.isErr()` is fine

Single-step, early-return flows:

```ts
const result = await getActiveConfig(userId);
if (result.isErr()) return result;
const config = result.value;
```

Reach for `Result.gen` once a second step appears. `.andThen` / `.map` are fine for one-liners or `pipe` chains — prefer `gen` for anything multi-step.

## Propagate vs Recover

**Default: propagate.** `Result<T, E>` exists so failures travel up to a terminal boundary that renders a real response. Anything that converts `Err` → "success" (`.unwrapOr`, `.isOk() ? v : default`, `.match({ err: () => fallback })`) is **recovery**.

Recover only when all three hold:

1. **The fallback is a genuine success state** for the caller, not a cover-up. "No profile yet → `null`" is real; "empty orders because DB failed" is not.
2. **The caller cannot surface the failure meaningfully** (e.g. non-critical prompt enrichment).
3. **The recovery is logged** — terminal boundaries will never see it.

If any is in doubt, propagate.

### The "broken data state" failure mode

These hide failures behind plausible defaults and have caused real incidents. Each should propagate:

```ts
// ✗ DB read failed → UI shows "0 orders"
const orders = ordersResult.unwrapOr([]);

// ✗ Config read failed → wrong config silently applied
const config = configResult.unwrapOr(DEFAULT_CONFIG);

// ✗ Write failed → caller thinks the write succeeded
const id = (await createRecord(data)).unwrapOr("unknown");

// ✗ Parse failed → downstream sees a shape that never existed
const parsed = parseResult.unwrapOr({ items: [], total: 0 });
```

### Rule of thumb

- **Reads feeding UI / decisions** → propagate.
- **Writes** → always propagate.
- **Non-critical enrichment** (optional prompt context, best-effort cache) → recovery + log.
- **Optional-by-design data** → return `Result<T | null, E>` from the producer rather than `.unwrapOr(null)` at the call site.

## Handling at Boundaries

A *boundary* is where a Result stops being a Result: HTTP response, server-function return, job handler, log line.

### HTTP route handlers

```ts
import { matchError } from "better-result";

export async function getUserHandler(req, res) {
  const result = await getUser(req.params.id);
  if (result.isOk()) return Response.json(result.value);

  return matchError(result.error, {
    NotFoundError: () => Response.json({ error: "Not found" }, { status: 404 }),
    DbError: (e) => {
      logger.error({ err: e, msg: "user db failure" });
      return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
    },
  });
}
```

`matchError` is **exhaustive** — new union members become type errors at every boundary until handled. Don't replace with `if (XError.is(...))` chains.

`matchErrorPartial` when a catch-all is reasonable:

```ts
matchErrorPartial(
  result.error,
  { NotFoundError: () => Response.json({ error: "Not found" }, { status: 404 }) },
  (e) => {
    logger.error({ err: e, msg: "unhandled user error" });
    return Response.json({ error: "Server error" }, { status: 500 });
  },
);
```

### Job / worker handlers

Handler returns `Result`; the worker wrapper throws on `Err` so the job framework retries. Throw a special "unrecoverable" error to skip retry.

```ts
const result = await runAnalysis(job.data.userId);
if (result.isErr()) {
  return matchError(result.error, {
    DbError: (e) => {
      logger.error({ err: e, msg: "analysis db failure — will retry" });
      return Result.err(e);
    },
    ValidationError: (e) => {
      logger.error({ err: e, msg: "analysis invalid input — skipping retry" });
      throw new UnrecoverableError(e.message); // or your framework's equivalent
    },
  });
}
```

## Logging

Log exactly once, at lifecycle ends:

1. **Terminal boundary** — route handler, server-function handler, job handler, tool handler. The Result leaves the Result world here; the handler has full request/job context.
2. **Recovery / fallback site** — `.unwrapOr(default)`, fail-open `if (r.isErr()) return fallback`. Errors here never reach a terminal boundary.

Transformations **never log**:

- `catch` handlers (`Result.try` / `tryPromise`) — map unknown → typed, return.
- `mapError` callbacks — rename/normalise, return.

### How the trail survives to the terminal

`TaggedError`'s base constructor chains `cause`'s stack into `this.stack` under `Caused by:`. `toJSON()` emits `_tag`, `message`, `stack`, declared Props, and a recursively normalised `cause`. Many loggers serialise `err` via `toJSON()` automatically — one log line at the terminal contains the outer tag/message, every Prop, the full stack chain down to the raw exception, and each intermediate tag.

The chain breaks only if `mapError` omits `cause` — see [Normalising error unions](#normalising-error-unions).

### Terminal and recovery examples

```ts
// Terminal (HTTP route)
if (result.isErr()) {
  return matchError(result.error, {
    DbError: (e) => {
      logger.error({ err: e, userId, msg: "user db failure" });
      return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
    },
    NotFoundError: () => Response.json({ error: "Not found" }, { status: 404 }),
  });
}

// Recovery (fail-open enrichment)
const analysis = analysisResult.isOk() ? analysisResult.value : null;
if (analysisResult.isErr()) {
  logger.warn({ err: analysisResult.error, userId, msg: "analysis unavailable, continuing without it" });
}
```

## Panic vs Err

`Panic` is thrown (not returned) when user callbacks throw inside Result operations (`.map`, `.andThen`, `Result.gen` bodies, `catch` handlers). It represents a bug, not a domain error.

- **Don't catch Panic.** Fix the callback. If a `.map` can fail, it's not a pure transformation — return a `Result` and use `.andThen` / `Result.gen`.
- **Don't return `Err` for programmer errors** (null deref, impossible branch). Let them surface via `throw` / `panic()`.

`UnhandledException` is the typed error produced by bare-thunk `Result.try`. Since we mandate `{ try, catch }`, you should rarely see it.

## Framework Escape Hatches (Throwing Is Correct)

- **Middleware redirects:** `throw redirect(...)` / `throw new Response(...)` short-circuits. Wrapping in `Result` bypasses the framework.
- **Job retry:** the worker wrapper converts `Result.err` → throw; `UnrecoverableError` (or your framework's equivalent) skips retry. Handlers return `Result`, the wrapper throws.
- **Validation frameworks** (Zod, Valibot, etc.) at request-validation middleware throw so the framework renders as 400. Inside business logic, use `.safeParse` + `Result.try`.

## Anti-Patterns (Fix on Sight)

1. **TaggedError missing `message` or `cause`**
   ```ts
   class ConfigDbError extends TaggedError("ConfigDbError")() {}                     // ✗ no props
   class ConfigDbError extends TaggedError("ConfigDbError")<{ message: string }>() {} // ✗ wraps exception, no cause
   ```

2. **Logging in `catch` / `mapError`** — they're transformations; log at the terminal or recovery site.

3. **Bare-thunk `Result.try`** — collapses to `UnhandledException`. Use `{ try, catch }`.

4. **`.isErr()` ladder for multi-step flows** — rewrite with `Result.gen`.

5. **Returning raw `Result` to the client** — serialise to plain objects at the server boundary.

6. **`result.unwrap()` after `.isOk()`** — use `result.value` (already narrowed).

7. **Generic error names** (`DbError`, `ApiError`) — collide across domains. Prefix with the domain.

8. **`.unwrapOr` hiding a real failure** — see [Propagate vs Recover](#propagate-vs-recover).
   ```ts
   const orders = ordersResult.unwrapOr([]);              // ✗ DB failure → "0 orders"
   const config = configResult.unwrapOr(DEFAULT_CONFIG);  // ✗ wrong config, silent
   ```

## Module Conventions & Checklist

- Errors co-located with the code that raises them — no separate `errors.ts`.
- Business logic returning `Result<T, DomainError>`. Route / server-function handlers unwrap.
- Import directly from `better-result` — no internal re-exports.
  ```ts
  import { Result, TaggedError, matchError, matchErrorPartial } from "better-result";
  ```

**New module checklist:**

1. TaggedError classes defined alongside the functions that raise them; export a union if callers handle several together.
2. Every I/O call wrapped with `Result.try*({ try, catch })`; `catch` returns a typed error — no logging.
3. Multi-step flows use `Result.gen` + `Result.await`; normalise with `mapError` preserving `cause`.
4. Boundary uses `matchError` to map errors → responses/log lines; log once at the boundary.
5. No raw `Result` objects cross the server boundary.
6. No `try/catch`, no `throw` (except framework escape hatches).
