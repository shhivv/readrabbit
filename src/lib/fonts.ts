export const katexFonts = {
  "Katex-Main": require("../../assets/fonts/katex/KaTeX_Main-Regular.ttf"),
  "Katex-Main-Bold": require("../../assets/fonts/katex/KaTeX_Main-Bold.ttf"),
  "Katex-Main-Italic": require("../../assets/fonts/katex/KaTeX_Main-Italic.ttf"),
  "Katex-Math-Italic": require("../../assets/fonts/katex/KaTeX_Math-Italic.ttf"),
  "Katex-Size1": require("../../assets/fonts/katex/KaTeX_Size1-Regular.ttf"),
  "Katex-Size2": require("../../assets/fonts/katex/KaTeX_Size2-Regular.ttf"),
  "Katex-Size3": require("../../assets/fonts/katex/KaTeX_Size3-Regular.ttf"),
  "Katex-Size4": require("../../assets/fonts/katex/KaTeX_Size4-Regular.ttf"),
  "Katex-Ams": require("../../assets/fonts/katex/KaTeX_AMS-Regular.ttf"),
} as Record<string, number>;

export const geistFonts = {
  Geist: require("@expo-google-fonts/geist/400Regular/Geist_400Regular.ttf"),
  "Geist-Bold": require("@expo-google-fonts/geist/700Bold/Geist_700Bold.ttf"),
  "Geist-Mono": require("@expo-google-fonts/geist-mono/400Regular/GeistMono_400Regular.ttf"),
} as Record<string, number>;

export function allFonts(): Record<string, number> {
  return { ...geistFonts, ...katexFonts };
}
