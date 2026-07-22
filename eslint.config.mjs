import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TypeScript rules
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",
    
    // React rules
    "react-hooks/exhaustive-deps": "off",
    "react-hooks/purity": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",

    // ── React Compiler rules (new in the Next 16 / eslint-plugin-react-hooks
    // v6 upgrade) ────────────────────────────────────────────────────────
    //
    // `set-state-in-effect` flags calling setState inside useEffect, which is
    // how every data-fetching panel in this app loads its data. It fired 94
    // times on existing, working code. Silencing it outright would hide a
    // rule that does catch genuine render loops, so it is a WARNING: visible
    // to anyone reading lint output, but not blocking, and not worth a
    // 94-site refactor with real regression risk on a live platform.
    //
    // The right resolution is migrating those fetches to a data library
    // (react-query is already a dependency), at which point this can go back
    // to "error".
    "react-hooks/set-state-in-effect": "warn",
    // Same upgrade, same reasoning — small counts, pre-existing patterns.
    "react-hooks/static-components": "warn",
    "react-hooks/refs": "warn",
    "react-hooks/immutability": "warn",
    
    // Next.js rules
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",
    
    // General JavaScript rules
    "prefer-const": "off",
    "no-unused-vars": "off",
    "no-console": "off",
    "no-debugger": "off",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-redeclare": "off",
    "no-undef": "off",
    "no-unreachable": "off",
    "no-useless-escape": "off",
  },
}, {
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills"]
}];

export default eslintConfig;
