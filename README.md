# Naturally Curious

A fully local, on-device blog discovery + reading app. No server, no accounts —
you pick your interests, the app crawls high-signal personal blogs (seeded from a
curated catalog), extracts clean reader-mode text, and serves an endless deque of
worthwhile posts. Discovery branches outward: HN for technology, math/econ
aggregators and outbound links everywhere else. Mainstream media is filtered out.

## Stack

- Expo SDK 57 (React Native, expo-router) in `src/`
- `expo-sqlite` as the entire data layer
- On-device crawler: RSS/Atom parsing, Readability-style extraction,
  feed autodiscovery
- Background refresh via `expo-background-task` + refresh-on-open

## Develop

```sh
bun install
bun start        # expo dev server
```

Always use `bun` instead of npm/npx.
