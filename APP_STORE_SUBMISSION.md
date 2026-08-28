# App Store Submission Checklist

## App Store Connect Setup

### App Information
- [ ] Create app record in App Store Connect with bundle ID `com.readrabbit.app`
- [ ] Set primary language to English
- [ ] Set primary category to **News** (subcategory: none needed)
- [ ] Set secondary category to **Books** (optional but recommended)
- [ ] Set content rights: "This app does not contain, show, or access third-party content" is **false** (the app displays third-party articles). Select "Yes, I have all necessary rights" and note that content is fetched from publicly available RSS feeds.

### Pricing and Availability
- [ ] Set price to **Free**
- [ ] Select availability territories (all or specific)
- [ ] No in-app purchases to declare

### App Privacy (App Store Connect > App Privacy)
- [ ] **Privacy Policy URL**: `https://readrabbit.one/privacy.html`
- [ ] Data types collected:
  - **Usage Data > Product Interaction**: Yes
    - Purpose: Analytics
    - Linked to identity: No
    - Used for tracking: No
- [ ] No other data types are collected (no identifiers, no contact info, no location, etc.)

### Version Information
- [ ] App name: **ReadRabbit**
- [ ] Subtitle (30 chars max): "For the Naturally Curious"
- [ ] Promotional text (170 chars): "A private reading app that surfaces thoughtful writing from independent blogs. No account, no ads, no tracking. Just reading."
- [ ] Description: Write a full description covering features (swipe reader, topic selection, bookmarks, paragraph likes, mute authors), the privacy angle (fully local, no accounts, open source), and the content focus (independent blogs, technology/economics/math)
- [ ] Keywords (100 chars): `reading,rss,reader,blogs,articles,news,technology,economics,math,privacy,open source`
- [ ] Support URL: `https://readrabbit.one`
- [ ] Marketing URL (optional): `https://readrabbit.one`

### Screenshots
- [ ] iPhone 6.7" (1290 x 2796): Required. At least 3 screenshots showing: feed/reader, onboarding topic selection, article view
- [ ] iPhone 6.5" (1284 x 2778): Required if supporting older devices
- [ ] iPad screenshots: Not required (app runs in iPhone compatibility mode on iPad)

### App Review Information
- [ ] Contact info: name, phone, email for review team
- [ ] **Review notes** (critical for avoiding rejection):

```
ReadRabbit is a fully local RSS reader that fetches articles from publicly
available blogs and RSS feeds. It does not require an account or login.

BACKGROUND FETCH: The app uses iOS Background App Refresh to periodically
check RSS feeds for new articles. This happens entirely on-device. No user
data is sent to any server during background refresh. The app registers a
BGProcessingTask that runs the feed update cycle (typically every 6 hours,
subject to iOS scheduling).

THIRD-PARTY CONTENT: Articles displayed in the app are written by
independent authors and fetched directly from their public RSS feeds. The
app does not host, moderate, or modify this content. It functions like
Safari's Reading List or any RSS reader.

ANALYTICS: The app uses PostHog for anonymous, non-identifying usage
analytics (feature usage counts, screen views). No personal information
is collected. The analytics use a random anonymous identifier, not IDFA.

NO ACCOUNT REQUIRED: The app has no login, registration, or account
system. All data is stored locally on the device in a SQLite database.

To test: Open the app, select one or more topics, and tap "Start reading".
The app will begin fetching articles (requires network). After a moment,
articles will appear in the swipe reader.
```

- [ ] Sign in required: **No**
- [ ] Demo account: N/A

## Build Configuration

### Before Building
- [ ] Run `expo prebuild --clean` to regenerate native projects from app.json (this will apply BGTaskSchedulerPermittedIdentifiers and sync version numbers)
- [ ] Verify app.json version matches what you want to submit (`0.1.1`)
- [ ] Verify android versionCode is incremented for each upload
- [ ] Replace `<ph_project_api_key>` in `src/app/_layout.tsx` with your actual PostHog project API key

### EAS Build
- [ ] Configure `eas.json` with a production profile if not already done
- [ ] Run `eas build --platform ios --profile production`
- [ ] Or if building locally: `eas build --platform ios --local`

### Code Signing
- [ ] Apple Developer account enrolled ($99/year)
- [ ] Distribution certificate created
- [ ] App Store provisioning profile created for `com.readrabbit.app`
- [ ] EAS configured with Apple credentials (or use `--local` with Xcode signing)

## Common Rejection Reasons: Audit Results

### Guideline 2.1 - Performance: App Completeness
- [x] App is complete and functional (not a beta, demo, or trial)
- [x] No placeholder content or "coming soon" features
- [x] No broken links in the app

### Guideline 2.3 - Performance: Accurate Metadata
- [x] App name matches what's in the app
- [x] Screenshots will be accurate (take them from a real device)
- [x] Description does not mention other platforms or contain pricing info
- [x] No misleading category selection

### Guideline 2.4 - Performance: Hardware Compatibility
- [x] App works in portrait orientation only (declared correctly)
- [x] No iPad-specific features required (runs in iPhone compatibility mode)

### Guideline 2.5.1 - Software Requirements
- [x] No private APIs used
- [x] No deprecated UIWebView usage (using react-native-render-html)

### Guideline 3.1 - Business: Payments
- [x] No payments, subscriptions, or in-app purchases
- [x] No external payment links

### Guideline 4.2 - Minimum Functionality
- [x] App provides clear value beyond a website wrapper
- [x] Swipe-based reader with likes, bookmarks, mute, and topic filtering
- [x] Background crawling and recommendation engine

### Guideline 5.1.1 - Data Collection and Storage
- [x] Privacy policy exists at https://readrabbit.one/privacy.html
- [x] Privacy policy accurately describes PostHog analytics collection
- [x] Privacy policy linked in App Store Connect
- [x] No IDFA/AdSupport framework usage
- [x] PrivacyInfo.xcprivacy manifest updated with collected data types
- [x] NSPrivacyTracking set to false (no tracking)

### Guideline 5.1.2 - Data Use and Sharing
- [x] PostHog analytics are anonymous and not linked to user identity
- [x] No data shared with third parties for advertising
- [x] App Privacy nutrition label matches actual data collection

### Guideline 2.16 - Background Modes
- [x] UIBackgroundModes includes only "fetch" (legitimate use)
- [x] Background task is genuinely used to fetch new RSS content
- [x] BGTaskSchedulerPermittedIdentifiers is declared
- [x] Review notes explain background fetch usage

### Guideline 4.0 - Design: Content
- [x] No user-generated content moderation issues (read-only RSS feeds)
- [x] No objectionable content (curated blog sources about tech/economics/math)
- [x] Content comes from publicly available independent blogs

### Guideline 5.4 - Apple Pay / Sign in with Apple
- [x] No third-party login, so Sign in with Apple is not required
- [x] No account system at all

### Additional Checks
- [x] NSAllowsArbitraryLoads is false (ATS compliant)
- [x] All network requests use HTTPS (RSS feeds fetched over HTTPS)
- [x] No crash-prone code paths identified
- [x] Accessibility labels present on interactive elements
- [x] App icon at 1024x1024 resolution exists

## Post-Submission

- [ ] Monitor App Store Connect for review status
- [ ] Respond to any reviewer questions within 24 hours
- [ ] If rejected, read the specific guideline cited and address it directly
- [ ] Once approved, consider phased release (start with 1% if nervous)

## URLs to Configure

| Where | URL |
|-------|-----|
| App Store Connect > App Privacy > Privacy Policy | `https://readrabbit.one/privacy.html` |
| App Store Connect > Version > Support URL | `https://readrabbit.one` |
| App Store Connect > Version > Marketing URL | `https://readrabbit.one` |
| PostHog API key in `src/app/_layout.tsx` | Replace `<ph_project_api_key>` |
