import type { BatteryCell } from "../battery/index.js";

export const NORMALIZE_VERSION = "1";
export type Validity = "valid" | "invalid" | "refusal" | "empty";
export interface NormalizedAnswer {
  raw: string;
  token: string;
  category?: string;
  validity: Validity;
}

const REFUSALS = [
  /^(i\s*(can'?t|cannot|won't)|unable|sorry|refuse)/iu,
  /^(не могу|извините|отказываюсь)/iu,
  /^(不能|无法|抱歉|拒绝)/u,
  /^(لا أستطيع|عذراً|آسف|أرفض)/u,
];

const DIGITS: Record<string, string> = {
  "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
  "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
  "零":"0","〇":"0","一":"1","二":"2","两":"2","三":"3","四":"4","五":"5","六":"6","七":"7","八":"8","九":"9",
};
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100 };

const COLORS: Record<string, string> = {
  red:"red", crimson:"red", scarlet:"red", rouge:"red", красный:"red", 红:"red", 红色:"red", أحمر:"red", حمراء:"red",
  blue:"blue", azure:"blue", navy:"blue", синий:"blue", голубой:"blue", 蓝:"blue", 蓝色:"blue", أزرق:"blue", زرقاء:"blue",
  green:"green", emerald:"green", зелёный:"green", зеленый:"green", 绿:"green", 绿色:"green", أخضر:"green", خضراء:"green",
  yellow:"yellow", gold:"yellow", golden:"yellow", жёлтый:"yellow", желтый:"yellow", 黄:"yellow", 黄色:"yellow", أصفر:"yellow", صفراء:"yellow",
  black:"black", чёрный:"black", черный:"black", 黑:"black", 黑色:"black", أسود:"black", سوداء:"black",
  white:"white", белый:"white", 白:"white", 白色:"white", أبيض:"white", بيضاء:"white",
  orange:"orange", оранжевый:"orange", 橙:"orange", 橙色:"orange", برتقالي:"orange",
  purple:"purple", violet:"purple", фиолетовый:"purple", 紫:"purple", 紫色:"purple", بنفسجي:"purple",
  pink:"pink", розовый:"pink", 粉:"pink", 粉色:"pink", وردي:"pink",
  brown:"brown", коричневый:"brown", 棕:"brown", 棕色:"brown", بني:"brown",
  gray:"gray", grey:"gray", серый:"gray", 灰:"gray", 灰色:"gray", رمادي:"gray",
};

const COIN: Record<string, string> = {
  heads:"heads", head:"heads", орёл:"heads", орел:"heads", 正面:"heads", صورة:"heads",
  tails:"tails", tail:"tails", решка:"tails", 反面:"tails", كتابة:"tails",
};

function cleanVisible(raw: string): string {
  return raw
    .normalize("NFC")
    .trim()
    .replace(/^[\s"'“”‘’`*_([{<]+|[\s"'“”‘’`*_)\]}>.,!?;:，。！？；：、]+$/gu, "")
    .trim();
}

function firstAnswer(text: string, language: string): string {
  if (language === "zh") {
    return text.split(/[\s，。！？；：、,.!?;:]/u)[0] ?? "";
  }
  return text.split(/[\s,;.!?،؛]+/u)[0] ?? "";
}

function chineseNumber(token: string): number | null {
  if (/^[零〇一二两三四五六七八九]$/u.test(token)) return Number(DIGITS[token]);
  if (!/^[零〇一二两三四五六七八九十百]+$/u.test(token)) return null;
  let total = 0;
  let current = 0;
  for (const char of token) {
    if (DIGITS[char] != null) current = Number(DIGITS[char]);
    else if (CN_UNITS[char]) {
      const unit = CN_UNITS[char];
      total += (current || 1) * unit;
      current = 0;
    }
  }
  return total + current;
}

function normalizeNumber(token: string): string | null {
  const mapped = [...token].map((char) => DIGITS[char] ?? char).join("");
  if (/^[+-]?\d+$/u.test(mapped)) return String(Number.parseInt(mapped, 10));
  const cn = chineseNumber(token);
  return cn == null ? null : String(cn);
}

function validNumber(task: string, category: string): boolean {
  if (!/^-?\d+$/u.test(category)) return false;
  const value = Number(category);
  if (task === "random_number_1_100") return value >= 1 && value <= 100;
  if (task === "random_number_1_10") return value >= 1 && value <= 10;
  return Number.isSafeInteger(value);
}

export function normalizeAnswer(cell: Pick<BatteryCell, "task" | "language">, rawValue: unknown): NormalizedAnswer {
  const raw = typeof rawValue === "string" ? rawValue : "";
  const cleaned = cleanVisible(raw);
  if (!cleaned) return { raw, token: "", validity: "empty" };
  if (REFUSALS.some((pattern) => pattern.test(cleaned))) {
    return { raw, token: cleaned, validity: "refusal" };
  }
  const token = firstAnswer(cleaned, cell.language).toLocaleLowerCase("und");
  if (!token) return { raw, token, validity: "empty" };

  let category: string | null = token;
  if (cell.task.includes("number")) category = normalizeNumber(token);
  else if (cell.task === "random_color" || cell.task === "favorite_color") category = COLORS[token] ?? null;
  else if (cell.task === "coin_flip") category = COIN[token] ?? null;
  else if (cell.task === "random_letter") category = [...token].length === 1 ? token : null;
  else if (/[\s]/u.test(token) || token.length > 80) category = null;

  if (category != null && cell.task.includes("number") && !validNumber(cell.task, category)) category = null;
  return category == null
    ? { raw, token, validity: "invalid" }
    : { raw, token, category, validity: "valid" };
}
