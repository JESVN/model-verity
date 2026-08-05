import type { BatteryCell } from "../battery/index.js";
import type { NormalizedAnswer } from "./index.js";

const AR_DIGITS: Record<string, string> = {
  "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
  "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
};
const ZH_DIGITS: Record<string, number> = { 零:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
const REFUSAL = /(i can.?t|i cannot|i'm sorry|as an ai|не могу|извин|抱歉|无法|لا أستطيع|عذراً|آسف)/iu;
const COIN: Record<string, Record<string, string>> = {
  en: { heads: "h", tails: "t" },
  ru: { "орёл": "h", "орел": "h", "решка": "t" },
  zh: { "正面": "h", "正": "h", "反面": "t", "反": "t" },
  ar: { "صورة": "h", "كتابة": "t" },
};
const INTEGER_TASKS = new Set(["num100-random", "num10-random", "num-favorite"]);
const WORD_TASKS = new Set(["word-random", "color-random", "color-favorite", "animal-random", "city-random"]);

function chineseNumber(value: string): number | null {
  const match = value.match(/^([零一二两三四五六七八九])?十?([零一二两三四五六七八九])?$/u);
  if (!match || (!match[1] && !match[2] && !value.includes("十"))) return null;
  if (!value.includes("十")) return match[1] ? ZH_DIGITS[match[1]] : null;
  return (match[1] ? ZH_DIGITS[match[1]] : 1) * 10 + (match[2] ? ZH_DIGITS[match[2]] : 0);
}

function clean(raw: string): string {
  return raw.normalize("NFC")
    .replace(/[«»"“”„'’‘`().,!?。！？、：:;؛؟\[\]{}*_#-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Exact TypeScript port of the normalizer archived at DOI 10.5281/zenodo.21278793. */
export function normalizePamelaAnswer(
  cell: Pick<BatteryCell, "task" | "language">,
  rawValue: unknown,
): NormalizedAnswer {
  const raw = typeof rawValue === "string" ? rawValue : "";
  if (!raw.trim()) return { raw, token: "", validity: "empty" };
  if (REFUSAL.test(raw)) return { raw, token: clean(raw), validity: "refusal" };
  let value = clean(raw);
  if (!value) return { raw, token: "", validity: "empty" };
  value = value.replace(/[٠-٩۰-۹]/gu, (digit) => AR_DIGITS[digit]);

  if (INTEGER_TASKS.has(cell.task)) {
    const match = value.match(/-?\d+/u);
    const number = match ? Number.parseInt(match[0], 10) : cell.language === "zh" ? chineseNumber(value) : null;
    if (number == null) return { raw, token: value, validity: "invalid" };
    const inRange = cell.task === "num100-random"
      ? number >= 1 && number <= 100
      : cell.task === "num10-random"
        ? number >= 1 && number <= 10
        : true;
    return inRange
      ? { raw, token: String(number), category: String(number), validity: "valid" }
      : { raw, token: String(number), validity: "invalid" };
  }

  if (cell.task === "coin-flip") {
    const token = value.toLocaleLowerCase("und").split(" ")[0];
    const category = COIN[cell.language]?.[token];
    return category
      ? { raw, token, category, validity: "valid" }
      : { raw, token, validity: "invalid" };
  }

  const words = value.toLocaleLowerCase("und").split(" ");
  if (WORD_TASKS.has(cell.task) && words.length > 3) return { raw, token: words[0] ?? "", validity: "invalid" };
  let token = words[0] ?? "";
  if (!token) return { raw, token, validity: "empty" };
  if (cell.task === "letter-random" && [...token].length > 1 && cell.language !== "zh") {
    token = words.find((word) => [...word].length === 1) ?? "";
    if (!token) return { raw, token: words[0] ?? "", validity: "invalid" };
  }
  return { raw, token, category: token, validity: "valid" };
}
