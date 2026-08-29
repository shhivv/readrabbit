# App Store screenshots

The three PNG files in `screenshots/` are 1320 x 2868 iPhone 6.9-inch
simulator captures:

- `01-onboarding.png` shows the welcome screen.
- `02-topics.png` shows topic selection.
- `03-fictional-reader.png` shows the reader with fictional content.

The reader screenshot contains no real publication, author, article, URL, or
article text. `app-store-demo.sql` is a repeatable simulator-only fixture. It
archives downloaded articles, pauses sources, and inserts one fictional page
under the reserved `example.invalid` domain. It does not change the app build
or ship demo content to users.
