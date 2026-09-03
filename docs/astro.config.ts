import { defineConfig } from "astro/config";
import icon from "astro-icon";
import tailwindcss from "@tailwindcss/vite";
import nimbus, {
  defineConfig as defineNimbusConfig,
} from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";

const nimbusConfig = defineNimbusConfig({
  site: "https://machine-memory.jfa.dev",
  title: "MACHINE-MEMORY",
  description:
    "Persistent project-scoped memory for LLM agents. Stores facts, decisions, references, status snapshots, and other project context so future agent sessions can recall them.",
  locale: "en",
  github: "https://github.com/jfalava/machine-memory",
  socialImageAlt: "MACHINE-MEMORY documentation",
  sidebar: {
    items: [
      {
        label: "Installation",
        link: "/installation",
      },
      {
        label: "Human commands",
        items: [
          { label: "Overview", link: "/human/overview" },
          { label: "--pretty", link: "/human/pretty" },
          { label: "init", link: "/human/init" },
          {
            label: "local",
            items: [
              { label: "Overview", link: "/human/local/overview" },
              { label: "Export", link: "/human/local/export" },
            ],
          },
          {
            label: "remote",
            items: [
              { label: "Overview", link: "/human/remote/overview" },
              { label: "setup", link: "/human/remote/setup" },
              {
                label: "provision",
                link: "/human/remote/provision",
              },
              {
                label: "Keychain Access",
                link: "/human/remote/keychain-access",
              },
            ],
          },
          { label: "upgrade", link: "/human/upgrade" },
          { label: "reindex", link: "/human/reindex" },
        ],
      },
      {
        label: "MCP",
        items: [
          { label: "Overview", link: "/mcp/overview" },
          { label: "Infrastructure", link: "/mcp/infrastructure" },
          { label: "Enable MCP", link: "/mcp/enable" },
          { label: "Init", link: "/mcp/init" },
          { label: "Tools", link: "/mcp/tools" },
        ],
      },
      {
        label: "Troubleshooting",
        items: [
          { label: "MCP", link: "/troubleshooting/mcp" },
          { label: "Sandbox & credentials", link: "/troubleshooting/sandbox" },
          { label: "Deploy", link: "/troubleshooting/deploy" },
          { label: "CLI", link: "/troubleshooting/cli" },
        ],
      },
      {
        label: "Machine commands",
        items: [{ autogenerate: { directory: "machine" } }],
      },
    ],
  },
});

export default defineConfig({
  output: "static",
  // Tailwind v4 via its Vite plugin (the integration Astro recommends for
  // Tailwind v4 — replaces the PostCSS plugin, which doesn't build under
  // Astro 7's Vite 8 bundler).
  vite: {
    plugins: [tailwindcss()],
    // Bun hoists workspace dependencies into the repository-level .bun store;
    // allow Vite to serve self-hosted font assets through that symlink.
    server: {
      fs: {
        allow: [".", ".."],
      },
    },
  },
  // Hover-prefetch link targets so full-page navigations feel instant without
  // a client-side router.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    icon(),
    nimbus(nimbusConfig, {
      // Authoring rules are opt-in by design — your repo, your taste. The
      // two below are the load-bearing pair: frontmatter has to validate
      // against the content schema for the page to render properly, and
      // broken internal links are 404s for your readers. Add the others
      // (heading hierarchy, code-block language, style, etc.) when you're
      // ready to enforce them — see `nimbus-docs lint --help`.
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
      // Wrap wide tables so they scroll instead of overflowing the page
      // (styled by `.nb-table-scroll` in src/styles/prose.css).
      markdown: {
        hastPlugins: [tableScroll()],
      },
    }),
  ],
});
