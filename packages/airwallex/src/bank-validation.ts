/** Checksums Airwallex enforces at beneficiary creation. Used by the simulator and by pre-flight checks. */

export function validIban(iban: string): boolean {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const v = ch >= "A" && ch <= "Z" ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const d of v) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** ABA routing number checksum (weights 3,7,1). */
export function validAba(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split("").map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

export function validSwift(code: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(code);
}

/** A handful of real UK sort codes; invented ones fail like the sandbox does (code 010). */
export const KNOWN_SORT_CODES = new Set([
  "040004",
  "200000",
  "401276",
  "089999",
  "309634",
  "601613",
  "070116",
]);

export function validSortCode(code: string): boolean {
  return /^\d{6}$/.test(code) && KNOWN_SORT_CODES.has(code);
}
