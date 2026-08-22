import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, fonts } from "./theme";
import { tokenizeLines } from "./code-tokens";

// RN rendering for highlighted code blocks; all prism/tokenizer logic lives
// in ./code-tokens (pure TS, testable outside React Native).

const TOKEN_COLORS: Record<string, string> = {
  keyword: "#d98e73",
  builtin: "#e3c3a3",
  function: "#e3c3a3",
  "function-definition": "#e3c3a3",
  "class-name": "#8fa8c8",
  string: "#a3b37c",
  char: "#a3b37c",
  number: "#c9a87c",
  boolean: "#c9a87c",
  comment: "#716b63",
  operator: "#8a847c",
  punctuation: "#8a847c",
  macro: "#c39ac2",
  attribute: "#c9a87c",
  tag: "#d98e73",
  "attr-name": "#e3c3a3",
  namespace: "#8fa8c8",
  selector: "#a3b37c",
  property: "#a3b37c",
  variable: "#d5d0c9",
};

const PLAIN_COLOR = "#d5d0c9";

export function CodeBlock({
  code,
  langHint,
}: {
  code: string;
  langHint?: string;
}) {
  const lines = React.useMemo(() => tokenizeLines(code, langHint), [code, langHint]);
  return (
    <View style={styles.codeBlock}>
      {lines.map((line, i) => (
        <Text key={i} style={styles.codeLine}>
          {line.tokens.map((t, j) => (
            <Text key={j} style={{ color: TOKEN_COLORS[t.type] ?? PLAIN_COLOR }}>
              {t.text}
            </Text>
          ))}
          {"\n"}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  codeBlock: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginVertical: 10,
  },
  codeLine: {
    fontFamily: fonts.mono,
    fontSize: 13.5,
    lineHeight: 21,
  },
});
