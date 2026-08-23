# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# ReadRabbit

- Fully local app: no server, no API keys. All data in `expo-sqlite`.
- Always use `bun` instead of npm/npx for installing packages and running scripts.
- App code lives in `src/` (expo-router: `src/app`, libs: `src/lib`).
- `bunfig.toml` disables the global minimum-release-age policy **for this repo
  only** because Expo SDK 57 patches ship faster than that policy allows.
  Do not remove it.
