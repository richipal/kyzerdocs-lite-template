# Widget Guide

This guide covers putting a chat widget for your knowledge base on your own website. It assumes
your deployment is already live — if you have not deployed yet, start with
[docs/DEPLOY.md](./DEPLOY.md).


### One entry covers www and non-www

Add `yourshop.com` and visitors arriving at `www.yourshop.com` are covered too — the two are treated
as the same site. You do not need to add both, and if you try, the screen will tell you it is already
listed rather than adding a second row.

Everything else must match exactly. `shop.yourshop.com` is a different site and needs its own entry,
and there are no wildcards — that is deliberate, so a lookalike domain like `evil-yourshop.com` can
never match `yourshop.com`.

## Where to find your install snippet

Sign in to your deployment and open the **Widget** screen. Once you have saved your widget
settings at least once, an **Install snippet** panel shows the exact `<script>` tag for your
knowledge base, with a **Copy snippet** button. It looks like this:

```html
<script src="https://your-deployment.vercel.app/widget.js" data-kb-id="default" data-position="bottom-right" async></script>
```

Paste it once, anywhere in your site's HTML — it does not need to go in a specific place, and it
does not require any other change to your site.

### What the two data attributes mean

- **`data-kb-id`** — identifies which knowledge base the widget talks to. You never type this by
  hand; copy it from the Install snippet panel, which always reflects your real, live value.
- **`data-position`** — which corner of the screen the launcher bubble appears in:
  `bottom-right` or `bottom-left`. Set this from the Widget screen's settings, not by editing the
  snippet directly — the panel regenerates the snippet to match whatever you last saved.

## Where to paste it

**WordPress:** most themes and page builders have a "Custom HTML" block or a "Header/Footer
Scripts" setting (some site-specific plugins call this "Insert Headers and Footers"). Paste the
snippet there. If your theme has no such option, a plugin that lets you add custom HTML to every
page will do the same job.

**A hosted site builder (Squarespace, Wix, Webflow, and similar):** look for a setting named
something like "Custom Code," "Embed," or "Header Code" in your site's global settings — most
site builders offer one specifically for this purpose. Paste the snippet there so it loads on
every page, not just one.

The widget works on a JavaScript-rendered single-page site too — it is injected by the script
itself, not by crawling your page, so how your site is built does not matter here.

## Allowed domains — read this before you publish

Before your install snippet will actually respond to anyone, you must add your website's domain
to the **Allowed domains** list on the Widget screen. **An empty allowlist means the widget will
not respond anywhere** — this is deliberate, not a bug, so a snippet cannot go live pointed at
nothing.

Requests from other domains are rejected — but be plain with yourself about what this list
actually is: the `Origin` header a browser sends is spoofable by anything that is not a browser,
so the allowed-domains list is a convenience filter, **not a security boundary**. The rate limit
on your chat endpoint is what actually protects your usage costs from abuse; the allowlist just
keeps the widget from quietly responding on sites you never intended it to appear on.

## If your site sends a Content-Security-Policy header

If your website sends its own `Content-Security-Policy` header, add the widget's domain to both
`script-src` and `frame-src`, or the browser will silently block the widget with no error from
us. This is not something we can engineer around: the loader script that injects the launcher
bubble runs inside your page and is subject to your `script-src`, and the chat panel itself opens
in a separate-origin iframe subject to your `frame-src` — two different browser rules, both
pointed at the same domain, both need to allow it.

There is no error message on your page when this happens — the browser enforces the policy
silently, before our code ever gets a chance to report anything. If the widget's launcher bubble
never appears at all, a strict CSP is the first thing to check, alongside the allowed-domains
step above.

**How to diagnose it:** open your browser's developer console on the page where the widget should
appear (right-click the page, choose Inspect, then the Console tab). If the chat frame never
loads, the widget itself logs a console message naming both possible causes — that this domain
is not on the allowlist for this knowledge base, or that the page's Content-Security-Policy
blocked the widget frame — so you know exactly which of the two to check first rather than
guessing.

## What does not work

A page that blocks third-party frames entirely (for example, an extremely strict
`frame-src 'none'` with no exception added) cannot run the widget — there is no configuration on
our side that gets around a host page refusing to frame anything at all. Adding the widget's
domain to `frame-src` as described above is the fix, not a workaround.
