import type { PostHog } from "posthog-react-native";

let client: PostHog | null = null;

export function setPostHogClient(posthog: PostHog | null) {
  client = posthog;
}

type Properties = Record<string, string | number | boolean | string[] | null>;

export function capture(event: string, properties?: Properties) {
  client?.capture(event, properties);
}
