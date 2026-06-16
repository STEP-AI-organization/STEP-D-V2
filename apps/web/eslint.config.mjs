import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  {
    ignores: [".next/**", ".next-codex-build/**"]
  },
  ...nextVitals
];

export default eslintConfig;
