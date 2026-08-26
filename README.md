# kyzerdocs-lite

Upload your documents, ask questions about them, and get streaming answers with clickable
citations back to the exact passage each claim came from.

Two ways to run it: entirely on your own machine with no cloud account at all, or on your own
Vercel account with a public URL and an embeddable chat widget for your website.

## Run it locally

```
npx kyzerdocs-lite
```

Run this from the folder where you want your knowledge base to live, follow the two prompts
(a Gemini API key and an admin password you choose), then open the URL it prints. No cloud
account, no monthly subscription, no data leaving your computer except to call the Gemini API you
provide the key for. That is the only account this mode requires.

New here? Follow [docs/SETUP.md](docs/SETUP.md) for a full walkthrough, including a step-by-step
guide (with screenshots) to getting your free Gemini API key.

## Deploy to your own Vercel account

Want a public URL and a chat widget you can drop on your own website? Deploy to Vercel — one
click provisions everything the app needs, and the database schema applies itself during the
build, so there is nothing to run by hand.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Frichipal%2Fkyzerdocs-lite&env=GEMINI_API_KEY%2CADMIN_PASSWORD&envDescription=Two+values+only+you+can+provide%3A+a+free+Gemini+API+key+and+an+admin+password+you+choose+for+signing+in.&envLink=https%3A%2F%2Faistudio.google.com%2Fapikey&stores=%5B%7B%22type%22%3A%22blob%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%2C%22protocol%22%3A%22storage%22%7D%5D)

**What this actually costs you, in accounts:** two, and only two. You create a Vercel account —
that's the click above. Inside that same flow, Vercel provisions a Neon Postgres database and a
Vercel Blob store on your behalf, with billing routed through Vercel, so there is no separate Neon
signup or payment method to set up. The only credential you obtain yourself, from a completely
different company, is a free Gemini API key from AI Studio — the Deploy button links straight to
the page that issues one. Two accounts total (Vercel, and effectively Neon-via-Vercel), never
three, exactly as the Business tier is sold.

Do not go looking for "Vercel Postgres" or "Vercel KV" in your Vercel dashboard — both were
discontinued in December 2024 and no longer exist as products. Neon (via the Vercel Marketplace)
is what replaced Vercel Postgres, and it's what this template provisions.

Full walkthrough, including what each environment variable does and how to confirm your
deployment is healthy: [docs/DEPLOY.md](docs/DEPLOY.md). Putting the widget on your own site:
[docs/WIDGET.md](docs/WIDGET.md).

If something goes wrong, every error carries a short code you can look up in
[docs/ERROR-CODES.md](docs/ERROR-CODES.md).

## What it does

- Upload PDF, DOCX, TXT, and Markdown documents.
- Ask questions in a chat interface; answers stream in with citations you can click to see the
  source passage.
- If nothing in your documents actually answers a question, it says so directly rather than
  guessing.

## Requirements

- Node.js 22.5 or newer.
- A free [Gemini API key](https://aistudio.google.com/apikey).
