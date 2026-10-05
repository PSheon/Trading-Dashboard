import { fileURLToPath } from "node:url";
const config = {
  oxc: { jsx: { runtime: "automatic" as const } },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)), "next/root-params": fileURLToPath(new URL("./test/stubs/root-params.ts", import.meta.url)) } },
  test: { include: ["test/**/*.test.{ts,tsx}"] },
};

export default config;
