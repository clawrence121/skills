---
name: tanstack-query
description: Apply when writing or reviewing data-loading code with TanStack Query and/or TanStack Start. Covers server functions, queryOptions factories, useSuspenseQuery vs useQuery, route loader prefetch with ensureQueryData, mutations, and error boundaries.
---

# Data Loading with TanStack Query + TanStack Start

Guide for data loading with TanStack Query and TanStack Start. Existing code may predate these conventions (notably `useQuery` + `initialData` instead of `useSuspenseQuery`). Treat it as a migration target, not a template.

## Core Principles

1. **`useSuspenseQuery` is the default for UI.** Components don't render without data. Loading / error states live in parent `<Suspense>` / `<ErrorBoundary>` boundaries, not in ternaries inside the component.
2. **`useQuery` is for side effects only** — CSV export, feeding data into an AI prompt, analytics that read cached values — where `data === undefined` is a tolerable state.
3. **`queryOptions` factories co-located with their server function or API client.** The function that defines the data shape should own the query options so the two can never drift.
4. **Route loaders prefetch with `ensureQueryData`.** Data is warm in the cache before the component renders — `useSuspenseQuery` hits the cache synchronously on first render.
5. **Throw in `queryFn` / `mutationFn` when the server returns an error**, so `<ErrorBoundary>` / `onError` see a real failure. Never let the component inspect a `status` field on the returned data.
6. **Mutations invalidate surgically** — a specific `queryKey`, not the whole cache.
7. **Query keys are hierarchical and prefixed.** Flat keys like `["userList"]` collide across apps sharing the same `QueryClient`.

## Server Functions + queryOptions

Co-locate the server function, its input validator, and its `queryOptions` factory in a single file. The server function is the I/O boundary; the factory is how the rest of the app uses it.

```ts
// routes/users/-functions/get-user.ts
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod/v4";

export const getUserInputSchema = z.object({ userId: z.string() });

// The server function returns plain data directly.
// Let the framework handle HTTP errors or throw on failure.
export const $getUser = createServerFn({ method: "GET" })
  .inputValidator(getUserInputSchema)
  .handler(async ({ data }) => {
    const user = await getUserFromRepository(data.userId);
    if (!user) throw new Error("User not found"); // framework turns this into a 4xx/5xx response
    return user;
  });

export const userQueryOptions = (userId: string) =>
  queryOptions({
    queryKey: ["app", "user", userId],
    queryFn: async () => {
      const res = await $getUser({ data: { userId } });
      return res;
    },
    staleTime: 60_000,
  });
```

### Rules

- **Handler is a thin controller.** Validate input, delegate to a repository or service, return plain data. No business logic, no direct database queries, no ad-hoc error-wrapping abstractions inside the handler.
- **Factory naming: `<camelCase>QueryOptions`.** With parameters, it's a function returning `queryOptions(...)`; without, it's the `queryOptions(...)` value directly.
- **Static queryKey prefix: `["app", …]`** or your app identifier, followed by the domain segment and any parameters that affect the result (`["app", "user", userId]`).
- **No default exports.** Named exports only.

## Throwing on Server Errors

A server function that throws is a thrown error on the client — but TanStack Query sees it as a failed `queryFn`. For `useSuspenseQuery` + `<ErrorBoundary>` to work, the `queryFn` must throw when the result is an error, or let the server function throw natively. Same rule applies to `mutationFn` / `onError`.

If the server response carries a structured error shape (for example, a discriminated union with a `status` field), throw in the `queryFn` so the error flows to the boundary:

```ts
queryFn: async () => {
  const res = await fetchUser(userId);
  if (res.status === "error") throw new Error(res.error.message);
  return res.value;
},
```

If the boundary needs to distinguish failure modes, attach a tag to the thrown error and branch on it in the fallback:

```ts
queryFn: async () => {
  const res = await fetchUser(userId);
  if (res.status === "error") {
    const err = new Error(res.error.message);
    Object.assign(err, { _tag: res.error._tag });
    throw err;
  }
  return res.value;
},
```

```tsx
function isTaggedError(e: unknown): e is { _tag: string; message: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    "_tag" in e &&
    typeof (e as { _tag: unknown })._tag === "string"
  );
}

function UserError({ error }: FallbackProps) {
  if (!isTaggedError(error)) return <GenericError />;
  switch (error._tag) {
    case "UserDbError":
      return <TryAgain message="Couldn't load the user right now." />;
    case "UserNotFoundError":
      return <NotFound />;
    default:
      return <GenericError />;
  }
}
```

A type guard is the right shape here: `FallbackProps["error"]` is `unknown` from `react-error-boundary`'s perspective, and the `_tag` is attached dynamically in `queryFn`. Casting with `as` silences the mismatch but also defeats the `switch` — a non-string `_tag` would slip through. The guard narrows to a known shape and protects every branch.

- **Never let `.status === "error"` reach the component.** If the component branches on it, `useSuspenseQuery` silently succeeds with an error payload and the `<ErrorBoundary>` never fires.
- **Don't render `error.message` directly in UI.** It can echo back identifiers; map `_tag` to a copy-edited message per case.
- **`error.stack` and `error.cause` don't exist on the wire** — strip them server-side before the response leaves the boundary. Server-side log line is the source of truth for diagnostics.

## Route Loaders: Prefetch with ensureQueryData

Pre-populate the cache during route loading so `useSuspenseQuery` hits it synchronously. This is the TanStack Start equivalent of SSR data loading.

```tsx
// routes/users/$userId.tsx
import { createFileRoute } from "@tanstack/react-router";
import { userQueryOptions } from "./-functions/get-user";

export const Route = createFileRoute("/users/$userId")({
  component: UserPage,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(userQueryOptions(params.userId)),
});

function UserPage() {
  const { userId } = Route.useParams();
  return (
    <ErrorBoundary FallbackComponent={UserError}>
      <Suspense fallback={<UserSkeleton />}>
        <UserProfile userId={userId} />
      </Suspense>
    </ErrorBoundary>
  );
}

function UserProfile({ userId }: { userId: string }) {
  const { data } = useSuspenseQuery(userQueryOptions(userId));
  return <ProfileCard user={data} />;
}
```

- **`ensureQueryData` over `prefetchQuery`** — `ensureQueryData` returns the data (or cached value if fresh) and the loader awaits it. `prefetchQuery` fires and forgets; `useSuspenseQuery` then re-suspends on first render, defeating the loader.
- **Use `beforeLoad` for auth-gated context**, `loader` for page data. Multiple parallel fetches: `Promise.all([ensureQueryData(a), ensureQueryData(b)])`. Don't await them serially.
- **Don't return the data from the loader into `useLoaderData()` and then overlay with `useQuery({ initialData })`** — that pattern exists in many codebases as a migration artifact. The aspirational path is loader prefetch + `useSuspenseQuery` reading from cache.

## useSuspenseQuery vs useQuery

### Use `useSuspenseQuery` for UI

- `data` is always defined — no `data?.field` everywhere.
- Loading / error states are declarative via `<Suspense>` / `<ErrorBoundary>`.
- Components are clean of status-checking logic.

```tsx
function UserList() {
  const { data } = useSuspenseQuery(usersQueryOptions);
  return (
    <ul>
      {data.map((user) => (
        <UserRow key={user.id} user={user} />
      ))}
    </ul>
  );
}
```

### Use `useQuery` for side effects

- CSV export, feeding data into an AI prompt, analytics that read cached values.
- `data === undefined` is tolerable — the feature still works without the data, or waits for a user action.

```tsx
function ExportButton() {
  const { data } = useQuery(usersQueryOptions);
  return (
    <Button disabled={!data} onClick={() => downloadCsv(data ?? [])}>
      Export
    </Button>
  );
}
```

Don't use `useQuery` to render UI with loading/error ternaries. That's what `useSuspenseQuery` + boundaries exist to eliminate.

## Parallel Queries: useSuspenseQueries

Multiple `useSuspenseQuery` calls in the same component run **serially** — each suspends before the next starts. Use `useSuspenseQueries` for independent fetches:

```tsx
function Dashboard({ userId }: { userId: string }) {
  const [userQ, teamsQ, projectsQ] = useSuspenseQueries({
    queries: [
      userQueryOptions(userId),
      teamsQueryOptions(userId),
      projectsQueryOptions(userId),
    ],
  });

  return (
    <DashboardLayout
      user={userQ.data}
      teams={teamsQ.data}
      projects={projectsQ.data}
    />
  );
}
```

Or prefetch in the loader with `Promise.all`:

```tsx
loader: ({ context, params }) =>
  Promise.all([
    context.queryClient.ensureQueryData(userQueryOptions(params.userId)),
    context.queryClient.ensureQueryData(teamsQueryOptions(params.userId)),
    context.queryClient.ensureQueryData(projectsQueryOptions(params.userId)),
  ]),
```

## Multiple Components, Same Query

TanStack Query dedupes by `queryKey` — multiple `useSuspenseQuery` calls with the same options share one network request and one cache entry. Prefer this over prop-drilling:

```tsx
function UserBadge({ userId }: { userId: string }) {
  const { data } = useSuspenseQuery(userQueryOptions(userId));
  return <Avatar name={data.name} />;
}

function UserPanel({ userId }: { userId: string }) {
  const { data } = useSuspenseQuery(userQueryOptions(userId));
  return <ProfileCard user={data} />;
}
```

Both subscribe to the same cache entry; one fetch, two readers.

## Mutations

Mirror the read-side layout: the write server function lives alongside its query options, the component calls it via `useMutation`, and invalidation targets a specific `queryKey`.

```ts
// routes/users/-functions/update-user.ts
export const $updateUser = createServerFn({ method: "POST" })
  .inputValidator(updateUserInputSchema)
  .handler(async ({ data }) => {
    const updated = await updateUserInRepository(data);
    return updated;
  });
```

```tsx
// routes/users/-hooks/use-update-user.ts
export function useUpdateUser(userId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateUserInput) => {
      const res = await $updateUser({ data: input });
      return res;
    },
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(
        userQueryOptions(userId).queryKey,
        updatedUser,
      );
    },
  });
}
```

### Rules

- **`mutationFn` should throw or return on error** — let the mutation result surface failure as a rejection; `onError` or the caller's `try/catch` handles it.
- **Prefer `setQueryData` when the mutation returns the updated entity** — the server has already returned authoritative state, so an extra refetch is wasted I/O. Use `invalidateQueries` only when the response doesn't carry the new shape (e.g. a delete, or a write that affects siblings the client can't reconstruct).
- **Invalidate specific keys**, not `queryClient.invalidateQueries()` with no args — that refetches every active query on the page.
- **Optimistic updates**: use `onMutate` / `onError` rollback from TanStack Query — not a custom client-side error-abstraction dance. See [TanStack docs on optimistic updates](https://tanstack.com/query/latest/docs/react/guides/optimistic-updates).

## Query Key Conventions

Hierarchical, predictable, app-prefixed:

```ts
// ✓ Good
["app", "user", userId]
["app", "user", userId, "posts"]
["app", "user", userId, "posts", postId]
["app", "teams", userId]

// ✗ Avoid — flat, unprefixed, ad-hoc
["userList"]
["getUserById", userId]
["postsForUser", userId]
```

The app prefix (`"app"`) matters because multiple apps may share a `QueryClient` during SSR bootstrapping. An unprefixed key can collide silently.

Parameters that affect the result must appear in the key. Parameters that don't affect it (auth context, logging tags) must not.

## Error Boundaries

Pair `<ErrorBoundary>` with `useQueryErrorResetBoundary` so retry actually re-runs failed queries:

```tsx
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { ErrorBoundary } from "react-error-boundary";

function UserPage({ userId }: { userId: string }) {
  const { reset } = useQueryErrorResetBoundary();

  return (
    <ErrorBoundary onReset={reset} FallbackComponent={UserError}>
      <Suspense fallback={<UserSkeleton />}>
        <UserProfile userId={userId} />
      </Suspense>
    </ErrorBoundary>
  );
}
```

- **Scope boundaries tightly.** A page-level boundary turns any sub-section failure into a full-page error. Wrap each suspendable subtree (chart, list, panel) in its own boundary so siblings keep rendering.
- **Branch on `_tag` in the fallback** when the `queryFn` attached one (see [Throwing on Server Errors](#throwing-on-server-errors)). A generic "something went wrong" fallback misses the opportunity to distinguish a missing-resource 404 from a transient DB failure.
- **Don't render raw `error.message`** — the serialised error strips `stack` and `cause` but `message` can still echo back user input or identifiers. Render a copy-edited message per `_tag`, fall back to a generic message for unknown tags.

## Testing

Wrap test components in a `QueryClient` (with `retry: false`) and provide `<Suspense>` + `<ErrorBoundary>` ancestors so `useSuspenseQuery` resolves in the test render.

```ts
import { QueryClient } from "@tanstack/react-query";

it("renders the user", async () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  // Use your app's test renderer that provides QueryClient + Router context.
  renderWithProviders(<UserProfile userId="abc" />, { queryClient });

  expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
});
```

- **`useSuspenseQuery` components need `<Suspense>` and `<ErrorBoundary>` ancestors.** Wrap the component under test (or supply them in the test fixture) so suspension and errors resolve in the test render.
- **`retry: false`** — already a sensible default for tests. Without it, test failures retry up to 3 times with exponential backoff, stretching a 5ms assertion into 30s.
- **`gcTime: 0`** in a test-specific `QueryClient` — prevents cache state bleeding between tests when running in parallel or sharing fixtures.
- Mock server functions or API calls via your app's standard mocking tools (e.g. TanStack Start test helpers, MSW, or vitest mocks). Don't reinvent per spec file.

## Anti-patterns (fix on sight)

1. **`useQuery` + `data?.field` ternaries in JSX** for UI rendering — use `useSuspenseQuery` with a parent `<Suspense>`.
2. **Loader calls `prefetchQuery`** instead of `ensureQueryData` — `useSuspenseQuery` still suspends, defeating the prefetch.
3. **Loader returns data; component reads via `useLoaderData` and overlays `useQuery({ initialData })`** — legacy shape. Migrate to `ensureQueryData` in the loader and `useSuspenseQuery` in the component; data still flows via the cache.
4. **Component inspects `data.status === "error"`** — throw in the `queryFn` instead, so the error flows to `<ErrorBoundary>`.
5. **Flat or unprefixed query keys** (`["user"]`, `["getUserInfo"]`) — prefix with app and domain.
6. **Global `queryClient.invalidateQueries()`** on a mutation — targets every active query. Invalidate the specific `queryKey`.
7. **Inline `queryOptions` at the call site** — duplicated shapes drift. Extract a factory co-located with the server function.
8. **Server-function handler containing database queries or business logic** — extract to a repository/service layer in your project structure.
9. **Rendering `error.message` directly in the fallback** without tag-based narrowing — `message` can echo identifiers; it's a copy-edit concern, not a debug dump.
10. **`useSuspenseQuery` without a `<Suspense>` / `<ErrorBoundary>` ancestor** — the suspense bubbles to the router's root boundary and blanks the page.
11. **Calling `useQuery` to read data that will be sent straight into a mutation** — read from the cache directly (`queryClient.getQueryData(queryOptions.queryKey)`) inside `onClick` / `onSuccess`; subscribing in the component causes a re-render on every cache update.

## New-query checklist

1. Server function, input schema, and `queryOptions` factory co-located.
2. Handler delegates to a repository/service; returns plain data.
3. `queryFn` throws on error so it flows to `<ErrorBoundary>`.
4. Route loader prefetches with `context.queryClient.ensureQueryData(...)`; parallel fetches batched in `Promise.all`.
5. Component reads via `useSuspenseQuery` (UI) or `useSuspenseQueries` (parallel). `useQuery` only for side-effect readers.
6. Every suspendable subtree has a scoped `<ErrorBoundary>` + `<Suspense>` pair. Fallback branches on `_tag` where meaningful.
7. Mutations throw on error, invalidate the specific `queryKey`, and don't invent unnecessary client-side error abstractions.
8. Query key prefixed with app (`"app"` or your identifier), followed by domain and any parameters that affect the result.
