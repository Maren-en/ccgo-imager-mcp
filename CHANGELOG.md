# Changelog

## 0.2.7

- Removed `OPENAI_API_KEY` and `OPENAI_BASE_URL` fallback to prevent accidental cross-service key use.
- Added manual redirect handling for image URL downloads, with safety checks applied to every redirect target.
- Added user-facing key storage, uninstall, and key rotation notes.
- Added minimal security and copyright documents for GitHub release review.

## 0.2.6

- Added natural-language size guidance for 1:1, 16:9, 9:16, 2K, and 4K requests.
- Added guidance for clients to report the actual saved image size and path after generation.

## 0.2.5

- Prevented generated files from overwriting existing files with the same prefix.
- Improved installer dependency installation with `npm ci --omit=dev` when a lockfile exists.
- Cleaned up public-package wording and test fixtures.

## 0.2.4

- Added async image task polling and binary result download support.

