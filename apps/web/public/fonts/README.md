# Fixed Orbie font assets

These unmodified WOFF2 files are the Noto Sans TC, Nunito and Fredoka assets captured from existing local Next production output during ef169530 verification. This identifies the capture source; ef169530 pre-push built API, not Web. They were originally fetched by next/font/google. Each filename is its SHA-256 digest; manifest.json records bytes, hashes and original build asset paths.

The font-face rules retain the same unicode slices, weights, font-display and size-adjusted fallback metrics. Only the resource URLs changed. Latin brand fonts remain preloaded. Noto Sans TC remains in a lazy CSS module, with optional display and no first-paint preload; the current-build CJK cookie guard is unchanged.

Each family directory includes its SIL Open Font License, retrieved from the official Google Fonts repository:

- https://github.com/google/fonts/tree/main/ofl/notosanstc
- https://github.com/google/fonts/tree/main/ofl/nunito
- https://github.com/google/fonts/tree/main/ofl/fredoka

Vendoring removes build-time dependence on the Google CSS endpoint and its occasional extensionless font URLs. The matching upstream parser issue is https://github.com/vercel/next.js/issues/99114. No SDK, API, funding, signature or trading behavior changes.
