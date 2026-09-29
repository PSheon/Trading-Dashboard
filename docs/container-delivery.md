# API image and migration delivery

Build from the repository root:

```sh
docker build -f apps/api/Dockerfile -t orbie-api:review .
```

The base Node 22 Bookworm image is pinned to a manifest digest; Dependabot tracks
Docker updates. The build installs only the API/shared workspace closure,
compiles both, then pnpm 10.17.1 `deploy --legacy --prod` creates a portable
runtime. The final image runs as node (non-root), without Next, Vitest,
TypeScript, Nest CLI or drizzle-kit. Package file allowlists include compiled
code and release migrations; Docker excludes environment files and test/build
artifacts. The final image still includes OS/Node and API production transitives;
this is not a distroless image or a vulnerability scan of the base OS.

For a release, back up the target database, then run the **same built image's**
migration command once before shifting API traffic:

```sh
docker run --rm -e DATABASE_URL orbie-api:review node scripts/migrate.mjs
```

Supply DATABASE_URL via the deployment secret mechanism. The script never reads
.env, does not print connection errors/URLs, and takes a dedicated session
advisory lock (73104, 2), with a 60-second admission deadline. Each statement has
a 120-second timeout. Drizzle records completed migrations transactionally.
Concurrent release jobs serialize; failed migrations fail the release. Do not
run schema push or migration generation against production. API startup does
not implicitly migrate; readiness checks connectivity, not schema version.

After migration, start the API with validated production configuration, wait for
/health/ready and only then switch traffic. Apply API before frontend for the
required /me.permissions contract. Railway config remains single-replica; this
repository does not configure live Railway release hooks or secrets.

Rollback code only when the previous binary supports the new schema. Current
additive migrations retain old columns, but do not infer that every future
migration is reversible. A destructive rollback requires a tested restore and
an explicitly chosen downtime/data-loss window. Never automatically run down
migrations on deploy failure.

Local evidence: image built successfully, runs non-root, required runtime files
present and compiler/test/frontend packages unresolvable. Docker Desktop smoke
created an owned disposable DB, ran the image migration, observed readiness 200
and graceful exit 0, then removed its container and DB. Concurrent migration
smoke preserved the journal count. `scripts/image-smoke.mjs` uses Docker Desktop's
host.docker.internal; it is not a portable production deployment script. No
remote image push, Railway deployment, or application DB migration was run.
