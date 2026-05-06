declare module "opencc-js" {
  // Locale codes supported by the full preset:
  //   from: "cn" (Simplified) | "tw" | "twp" | "hk" | "jp" | "t"
  //   to:   "cn" | "tw" | "twp" | "hk" | "jp" | "t"
  // "twp" = Traditional + Taiwan idiom mapping (e.g. 软件→軟體). "hk" = Hong Kong written Chinese.
  export interface ConverterOptions {
    from: "cn" | "tw" | "twp" | "hk" | "jp" | "t";
    to: "cn" | "tw" | "twp" | "hk" | "jp" | "t";
  }
  export function Converter(opts: ConverterOptions): (input: string) => string;
}
