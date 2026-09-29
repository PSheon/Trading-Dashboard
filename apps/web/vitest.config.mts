import { fileURLToPath } from "node:url";
const config = {
  oxc: { jsx: { runtime: "automatic" as const } },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"] },
};

export default config;
