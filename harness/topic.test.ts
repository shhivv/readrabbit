import { describe, expect, test } from "bun:test";
import { assessTopic, MIN_TOPIC_RELEVANCE } from "../src/lib/crawler/topic";

describe("article topic relevance", () => {
  test("rejects a technology detour from an economics feed", () => {
    const result = assessTopic(
      {
        title: "What MCP changes about developer tools",
        excerpt: "The Model Context Protocol connects AI assistants to software and APIs.",
        textContent: "Programming teams can expose tools to an LLM through a local server protocol.",
      },
      "economics"
    );

    expect(result.topic).toBe("technology");
    expect(result.scores.economics).toBeLessThan(MIN_TOPIC_RELEVANCE);
  });

  test("keeps an economics article that mentions technology", () => {
    const result = assessTopic(
      {
        title: "AI investment, productivity, and the labor market",
        excerpt: "What capital spending on software means for wages and economic growth.",
        textContent: "Economists disagree about productivity, competition, income and monetary policy.",
      },
      "economics"
    );

    expect(result.topic).toBe("economics");
    expect(result.relevance).toBeGreaterThan(MIN_TOPIC_RELEVANCE);
  });

  test("recognizes finance and public-policy economics without a generic label", () => {
    const finance = assessTopic(
      {
        title: "How equity derivatives change asset pricing",
        excerpt: "Options markets, portfolio risk, and financial regulation.",
        textContent:
          "Investors use futures and credit to value equity while banks manage market risk.",
      },
      "economics"
    );
    const policy = assessTopic(
      {
        title: "The fiscal arithmetic of Social Security reform",
        excerpt: "Retirement benefits, public pensions, and the federal deficit.",
        textContent:
          "Tax policy changes worker incentives, government spending, debt, and household wealth.",
      },
      "economics"
    );

    expect(finance.topic).toBe("economics");
    expect(finance.relevance).toBeGreaterThan(MIN_TOPIC_RELEVANCE);
    expect(policy.topic).toBe("economics");
    expect(policy.relevance).toBeGreaterThan(MIN_TOPIC_RELEVANCE);
  });

  test("recognizes mathematical writing from its content", () => {
    const result = assessTopic(
      {
        title: "A shorter proof of the prime number theorem",
        excerpt: "A lemma about a sequence of integers gives the key bound.",
        textContent: "The proof uses complex analysis, an integral and a polynomial estimate.",
      },
      "technology"
    );

    expect(result.topic).toBe("math");
    expect(result.relevance).toBeGreaterThan(MIN_TOPIC_RELEVANCE);
  });

  test("does not bless an unrelated personal update just because of its feed", () => {
    const result = assessTopic(
      {
        title: "Notes from my summer holiday",
        excerpt: "A few photographs, meals, and thoughts from the road.",
        textContent: "We walked along the coast and visited friends before returning home.",
      },
      "math"
    );

    expect(result.relevance).toBeLessThan(MIN_TOPIC_RELEVANCE);
  });

  test("rejects a restaurant guide with one incidental economics mention", () => {
    const result = assessTopic(
      {
        title: "Where to eat in San Francisco",
        textContent:
          "There is a tradition of economics bloggers sharing restaurant recommendations. " +
          "Here are the dishes, dining rooms, chefs, and meals I enjoyed around the city.",
      },
      "economics"
    );

    expect(result.relevance).toBeLessThan(MIN_TOPIC_RELEVANCE);
  });

  test("recognizes current AI tooling terminology as technology", () => {
    const result = assessTopic(
      {
        title: "ChatGPT search and Claude coding agents",
        textContent:
          "OpenAI and Anthropic language models are changing software developer tools.",
      },
      "economics"
    );

    expect(result.topic).toBe("technology");
    expect(result.relevance).toBeGreaterThan(MIN_TOPIC_RELEVANCE);
  });

  test("recognizes systems stories surfaced by community feeds", () => {
    expect(
      assessTopic(
        {
          title: "Wi-Fi 8 changes how wireless home networks work",
          textContent: "The chipset and firmware coordinate access points.",
        },
        "technology"
      ).relevance
    ).toBeGreaterThanOrEqual(MIN_TOPIC_RELEVANCE);
    expect(
      assessTopic(
        {
          title: "NanoGPT speedrun frontier",
          textContent: "A GPT training implementation optimized for a modern processor.",
        },
        "technology"
      ).relevance
    ).toBeGreaterThanOrEqual(MIN_TOPIC_RELEVANCE);
  });
});
