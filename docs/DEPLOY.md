# Deploy Guide (cloud mode)

This guide gets your knowledge base running on a public URL you control, on your own Vercel
account. It assumes no prior experience with Vercel or with a terminal — you will not need to
type a single command. If you are running kyzerdocs-lite entirely on your own machine instead,
see [docs/SETUP.md](./SETUP.md); this guide is that one's cloud-mode sibling.

You will need about 10 minutes and two things you have never had to create before: a Vercel
account, and a free API key from Google. Neither costs money to obtain.

## 1. Click the Deploy button

From the project's [README](../README.md), click **Deploy with Vercel**. If you do not already
have a Vercel account, the page walks you through creating one first — this is free and is the
only account you sign up for directly.

## 2. What gets provisioned automatically

The same click that creates your project also sets up the two pieces of infrastructure the app
needs to run in the cloud:

- **A Postgres database**, provisioned through Vercel's marketplace integration with Neon. This
  replaces the SQLite file that local mode uses, since a serverless app has no persistent local
  disk to keep one on.
- **A Blob store**, for the documents you upload. Same reason — a serverless deployment cannot
  keep uploaded files on its own filesystem between requests.

Neither of these is a second signup you have to go find and complete yourself. Vercel creates
both inside the same deploy flow, with billing routed through your Vercel account. **You end up
with exactly two accounts: Vercel, and Neon (created on your behalf, through Vercel).** That
matches what the Business tier is sold on.


### One extra step the deploy flow does not do for you

When Vercel connects a Blob store it authenticates your server automatically, and that is enough for
most things — but **not** for uploads. Documents are sent from the browser straight to storage (this
is how files larger than 4.5MB get through at all), and permission for that has to be issued by a
token the automatic setup does not create.

Without it your site will deploy, sign in, and answer questions perfectly, and every document upload
will fail. The health panel will tell you so in plain terms, with the code `KDL-BLOB-005`.

To create it, once:

1. In your Vercel project, open **Storage** and click your Blob store.
2. Find **Tokens**, and create a **Read-write** token. Copy it.
3. Go to **Settings → Environment Variables** in the project.
4. Add a variable named exactly `BLOB_READ_WRITE_TOKEN`, paste the token as the value, and save it
   for **Production**.
5. Open the **Deployments** tab and redeploy the most recent deployment.

Uploads will work from that point on.

You will not see "Vercel Postgres" or "Vercel KV" as options anywhere in this flow — Vercel
discontinued both of those products in December 2024. Neon (via the Vercel Marketplace) is what
you get instead, and it is the correct, current choice, not a downgrade.

The database schema applies itself as part of the deploy build — there is no migration command
for you to run, before or after your first deploy.

## 3. The two values only you can provide

Partway through the deploy flow, Vercel asks you to fill in two environment variables. Every
other value your deployment needs (the database connection, the Blob store's token) is filled in
for you automatically by the provisioning step above.

- **`GEMINI_API_KEY`** — a free API key from Google. Go to
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey), sign in with any Google
  account, and click **Create API key**. Paste the value in. This is the only credential you
  obtain from outside Vercel.
- **`ADMIN_PASSWORD`** — a password you make up yourself, for signing in to your own deployment
  once it is live. There is no username; this one password is all you need to remember.

## 4. Wait for the build, then log in

Once you submit the form, Vercel builds and deploys the app — this takes a few minutes. When it
finishes, Vercel gives you a URL (something like `your-project.vercel.app`). Open it, and sign in
with the admin password you chose in step 3.

## 5. Confirm your deployment is healthy

The document screen includes a health panel. After your first deploy, open it and check each
row:

- **Database** — should read OK. If not, the Neon integration did not provision correctly; check
  your Vercel project's Storage tab for the connection.
- **API key** — should read OK once `GEMINI_API_KEY` is set. If not, revisit your project's
  Environment Variables settings.
- **Embedding model** — a live check that Google actually accepts your key. If this fails but
  "API key" passes, the key itself may be revoked or mistyped.
- **Chat provider** — should read OK; this mirrors the API key check unless you have separately
  configured OpenRouter.
- **Blob storage** — appears only in cloud mode. A real reachability check against your Blob
  store, not just "is a token present." If this fails, check that the Blob store still exists in
  your Vercel project.
- **Index rebuild (cold)** — appears only after the app has actually rebuilt its search index once
  in this deployment's process (see "What a cold start feels like," below). Its absence on a brand
  new deployment is expected, not a problem.

Every code shown anywhere in this panel is documented in
[docs/ERROR-CODES.md](./ERROR-CODES.md) — that file, not this one, is the place to look up what a
specific code means and what to do about it.

## Uploading documents in cloud mode

Uploads work the same way as local mode — drag a file onto the document screen. The real limit on
how large a single document can be is **100MB**, the same ceiling that applies locally; a cloud
deployment's upload path was specifically built to route your file's bytes directly to Blob
storage rather than through the size limits an ordinary web request is subject to, so you should
not notice cloud mode being more restrictive than running on your own machine.

## What a cold start feels like

The first request your deployment serves after sitting idle for a while (or any time Vercel spins
up a fresh copy of your app) has to rebuild its in-memory search index from your database before
it can answer. This adds real, measured time to that one request — it is not a rounding-error
delay, and we are not going to tell you it feels instant, because we measured it and it does not.
What we can tell you honestly: it is a one-time cost per cold start, not something you pay on
every question, and everything after that first request is fast again until the next idle period.
If a specific deployment's cold-start behavior becomes a problem for your use case, quote the
"Index rebuild (cold)" row from your own health panel — that is the real number for your
deployment, not a number from our testing lab.

## If something goes wrong

Every error kyzerdocs-lite can show you carries a short code like `KDL-DB-003` or `KDL-BLOB-001`.
Look it up in [docs/ERROR-CODES.md](./ERROR-CODES.md) first — it explains what actually happened
and what to do next. If you need support, quoting that code is the fastest way to get a useful
answer.

## Putting the widget on your own website

Once your deployment is live and you have uploaded documents, see
[docs/WIDGET.md](./WIDGET.md) for how to drop a chat widget onto your own site with one
`<script>` tag.
